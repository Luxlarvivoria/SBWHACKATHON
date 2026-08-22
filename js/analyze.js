// analyze.js — turn an abstract into something readable, and work out
// whether one paper backs another up or pushes against it.
import { sentences, esc, keywords, overlapScore, sharedKeywords, truncate } from './util.js';

export const CLAUDE_MODEL = 'claude-sonnet-5';

/* ================================================================== *
 * 1. Plain language
 * ================================================================== */

/** Jargon -> plain English. Replacements are shown with the original on hover. */
const GLOSSARY = [
  [/\bin order to\b/gi, 'to'],
  [/\ba (?:large )?number of\b/gi, 'several'],
  [/\bthe present study\b/gi, 'this study'],
  [/\bthe current study\b/gi, 'this study'],
  [/\bwe demonstrate(d)?\b/gi, 'we showed'],
  [/\bdemonstrat(e|es|ed|ing)\b/gi, 'show'],
  [/\butiliz(e|es|ed|ing)\b/gi, 'use'],
  [/\belucidat(e|es|ed|ing)\b/gi, 'work out'],
  [/\bameliorat(e|es|ed|ing)\b/gi, 'improve'],
  [/\battenuat(e|es|ed|ing)\b/gi, 'reduce'],
  [/\bexacerbat(e|es|ed|ing)\b/gi, 'worsen'],
  [/\bmodulat(e|es|ed|ing)\b/gi, 'change'],
  [/\bfacilitat(e|es|ed|ing)\b/gi, 'help'],
  [/\bprior to\b/gi, 'before'],
  [/\bsubsequent to\b/gi, 'after'],
  [/\bapproximately\b/gi, 'about'],
  [/\bnovel\b/gi, 'new'],
  [/\brobust\b/gi, 'strong'],
  [/\bheterogeneity\b/gi, 'variation between studies'],
  [/\bconfounder(s)?\b/gi, 'other factors that could explain the result'],
  [/\bcohort\b/gi, 'group of people followed over time'],
  [/\bin vitro\b/gi, 'in cells in a dish'],
  [/\bin vivo\b/gi, 'in living animals'],
  [/\bmurine\b/gi, 'mouse'],
  [/\bplacebo-controlled\b/gi, 'compared against a dummy treatment'],
  [/\bdouble-blind\b/gi, 'neither patients nor doctors knew who got what'],
  [/\bstatistically significant\b/gi, 'unlikely to be chance'],
  [/\bsignificantly\b/gi, 'measurably'],
  [/\befficacy\b/gi, 'how well it works'],
  [/\bmortality\b/gi, 'death rate'],
  [/\bmorbidity\b/gi, 'illness rate'],
  [/\bprevalence\b/gi, 'how common it is'],
  [/\bincidence\b/gi, 'rate of new cases'],
  [/\betiology\b/gi, 'cause'],
  [/\bpathogenesis\b/gi, 'how the disease develops'],
  [/\bbiomarker(s)?\b/gi, 'measurable biological signal'],
  [/\bassay(s)?\b/gi, 'lab test'],
  [/\bparadigm\b/gi, 'approach'],
  [/\bmechanistic\b/gi, 'about how it works'],
  [/\bnon-?inferior\b/gi, 'no worse than'],
  [/\bcorrelat(e|es|ed|ion)\b/gi, 'move together'],
  [/\bassociation\b/gi, 'link'],
  [/\bassociated with\b/gi, 'linked to'],
  [/\bhypothesiz(e|ed)\b/gi, 'expected'],
  [/\bcorroborat(e|es|ed)\b/gi, 'back up'],
  [/\bthus\b/gi, 'so'],
  [/\bhowever\b/gi, 'but'],
  [/\btherefore\b/gi, 'so'],
  [/\bfurthermore\b/gi, 'also'],
  [/\bmoreover\b/gi, 'also'],
];

