// background.js - the agent loop. Observe (scan frames) -> ask LLM for actions -> execute -> repeat.
// Retries failures with richer DOM context, and never clicks a final submit (guarded here AND in content.js).
'use strict';

const DEFAULTS = {
  apiKey: '',
  model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  baseUrl: 'https://api.deepinfra.com/v1/openai',
  profile: '',
  maxRounds: 8,
};
const getSettings = async () => ({ ...DEFAULTS, ...((await browser.storage.local.get('settings')).settings || {}) });
const getDocs = async () => (await browser.storage.local.get('docs')).docs || [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const runs = new Map();      // tabId -> { cancel, abort: AbortController }
const lastRun = new Map();   // tabId -> { idFrame: Map }
browser.tabs.onRemoved.addListener((tabId) => { runs.delete(tabId); lastRun.delete(tabId); });

// ---------------------------------------------------------------- messaging
browser.runtime.onMessage.addListener((m, sender) => {
  if (m.cmd === 'run') {
    if (runs.has(m.tabId)) return Promise.resolve({ error: 'Already running on this tab.' });
    runAgent(m).catch((e) => panel(m.tabId, { error: String(e.message || e) }));
    return Promise.resolve({ started: true });
  }
  if (m.cmd === 'stop') {
    const r = runs.get(m.tabId);
    if (r) { r.cancel = true; r.abort.abort(); }
    return Promise.resolve(true);
  }
  if (m.cmd === 'status') return Promise.resolve({ running: runs.has(m.tabId) });
  if (m.cmd === 'focusField' && sender.tab) {
    const fid = lastRun.get(sender.tab.id)?.idFrame.get(m.id);
    if (fid !== undefined) browser.tabs.sendMessage(sender.tab.id, { cmd: 'focus', id: m.id }, { frameId: fid }).catch(() => {});
  }
});

const panel = (tabId, msg) => browser.tabs.sendMessage(tabId, { cmd: 'panel', ...msg }, { frameId: 0 }).catch(() => {});
const toFrame = (tabId, frameId, msg) =>
  Promise.race([browser.tabs.sendMessage(tabId, msg, { frameId }), sleep(20000).then(() => { throw new Error('frame timeout'); })]);

async function frameIds(tabId) {
  try {
    const f = await browser.webNavigation.getAllFrames({ tabId });
    return f.filter((x) => /^(https?:|about:blank|about:srcdoc)/.test(x.url)).map((x) => x.frameId);
  } catch { return [0]; }
}
async function ensureContent(tabId) {
  try { await toFrame(tabId, 0, { cmd: 'ping' }); return; }
  catch { /* not injected yet */ }
  try { await browser.tabs.executeScript(tabId, { file: 'content.js', allFrames: true, matchAboutBlank: true }); }
  catch { throw new Error("This page can't be scripted (PDF viewer, browser page, or restricted URL)."); }
}
async function scanAll(tabId) {
  const out = [];
  await Promise.all((await frameIds(tabId)).map(async (frameId) => {
    try { out.push({ frameId, ...(await toFrame(tabId, frameId, { cmd: 'scan', guard: true })) }); } catch { /* frame not ready */ }
  }));
  return out.sort((a, b) => a.frameId - b.frameId);
}
async function waitTabComplete(tabId) {
  for (let i = 0; i < 40; i++) {
    const t = await browser.tabs.get(tabId);
    if (t.status === 'complete') return;
    await sleep(250);
  }
}

// ---------------------------------------------------------------- LLM
async function chat(messages, { json = true, temperature = 0.3, max_tokens = 4000, signal } = {}) {
  const s = await getSettings();
  const url = s.baseUrl.replace(/\/$/, '') + '/chat/completions';
  const call = async (withJson) => fetch(url, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.apiKey },
    body: JSON.stringify({ model: s.model, messages, temperature, max_tokens, ...(withJson ? { response_format: { type: 'json_object' } } : {}) }),
  });
  let r = await call(json);
  if (!r.ok && json && r.status === 400) r = await call(false); // model without JSON mode
  if (!r.ok) throw new Error(`DeepInfra ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return (j.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
function parseJson(s) {
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch { /* fall through */ } }
  throw new Error('Model did not return valid JSON');
}

const SYSTEM = `You are the planning brain of a browser form-filling agent. The user wants the web form on the current page filled in using THEIR OWN documents. You receive: page context, the user's documents, standing profile notes, a list of form fields (each with an id) and clickable buttons, and possibly failures from earlier attempts. You may also receive prefilled_fields: inputs the page already populated — only override one if the documents clearly show it is wrong.

Reply with ONLY a JSON object:
{"actions":[...],"done":true|false,"summary":"one or two sentences for the user"}

Action types ("id" comes from the fields/buttons lists):
- {"do":"fill","id":"..","value":".."}  for text, textarea, number, email, tel, date, select, radio, combobox, dropdown, richtext. For select/radio/dropdown use the visible option text exactly as listed. <input type=date> needs YYYY-MM-DD, type=month YYYY-MM, type=time HH:MM; for plain text boxes follow the placeholder/pattern hint.
- {"do":"check","id":"..","value":true|false}  for checkboxes.
- {"do":"upload","id":"..","doc":"<document name>","tailor":true|false}  for file inputs. Use tailor:true for CV / resume / cover letter uploads when a specific job or role is on the page.
- {"do":"click","id":".."}  ONLY for Next / Continue / Add another / "Apply" buttons that open the form. At most one click per reply and it must be last.
- {"do":"needs_user","id":"..","question":".."}  when the answer is not in the documents/notes, or must be the user's own decision (consent, legal declarations, passwords, captcha, payment details, anything you would have to guess).
- {"do":"skip","id":".."}  for irrelevant fields (site search, newsletter opt-ins, etc).
- Troubleshooting: if earlier attempts failed or no fields were found, you may use "selector" (a CSS selector) instead of "id" on any action, plus {"do":"press","selector":"..","value":"Enter"}. Use the provided HTML snippets / skeleton / optionsSeen to choose better selectors or exact option text.

Rules:
1. Facts about the user come ONLY from the documents and profile notes. Never invent or guess names, ids, numbers, dates, addresses, medical, financial or legal facts. If missing -> needs_user.
2. Open-ended questions ("why do you want this role", "tell us about yourself", cover-letter boxes, claim descriptions): write the answer yourself, as the user, first person, natural and specific. Tie concrete experience from their documents to details of the role/company/situation on the page. No filler ("passionate", "excited to leverage"), no flattery, no bullet lists unless asked, no invented achievements. Default 60-130 words (up to ~250 for cover letters); respect maxlength. Write in the language of the form.
3. NEVER submit. Do not click Submit / Send / Pay / Confirm / Finish / Place order. If the form is at its final review/submit step, set done:true.
4. Do not touch password or captcha fields. Leave marketing opt-ins unchecked. Terms/consent/declaration checkboxes -> needs_user.
5. Respect "required" flags but never fabricate to satisfy them.
6. Dropdown/combobox values must be real options. If unsure of the exact text, give the closest natural phrase; you'll get optionsSeen if it fails.
7. Set done:true when nothing more can be done on this page (including when what remains is all needs_user). If you click Next, set done:false.
8. Output nothing outside the JSON.`;

async function planActions(payload, signal) {
  const msgs = [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(payload) }];
  let raw = await chat(msgs, { signal });
  try { return parseJson(raw); }
  catch {
    msgs.push({ role: 'assistant', content: raw }, { role: 'user', content: 'That was not valid JSON. Reply again with ONLY the JSON object.' });
    return parseJson(await chat(msgs, { signal, temperature: 0 }));
  }
}

const tailorCache = new Map();
const TAILOR_CACHE_MAX = 10;
async function tailorText(doc, page, instruction, signal) {
  const key = doc.id + '|' + (page.url || '');
  if (tailorCache.has(key)) return tailorCache.get(key);
  const out = await chat([
    { role: 'system', content: `You adapt a person's CV/resume for one specific job. Keep EVERY fact true: do not invent employers, titles, dates, degrees, skills or numbers. You may reorder sections and bullets, tighten wording, drop the least relevant items, and mirror terminology from the posting where it is truthful. Keep it to at most two pages. Output ONLY the CV in light markdown: "# Full Name", a contact line, "## Section" headings, "- " bullets. No commentary.` },
    { role: 'user', content: `JOB / PAGE CONTEXT:\n${page.title || ''}\n${page.url || ''}\n${(page.text || '').slice(0, 7000)}\n\nUSER INSTRUCTION: ${instruction || '(none)'}\n\nORIGINAL CV:\n${doc.text.slice(0, 20000)}` },
  ], { json: false, temperature: 0.4, max_tokens: 3500, signal });
  if (tailorCache.size >= TAILOR_CACHE_MAX) tailorCache.delete(tailorCache.keys().next().value);
  tailorCache.set(key, out);
  return out;
}

