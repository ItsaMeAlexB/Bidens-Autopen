const $ = (id) => document.getElementById(id);
(async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const { docs = [] } = await browser.storage.local.get('docs');
  const { lastSel } = await browser.storage.local.get('lastSel');
  const box = $('docs');
  if (!docs.length) box.textContent = 'No documents yet. Add one in Settings.';
  docs.forEach((d) => {
    const l = document.createElement('label'); l.className = 'd';
    const c = document.createElement('input'); c.type = 'checkbox'; c.value = d.id;
    c.checked = lastSel ? lastSel.includes(d.id) : true;
    l.append(c, document.createTextNode(d.name));
    box.appendChild(l);
  });
  const setRunning = (r) => { $('go').disabled = r; $('stop').style.display = r ? 'inline-block' : 'none'; };
  const poll = async () => setRunning((await browser.runtime.sendMessage({ cmd: 'status', tabId: tab.id })).running);
  poll(); setInterval(poll, 1000);

  $('go').onclick = async () => {
    const sel = [...box.querySelectorAll('input:checked')].map((c) => c.value);
    await browser.storage.local.set({ lastSel: sel });
    const r = await browser.runtime.sendMessage({ cmd: 'run', tabId: tab.id, docIds: sel, instruction: $('instr').value.trim() });
    $('msg').textContent = r.error || 'Running. Watch the panel on the page.';
    if (!r.error) setTimeout(() => window.close(), 600);
  };
  $('stop').onclick = () => browser.runtime.sendMessage({ cmd: 'stop', tabId: tab.id });
  $('opts').onclick = () => browser.runtime.openOptionsPage();
})();