const BUCKETS = [
  ['question', /\b(we aim|aimed to|the (aim|goal|purpose|objective)|remains? (unclear|unknown|controversial)|little is known|we (sought|set out)|it is unclear|whether|this study (examin|investigat|explor|assess)|we ask)/i],
  ['method', /\b(we (conducted|performed|carried out|recruited|enrolled|analy[sz]ed|measured|used|applied|randomi)|participants (were|included)|patients were|data (from|were)|a total of|randomi[sz]ed|double-?blind|cross-?sectional|questionnaire|we searched|databases|inclusion criteria|sample of|were assigned|protocol|methods?:)/i],
  ['result', /\b(we (found|observed|detected|identified)|results?:|(was|were) (significantly|associated|higher|lower|greater|reduced|increased)|showed (that|a)|no (significant )?(difference|association|effect)|odds ratio|hazard ratio|risk ratio|95% ci|p\s*[<=>]|increased by|decreased by|compared (with|to) controls?)/i],
  ['meaning', /\b(conclusion|these (findings|results) (suggest|indicate|imply|support)|our (findings|results) (suggest|indicate)|suggests? that|may (be|have|help|represent)|implications|highlights?|warrants?|future (work|studies|research)|clinicians|should be|taken together|we conclude)/i],
];

function classifySentence(s) {
  for (const [name, re] of BUCKETS) if (re.test(s)) return name;
  if (/^\s*(background|introduction)/i.test(s)) return 'question';
  if (/^\s*(methods?|design|setting)/i.test(s)) return 'method';
  if (/^\s*(results?|findings)/i.test(s)) return 'result';
  if (/^\s*(conclusions?|interpretation|significance)/i.test(s)) return 'meaning';
  return null;
}

/** Pull the dense statistics out of a sentence so the prose can breathe. */
const STAT_RE = /\(([^()]*(?:p\s*[<=>]|95%\s*ci|±|n\s*=|\d+\.\d+\s*[–-]\s*\d+)[^()]*)\)/gi;

function simplify(text) {
  let out = ` ${text} `;
  const stats = [];
  out = out.replace(STAT_RE, (_, inner) => { stats.push(inner.trim()); return ''; });
  out = out.replace(/^\s*(background|introduction|methods?|results?|findings|conclusions?|objective|aim|purpose|interpretation)\s*[:.—-]\s*/i, '');

  for (const [re, plain] of GLOSSARY) {
    out = out.replace(re, (m) => `${plain}${m}`);
  }
  out = out.replace(/\s+/g, ' ').replace(/\s+([,.;:])/g, '$1').trim();
  if (out && !/[.!?]$/.test(out)) out += '.';
  return { text: out, stats };
}

/** Marked-up replacements -> HTML with the original word on hover. */
export function renderSimplified(s) {
  return esc(s)
    .replace(/([^]*)([^]*)/g,
      (_, plain, orig) => `<span class="term" title="in the paper: &quot;${orig.trim()}&quot;">${plain}</span>`);
}

const SECTION_LABELS = {
  question: 'What they wanted to know',
  method: 'How they did it',
  result: 'What they found',
  meaning: 'What it means',
};

/**
 * Rewrite an abstract as four plain-language sections, no API key needed.
 * @returns {{mode:string, sections:Array<{key,title,html}>, stats:string[]}}
 */
export function plainLanguage(paper) {
  const abs = (paper.abstract || '').trim();
  if (!abs || abs.length < 90) {
    const t = simplify(paper.title || '');
    return {
      mode: 'title-only',
      sections: [{
        key: 'meaning', title: 'No abstract was published',
        html: `<p>This record has no abstract in any of the indexes we searched, so there is nothing to rewrite. `
          + `The title claims: <em>${renderSimplified(t.text)}</em></p>`,
      }],
      stats: [],
    };
  }

  const bucketed = { question: [], method: [], result: [], meaning: [] };
  const allStats = [];
  let last = 'question';
  for (const s of sentences(abs)) {
    const b = classifySentence(s) || last;
    last = b;
    const { text, stats } = simplify(s);
    allStats.push(...stats);
    if (text.length > 8) bucketed[b].push(text);
  }
  // Nothing landed in results? Treat the back half of the abstract as findings.
  if (!bucketed.result.length && bucketed.question.length > 2) {
    bucketed.result = bucketed.question.splice(Math.ceil(bucketed.question.length / 2));
  }

  const sections = [];
  for (const key of ['question', 'method', 'result', 'meaning']) {
    const lines = bucketed[key];
    if (!lines.length) continue;
    sections.push({
      key,
      title: SECTION_LABELS[key],
      html: lines.map((l) => `<p>${renderSimplified(l)}</p>`).join(''),
    });
  }
  return { mode: 'heuristic', sections, stats: [...new Set(allStats)].slice(0, 8) };
}