// ---------------------------------------------------------------- uploads
const findDoc = (docs, name) => {
  const n = (name || '').toLowerCase();
  return docs.find((d) => d.name.toLowerCase() === n) || docs.find((d) => d.name.toLowerCase().includes(n) || n.includes(d.name.toLowerCase())) || (docs.length === 1 ? docs[0] : null);
};
function pickFormat(accept) {
  const a = (accept || '').toLowerCase();
  if (!a) return 'pdf';
  if (/pdf/.test(a)) return 'pdf';
  if (/docx|wordprocessingml|\.doc/.test(a)) return 'docx';
  if (/txt|text\/plain/.test(a)) return 'txt';
  return null; // accept list we can't generate
}
function fileMatches(file, accept) {
  const a = (accept || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  if (!a.length) return true;
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  return a.some((x) => x === ext || x === file.mime || (x.endsWith('/*') && file.mime.startsWith(x.slice(0, -1))));
}
const MIME = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain' };
const baseName = (n) => n.replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'document';

async function prepareUpload(a, f, docs, ctx) {
  const doc = findDoc(docs, a.doc);
  if (!doc) return { missing: true };
  const fmt = pickFormat(f?.accept);
  const wantTailor = doc.tailor && a.tailor !== false && doc.text;
  if (wantTailor) {
    if (!fmt) return { unsupported: true, accept: f?.accept };
    const text = await tailorText(doc, ctx.page, ctx.instruction, ctx.signal);
    const bytes = DocGen[fmt](text);
    return { filename: `${baseName(doc.file?.name || doc.name)}.${fmt}`, mime: MIME[fmt], b64: DocGen.bytesToB64(bytes), note: 'tailored' };
  }
  if (doc.file && fileMatches(doc.file, f?.accept)) return { filename: doc.file.name, mime: doc.file.mime, b64: doc.file.b64 };
  if (doc.text) {
    if (!fmt) return { unsupported: true, accept: f?.accept };
    return { filename: `${baseName(doc.name)}.${fmt}`, mime: MIME[fmt], b64: DocGen.bytesToB64(DocGen[fmt](doc.text)) };
  }
  if (doc.file) return { filename: doc.file.name, mime: doc.file.mime, b64: doc.file.b64, note: 'original format may not match accept' };
  return { missing: true };
}

// ---------------------------------------------------------------- agent
async function runAct(tabId, frameId, action) {
  if (frameId !== undefined) return toFrame(tabId, frameId, { cmd: 'act', action });
  for (const fid of await frameIds(tabId)) { // selector-only action: try each frame
    try {
      const r = await toFrame(tabId, fid, { cmd: 'act', action });
      if (!/element not found/.test(r.error || '')) return r;
    } catch { /* next frame */ }
  }
  return { ok: false, error: 'element not found in any frame' };
}

async function runAgent({ tabId, docIds, instruction }) {
  const ctl = { cancel: false, abort: new AbortController() };
  runs.set(tabId, ctl);
  const idFrame = new Map();
  lastRun.set(tabId, { idFrame });
  const log = (s) => panel(tabId, { status: s });
  const report = { filled: [], needsUser: [], uploaded: [], failed: [], clicked: [], blocked: [], summary: '' };
  try {
    const settings = await getSettings();
    if (!settings.apiKey) throw new Error('Add your DeepInfra API key in the extension options first.');
    const docs = (await getDocs()).filter((d) => docIds.includes(d.id));
    await ensureContent(tabId);

    const handled = new Map();   // id -> {status, tries}
    const fieldMeta = new Map();
    let failures = [], didClick = false, pageCtx = {};

    for (let round = 1; round <= settings.maxRounds && !ctl.cancel; round++) {
      log(`Round ${round}: reading the page…`);
      const scans = await scanAll(tabId);
      const top = scans.find((s) => s.top) || scans[0];
      if (top?.page?.text) pageCtx = top.page;
      const fields = [], prefilled = [], buttons = [];
      for (const s of scans) {
        for (const f of s.fields) {
          idFrame.set(f.id, s.frameId); fieldMeta.set(f.id, f);
          const h = handled.get(f.id);
          if (h && (h.status !== 'failed' || h.tries >= 3)) continue;
          if (f.filled) { prefilled.push(f); continue; }
          fields.push(f);
        }
        for (const b of s.buttons) { idFrame.set(b.id, s.frameId); buttons.push(b); }
      }
      if (!fields.length && !failures.length && round > 1 && !didClick) break;
      didClick = false;

      let skeleton;
      if (!fields.length && !prefilled.length && round === 1) {
        log('No standard fields found, inspecting page structure…');
        skeleton = '';
        for (const fid of (await frameIds(tabId)).slice(0, 3)) { try { skeleton += (await toFrame(tabId, fid, { cmd: 'skeleton' })) + '\n'; } catch { /* skip */ } }
        skeleton = skeleton.slice(0, 18000);
      }

      log(`Round ${round}: thinking (${fields.length} fields${prefilled.length ? `, ${prefilled.length} prefilled` : ''})…`);
      const plan = await planActions({
        task: instruction || 'Fill in this form using my documents.',
        round, page: pageCtx,
        documents: docs.map((d) => ({ name: d.name, text: (d.text || '(file only, no readable text)').slice(0, 15000) })),
        profile_notes: settings.profile,
        fields, buttons,
        ...(prefilled.length ? { prefilled_fields: prefilled } : {}),
        previous_failures: failures,
        ...(skeleton ? { page_skeleton: skeleton } : {}),
      }, ctl.abort.signal);
      if (plan.summary) report.summary = plan.summary;

      let actions = (plan.actions || []).filter((a) => a && a.do);
      const click = actions.find((a) => a.do === 'click');
      actions = actions.filter((a) => a.do !== 'click');
      if (click) actions.push(click);
      if (!actions.length) break;

      failures = [];
      let stop = false;
      const toMark = new Map();
      for (const a of actions) {
        if (ctl.cancel) break;
        const f = fieldMeta.get(a.id);
        const label = f?.label || a.label || a.selector || a.id;
        const frameId = idFrame.get(a.id);
        if (a.do === 'needs_user') {
          report.needsUser.push({ id: a.id, label, question: a.question || 'Needs your input' });
          handled.set(a.id, { status: 'needs_user' });
          if (frameId !== undefined) (toMark.get(frameId) || toMark.set(frameId, []).get(frameId)).push(a.id);
          continue;
        }
        if (a.do === 'skip') { handled.set(a.id, { status: 'skipped' }); continue; }
        if (a.do === 'upload') {
          log(`Preparing file for "${label}"…`);
          const up = await prepareUpload(a, f, docs, { page: pageCtx, instruction, signal: ctl.abort.signal });
          if (up.missing) {
            report.needsUser.push({ id: a.id, label, question: `Asks for a file ("${a.doc || label}") that I don't have. Please attach it yourself.` });
            handled.set(a.id, { status: 'needs_user' });
            if (frameId !== undefined) (toMark.get(frameId) || toMark.set(frameId, []).get(frameId)).push(a.id);
            continue;
          }
          if (up.unsupported) {
            report.needsUser.push({ id: a.id, label, question: `Only accepts "${up.accept}" and I can't produce that format. Please attach it yourself.` });
            handled.set(a.id, { status: 'needs_user' });
            if (frameId !== undefined) (toMark.get(frameId) || toMark.set(frameId, []).get(frameId)).push(a.id);
            continue;
          }
          Object.assign(a, up);
        }
        log(`${a.do === 'click' ? 'Clicking' : 'Filling'} "${String(label).slice(0, 50)}"…`);
        const res = await runAct(tabId, frameId, a).catch((e) => ({ ok: false, error: String(e.message || e) }));
        const prev = handled.get(a.id) || { tries: 0 };
        if (res.blocked) { report.blocked.push(res.clickedLabel); stop = true; handled.set(a.id, { status: 'blocked', tries: 9 }); continue; }
        if (res.ok) {
          if (a.do === 'click') { report.clicked.push(res.clickedLabel); didClick = true; }
          else if (a.do === 'upload') report.uploaded.push({ label, file: a.filename + (a.note ? ` (${a.note})` : '') });
          else report.filled.push({ label, kind: res.kind, value: res.value ?? a.value ?? '' });
          handled.set(a.id, { status: 'ok', tries: prev.tries + 1 });
        } else {
          handled.set(a.id, { status: 'failed', tries: prev.tries + 1 });
          let html = null;
          try { html = await toFrame(tabId, frameId ?? 0, { cmd: 'inspect', id: a.id, selector: a.selector }); } catch { /* ignore */ }
          failures.push({ id: a.id, label, tried: a.do + ' ' + String(a.value ?? a.selector ?? '').slice(0, 80), error: res.error, optionsSeen: res.optionsSeen, html });
        }
      }
      for (const [fid, list] of toMark) browser.tabs.sendMessage(tabId, { cmd: 'mark', ids: list }, { frameId: fid }).catch(() => {});
      if (stop) break;
      if (didClick) { await sleep(1500); await waitTabComplete(tabId); await ensureContent(tabId).catch(() => {}); }
      else await sleep(700);
    }

    // anything that still failed after retries goes in the report
    for (const [id, h] of handled) {
      if (h.status === 'failed') {
        const f = fieldMeta.get(id);
        report.failed.push({ id, label: f?.label || id, error: 'could not be filled automatically after several attempts' });
      }
    }
    if (ctl.cancel) report.summary = 'Stopped. ' + report.summary;
    panel(tabId, { report });
  } catch (e) {
    panel(tabId, { error: String(e.message || e) });
  } finally {
    for (const fid of await frameIds(tabId)) browser.tabs.sendMessage(tabId, { cmd: 'guard', on: false }, { frameId: fid }).catch(() => {});
    runs.delete(tabId);
  }
}
