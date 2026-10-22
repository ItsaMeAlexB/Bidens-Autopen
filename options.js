const $ = (id) => document.getElementById(id);
const DEF = { apiKey: '', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', baseUrl: 'https://api.deepinfra.com/v1/openai', profile: '', maxRounds: 8 };
let editId = null, pendingFile = null;

async function loadSettings() {
  const s = { ...DEF, ...((await browser.storage.local.get('settings')).settings || {}) };
  for (const k of Object.keys(DEF)) $(k).value = s[k];
}
$('saveSettings').onclick = async () => {
  const s = {};
  for (const k of Object.keys(DEF)) s[k] = k === 'maxRounds' ? Number($(k).value) || 8 : $(k).value.trim();
  await browser.storage.local.set({ settings: s });
  $('s1').textContent = 'Saved.';
};

async function renderDocs() {
  const { docs = [] } = await browser.storage.local.get('docs');
  const list = $('list'); list.textContent = '';
  if (!docs.length) list.textContent = 'No documents yet.';
  docs.forEach((d) => {
    const row = document.createElement('div'); row.className = 'doc';
    const t = document.createElement('span');
    t.textContent = `${d.name}  (${d.text ? d.text.length + ' chars' : 'no text'}${d.file ? ', file: ' + d.file.name : ''}${d.tailor ? ', tailored' : ''})`;
    const b = document.createElement('span');
    const e = document.createElement('button'); e.textContent = 'Edit';
    e.onclick = () => { editId = d.id; $('dname').value = d.name; $('dtext').value = d.text || ''; $('dtailor').checked = !!d.tailor; pendingFile = d.file || null; scrollTo(0, document.body.scrollHeight); };
    const x = document.createElement('button'); x.textContent = 'Delete';
    x.onclick = async () => { await browser.storage.local.set({ docs: docs.filter((z) => z.id !== d.id) }); renderDocs(); };
    b.append(e, ' ', x); row.append(t, b); list.appendChild(row);
  });
}

$('dfile').onchange = async () => {
  const f = $('dfile').files[0]; if (!f) return;
  const buf = await f.arrayBuffer();
  pendingFile = { name: f.name, mime: f.type || 'application/octet-stream', b64: DocGen.bytesToB64(new Uint8Array(buf)) };
  if (!$('dname').value) $('dname').value = f.name.replace(/\.[^.]+$/, '');
  try {
    if (/\.(txt|md|csv|json)$/i.test(f.name)) $('dtext').value = new TextDecoder().decode(buf);
    else if (/\.docx$/i.test(f.name)) $('dtext').value = await DocGen.docxToText(buf);
    else $('fhint').textContent = 'File stored. Please paste its text content above so the AI can read it.';
  } catch (e) { $('fhint').textContent = 'Could not extract text: ' + e.message; }
};
const clearForm = () => { editId = null; pendingFile = null; ['dname', 'dtext'].forEach((i) => ($(i).value = '')); $('dfile').value = ''; $('dtailor').checked = false; };
$('clearDoc').onclick = clearForm;
$('saveDoc').onclick = async () => {
  const name = $('dname').value.trim();
  if (!name) return alert('Give the document a name.');
  const { docs = [] } = await browser.storage.local.get('docs');
  const rec = { id: editId || crypto.randomUUID(), name, text: $('dtext').value, file: pendingFile, tailor: $('dtailor').checked };
  const i = docs.findIndex((d) => d.id === rec.id);
  if (i >= 0) docs[i] = rec; else docs.push(rec);
  await browser.storage.local.set({ docs });
  clearForm(); renderDocs();
};
loadSettings(); renderDocs();
