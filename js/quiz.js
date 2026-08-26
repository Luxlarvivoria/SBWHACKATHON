import { esc, truncate } from './util.js';
import {
  studyDesign, sampleSize, numericFindings, caveats, takeaways, evidenceStrength, plainSimplified,
} from './analyze.js';

const QUESTIONS_PER_RUN = 6;
const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(([, v]) => v);
const pick = (a, n) => shuffle(a).slice(0, n);
const sentenceish = (s) => {
  const t = truncate(plainSimplified(s).replace(/\s+/g, ' ').trim(), 150);

  return /^[a-z]/.test(t) ? t.charAt(0).toUpperCase() + t.slice(1) : t;
};

// Every question knows which part of the read it was built from, so a miss can
// point straight back at it. `sections` are matched against the .section-title
// headings in that tab, in order, so the first one that exists on the page wins.
const PART = {
  design:    { tab: 'read', sections: ['Key facts'], label: 'Key facts \u2192 study design' },
  published: { tab: 'read', sections: ['Key facts'], label: 'Key facts \u2192 published' },
  sample:    { tab: 'read', sections: ['Key facts'], label: 'Key facts \u2192 sample size' },
  status:    { tab: 'read', sel: '.detail-meta', sections: [], label: 'the badges under the title' },
  claim:     { tab: 'read', sections: ['The claim in one breath', 'Plain-language read'], label: 'The claim in one breath' },
  caution:   { tab: 'read', sections: ['Read this with caution'], label: 'Read this with caution' },
  weight:    { tab: 'read', sections: ['How much weight it deserves'], label: 'How much weight it deserves' },
  numbers:   { tab: 'read', sections: ['The numbers it rests on', 'Statistics pulled out of the prose', 'Original abstract'], label: 'The numbers it rests on' },
  field:     { tab: 'evidence', sections: ['Where the field landed'], label: 'Supports & challenges' },
};

const jumpTo = (part) => {
  if (part) document.dispatchEvent(new CustomEvent('quiz:goto', { detail: part }));
};

const DESIGN_POOL = [
  'Meta-analysis / systematic review', 'Randomised controlled trial', 'Prospective cohort',
  'Retrospective / case-control', 'Cross-sectional survey', 'Case report / series',
  'Lab / cell study', 'Animal study', 'Model / simulation', 'Qualitative study', 'Narrative review',
];

const DESIGN_CLAIMS = {
  high: {
    can: 'Support a causal claim, because assignment was randomised',
    cannot: 'Prove the effect holds in populations that were never enrolled',
  },
  mid: {
    can: 'Show that an exposure and an outcome travel together over time',
    cannot: 'Establish that the exposure caused the outcome',
  },
  low: {
    can: 'Describe what was observed and generate a hypothesis',
    cannot: 'Establish that the exposure caused the outcome',
  },
};

function numberVariants(n) {
  const out = new Set();
  const round = (v) => (v >= 1000 ? Math.round(v / 100) * 100 : Math.round(v));
  [0.1, 0.5, 2, 10].forEach((f) => { const v = round(n * f); if (v >= 3 && v !== n) out.add(v); });
  return [...out].slice(0, 3);
}

function statCloze(paper) {
  const re = /(\d+(?:\.\d+)?\s*%|p\s*[<=]\s*0?\.\d+|\b\d+\.\d{1,2}\b)/i;
  for (const s of numericFindings(paper, 5)) {
    const m = s.match(re);
    if (!m) continue;
    const value = m[0].trim();
    const num = parseFloat(value.replace(/[^\d.]/g, ''));
    if (!isFinite(num)) continue;
    const isP = /^p/i.test(value);
    const alts = isP
      ? ['p < 0.05', 'p = 0.31', 'p < 0.001', 'p = 0.08'].filter((x) => x.replace(/\s/g, '') !== value.replace(/\s/g, ''))
      : [num * 2, num / 2, num + (num > 10 ? 11 : 3.4)]
        .map((v) => `${(v < 10 ? v.toFixed(1) : Math.round(v))}${value.includes('%') ? '%' : ''}`)
        .filter((x) => x !== value);
    const stem = sentenceish(s.replace(value, ' ______ '));
    return {
      level: 3,
      tag: 'The numbers',
      part: PART.numbers,
      q: 'Fill the gap from the paper\'s own reported result:',
      stem,
      options: [{ text: value, ok: true }, ...pick(alts, 3).map((t) => ({ text: t, ok: false }))],
      why: `The abstract reports “${sentenceish(s)}”.`,
    };
  }
  return null;
}

