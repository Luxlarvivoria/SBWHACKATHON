// app.js — Consilium: search every publisher at once, read the paper in plain
// English, then see who backs it, who fights it, and who is talking about it.
import {
  $, $$, esc, settings, library, settle, toast, truncate, fmtNum, authorLine, keywords,
} from './util.js';
import {
  searchAll, enrich, citingWorks, siblingWorks, consensusWorks, referencedWorks, s2Contexts,
} from './sources.js';
import {
  plainLanguage, aiPlainLanguage, classifyStance, aiStances, studyDesign, sampleSize,
  numericFindings, caveats, takeaways, evidenceStrength, renderSimplified,
} from './analyze.js';
import { findVoices, findCommentary, topicLinks } from './voices.js';

const state = {
  query: '',
  papers: [],
  current: null,
  token: 0,        // guards against out-of-order async renders
  loaded: {},      // which detail panels have been filled for the current paper
};

/* ================================================================== *
 * Search
 * ================================================================== */
function readOptions() {
  return {
    from: $('#f-from').value.trim(),
    to: $('#f-to').value.trim(),
    sort: $('#f-sort').value,
    oaOnly: $('#f-oa').checked,
    includeReviews: $('#f-reviews').checked,
  };
}

async function runSearch(q) {
  if (!q.trim()) return;
  state.query = q.trim();
  $('#q').value = state.query;
  const myToken = ++state.token;

  // A new search invalidates whatever paper was open.
  state.current = null;
  $('#detail').classList.add('hidden');
  $('#detail').innerHTML = '';
  $('#detail-placeholder').classList.remove('hidden');
  history.replaceState(null, '', `#q=${encodeURIComponent(state.query)}`);

  $('#results-title').textContent = 'Searching…';
  $('#results-meta').textContent = '';
  $('#results').innerHTML = skeletons(6);
  $('#source-status').innerHTML = '<span class="spinner"></span>';

  let res;
  try {
    res = await searchAll(state.query, readOptions());
  } catch (err) {
    if (myToken !== state.token) return;
    $('#results').innerHTML = `<div class="empty-state"><p>Search failed: ${esc(err.message)}</p>
      <p class="muted">These are public APIs with no key required — a browser extension blocking requests, or a dropped connection, is the usual cause.</p></div>`;
    $('#source-status').textContent = '';
    return;
  }
  if (myToken !== state.token) return;

  state.papers = res.papers;
  $('#source-status').innerHTML = Object.entries(res.status)
    .map(([k, v]) => `${esc(k)} <span class="${v === 'fail' ? 'bad' : 'ok'}">${v === 'fail' ? '×' : v}</span>`)
    .join(' · ');

  if (!res.papers.length) {
    $('#results-title').textContent = 'Nothing found';
    $('#results').innerHTML = `<div class="empty-state"><p>No papers matched <strong>${esc(state.query)}</strong>.</p>
      <p>Try fewer words, or drop the date filters.</p></div>`;
    return;
  }

  $('#results-title').textContent = 'Results';
  $('#results-meta').textContent = `${res.papers.length} papers`;
  $('#results').innerHTML = res.papers.map(cardHTML).join('');
  $$('#results .card').forEach((el) => {
    el.addEventListener('click', () => openPaper(state.papers.find((p) => p.id === el.dataset.id)));
  });
}

const skeletons = (n) => Array.from({ length: n }, () =>
  `<div class="skel"><div class="skel-line" style="width:92%"></div>
   <div class="skel-line" style="width:70%"></div><div class="skel-line" style="width:45%"></div></div>`).join('');

