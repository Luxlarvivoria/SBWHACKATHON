const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const dock = $('#dock');

function setDockActive(name) {
  $$('.dock-btn', dock).forEach((b) => b.classList.toggle('on', b.dataset.dock === name));
}

$('#dock-feed').addEventListener('click', () => {
  document.dispatchEvent(new CustomEvent('ui:exit-reading'));
  $('#results').scrollTo({ top: 0, behavior: 'smooth' });
  setDockActive('feed');
});

$('#dock-search').addEventListener('click', () => {
  document.dispatchEvent(new CustomEvent('ui:exit-reading'));
  setDockActive('search');
  const q = $('#q');
  q.focus();
  q.select();
});

$('#btn-library').addEventListener('click', () => setDockActive('library'));
$$('dialog').forEach((d) => d.addEventListener('close', () => setDockActive('feed')));

document.addEventListener('ui:home', () => setDockActive(''));

$('#q').addEventListener('focus', () => setDockActive('search'));
new MutationObserver(() => {
  if (document.body.classList.contains('reading')) setDockActive('feed');
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });

$$('dialog.sheet').forEach((dlg) => {
  dlg.addEventListener('click', (e) => {

    if (e.target === dlg) dlg.close();
  });

  const grip = $('.sheet-grip', dlg);
  if (!grip) return;
  let startY = null;
  const panel = $('.dialog-body', dlg);

  const down = (e) => { startY = (e.touches ? e.touches[0] : e).clientY; panel.style.transition = 'none'; };
  const move = (e) => {
    if (startY == null) return;
    const dy = Math.max(0, (e.touches ? e.touches[0] : e).clientY - startY);
    panel.style.transform = `translateY(${dy}px)`;
  };
  const up = () => {
    if (startY == null) return;
    const dy = parseFloat((panel.style.transform.match(/([\d.]+)px/) || [0, 0])[1]);
    panel.style.transition = '';
    panel.style.transform = '';
    startY = null;
    if (dy > 90) dlg.close();
  };

  grip.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

const RECENTS = 'consilium.recents';
const readRecents = () => { try { return JSON.parse(localStorage.getItem(RECENTS)) || []; } catch { return []; } };

function renderRecents() {
  const rail = $('#recents-rail');
  if (!rail) return;
  const items = readRecents();
  rail.innerHTML = items.length
    ? `<span class="rail-k">Recent</span>${items.map((q) =>
        `<button class="suggest" data-q="${q.replace(/"/g, '&quot;')}">${q.replace(/[<>&]/g, '')}</button>`).join('')}
       <button class="suggest ghost" data-clear="1">Clear</button>`
    : '';
  rail.classList.toggle('hidden', !items.length);
}

function pushRecent(q) {
  const items = [q, ...readRecents().filter((x) => x !== q)].slice(0, 5);
  try { localStorage.setItem(RECENTS, JSON.stringify(items)); } catch {  }
  renderRecents();
}

$('#search-form').addEventListener('submit', () => {
  const q = $('#q').value.trim();
  if (q) pushRecent(q);
});

$('#recents-rail')?.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.clear) { localStorage.removeItem(RECENTS); renderRecents(); return; }
  document.dispatchEvent(new CustomEvent('ui:search', { detail: btn.dataset.q }));
  pushRecent(btn.dataset.q);
});

renderRecents();

window.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.metaKey || e.ctrlKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
  e.preventDefault();
  $('#q').focus();
  $('#q').select();
});