const FLIPS = [
  [/\bincreased?\b/i, 'decreased'], [/\bdecreased?\b/i, 'increased'],
  [/\bhigher\b/i, 'lower'], [/\blower\b/i, 'higher'],
  [/\breduced?\b/i, 'raised'], [/\bimproved?\b/i, 'worsened'],
  [/\bno significant\b/i, 'a significant'], [/\bsignificantly\b/i, 'not significantly'],
  [/\bassociated with\b/i, 'unrelated to'],
];

function flipClaim(raw) {
  const text = plainSimplified(raw);
  for (const [re, sub] of FLIPS) {
    if (re.test(text)) return text.replace(re, sub);
  }
  return null;
}

export function buildBank(paper, evidence) {
  const bank = [];
  const design = studyDesign(paper);
  const n = sampleSize(paper);
  const cav = caveats(paper);
  const tips = takeaways(paper);
  const strength = evidenceStrength(paper, evidence || {});

  bank.push({
    level: 1,
    tag: 'Key facts',
    part: PART.design,
    q: 'What kind of study is this?',
    options: [
      { text: design.label, ok: true },
      ...pick(DESIGN_POOL.filter((d) => d !== design.label), 3).map((t) => ({ text: t, ok: false })),
    ],
    why: `${design.label} — ${design.note}`,
  });

  if (paper.year) {
    const y = paper.year;
    bank.push({
      level: 1,
      tag: 'Key facts',
      part: PART.published,
      q: 'When was this published?',
      options: [
        { text: String(y), ok: true },
        ...pick([y - 3, y - 7, y + 2, y - 12].filter((v) => v > 1800 && v <= new Date().getFullYear()), 3)
          .map((t) => ({ text: String(t), ok: false })),
      ],
      why: `Published ${y}${paper.venue ? ` in ${truncate(paper.venue, 60)}` : ''}.`,
    });
  }

  if (n != null) {
    bank.push({
      level: 2,
      tag: 'Key facts',
      part: PART.sample,
      q: 'Roughly how many subjects does the paper report?',
      options: [
        { text: n.toLocaleString(), ok: true },
        ...numberVariants(n).map((t) => ({ text: t.toLocaleString(), ok: false })),
      ],
      why: `The largest sample figure in the abstract is about ${n.toLocaleString()}.`
        + (n < 100 ? ' That is small enough that the result could be noise.' : ''),
    });
  } else {
    bank.push({
      level: 2,
      tag: 'Key facts',
      part: PART.sample,
      q: 'What does the abstract say about how many subjects were studied?',
      options: [
        { text: 'It never states a sample size', ok: true },
        { text: 'About 1,200 participants', ok: false },
        { text: 'Exactly 48 participants', ok: false },
        { text: 'Over 100,000 participants', ok: false },
      ],
      why: 'No sample size appears anywhere in the indexed abstract — which is itself a reason for caution.',
    });
  }

  const statusTrue = paper.isRetracted ? 'It has been retracted'
    : paper.isPreprint ? 'It is a preprint, not yet peer reviewed'
      : paper.oa?.isOA ? 'It is open access and peer reviewed'
        : 'It is peer reviewed but paywalled';
  bank.push({
    level: 1,
    tag: 'Key facts',
    part: PART.status,
    q: 'What is this paper\'s publication status?',
    options: shuffleOptions([
      { text: statusTrue, ok: true },
      ...['It has been retracted', 'It is a preprint, not yet peer reviewed',
        'It is open access and peer reviewed', 'It is peer reviewed but paywalled']
        .filter((t) => t !== statusTrue).slice(0, 3).map((t) => ({ text: t, ok: false })),
    ]),
    why: paper.isRetracted ? 'Retracted — the claims have been formally withdrawn.'
      : paper.isPreprint ? 'Preprints skip peer review, so nothing here has been vetted by other scientists yet.'
        : paper.oa?.isOA ? 'Open access means you can read the full text and check the claims yourself.'
          : 'Only the abstract is public, so the methods could not be checked in full.',
  });

  const claim = tips[0];
  const flipped = claim && flipClaim(claim);
  if (claim && flipped) {
    bank.push({
      level: 2,
      tag: 'Plain read',
      part: PART.claim,
      q: 'Which statement matches what the paper actually found?',
      options: shuffleOptions([
        { text: sentenceish(claim), ok: true },
        { text: sentenceish(flipped), ok: false },
        { text: 'The study was inconclusive and reported no findings at all', ok: false },
        ...(tips[1] ? [{ text: sentenceish(flipClaim(tips[1]) || `The effect disappeared entirely once adjusted for age`), ok: false }] : []),
      ].slice(0, 4)),
      why: `The paper reports: “${sentenceish(claim)}”.`,
    });
  }

  if (cav.length) {
    bank.push({
      level: 2,
      tag: 'Read with caution',
      part: PART.caution,
      q: 'Which of these is a real limitation of this paper?',
      options: shuffleOptions([
        { text: sentenceish(cav[0]), ok: true },
        { text: 'It was withdrawn by its own authors after publication', ok: false },
        { text: 'It reports results from a different field entirely', ok: false },
        { text: 'It has no limitations worth noting', ok: false },
      ]),
      why: `Flagged in the caution list: “${sentenceish(cav[0])}”.`,
    });
  }

  bank.push({
    level: 2,
    tag: 'Weight',
    part: PART.weight,
    q: 'How much weight does this paper deserve, on the evidence?',
    options: shuffleOptions([
      { text: strength.label, ok: true },
      ...['Strong', 'Solid', 'Suggestive', 'Weak', 'Very weak']
        .filter((l) => l !== strength.label).slice(0, 3).map((t) => ({ text: t, ok: false })),
    ]),
    why: `Scored ${strength.score}/100 — ${strength.reasons[0]}`,
  });

  const tier = design.weight >= 85 ? 'high' : design.weight >= 52 ? 'mid' : 'low';
  const claims = DESIGN_CLAIMS[tier];
  const named = design.label !== 'Unclassified';
  const article = /^[aeiou]/i.test(design.label) ? 'an' : 'a';
  bank.push({
    level: 3,
    tag: 'Interpretation',
    part: PART.design,
    q: named
      ? `Given it is ${article} ${design.label.toLowerCase()}, which conclusion does the design NOT license?`
      : 'Given the design this abstract describes, which conclusion does it NOT license?',
    options: shuffleOptions([
      { text: claims.cannot, ok: true },
      { text: claims.can, ok: false },
      { text: 'Report what the measured outcomes were', ok: false },
      { text: 'Describe the population that was studied', ok: false },
    ]),
    why: `${design.note} That is the limit of what the design can carry, regardless of how large the effect looks.`,
  });

  const cloze = statCloze(paper);
  if (cloze) bank.push(cloze);

  const ev = evidence || {};
  if ((ev.supporting || 0) + (ev.challenging || 0) >= 3) {
    const verdict = ev.supporting > ev.challenging * 1.5 ? 'Later work mostly lines up with it'
      : ev.challenging > ev.supporting * 1.5 ? 'Later work mostly pushes back on it'
        : 'The later literature is split';
    bank.push({
      level: 3,
      tag: 'Supports & challenges',
      part: PART.field,
      q: 'How did the field respond to this paper?',
      options: shuffleOptions([
        { text: verdict, ok: true },
        ...['Later work mostly lines up with it', 'Later work mostly pushes back on it',
          'The later literature is split', 'Nobody has cited it at all']
          .filter((t) => t !== verdict).slice(0, 3).map((t) => ({ text: t, ok: false })),
      ]),
      why: `${ev.supporting} later papers back it up, ${ev.challenging} push back.`,
    });
  }

  if (cav.length > 1) {
    bank.push({
      level: 3,
      tag: 'Interpretation',
      part: PART.weight,
      q: 'A friend cites this paper as settled fact. What is the fairest correction?',
      options: shuffleOptions([
        { text: `It is ${strength.label.toLowerCase()} evidence — worth quoting with its limits attached`, ok: true },
        { text: 'It proves the claim outright; no caveats are needed', ok: false },
        { text: 'It is worthless and should not be cited', ok: false },
        { text: 'Only papers from the last two years can be cited', ok: false },
      ]),
      why: `${strength.reasons.slice(0, 2).join(' ')}`,
    });
  }

  return bank;
}

