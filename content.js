// content.js - runs in every frame. Describes the page's form widgets generically (no per-site rules)
// and performs actions that the background/LLM asks for. It never decides anything itself.
(() => {
  'use strict';
  if (window.__affLoaded) return;
  window.__affLoaded = true;

  const FRAME = Math.random().toString(36).slice(2, 6);
  let seq = 0, guard = false, allowSubmitUntil = 0;
  const ids = new WeakMap(), reg = new Map(), meta = new Map();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const txt = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

  // ---------- generic helpers ----------
  const idFor = (el) => {
    let id = ids.get(el);
    if (!id) { id = `${FRAME}_${++seq}`; ids.set(el, id); reg.set(id, el); }
    return id;
  };
  function collect(root, sel, out = []) {
    try { root.querySelectorAll(sel).forEach((e) => out.push(e)); } catch { return out; }
    root.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) collect(e.shadowRoot, sel, out); });
    return out;
  }
  function visible(el) {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    return cs.visibility !== 'hidden' && cs.display !== 'none' && (r.width > 0 || r.height > 0);
  }
  function score(a, b) {
    a = norm(a); b = norm(b);
    if (!a || !b) return 0;
    if (a === b) return 100;
    if (a.startsWith(b) || b.startsWith(a)) return 80;
    if (a.includes(b) || b.includes(a)) return 60;
    const A = new Set(a.split(' ')), B = b.split(' ');
    const hit = B.filter((w) => A.has(w)).length;
    return hit ? (40 * hit) / Math.max(A.size, B.length) : 0;
  }
  function bestBy(list, get, want, min = 40) {
    let best = null, bs = 0;
    for (const it of list) {
      const s = Math.max(...[].concat(get(it)).map((t) => score(t, want)));
      if (s > bs) { bs = s; best = it; }
    }
    return bs >= min ? best : null;
  }
  const textOfIds = (el, attr) => {
    const root = el.getRootNode();
    return (el.getAttribute(attr) || '').split(/\s+/).map((i) => txt(root.getElementById && root.getElementById(i)?.textContent)).filter(Boolean).join(' ');
  };

  function labelOf(el) {
    let t = txt(el.getAttribute('aria-label')) || textOfIds(el, 'aria-labelledby');
    if (!t && el.labels && el.labels.length) t = txt([...el.labels].map((l) => l.textContent).join(' '));
    if (!t) { const l = el.closest('label'); if (l) t = txt(l.textContent); }
    if (!t) t = txt(el.getAttribute('placeholder')) || txt(el.title);
    if (!t) {
      let p = el.parentElement;
      for (let i = 0; i < 4 && p && !t; i++, p = p.parentElement) {
        const c = txt(p.innerText || p.textContent);
        if (c && c.length < 200) t = c;
      }
    }
    return (t || el.name || el.id || '').slice(0, 200);
  }
  function groupOf(el) {
    const g = el.closest('fieldset,[role=radiogroup],[role=group]');
    if (!g) return '';
    const lg = g.querySelector('legend');
    return txt(lg ? lg.textContent : g.getAttribute('aria-label') || textOfIds(g, 'aria-labelledby')).slice(0, 200);
  }
  function sectionOf(el, hs) {
    let best = '';
    for (const h of hs) { if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = txt(h.textContent); else break; }
    return best.slice(0, 100);
  }
  const isReq = (el, label) => el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$|\(required\)/i.test(label);

  // ---------- scanning ----------
  const NAV_LINK = /next|continue|add|save|apply|start|begin|upload|back|skip|review/i;

  function scan(m) {
    if (m.guard) guard = true;
    const headings = collect(document, 'h1,h2,h3,h4,legend').filter(visible);
    const fields = [], seenRadio = new Set();
    const els = collect(document, 'input,textarea,select,[contenteditable],[role=combobox],[role=textbox],button[aria-haspopup=listbox],button[aria-haspopup=menu]');
    for (const el of els) {
      if (el.closest('[data-aff-panel]')) continue;
      const tag = el.tagName, type = (el.type || '').toLowerCase(), role = el.getAttribute('role');
      if (tag === 'INPUT' && ['hidden', 'submit', 'button', 'reset', 'image', 'password'].includes(type)) continue;
      if (el.disabled) continue;
      if (!['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(tag)) {
        if (el.hasAttribute('contenteditable') && !el.isContentEditable) continue;
        if (el.querySelector('input,textarea,select')) continue;
        if (!(el.isContentEditable || role === 'combobox' || role === 'textbox')) continue;
      }
      const choice = ['radio', 'checkbox', 'file'].includes(type);
      if (!(visible(el) || (choice && visible(el.closest('label') || el.parentElement || el)))) continue;

      let kind;
      if (tag === 'SELECT') kind = 'select';
      else if (tag === 'TEXTAREA') kind = 'textarea';
      else if (type === 'radio') kind = 'radio';
      else if (type === 'checkbox') kind = 'checkbox';
      else if (type === 'file') kind = 'file';
      else if (tag !== 'INPUT' && el.isContentEditable) kind = 'richtext';
      else if (role === 'combobox' || el.getAttribute('aria-autocomplete') || el.getAttribute('aria-haspopup') === 'listbox') kind = tag === 'INPUT' ? 'combobox' : 'dropdown';
      else if (tag === 'BUTTON') kind = 'dropdown';
      else if (tag === 'INPUT') kind = ['date', 'datetime-local', 'month', 'time', 'number', 'email', 'tel', 'url'].includes(type) ? type : 'text';
      else kind = 'richtext';

      const id = idFor(el);
      const label = labelOf(el);
      const f = { id, kind, label, group: groupOf(el), section: sectionOf(el, headings), required: isReq(el, label) };

      if (kind === 'select') {
        f.options = [...el.options].map((o) => txt(o.textContent)).filter(Boolean).slice(0, 150);
        f.value = el.value ? txt(el.selectedOptions[0]?.textContent) : '';
        f.filled = !!el.value;
      } else if (kind === 'radio') {
        const key = (el.form ? el.form.id || 'form' : '') + '|' + (el.name || id);
        if (seenRadio.has(key)) continue;
        seenRadio.add(key);
        const peers = el.name ? collect(el.getRootNode(), `input[type=radio][name="${CSS.escape(el.name)}"]`) : [el];
        f.options = peers.map((p) => ({ id: idFor(p), label: labelOf(p) || p.value }));
        f.filled = peers.some((p) => p.checked);
        f.value = f.filled ? f.options[peers.findIndex((p) => p.checked)].label : '';
        f.label = f.group || `Choice: ${f.options.map((o) => o.label).join(' / ')}`.slice(0, 200);
      } else if (kind === 'checkbox') {
        f.value = el.checked; f.filled = el.checked;
      } else if (kind === 'file') {
        f.accept = el.accept || ''; f.multiple = el.multiple; f.filled = !!(el.files && el.files.length);
      } else if (kind === 'dropdown') {
        const t = txt(el.innerText || el.value);
        f.value = t.slice(0, 80);
        f.filled = !!t && t.length < 80 && !/^(select|choose|please|--)/i.test(t) && norm(t) !== norm(label);
      } else if (kind === 'richtext') {
        f.value = txt(el.innerText).slice(0, 200); f.filled = !!f.value;
      } else {
        f.value = (el.value || '').slice(0, 200); f.filled = !!el.value;
        if (el.placeholder) f.placeholder = el.placeholder;
        if (el.maxLength > 0 && el.maxLength < 100000) f.maxlength = el.maxLength;
        if (el.pattern) f.pattern = el.pattern;
      }
      meta.set(id, f);
      fields.push(f);
    }

    const buttons = [];
    for (const el of collect(document, 'button,input[type=submit],input[type=button],[role=button],a[href]')) {
      if (buttons.length >= 40) break;
      if (el.closest('[data-aff-panel]') || !visible(el)) continue;
      if (el.getAttribute('aria-haspopup') === 'listbox' || el.disabled) continue;
      const text = txt(el.innerText || el.value || el.getAttribute('aria-label') || el.title);
      if (!text || text.length > 60) continue;
      if (el.tagName === 'A' && !NAV_LINK.test(text)) continue;
      buttons.push({ id: idFor(el), text, tag: el.tagName.toLowerCase(), type: el.type || '', inForm: !!el.form });
    }

    const top = window === window.top;
    return {
      frameUrl: location.href, top, fields, buttons,
      page: top ? {
        url: location.href, title: document.title,
        headings: headings.slice(0, 12).map((h) => txt(h.textContent).slice(0, 100)),
        text: (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, 9000),
      } : { url: location.href },
    };
  }

  // compact DOM outline, for when generic scanning finds nothing and the model must work from raw structure
  function skeleton() {
    let out = '';
    const KEEP = ['id', 'class', 'name', 'type', 'role', 'aria-label', 'placeholder', 'for', 'href', 'data-testid'];
    const SKIP = new Set(['script', 'style', 'svg', 'noscript', 'path', 'head', 'link', 'meta', 'img', 'picture']);
    (function walk(n, d) {
      if (out.length > 14000 || d > 28) return;
      if (n.nodeType === 3) { const t = txt(n.textContent); if (t) out += t.slice(0, 80) + ' '; return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName.toLowerCase();
      if (SKIP.has(tag) || el_hidden(n) || n.closest('[data-aff-panel]')) return;
      const at = KEEP.map((k) => (n.hasAttribute(k) ? ` ${k}="${n.getAttribute(k).slice(0, 60)}"` : '')).join('');
      out += `<${tag}${at}>`;
      if (n.shadowRoot) n.shadowRoot.childNodes.forEach((c) => walk(c, d + 1));
      n.childNodes.forEach((c) => walk(c, d + 1));
    })(document.body, 0);
    return out;
  }
  const el_hidden = (n) => { const cs = getComputedStyle(n); return cs.display === 'none' || cs.visibility === 'hidden'; };

  // ---------- acting ----------
  const resolve = (a) => {
    if (a.id && reg.has(a.id)) return reg.get(a.id);
    if (a.selector) { try { return collect(document, a.selector)[0] || null; } catch { return null; } }
    return null;
  };
  function realClick(el) {
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const C = t.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
      el.dispatchEvent(new C(t, { bubbles: true, cancelable: true, composed: true }));
    }
  }
  function setText(el, v) {
    el.focus();
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, v); else el.value = v;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: v }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }
  function findOpt(v) {
    const cands = collect(document, '[role=option],[role=menuitem],ul[role=listbox] li,[class*=option],[class*=Option],li[id*=option]').filter(visible);
    let best = null, bs = 0, bl = 1e9;
    for (const c of cands) {
      const t = txt(c.textContent), s = score(t, v);
      if (s > bs || (s === bs && s > 0 && t.length < bl)) { bs = s; best = c; bl = t.length; }
    }
    return bs >= 40 ? best : null;
  }
  const visibleOptions = () => collect(document, '[role=option],[role=menuitem]').filter(visible).map((o) => txt(o.textContent)).slice(0, 30);

  function setChecked(el, want) {
    if (el.checked !== want) el.click();
    if (el.checked !== want) {
      const l = el.closest('label') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
      if (l) l.click();
    }
    return { ok: el.checked === want, note: el.checked === want ? '' : 'could not toggle' };
  }

  async function fill(el, f, a) {
    const v = String(a.value ?? '');
    switch (f.kind) {
      case 'select': {
        const opts = [...el.options];
        const best = bestBy(opts, (o) => [txt(o.textContent), o.value], v);
        if (!best) return { ok: false, error: `no matching option for "${v}"`, optionsSeen: opts.map((o) => txt(o.textContent)).slice(0, 40) };
        el.selectedIndex = opts.indexOf(best);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: txt(best.textContent) };
      }
      case 'radio': {
        const best = bestBy(f.options, (o) => o.label, v);
        if (!best) return { ok: false, error: `no matching choice for "${v}"`, optionsSeen: f.options.map((o) => o.label) };
        const r = setChecked(reg.get(best.id), true);
        return { ...r, value: best.label };
      }
      case 'checkbox': return setChecked(el, !/^(false|no|0)$/i.test(v));
      case 'file': return { ok: false, error: 'file inputs need the upload action' };
      case 'combobox': {
        el.focus(); realClick(el);
        setText(el, v); el.focus();
        await sleep(700);
        let opt = findOpt(v);
        if (!opt) { setText(el, v.split(/[ ,(]/)[0]); el.focus(); await sleep(700); opt = findOpt(v); }
        if (opt) { realClick(opt); await sleep(200); return { ok: true, value: txt(opt.textContent) }; }
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return { ok: !!el.value, error: el.value ? undefined : 'no option list appeared', note: 'typed text, no option list found', optionsSeen: visibleOptions() };
      }
      case 'dropdown': {
        realClick(el); await sleep(600);
        const opt = findOpt(v);
        if (opt) { realClick(opt); await sleep(200); return { ok: true, value: txt(opt.textContent) }; }
        const seen = visibleOptions();
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return { ok: false, error: `option "${v}" not found in dropdown`, optionsSeen: seen };
      }
      case 'richtext': {
        el.focus();
        document.execCommand('selectAll', false);
        if (!document.execCommand('insertText', false, v)) { el.textContent = v; el.dispatchEvent(new InputEvent('input', { bubbles: true })); }
        return { ok: !!txt(el.innerText) };
      }
      default: {
        setText(el, v);
        const got = el.value || '';
        if (!got) return { ok: false, error: 'value did not stick (page cleared it?)' };
        return { ok: true, note: norm(got) === norm(v) ? '' : `page reformatted to "${got.slice(0, 40)}"` };
      }
    }
  }

  function upload(el, a) {
    if (!a.b64) return { ok: false, error: 'no file data' };
    const bytes = Uint8Array.from(atob(a.b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], a.filename || 'file', { type: a.mime || 'application/octet-stream' });
    const dt = new DataTransfer();
    dt.items.add(file);
    el.files = dt.files;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: !!(el.files && el.files.length), value: file.name };
  }

  // ---------- the "never submit" guard ----------
  const NAVOK = /^(next|continue|save (&|and) (continue|next)|proceed|go to next|next step|continue to)/i;
  const DANGER = /\b(submit|send (my )?application|place (your )?order|pay( now)?|confirm (and )?(pay|order|booking|purchase)|complete (order|purchase|application|registration|booking)|finish|purchase|buy now|book now|donate)\b/i;
  function dangerous(el, label) {
    if (NAVOK.test(label)) return false;
    if (DANGER.test(label)) return true;
    if ((el.type || '').toLowerCase() === 'submit' && el.form) {
      const n = [...el.form.elements].filter((e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName) && !['hidden', 'submit', 'button'].includes(e.type)).length;
      if (n >= 3) return true;
    }
    return false;
  }
  // backstop: any submit event we did not explicitly allow is cancelled while a run is active
  window.addEventListener('submit', (e) => {
    if (guard && Date.now() > allowSubmitUntil) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);

  function doClick(el) {
    const label = txt(el.innerText || el.value || el.getAttribute('aria-label') || '');
    if (dangerous(el, label)) return { ok: false, blocked: true, clickedLabel: label, error: `Blocked, looks like a final submit: "${label}"` };
    allowSubmitUntil = Date.now() + 2500;
    el.click();
    return { ok: true, clickedLabel: label };
  }

  async function act(a) {
    const el = resolve(a);
    if (!el) return { id: a.id, ok: false, error: 'element not found (stale id or bad selector)' };
    const f = meta.get(a.id) || { kind: el.tagName === 'SELECT' ? 'select' : el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : 'text' };
    const label = f.label || txt(el.innerText || el.value || el.getAttribute('aria-label')) || a.selector;
    try {
      el.scrollIntoView({ block: 'center' });
      let r;
      if (a.do === 'click') r = doClick(el);
      else if (a.do === 'press') { el.focus(); for (const t of ['keydown', 'keyup']) el.dispatchEvent(new KeyboardEvent(t, { key: a.value || 'Enter', bubbles: true })); r = { ok: true }; }
      else if (a.do === 'check') r = setChecked(el, a.value !== false && !/^(false|no|0)$/i.test(String(a.value)));
      else if (a.do === 'upload') r = upload(el, a);
      else if (a.do === 'fill') r = await fill(el, f, a);
      else r = { ok: false, error: 'unknown action ' + a.do };
      return { id: a.id, label, kind: f.kind, ...r };
    } catch (e) {
      return { id: a.id, label, ok: false, error: String(e.message || e) };
    }
  }

  function inspect(a) {
    const el = resolve(a);
    if (!el) return null;
    let c = el;
    for (let i = 0; i < 3 && c.parentElement; i++) c = c.parentElement;
    return c.outerHTML.replace(/\s+/g, ' ').replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>').replace(/ style="[^"]*"/g, '').slice(0, 1800);
  }

  // ---------- on-page panel (top frame only) ----------
  let panel = null;
  function ensurePanel() {
    if (panel || window !== window.top) return panel;
    const host = document.createElement('div');
    host.setAttribute('data-aff-panel', '');
    host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647';
    const root = host.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent = `.p{font:13px/1.4 system-ui,sans-serif;width:360px;max-height:70vh;overflow:auto;background:#111827;color:#f9fafb;border-radius:10px;padding:12px 14px;box-shadow:0 8px 30px rgba(0,0,0,.4)}
      h4{margin:0 0 6px;font-size:13px;display:flex;justify-content:space-between}h5{margin:10px 0 4px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:.04em}
      .x{cursor:pointer;color:#9ca3af}.l{color:#d1d5db;font-size:12px;margin:2px 0}.i{margin:3px 0;padding:5px 7px;border-radius:6px;background:#1f2937}
      .n{background:#78350f;cursor:pointer}.f{background:#7f1d1d}.b{background:#4c1d95}.k{color:#9ca3af}.s{margin-top:8px;color:#e5e7eb}`;
    const wrap = document.createElement('div'); wrap.className = 'p';
    const h = document.createElement('h4');
    const title = document.createElement('span'); title.textContent = 'AutoFill Agent';
    const x = document.createElement('span'); x.className = 'x'; x.textContent = '✕'; x.onclick = () => { host.remove(); panel = null; };
    h.append(title, x);
    const log = document.createElement('div'), body = document.createElement('div');
    wrap.append(h, log, body);
    root.append(st, wrap);
    document.documentElement.appendChild(host);
    panel = { host, log, body };
    return panel;
  }
  const mk = (cls, text, onclick) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; if (onclick) d.onclick = onclick; return d; };
  function showPanel(m) {
    const p = ensurePanel();
    if (!p) return;
    if (m.status) { p.log.textContent = ''; p.log.appendChild(mk('l', m.status)); }
    if (m.error) { p.log.textContent = ''; p.body.append(mk('i f', m.error)); }
    if (m.report) {
      const r = m.report;
      p.log.textContent = ''; p.body.textContent = '';
      const sec = (t) => p.body.appendChild(mk('', '')) && p.body.appendChild(Object.assign(document.createElement('h5'), { textContent: t }));
      if (r.summary) p.body.append(mk('s', r.summary));
      if (r.needsUser.length) {
        sec(`Needs your input (${r.needsUser.length})`);
        r.needsUser.forEach((n) => p.body.append(mk('i n', `${n.label}: ${n.question}`, () => browser.runtime.sendMessage({ cmd: 'focusField', id: n.id }))));
      }
      if (r.failed.length) { sec(`Could not fill (${r.failed.length})`); r.failed.forEach((n) => p.body.append(mk('i f', `${n.label}: ${n.error}`))); }
      if (r.blocked.length) { sec('Stopped before'); r.blocked.forEach((n) => p.body.append(mk('i b', `"${n}": you take it from here.`))); }
      if (r.uploaded.length) { sec(`Uploaded (${r.uploaded.length})`); r.uploaded.forEach((n) => p.body.append(mk('i', `${n.label}: ${n.file}`))); }
      if (r.filled.length) { sec(`Filled (${r.filled.length})`); r.filled.forEach((n) => p.body.append(mk('i', `${n.label} → ${String(n.value).slice(0, 70)}`))); }
      if (r.clicked.length) { sec('Clicked'); r.clicked.forEach((n) => p.body.append(mk('l', n))); }
    }
  }

  // ---------- message bus ----------
  browser.runtime.onMessage.addListener((m) => {
    switch (m.cmd) {
      case 'ping': return Promise.resolve({ ok: true, top: window === window.top });
      case 'scan': return Promise.resolve(scan(m));
      case 'skeleton': return Promise.resolve(skeleton());
      case 'act': return act(m.action);
      case 'inspect': return Promise.resolve(inspect(m));
      case 'guard': guard = !!m.on; return Promise.resolve(true);
      case 'panel': showPanel(m); return Promise.resolve(true);
      case 'mark':
        (m.ids || []).forEach((id) => { const el = reg.get(id); if (el) { el.style.outline = '2px solid #f59e0b'; el.style.outlineOffset = '2px'; } });
        return Promise.resolve(true);
      case 'focus': {
        const el = reg.get(m.id);
        if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); }
        return Promise.resolve(true);
      }
    }
  });
})();