/* ================================================================== *
 * 2. Key facts
 * ================================================================== */
const DESIGNS = [
  [/\b(meta-?analys[ie]s|systematic review)\b/i, 'Meta-analysis / systematic review', 95, 'Pools many studies — the strongest single form of evidence.'],
  [/\b(randomi[sz]ed|randomised controlled|\brct\b|placebo-?controlled|double-?blind)\b/i, 'Randomised controlled trial', 85, 'Random assignment is what lets a study claim cause, not just correlation.'],
  [/\b(prospective (cohort|study)|longitudinal|followed[- ]up for)\b/i, 'Prospective cohort', 68, 'Follows people forward in time. Strong, but cannot fully rule out other causes.'],
  [/\b(retrospective|case-?control|registry|claims data|chart review)\b/i, 'Retrospective / case-control', 52, 'Looks backwards at existing records — vulnerable to hidden bias.'],
  [/\b(cross-?sectional|survey|questionnaire|nationally representative sample)\b/i, 'Cross-sectional survey', 45, 'A snapshot in time. Shows links, never direction.'],
  [/\b(mendelian randomi[sz]ation)\b/i, 'Mendelian randomisation', 70, 'Uses genetics as a natural experiment to probe causality.'],
  [/\b(case report|case series)\b/i, 'Case report / series', 25, 'A handful of individuals. Generates hypotheses, does not test them.'],
  [/\b(in vitro|cell line|cultured cells)\b/i, 'Lab / cell study', 30, 'Done in cells, not people. Often does not carry over to humans.'],
  [/\b(mice|mouse|murine|rats?|zebrafish|in vivo|animal model)\b/i, 'Animal study', 32, 'Done in animals. Most animal findings do not replicate in humans.'],
  [/\b(simulation|computational model|monte carlo|in silico|machine learning model)\b/i, 'Model / simulation', 38, 'A model of reality, only as good as its assumptions.'],
  [/\b(qualitative|interviews were|thematic analysis|focus groups?)\b/i, 'Qualitative study', 40, 'Depth over numbers — describes experience rather than measuring effects.'],
  [/\b(review|overview of)\b/i, 'Narrative review', 42, 'An expert summary. Useful, but selection of sources is not systematic.'],
];

export function studyDesign(paper) {
  const hay = `${paper.title} ${paper.abstract || ''} ${paper.type || ''} ${(paper.pubTypes || []).join(' ')}`;
  for (const [re, label, weight, note] of DESIGNS) {
    if (re.test(hay)) return { label, weight, note };
  }
  return { label: paper.type ? sentenceCase(paper.type.replace(/-/g, ' ')) : 'Unclassified', weight: 45, note: 'The abstract does not state a recognisable study design.' };
}

const sentenceCase = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

export function sampleSize(paper) {
  const text = `${paper.abstract || ''}`;
  const nums = [];
  const push = (v) => { const n = Number(String(v).replace(/[,\s]/g, '')); if (n >= 3 && n < 5e8) nums.push(n); };
  for (const m of text.matchAll(/\bn\s*=\s*([\d,]{1,12})/gi)) push(m[1]);
  for (const m of text.matchAll(/\b([\d,]{2,12})\s+(?:participants|patients|subjects|adults|children|individuals|respondents|women|men|volunteers|cases|samples|studies|trials)\b/gi)) push(m[1]);
  for (const m of text.matchAll(/\b(?:enrolled|recruited|included|analy[sz]ed)\s+([\d,]{2,12})\b/gi)) push(m[1]);
  if (!nums.length) return null;
  return Math.max(...nums);
}