function shuffleOptions(opts) { return shuffle(opts); }

function nextQuestion(bank, used, level) {
  const free = bank.filter((q) => !used.has(q));
  if (!free.length) return null;

  for (const l of [level, level + 1, level - 1, level + 2, level - 2]) {
    const at = free.filter((q) => q.level === l);
    if (at.length) return at[Math.floor(Math.random() * at.length)];
  }
  return free[0];
}

export function mountQuiz(root, paper, evidence) {
  const bank = buildBank(paper, evidence);
  const total = Math.min(QUESTIONS_PER_RUN, bank.length);

  const run = { used: new Set(), level: 2, streak: 0, asked: 0, score: 0, max: 0, history: [] };

  function render() {
    const q = nextQuestion(bank, run.used, run.level);
    if (!q || run.asked >= total) return renderResult();
    run.used.add(q);
    run.asked += 1;

    root.innerHTML = `
      <div class="quiz">
        <div class="quiz-head">
          <div class="quiz-dots">${Array.from({ length: total }, (_, i) => {
            const h = run.history[i];
            return `<span class="qdot ${h ? (h.correct ? 'ok' : 'no') : ''} ${i === run.asked - 1 ? 'now' : ''}"></span>`;
          }).join('')}</div>
          <span class="quiz-level">Level ${q.level} · ${esc(q.tag)}</span>
        </div>
        <h3 class="quiz-q">${esc(q.q)}</h3>
        ${q.stem ? `<p class="quiz-stem">${esc(q.stem)}</p>` : ''}
        <div class="quiz-options">
          ${q.options.map((o, i) => `<button class="quiz-opt" data-i="${i}">${esc(o.text)}</button>`).join('')}
        </div>
        <div class="quiz-feedback" hidden></div>
      </div>`;

    const opts = [...root.querySelectorAll('.quiz-opt')];
    opts.forEach((btn) => btn.addEventListener('click', () => answer(q, opts, Number(btn.dataset.i))));
  }

  function answer(q, opts, i) {
    const correct = !!q.options[i].ok;
    opts.forEach((b, j) => {
      b.disabled = true;
      if (q.options[j].ok) b.classList.add('right');
      else if (j === i) b.classList.add('wrong');
    });

    run.max += q.level;
    if (correct) {
      run.score += q.level;
      run.streak += 1;
      if (run.streak >= 2 && run.level < 3) { run.level += 1; run.streak = 0; }
    } else {
      run.streak = 0;
      if (run.level > 1) run.level -= 1;
    }
    run.history[run.asked - 1] = { correct, tag: q.tag, level: q.level, part: q.part };

    const fb = root.querySelector('.quiz-feedback');
    fb.hidden = false;
    fb.className = `quiz-feedback ${correct ? 'ok' : 'no'}`;
    fb.innerHTML = `
      <div class="quiz-verdict">${correct ? '✓ Right' : '✗ Not quite'}${
        run.asked < total ? ` · next question moves ${correct ? 'up' : 'down'} a level` : ''}</div>
      <p>${esc(q.why)}</p>
      ${q.part ? `<div class="quiz-source ${correct ? 'quiet' : ''}">
        <span class="quiz-source-k">${correct ? 'Where this came from' : 'Go read this bit'}</span>
        <button class="quiz-jump" type="button">${esc(q.part.label)} →</button>
      </div>` : ''}
      <button class="primary-btn quiz-next">${run.asked >= total ? 'See your result' : 'Next question'}</button>`;
    fb.querySelector('.quiz-next').addEventListener('click', render);
    fb.querySelector('.quiz-jump')?.addEventListener('click', () => jumpTo(q.part));
    fb.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function renderResult() {
    const right = run.history.filter((h) => h.correct).length;
    const pct = run.max ? Math.round((run.score / run.max) * 100) : 0;
    const verdict = pct >= 85 ? 'You have this paper cold.'
      : pct >= 60 ? 'You have the shape of it — the details need another pass.'
        : 'Worth re-reading before you cite this one.';
    const missed = [];
    run.history.filter((h) => !h.correct && h.part).forEach((h) => {
      if (!missed.some((m) => m.label === h.part.label)) missed.push(h.part);
    });

    root.innerHTML = `
      <div class="quiz quiz-result">
        <div class="quiz-score" style="--pct:${pct}">
          <span class="quiz-score-n">${pct}<small>%</small></span>
        </div>
        <h3 class="quiz-q">${esc(verdict)}</h3>
        <p class="muted">${right} of ${run.history.length} correct · reached level ${Math.max(1, run.level)} of 3 · weighted for difficulty</p>
        ${missed.length ? `<div class="section-title">Go back over</div>
          <p class="quiz-source-k" style="margin:-4px 0 12px">Tap one to jump straight to that part of the paper</p>
          <div class="suggest-row">${missed.map((m, i) =>
            `<button class="suggest quiz-jump" type="button" data-miss="${i}">${esc(m.label)} →</button>`).join('')}</div>` : ''}
        <div class="quiz-actions">
          <button class="primary-btn quiz-again">Run it again</button>
        </div>
        <p class="note">Questions are built from this paper's own abstract, design and citation record — a fresh run reshuffles them and starts you back at level 2.</p>
      </div>`;
    root.querySelectorAll('[data-miss]').forEach((btn) => {
      btn.addEventListener('click', () => jumpTo(missed[Number(btn.dataset.miss)]));
    });
    root.querySelector('.quiz-again').addEventListener('click', () => {
      run.used.clear(); run.level = 2; run.streak = 0; run.asked = 0;
      run.score = 0; run.max = 0; run.history = [];
      render();
    });
  }

  function renderIntro() {
    root.innerHTML = `
      <div class="quiz quiz-intro">
        <div class="section-title">Test yourself</div>
        <h3 class="quiz-q">${total} questions that adapt to you</h3>
        <p>Start at level 2. Two right in a row and the questions get harder; miss one and they ease off.
           Everything is drawn from this paper — its design, its numbers, its limits, and how the field responded.</p>
        <p>Get one wrong and you can jump straight to the part of the read it came from, then come
           back to the quiz where you left off.</p>
        <div class="quiz-actions"><button class="primary-btn quiz-start">Start the quiz</button></div>
      </div>`;
    root.querySelector('.quiz-start').addEventListener('click', render);
  }

  if (bank.length < 3) {
    root.innerHTML = '<div class="note">There is too little indexed detail on this paper to build a fair quiz — no abstract means nothing to ask about.</div>';
    return;
  }
  renderIntro();
}