function cardHTML(p) {
  const design = studyDesign(p);
  return `<article class="card" data-id="${esc(p.id)}">
    <h3 class="card-title">${esc(p.title)}</h3>
    <div class="card-authors">${esc(authorLine(p.authors, 3))}</div>
    <div class="card-meta">
      <span>${p.year || 'n.d.'}</span>
      ${p.venue ? `<span>${esc(truncate(p.venue, 42))}</span>` : ''}
      <span class="cites">${fmtNum(p.cites)} cites</span>
      ${design.weight >= 85 ? `<span class="badge type">${esc(design.label.split(' /')[0])}</span>` : ''}
      ${p.isPreprint ? '<span class="badge pre">preprint</span>' : ''}
      ${p.isRetracted ? '<span class="badge pre">retracted</span>' : ''}
      ${p.oa?.isOA ? '<span class="badge oa">open</span>' : ''}
      <span class="badge">${esc(p.sources.join(' + '))}</span>
    </div>
  </article>`;
}

/* ================================================================== *
 * Paper detail
 * ================================================================== */
async function openPaper(paper) {
  if (!paper) return;
  state.current = paper;
  state.loaded = {};
  const myToken = ++state.token;

  $$('#results .card').forEach((el) => el.classList.toggle('active', el.dataset.id === paper.id));
  $('#detail-placeholder').classList.add('hidden');
  const detail = $('#detail');
  detail.classList.remove('hidden');
  detail.innerHTML = `<div class="loading-row"><span class="spinner"></span> Pulling the full record…</div>`;
  $('#detail-pane').scrollTop = 0;

  await enrich(paper);
  if (myToken !== state.token) return;

  detail.innerHTML = detailShell(paper);
  wireDetail(paper);
  fillReadPanel(paper, myToken);
}

function detailShell(p) {
  const saved = library.has(p.id);
  return `
  <h1>${esc(p.title)}</h1>
  <div class="detail-authors">${esc(authorLine(p.authors, 8))}</div>
  <div class="detail-meta">
    <span class="muted">${p.year || 'n.d.'}</span>
    ${p.venue ? `<span class="badge">${esc(truncate(p.venue, 60))}</span>` : ''}
    ${p.publisher ? `<span class="badge">${esc(truncate(p.publisher, 34))}</span>` : ''}
    <span class="badge">${fmtNum(p.cites)} citations</span>
    ${p.oa?.isOA ? '<span class="badge oa">open access</span>' : ''}
    ${p.isPreprint ? '<span class="badge pre">preprint</span>' : ''}
    ${p.isRetracted ? '<span class="badge pre">RETRACTED</span>' : ''}
    <span class="badge">indexed by ${esc(p.sources.join(' + '))}</span>
  </div>
  <div class="detail-actions">
    ${p.url ? `<a class="ghost-btn" href="${esc(p.url)}" target="_blank" rel="noopener">Publisher page ↗</a>` : ''}
    ${p.oa?.url ? `<a class="ghost-btn" href="${esc(p.oa.url)}" target="_blank" rel="noopener">Free full text ↗</a>` : ''}
    ${p.pmid ? `<a class="ghost-btn" href="https://pubmed.ncbi.nlm.nih.gov/${esc(p.pmid)}/" target="_blank" rel="noopener">PubMed ↗</a>` : ''}
    <button class="ghost-btn" id="btn-save">${saved ? '★ Saved' : '☆ Save'}</button>
    <button class="ghost-btn" id="btn-cite">Copy citation</button>
    ${settings.get().apiKey ? '<button class="ghost-btn" id="btn-ai">✨ Rewrite with Claude</button>' : ''}
  </div>

  <nav class="tabs">
    <button class="tab on" data-tab="read">Plain read</button>
    <button class="tab" data-tab="evidence">Supports &amp; challenges <span class="pill" id="evi-count">…</span></button>
    <button class="tab" data-tab="voices">Scientists talking</button>
    <button class="tab" data-tab="roots">What it builds on</button>
  </nav>

  <section class="panel on" id="panel-read"></section>
  <section class="panel" id="panel-evidence"></section>
  <section class="panel" id="panel-voices"></section>
  <section class="panel" id="panel-roots"></section>`;
}