/** Sentences that carry an actual number — the load-bearing claims. */
export function numericFindings(paper, max = 5) {
  const re = /(\d+(\.\d+)?\s*%|\bp\s*[<=>]\s*0?\.\d+|95%\s*ci|odds ratio|hazard ratio|risk ratio|\bor\s*=|\bhr\s*=|\brr\s*=|cohen'?s d|\bn\s*=\s*\d)/i;
  return sentences(paper.abstract || '').filter((s) => re.test(s)).slice(0, max);
}

const CAVEAT_RE = /\b(limitation|caveat|however|but the|small sample|underpowered|observational|cannot (rule out|exclude|determine)|does not (prove|establish)|causal(ity)? cannot|self-?report|short (follow-?up|duration)|single (centre|center|site)|generali[sz]ability|preliminary|further (research|studies|work) (is|are) needed|warrants? (further|confirmation)|no control group|unblinded|heterogeneity was (high|substantial))/i;

export function caveats(paper) {
  const found = sentences(paper.abstract || '').filter((s) => CAVEAT_RE.test(s)).map((s) => simplify(s).text);
  const extra = [];
  if (paper.isPreprint) extra.push('This is a preprint — it has not been through peer review yet.');
  if (paper.isRetracted) extra.push('This paper has been RETRACTED. Treat its claims as withdrawn.');
  const d = studyDesign(paper);
  if (d.weight < 50) extra.push(d.note);
  const n = sampleSize(paper);
  if (n != null && n < 40) extra.push(`The study is small (about ${n} subjects), so the result could easily be noise.`);
  if (!paper.abstract) extra.push('No abstract is indexed, so none of this could be checked against the text.');
  return [...extra, ...found.slice(0, 4)];
}

/** Headline sentences: the claim the paper is actually making. */
export function takeaways(paper, max = 4) {
  const ss = sentences(paper.abstract || '');
  const scored = ss.map((s) => {
    let score = 0;
    if (/\b(we (found|show|observed|report)|results? (show|indicate)|conclusion|these (findings|results))/i.test(s)) score += 3;
    if (/\b(significant|increased|decreased|reduced|higher|lower|no difference|associated)\b/i.test(s)) score += 2;
    if (/\d/.test(s)) score += 1;
    if (/\b(suggests?|indicates?|demonstrates?)\b/i.test(s)) score += 1;
    return { s, score };
  }).filter((x) => x.score >= 3).sort((a, b) => b.score - a.score).slice(0, max);
  if (!scored.length && ss.length) return [simplify(ss[ss.length - 1]).text];
  return scored.map((x) => simplify(x.s).text);
}

/* ================================================================== *
 * 3. Stance: does this paper back the focus paper, or fight it?
 * ================================================================== */
const SUPPORT_CUES = [
  [/\b(consistent with|in (line|agreement) with|in accordance with)\b/i, 'says its results are consistent with the earlier work', 3],
  [/\b(confirm(s|ed|ing)?|corroborat(e|es|ed|ing)|verif(y|ies|ied))\b/i, 'reports confirming the finding', 3],
  [/\b(replicat(e|es|ed|ing|ion))\b/i, 'reports a replication', 3],
  [/\b(support(s|ed|ing)? (the|this|these|our|previous)|lends? support)\b/i, 'states that it supports the finding', 3],
  [/\b(extend(s|ed)? (these|previous|prior|earlier)|builds? (up)?on)\b/i, 'extends the earlier work', 2],
  [/\b(similarly|likewise|as (previously )?(reported|shown|observed))\b/i, 'reports a similar result', 2],
  [/\b(reproduc(e|ed|ible))\b/i, 'reports the effect was reproducible', 2],
  [/\b(significant(ly)? (increase|decrease|improve|reduc|associat))/i, 'reports a measurable effect in the same direction', 1],
];

const AGAINST_CUES = [
  [/\b(fail(ed|s|ure)? to (replicat|confirm|reproduce|find|detect|show))\b/i, 'reports failing to reproduce the result', 4],
  [/\b(could not (replicat|confirm|reproduce)|did not replicat)\b/i, 'could not replicate it', 4],
  [/\b(contradicts?|contradicted|refut(e|es|ed)|disprov(e|es|ed))\b/i, 'directly contradicts the claim', 4],
  [/\b(contrary to|at odds with|in contrast to (the|previous|earlier)|inconsistent with)\b/i, 'reports results at odds with it', 3],
  [/\b(challeng(e|es|ed|ing) (the|this|these|previous|current)|calls? into question|casts? doubt|questions? (the|whether))\b/i, 'challenges the claim', 3],
  [/\b(no (statistically )?significant (association|difference|effect|correlation|relationship)|found no (association|effect|difference)|null (result|finding)s?)\b/i, 'found no effect where the original reported one', 3],
  [/\b(does not (support|appear|seem)|do not support|was not (associated|significant))\b/i, 'does not support the claim', 3],
  [/\b(overestimat|inflated|publication bias|p-?hacking|underpowered|spurious|confound(ed|ing) by)\b/i, 'argues the original result is biased or overstated', 3],
  [/\b(retract(ed|ion)|erratum|expression of concern)\b/i, 'is a retraction or correction notice', 4],
  [/\b(rebut|comment on|reply to|criticis|critiqu)\b/i, 'is a direct critique or reply', 2],
];

/** Sentences that describe the state of the literature rather than this paper's own result. */
const HEDGE_CONTEXT = /\b(previous (studies|work|research|reports)|prior (studies|work)|earlier (studies|work)|studies have (reported|shown|found|suggested)|the literature|results have been|remains (controversial|unclear|debated|elusive)|it (is|has been) (unclear|debated|suggested|proposed)|has been (reported|suggested|proposed)|some studies|little is known|to date)/i;

/** "The evidence is mixed" is a statement about the field, not a challenge to one paper. */
const FIELD_MIXED = /\b(contradictory|conflicting|inconsistent|mixed|divergent)\s+(results?|findings?|evidence|data|reports?|conclusions?)\b/i;

function cueScan(text, cues) {
  let best = null;
  for (const [re, why, w] of cues) {
    const m = re.exec(text);
    if (m && (!best || w > best.weight)) best = { why, weight: w, match: m[0], index: m.index };
  }
  if (best) best.sentence = sentenceContaining(text, best.match);
  return best;
}

function sentenceContaining(text, match) {
  const ss = sentences(text);
  return ss.find((s) => s.toLowerCase().includes(match.toLowerCase())) || text.slice(0, 300);
}

/** Quote the sentence the cue appeared in, with the cue itself highlighted. */
function quoteAround(text, match) {
  const ss = sentences(text);
  const hit = ss.find((s) => s.toLowerCase().includes(match.toLowerCase())) || text.slice(0, 240);
  const safe = esc(truncate(hit, 260));
  return safe.replace(new RegExp(esc(match).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), (m) => `<b>${m}</b>`);
}

/**
 * Label one candidate paper relative to the focus paper.
 * `context` is the actual citing sentence when Semantic Scholar supplies one —
 * far more reliable than scanning the whole abstract.
 * @returns {{stance:'s'|'a'|'n', why:string, quote:string, conf:number}}
 */
export function classifyStance(candidate, focus, context = '') {
  const title = candidate.title || '';
  const abs = candidate.abstract || '';
  const scanText = context || `${title}. ${abs}`.slice(0, 2600);

  const sup = cueScan(scanText, SUPPORT_CUES);
  const ag = cueScan(scanText, AGAINST_CUES);

  // Cues in the title itself are a much louder signal than cues buried in an abstract.
  const titleAg = cueScan(title, AGAINST_CUES);
  const titleSup = cueScan(title, SUPPORT_CUES);

  let stance = 'n';
  let why = 'Works on the same question without taking an explicit position on this paper.';
  let quote = '';
  let conf = 0.3;

  let agW = (ag?.weight || 0) + (titleAg ? 2 : 0);
  let supW = (sup?.weight || 0) + (titleSup ? 2 : 0);

  // A cue sitting in a background sentence ("previous studies have reported…")
  // describes the field, not a position on this paper. Only the strongest,
  // unmistakable cues survive that context.
  // How much is this candidate even about the same question? A cue phrase in a
  // paper on a different subject is a coincidence, not a verdict.
  const relevance = Math.max(
    overlapScore(focus.title, `${title} ${abs.slice(0, 1800)}`),
    overlapScore(focus.title, title) * 1.2,
  );

  if (!context) {
    if (ag && HEDGE_CONTEXT.test(ag.sentence) && ag.weight < 4) agW -= 2;
    if (sup && HEDGE_CONTEXT.test(sup.sentence) && sup.weight < 3) supW -= 2;
    // One word in common is a coincidence ("power posing" vs "constituent power").
    if (relevance < 0.15 || sharedKeywords(focus.title, `${title} ${abs.slice(0, 1800)}`) < 2) {
      agW -= 3; supW -= 3;
    }
  }

  // "The evidence is contradictory" is a report of disagreement, not an argument —
  // but only when that phrasing is what triggered the cue in the first place,
  // or when nothing else in the text takes a side.
  const mixedIsTheCue = ag && FIELD_MIXED.test(ag.sentence);
  const nothingDecisive = agW < 3 && supW < 3;
  if (FIELD_MIXED.test(scanText) && agW < 4 && (mixedIsTheCue || nothingDecisive)) {
    return {
      stance: 'n',
      why: 'Describes the evidence on this question as mixed or contradictory rather than taking a side.',
      quote: quoteAround(scanText, (FIELD_MIXED.exec(scanText) || [''])[0]),
      conf: 0.45,
      design: studyDesign(candidate),
    };
  }

  if (agW > supW && agW >= 3) {
    stance = 'a';
    why = `This paper ${ag.why}.`;
    quote = quoteAround(scanText, ag.match);
    conf = Math.min(0.95, 0.4 + agW * 0.12);
  } else if (supW >= 3) {
    stance = 's';
    why = `This paper ${sup.why}.`;
    quote = quoteAround(scanText, sup.match);
    conf = Math.min(0.95, 0.4 + supW * 0.12);
  } else if (candidate.isRetracted) {
    stance = 'a';
    why = 'This paper has been retracted.';
    conf = 0.9;
  }

  if (context) conf = Math.min(0.97, conf + 0.15); // the sentence really is about the focus paper

  // A same-topic meta-analysis is a verdict even when it uses no cue words.
  const design = studyDesign(candidate);
  if (stance === 'n' && design.weight >= 95 && overlapScore(focus.title, title) > 0.25) {
    why = 'A systematic review or meta-analysis covering the same question — the field-level answer to compare against.';
    conf = 0.5;
  }
  return { stance, why, quote, conf, design };
}

/* ================================================================== *
 * 4. How much weight does this paper deserve?
 * ================================================================== */
export function evidenceStrength(paper, { supporting = 0, challenging = 0 } = {}) {
  const d = studyDesign(paper);
  const n = sampleSize(paper);
  const reasons = [];
  let score = d.weight;
  reasons.push(`${d.label} — ${d.note}`);

  if (n != null) {
    if (n >= 10000) { score += 12; reasons.push(`Large sample (about ${n.toLocaleString()}), so small effects can be detected reliably.`); }
    else if (n >= 1000) { score += 7; reasons.push(`Decent sample size (about ${n.toLocaleString()}).`); }
    else if (n >= 100) { score += 2; reasons.push(`Modest sample size (about ${n.toLocaleString()}).`); }
    else { score -= 10; reasons.push(`Small sample (about ${n.toLocaleString()}) — results may not hold up.`); }
  }

  const age = paper.year ? new Date().getFullYear() - paper.year : 0;
  const cites = paper.cites || 0;
  if (cites >= 5000) { score += 15; reasons.push(`A landmark by citation count (${cites.toLocaleString()}) — the field has built on it extensively.`); }
  else if (cites >= 500) { score += 9; reasons.push(`Heavily cited (${cites.toLocaleString()} citations) — the field has engaged with it.`); }
  else if (cites >= 50) { score += 4; reasons.push(`Well cited (${cites} citations).`); }
  else if (age >= 4 && cites < 5) { score -= 6; reasons.push('Barely cited despite being several years old — the field has largely ignored it.'); }

  // Only let the later literature move the score when enough of it was
  // labelled to mean anything — a couple of cue-phrase hits is noise.
  const labelled = supporting + challenging;
  if (labelled >= 6) {
    const ratio = supporting / labelled;
    if (ratio >= 0.75) { score += 10; reasons.push(`Later work mostly lines up with it (${supporting} supporting vs ${challenging} challenging).`); }
    else if (ratio <= 0.35) { score -= 12; reasons.push(`Later work pushes back hard (${challenging} challenging vs ${supporting} supporting).`); }
    else { reasons.push(`The literature is split (${supporting} supporting, ${challenging} challenging).`); }
  } else if (labelled) {
    reasons.push(`Too few later papers took a clear position (${supporting} supporting, ${challenging} challenging) to read anything into the balance.`);
  }

  if (paper.isPreprint) { score -= 12; reasons.push('Preprint — not yet peer reviewed.'); }
  if (paper.oa?.isOA) reasons.push('Open access, so you can read the full text and check it yourself.');
  if (paper.isRetracted) { score = 3; reasons.length = 0; reasons.push('RETRACTED — the claims have been formally withdrawn.'); }

  score = Math.max(3, Math.min(99, Math.round(score)));
  const label = score >= 80 ? 'Strong' : score >= 62 ? 'Solid' : score >= 45 ? 'Suggestive' : score >= 28 ? 'Weak' : 'Very weak';
  return { score, label, reasons };
}

/* ================================================================== *
 * 5. Optional: let Claude do the rewriting and the stance calls
 * ================================================================== */
async function claude(apiKey, { system, prompt, maxTokens = 1200 }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${truncate(await res.text(), 160)}`);
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

function extractJSON(text) {
  const m = text.match(/```json\s*([\s\S]*?)```/) || text.match(/([\[{][\s\S]*[\]}])/);
  return JSON.parse(m ? m[1] : text);
}

/** A real plain-English rewrite, when the user has supplied a key. */
export async function aiPlainLanguage(paper, apiKey) {
  const out = await claude(apiKey, {
    system: 'You explain research papers to a curious non-specialist. Plain, concrete, honest. '
      + 'Never overstate what a study shows; keep the hedging the authors intended. No jargon without a gloss.',
    prompt: `Rewrite this paper for a smart 15-year-old. Return ONLY JSON:
{"question":"...","method":"...","result":"...","meaning":"...","claim":"one sentence stating what the paper claims"}
Each field 1-3 short sentences. If the abstract is missing, say so plainly instead of inventing content.

TITLE: ${paper.title}
JOURNAL: ${paper.venue || 'unknown'} (${paper.year || 'n.d.'})
ABSTRACT: ${(paper.abstract || '(none indexed)').slice(0, 6000)}`,
    maxTokens: 900,
  });
  const j = extractJSON(out);
  const sections = [];
  for (const key of ['question', 'method', 'result', 'meaning']) {
    if (j[key]) sections.push({ key, title: SECTION_LABELS[key], html: `<p>${esc(j[key])}</p>` });
  }
  return { mode: 'ai', sections, stats: [], claim: j.claim || '' };
}

/** Ask Claude to adjudicate stance for a batch of candidates at once. */
export async function aiStances(focus, candidates, apiKey) {
  if (!candidates.length) return {};
  const list = candidates.slice(0, 24).map((c, i) =>
    `[${i}] ${c.paper.title} (${c.paper.year || 'n.d.'})\n`
    + (c.contexts?.length ? `CITING SENTENCE: "${truncate(c.contexts[0], 400)}"\n` : '')
    + `ABSTRACT: ${truncate(c.paper.abstract || '(none)', 600)}`).join('\n\n');

  const out = await claude(apiKey, {
    system: 'You are a careful research librarian judging whether one paper supports, challenges, or is merely '
      + 'related to another. Be conservative: only say supports/challenges when the text gives real grounds.',
    prompt: `FOCUS PAPER: ${focus.title} (${focus.year || 'n.d.'})
FOCUS CLAIM: ${truncate(focus.abstract || focus.title, 900)}

For each candidate below return JSON array entries:
{"i":0,"stance":"support"|"challenge"|"related","why":"<= 22 words, concrete, no hedging filler","conf":0..1}

CANDIDATES:
${list}

Return ONLY the JSON array.`,
    maxTokens: 2000,
  });
  const arr = extractJSON(out);
  const map = {};
  for (const r of arr) {
    map[r.i] = {
      stance: r.stance === 'support' ? 's' : r.stance === 'challenge' ? 'a' : 'n',
      why: r.why || '',
      conf: typeof r.conf === 'number' ? r.conf : 0.6,
    };
  }
  return map;
}

/** Search terms that surface public discussion rather than more papers. */
export function talkQueries(topic, paper) {
  const kw = keywords(`${topic} ${paper?.title || ''}`, 6);
  const short = kw.slice(0, 4).join(' ');
  return { short, full: topic };
}