function wireDetail(paper) {
  $$('#detail .tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('#detail .tab').forEach((t) => t.classList.toggle('on', t === tab));
      $$('#detail .panel').forEach((p) => p.classList.toggle('on', p.id === `panel-${tab.dataset.tab}`));
      const name = tab.dataset.tab;
      if (name === 'voices' && !state.loaded.voices) fillVoicesPanel(paper, state.token);
      if (name === 'roots' && !state.loaded.roots) fillRootsPanel(paper, state.token);
    });
  });

  $('#btn-save')?.addEventListener('click', (e) => {
    const added = library.toggle(paper);
    e.target.textContent = added ? '★ Saved' : '☆ Save';
    updateLibraryCount();
    toast(added ? 'Saved to your library' : 'Removed from library');
  });

  $('#btn-cite')?.addEventListener('click', async () => {
    await navigator.clipboard.writeText(citation(paper));
    toast('Citation copied');
  });

  $('#btn-ai')?.addEventListener('click', async (e) => {
    const btn = e.target;
    btn.disabled = true; btn.textContent = 'Rewriting…';
    try {
      const ai = await aiPlainLanguage(paper, settings.get().apiKey);
      renderPlain(ai, paper);
      toast('Rewritten by Claude');
    } catch (err) {
      toast(`Claude call failed: ${truncate(err.message, 70)}`, 5000);
    } finally {
      btn.disabled = false; btn.textContent = '✨ Rewrite with Claude';
    }
  });
}

function citation(p) {
  const first = (p.authors[0]?.name || 'Unknown').split(' ').pop();
  const key = `${first.toLowerCase()}${p.year || ''}`;
  return `@article{${key},
  title   = {${p.title}},
  author  = {${p.authors.map((a) => a.name).join(' and ')}},
  journal = {${p.venue || ''}},
  year    = {${p.year || ''}},
  doi     = {${p.doi || ''}},
  url     = {${p.url || ''}}
}`;
}

/* ---------------------- panel: plain read ---------------------- */
function fillReadPanel(paper, token) {
  if (token !== state.token) return;
  renderPlain(plainLanguage(paper), paper);
  // The evidence panel drives the strength meter, so start it immediately.
  fillEvidencePanel(paper, token);
}

function renderPlain(pl, paper) {
  const design = studyDesign(paper);
  const n = sampleSize(paper);
  const tips = takeaways(paper);
  const cav = caveats(paper);
  const nums = numericFindings(paper);

  const modeNote = pl.mode === 'ai'
    ? 'Rewritten by Claude from the published abstract.'
    : pl.mode === 'title-only'
      ? 'No abstract available.'
      : 'Rewritten automatically from the abstract — hover any underlined phrase to see the original wording.';

  $('#panel-read').innerHTML = `
    ${tips.length ? `<div class="section-title">The claim in one breath</div>
      <ul class="takeaways">${tips.map((t) => `<li>${renderSimplified(t)}</li>`).join('')}</ul>` : ''}

    <div class="section-title">Plain-language read</div>
    <div class="plain">
      ${pl.sections.map((s) => `<p><strong>${esc(s.title)}.</strong></p>${s.html}`).join('')}
    </div>
    <p class="muted" style="margin-top:8px">${esc(modeNote)}</p>

    <div class="section-title">How much weight it deserves</div>
    <div id="strength-slot">
      <div class="loading-row"><span class="spinner"></span> weighing the later literature…</div>
    </div>

    <div class="section-title">Key facts</div>
    <div class="fact-grid">
      <div class="fact"><div class="fact-k">Study design</div><div class="fact-v">${esc(design.label)}<small>${esc(design.note)}</small></div></div>
      <div class="fact"><div class="fact-k">Sample size</div><div class="fact-v">${n != null ? esc(n.toLocaleString()) : 'not stated'}<small>${n != null ? 'largest number found in the abstract' : 'no sample size in the abstract'}</small></div></div>
      <div class="fact"><div class="fact-k">Published</div><div class="fact-v">${paper.year || 'n.d.'}<small>${esc(truncate(paper.venue || 'venue unknown', 40))}</small></div></div>
      <div class="fact"><div class="fact-k">Citations</div><div class="fact-v">${fmtNum(paper.cites)}<small>${paper.refCount != null ? `cites ${paper.refCount} works itself` : 'per OpenAlex'}</small></div></div>
    </div>

    ${nums.length ? `<div class="section-title">The numbers it rests on</div>
      <ul class="takeaways">${nums.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}

    ${cav.length ? `<div class="section-title">Read this with caution</div>
      <ul class="takeaways caveats">${cav.map((c) => `<li>${renderSimplified(c)}</li>`).join('')}</ul>` : ''}

    ${pl.stats.length ? `<div class="section-title">Statistics pulled out of the prose</div>
      <div class="note">${pl.stats.map((s) => esc(s)).join(' &nbsp;·&nbsp; ')}</div>` : ''}

    ${paper.abstract ? `<div class="section-title">Original abstract</div>
      <div class="abstract-raw">${esc(paper.abstract)}</div>` : ''}`;
}

function renderStrength(paper, counts) {
  const slot = $('#strength-slot');
  if (!slot) return;
  const s = evidenceStrength(paper, counts);
  const color = s.score >= 70 ? 'var(--support)' : s.score >= 45 ? 'var(--neutral)' : 'var(--against)';
  slot.innerHTML = `
    <div class="strength">
      <span class="strength-label"><strong>${esc(s.label)}</strong> evidence</span>
      <span class="strength-bar"><span class="strength-fill" style="width:${s.score}%;background:${color}"></span></span>
      <span class="strength-label">${s.score}/100</span>
    </div>
    <ul class="takeaways" style="margin-top:12px">${s.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`;
}

/* ---------------------- panel: evidence ---------------------- */
async function fillEvidencePanel(paper, token) {
  state.loaded.evidence = true;
  const panel = $('#panel-evidence');
  panel.innerHTML = `<div class="loading-row"><span class="spinner"></span> Reading what came after this paper…</div>`;

  const topic = state.query || keywords(paper.title, 8).join(' ');
  const useS2 = settings.get().useS2 && !!paper.doi;

  const [cit, sib, cons, s2] = await settle([
    citingWorks(paper, 40),
    siblingWorks(paper, topic, 30),
    consensusWorks(topic, 10),
    useS2 ? s2Contexts(paper, 50) : Promise.resolve([]),
  ]);
  if (token !== state.token) return;

  // Build one candidate pool: {paper, contexts, origin}
  const pool = new Map();
  const add = (p, origin, contexts = []) => {
    if (!p || !p.title) return;
    if (p.id === paper.id || (paper.doi && p.doi === paper.doi)) return;
    const key = p.doi ? `d:${p.doi}` : `t:${p.title.toLowerCase().slice(0, 60)}`;
    const cur = pool.get(key);
    if (cur) {
      cur.origins.add(origin);
      if (contexts.length) cur.contexts.push(...contexts);
      if ((p.abstract || '').length > (cur.paper.abstract || '').length) cur.paper.abstract = p.abstract;
      return;
    }
    pool.set(key, { paper: p, origins: new Set([origin]), contexts: [...contexts] });
  };

  (cit.ok ? cit.value : []).forEach((p) => add(p, 'cites-this'));
  (cons.ok ? cons.value : []).forEach((p) => add(p, 'review'));
  (sib.ok ? sib.value : []).forEach((p) => add(p, 'same-question'));
  (s2.ok ? s2.value : []).forEach((c) => add(c.paper, 'cites-this', c.contexts));

  let items = [...pool.values()];
  // Papers that quote this one, and heavily cited ones, get judged first.
  items.sort((a, b) => (b.contexts.length - a.contexts.length)
    || ((b.paper.cites || 0) - (a.paper.cites || 0)));
  items = items.slice(0, 60);

  // Heuristic pass over everything…
  for (const it of items) {
    const verdict = classifyStance(it.paper, paper, it.contexts[0] || '');
    Object.assign(it, verdict, { by: 'rules' });
  }
  // …then let Claude re-judge the most important ones, if a key is set.
  const key = settings.get().apiKey;
  if (key) {
    try {
      const head = items.slice(0, 24);
      const map = await aiStances(paper, head, key);
      head.forEach((it, i) => { if (map[i]) Object.assign(it, map[i], { by: 'claude', quote: it.quote }); });
    } catch { /* keep the rule-based verdicts */ }
  }
  if (token !== state.token) return;

  const supports = items.filter((i) => i.stance === 's').sort((a, b) => b.conf - a.conf);
  const against = items.filter((i) => i.stance === 'a').sort((a, b) => b.conf - a.conf);
  const neutral = items.filter((i) => i.stance === 'n')
    .sort((a, b) => (b.paper.cites || 0) - (a.paper.cites || 0)).slice(0, 10);

  $('#evi-count').textContent = `${supports.length}/${against.length}`;
  renderStrength(paper, { supporting: supports.length, challenging: against.length });

  const total = supports.length + against.length + neutral.length || 1;
  const pct = (n) => (n / total) * 100;

  const failures = [cit, sib, cons].filter((r) => !r.ok).length;

  panel.innerHTML = `
    <div class="section-title">Where the field landed</div>
    <div class="strength">
      <span class="strength-bar" style="height:12px">
        <span style="display:flex;height:100%">
          <span style="width:${pct(supports.length)}%;background:var(--support)"></span>
          <span style="width:${pct(neutral.length)}%;background:var(--neutral)"></span>
          <span style="width:${pct(against.length)}%;background:var(--against)"></span>
        </span>
      </span>
    </div>
    <div class="evi-legend" style="margin-top:10px">
      <span><span class="dot s"></span>${supports.length} back it up</span>
      <span><span class="dot n"></span>${neutral.length} same question, no verdict</span>
      <span><span class="dot a"></span>${against.length} push back</span>
    </div>
    <div class="note">Stance is judged from ${useS2 ? 'the actual sentences later papers used to cite this one, plus their ' : ''}titles and abstracts${key ? ', reviewed by Claude' : ' using cue phrases'}. It is a reading aid, not a verdict — open anything that matters and check it yourself.${failures ? ' Some sources did not respond, so this is a partial picture.' : ''}</div>

    ${section('Papers that push back', against, 'a', 'Nothing in the pool openly contradicts this paper. That can mean it holds up — or that nobody has tried to check it.')}
    ${section('Papers that back it up', supports, 's', 'No later paper explicitly confirms this one yet.')}
    ${section('Same question, no explicit verdict', neutral, 'n', '')}`;
}

function section(title, items, cls, emptyNote) {
  if (!items.length) return emptyNote ? `<div class="section-title">${esc(title)}</div><div class="note">${esc(emptyNote)}</div>` : '';
  return `<div class="section-title">${esc(title)} <span class="pill">${items.length}</span></div>`
    + items.map((it) => eviHTML(it, cls)).join('');
}

function eviHTML(it, cls) {
  const p = it.paper;
  const tag = { s: 'supports', a: 'challenges', n: 'related' }[cls];
  const design = it.design || studyDesign(p);
  return `<article class="evi-item ${cls}">
    <div class="evi-head">
      <span class="stance-tag ${cls}">${tag}</span>
      <span class="evi-title">${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>` : esc(p.title)}</span>
    </div>
    <div class="evi-meta">
      <span>${p.year || 'n.d.'}</span>
      ${p.venue ? `<span>${esc(truncate(p.venue, 40))}</span>` : ''}
      <span class="cites">${fmtNum(p.cites)} cites</span>
      <span class="badge">${esc(design.label.split(' /')[0])}</span>
      ${[...(it.origins || [])].includes('cites-this') ? '<span class="badge">cites this paper</span>' : ''}
      ${it.by === 'claude' ? '<span class="badge type">Claude</span>' : ''}
      <span class="muted">confidence ${Math.round((it.conf || 0) * 100)}%</span>
    </div>
    ${it.why ? `<div class="evi-why">${esc(it.why)}${it.quote ? `<br><span class="muted">“${it.quote}”</span>` : ''}</div>` : ''}
  </article>`;
}

/* ---------------------- panel: voices ---------------------- */
async function fillVoicesPanel(paper, token) {
  state.loaded.voices = true;
  const panel = $('#panel-voices');
  panel.innerHTML = `<div class="loading-row"><span class="spinner"></span> Finding who works on this and where they speak…</div>`;

  const topic = state.query || keywords(paper.title, 6).join(' ');
  const [voicesRes, commentaryRes] = await settle([findVoices(topic), findCommentary(topic)]);
  if (token !== state.token) return;

  const voices = voicesRes.ok ? voicesRes.value : [];
  const commentary = commentaryRes.ok ? commentaryRes.value : [];
  const interviews = commentary.filter((c) => c.isInterview);
  const other = commentary.filter((c) => !c.isInterview).slice(0, 10);

  panel.innerHTML = `
    <div class="section-title">Hear the topic discussed</div>
    <div class="link-row">${topicLinks(topic).map(linkChip).join('')}</div>
    <p class="muted" style="margin-top:8px">These open searches in the places interviews actually live — we cannot index YouTube or podcasts from the browser, but we can take you straight to them.</p>

    ${interviews.length ? `<div class="section-title">Published interviews <span class="pill">${interviews.length}</span></div>
      ${interviews.map(commentaryHTML).join('')}` : ''}

    <div class="section-title">The people doing this work <span class="pill">${voices.length}</span></div>
    ${voices.length ? voices.map(voiceHTML).join('')
      : '<div class="note">Could not resolve the leading authors for this topic — try a more specific search phrase.</div>'}

    ${other.length ? `<div class="section-title">Commentary, editorials &amp; news in the literature</div>
      ${other.map(commentaryHTML).join('')}` : ''}`;
}

const linkChip = (l) => `<a class="link-chip" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.icon)} ${esc(l.label)}</a>`;

function voiceHTML(v) {
  const initials = v.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return `<article class="voice">
    <div class="avatar">${v.thumb ? `<img src="${esc(v.thumb)}" alt="" loading="lazy">` : esc(initials)}</div>
    <div class="voice-body">
      <div class="voice-name">${esc(v.name)}</div>
      <div class="voice-affil">
        ${v.institution ? esc(v.institution) + ' · ' : ''}${v.papersOnTopic} papers on this topic${v.hIndex ? ` · h-index ${v.hIndex}` : ''}${v.cited ? ` · ${fmtNum(v.cited)} citations` : ''}
      </div>
      ${v.bio ? `<div class="voice-bio">${esc(v.bio)}</div>` : ''}
      <div class="link-row">
        ${v.links.map(linkChip).join('')}
        ${v.wiki ? `<a class="link-chip" href="${esc(v.wiki)}" target="_blank" rel="noopener">📖 Wikipedia</a>` : ''}
        <a class="link-chip" href="${esc(v.openalex)}" target="_blank" rel="noopener">📚 All their papers</a>
      </div>
    </div>
  </article>`;
}

function commentaryHTML(c) {
  return `<article class="evi-item n">
    <div class="evi-head">
      <span class="stance-tag n">${esc(c.kind)}</span>
      <span class="evi-title"><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a></span>
    </div>
    <div class="evi-meta">
      <span>${c.year || 'n.d.'}</span>
      ${c.venue ? `<span>${esc(truncate(c.venue, 44))}</span>` : ''}
      ${c.authors.length ? `<span>${esc(c.authors.join(', '))}</span>` : ''}
    </div>
    ${c.snippet ? `<div class="evi-why">${esc(c.snippet)}</div>` : ''}
  </article>`;
}

/* ---------------------- panel: roots ---------------------- */
async function fillRootsPanel(paper, token) {
  state.loaded.roots = true;
  const panel = $('#panel-roots');
  panel.innerHTML = `<div class="loading-row"><span class="spinner"></span> Loading the work it stands on…</div>`;
  const res = await settle([referencedWorks(paper, 25)]);
  if (token !== state.token) return;
  const refs = res[0].ok ? res[0].value : [];
  if (!refs.length) {
    panel.innerHTML = '<div class="note">No reference list is indexed for this paper. Many publishers still do not deposit their references openly.</div>';
    return;
  }
  panel.innerHTML = `<div class="section-title">Its most important sources <span class="pill">${refs.length}</span></div>
    <div class="note" style="margin-bottom:14px">The papers this one leans on, heaviest-cited first. If the foundation is weak or very old, the conclusion inherits that.</div>
    ${refs.map((p) => eviHTML({ paper: p, origins: new Set(), conf: 0, why: '' }, 'n')).join('')}`;
}

/* ================================================================== *
 * Library + settings
 * ================================================================== */
function updateLibraryCount() {
  $('#library-count').textContent = library.all().length;
}

function renderLibrary() {
  const list = library.all();
  $('#library-list').innerHTML = list.length
    ? list.map((p) => `<div class="lib-item" data-id="${esc(p.id)}">
        <div style="flex:1">
          <div><a href="${esc(p.url || '#')}" target="_blank" rel="noopener">${esc(p.title)}</a></div>
          <div class="muted">${esc((p.authors || []).slice(0, 3).join(', '))} · ${p.year || 'n.d.'} · ${esc(p.venue || '')}</div>
        </div>
        <button class="x" title="Remove">×</button>
      </div>`).join('')
    : '<p class="muted">Nothing saved yet. Hit ☆ Save on any paper.</p>';

  $$('#library-list .x').forEach((btn) => btn.addEventListener('click', (e) => {
    library.remove(e.target.closest('.lib-item').dataset.id);
    renderLibrary(); updateLibraryCount();
  }));
}

/* ================================================================== *
 * Boot
 * ================================================================== */
function init() {
  const s = settings.get();
  $('#s-mailto').value = s.mailto || '';
  $('#s-apikey').value = s.apiKey || '';
  $('#s-s2').checked = !!s.useS2;
  updateLibraryCount();

  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch($('#q').value);
  });

  $$('.suggest').forEach((b) => b.addEventListener('click', () => runSearch(b.dataset.q)));

  ['#f-from', '#f-to', '#f-sort', '#f-oa', '#f-reviews'].forEach((sel) => {
    $(sel).addEventListener('change', () => { if (state.query) runSearch(state.query); });
  });

  $('#btn-settings').addEventListener('click', () => $('#settings-dialog').showModal());
  $('#s-save').addEventListener('click', () => {
    settings.set({
      mailto: $('#s-mailto').value.trim(),
      apiKey: $('#s-apikey').value.trim(),
      useS2: $('#s-s2').checked,
    });
    toast('Settings saved');
    if (state.current) openPaper(state.current);
  });

  $('#btn-library').addEventListener('click', () => { renderLibrary(); $('#library-dialog').showModal(); });
  $('#lib-close').addEventListener('click', () => $('#library-dialog').close());
  $('#lib-export').addEventListener('click', async () => {
    const text = library.all().map((p) =>
      `${(p.authors || []).join(', ')} (${p.year || 'n.d.'}). ${p.title}. ${p.venue || ''}. ${p.doi ? 'https://doi.org/' + p.doi : p.url || ''}`).join('\n\n');
    await navigator.clipboard.writeText(text || '(library empty)');
    toast('Library copied to clipboard');
  });

  // Deep link: index.html#q=topic
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('q')) runSearch(hash.get('q'));
}

init();
