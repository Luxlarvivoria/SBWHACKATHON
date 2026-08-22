// sources.js — one search across many publishers, plus citation graph lookups.
//
// OpenAlex   -> index of ~250M works (Elsevier, Springer Nature, Wiley, IEEE, MDPI, arXiv…)
// Crossref   -> the DOI registry itself (publisher-deposited metadata)
// Europe PMC -> PubMed / MEDLINE / PMC / preprint servers, with real abstracts
import { getJSON, settle, settings, fromInverted, stripTags, overlapScore, keywords } from './util.js';

const OA = 'https://api.openalex.org';
const CR = 'https://api.crossref.org';
const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest';

const PREPRINT_RE = /arxiv|biorxiv|medrxiv|chemrxiv|ssrn|research square|preprints?\.org|osf|psyarxiv|techrxiv/i;

function mailto() {
  const m = (settings.get().mailto || '').trim();
  return m ? `&mailto=${encodeURIComponent(m)}` : '';
}

const doiKey = (doi) => (doi || '').toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').trim();
const titleKey = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 70);

/* ------------------------------------------------------------------ *
 * Normalizers — every source collapses into the same paper shape.
 * ------------------------------------------------------------------ */
function fromOpenAlex(w) {
  const doi = doiKey(w.doi);
  const src = w.primary_location?.source || {};
  const venue = src.display_name || w.host_venue?.display_name || '';
  return {
    id: doi ? `doi:${doi}` : `oa:${w.id}`,
    doi,
    openalexId: (w.id || '').split('/').pop(),
    title: stripTags(w.display_name) || 'Untitled',
    authors: (w.authorships || []).map((a) => ({
      name: a.author?.display_name,
      openalexId: (a.author?.id || '').split('/').pop(),
      institution: a.institutions?.[0]?.display_name || '',
    })).filter((a) => a.name),
    year: w.publication_year || null,
    date: w.publication_date || '',
    venue,
    publisher: src.host_organization_name || '',
    type: w.type_crossref || w.type || '',
    isPreprint: w.type === 'preprint' || PREPRINT_RE.test(venue),
    isRetracted: !!w.is_retracted,
    oa: { isOA: !!w.open_access?.is_oa, url: w.best_oa_location?.pdf_url || w.open_access?.oa_url || '' },
    cites: w.cited_by_count ?? null,
    refCount: w.referenced_works_count ?? null,
    abstract: fromInverted(w.abstract_inverted_index),
    topics: (w.topics || []).map((t) => t.display_name).filter(Boolean),
    pmid: (w.ids?.pmid || '').split('/').pop() || '',
    url: doi ? `https://doi.org/${doi}` : w.id,
    sources: ['OpenAlex'],
  };
}

function fromCrossref(it) {
  const doi = doiKey(it.DOI);
  const venue = (it['container-title'] || [])[0] || (it['institution'] || [])[0]?.name || '';
  const parts = it.issued?.['date-parts']?.[0] || it.created?.['date-parts']?.[0] || [];
  return {
    id: doi ? `doi:${doi}` : `cr:${it.DOI}`,
    doi,
    openalexId: '',
    title: stripTags((it.title || [])[0]) || 'Untitled',
    authors: (it.author || []).map((a) => ({
      name: [a.given, a.family].filter(Boolean).join(' ') || a.name,
      institution: (a.affiliation || [])[0]?.name || '',
    })).filter((a) => a.name),
    year: parts[0] || null,
    date: parts.length ? parts.map((n) => String(n).padStart(2, '0')).join('-') : '',
    venue,
    publisher: it.publisher || '',
    type: it.type || '',
    isPreprint: it.type === 'posted-content' || PREPRINT_RE.test(venue) || PREPRINT_RE.test(it.publisher || ''),
    isRetracted: /retract/i.test((it.title || [])[0] || ''),
    oa: { isOA: !!(it.license || []).some((l) => /creativecommons/i.test(l.URL || '')), url: '' },
    cites: it['is-referenced-by-count'] ?? null,
    refCount: it['references-count'] ?? null,
    abstract: stripTags(it.abstract),
    topics: (it.subject || []),
    pmid: '',
    url: it.URL || (doi ? `https://doi.org/${doi}` : ''),
    sources: ['Crossref'],
  };
}

function fromEPMC(r) {
  const doi = doiKey(r.doi);
  const types = (r.pubTypeList?.pubType || []).map((t) => String(t).toLowerCase());
  const venue = r.journalInfo?.journal?.title || r.journalTitle || r.bookOrReportDetails?.publisher || '';
  return {
    id: doi ? `doi:${doi}` : `epmc:${r.source}:${r.id}`,
    doi,
    openalexId: '',
    title: stripTags(r.title) || 'Untitled',
    authors: (r.authorList?.author || []).map((a) => ({
      name: a.fullName || [a.firstName, a.lastName].filter(Boolean).join(' '),
      institution: a.affiliation || '',
    })).filter((a) => a.name),
    year: Number(r.pubYear) || null,
    date: r.firstPublicationDate || '',
    venue,
    publisher: '',
    type: types.find((t) => /review|meta|trial|editorial|comment|interview|news/.test(t)) || (types[0] || ''),
    isPreprint: r.source === 'PPR' || PREPRINT_RE.test(venue),
    isRetracted: types.some((t) => /retract/.test(t)),
    oa: { isOA: r.isOpenAccess === 'Y', url: r.pmcid ? `https://europepmc.org/article/PMC/${r.pmcid}` : '' },
    cites: r.citedByCount ?? null,
    refCount: null,
    abstract: stripTags(r.abstractText),
    topics: (r.keywordList?.keyword || []),
    pmid: r.pmid || '',
    pmcid: r.pmcid || '',
    pubTypes: types,
    url: doi ? `https://doi.org/${doi}`
      : r.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/`
      : `https://europepmc.org/article/${r.source}/${r.id}`,
    sources: ['Europe PMC'],
  };
}

/* ------------------------------------------------------------------ *
 * Per-source search
 * ------------------------------------------------------------------ */
async function searchOpenAlex(q, o, { reviewsOnly = false } = {}) {
  const filters = [];
  if (o.from) filters.push(`from_publication_date:${o.from}-01-01`);
  if (o.to) filters.push(`to_publication_date:${o.to}-12-31`);
  if (o.oaOnly) filters.push('is_oa:true');
  if (reviewsOnly) filters.push('type:review');
  const url = `${OA}/works?search=${encodeURIComponent(q)}`
    + `&per_page=${reviewsOnly ? 10 : 25}`
    + `&sort=${encodeURIComponent(o.sort || 'relevance_score:desc')}`
    + (filters.length ? `&filter=${encodeURIComponent(filters.join(','))}` : '')
    + mailto();
  const data = await getJSON(url);
  return (data.results || []).map(fromOpenAlex);
}

async function searchCrossref(q, o) {
  const filters = [];
  if (o.from) filters.push(`from-pub-date:${o.from}-01-01`);
  if (o.to) filters.push(`until-pub-date:${o.to}-12-31`);
  const sortMap = {
    'relevance_score:desc': 'relevance',
    'cited_by_count:desc': 'is-referenced-by-count',
    'publication_date:desc': 'published',
  };
  const url = `${CR}/works?query.bibliographic=${encodeURIComponent(q)}&rows=20`
    + `&sort=${sortMap[o.sort] || 'relevance'}&order=desc`
    + (filters.length ? `&filter=${encodeURIComponent(filters.join(','))}` : '')
    + `&select=DOI,title,author,issued,created,container-title,publisher,type,abstract,is-referenced-by-count,references-count,URL,license,subject`
    + (mailto() ? mailto() : '');
  const data = await getJSON(url);
  return (data.message?.items || []).map(fromCrossref);
}

async function searchEPMC(q, o) {
  const bits = [q];
  if (o.from || o.to) bits.push(`PUB_YEAR:[${o.from || 1800} TO ${o.to || 2100}]`);
  if (o.oaOnly) bits.push('OPEN_ACCESS:Y');
  const sortMap = { 'cited_by_count:desc': '&sort=CITED desc', 'publication_date:desc': '&sort=P_PDATE_D desc' };
  const url = `${EPMC}/search?query=${encodeURIComponent(bits.join(' AND '))}`
    + `&format=json&pageSize=25&resultType=core${sortMap[o.sort] || ''}`;
  const data = await getJSON(url);
  return (data.resultList?.result || []).map(fromEPMC);
}

/* ------------------------------------------------------------------ *
 * Merge + rank
 * ------------------------------------------------------------------ */
function mergeInto(a, b) {
  a.sources = [...new Set([...a.sources, ...b.sources])];
  if ((b.abstract || '').length > (a.abstract || '').length) a.abstract = b.abstract;
  for (const k of ['doi', 'openalexId', 'venue', 'publisher', 'type', 'date', 'pmid', 'pmcid']) {
    if (!a[k] && b[k]) a[k] = b[k];
  }
  if (!a.year && b.year) a.year = b.year;
  if ((b.authors || []).length > (a.authors || []).length) a.authors = b.authors;
  if (b.cites != null && (a.cites == null || b.cites > a.cites)) a.cites = b.cites;
  if (b.oa?.isOA && !a.oa?.isOA) a.oa = b.oa;
  if (b.isRetracted) a.isRetracted = true;
  if ((b.topics || []).length > (a.topics || []).length) a.topics = b.topics;
  return a;
}

export function dedupe(lists) {
  const byDoi = new Map();
  const byTitle = new Map();
  const out = [];
  for (const list of lists) {
    for (const p of list) {
      const dk = p.doi ? `d:${p.doi}` : null;
      const tk = `t:${titleKey(p.title)}`;
      const hit = (dk && byDoi.get(dk)) || byTitle.get(tk);
      if (hit) { mergeInto(hit, p); continue; }
      out.push(p);
      if (dk) byDoi.set(dk, p);
      byTitle.set(tk, p);
    }
  }
  return out;
}

function rank(papers, q) {
  const thisYear = new Date().getFullYear();
  for (const p of papers) {
    const titleHit = overlapScore(q, p.title) * 3;
    const absHit = overlapScore(q, (p.abstract || '').slice(0, 900)) * 1.2;
    const impact = Math.log10((p.cites || 0) + 1) * 0.55;
    const fresh = p.year ? Math.max(0, 1 - (thisYear - p.year) / 40) * 0.35 : 0;
    const multi = (p.sources.length - 1) * 0.25;
    const oa = p.oa?.isOA ? 0.12 : 0;
    const abstracted = p.abstract ? 0.25 : 0;
    const penalty = (p.isRetracted ? -2 : 0) + (p.isPreprint ? -0.15 : 0);
    p._score = titleHit + absHit + impact + fresh + multi + oa + abstracted + penalty;
  }
  return papers.sort((a, b) => b._score - a._score);
}

/**
 * Search every publisher index at once.
 * @returns {{papers:Array, status:Object}}
 */
export async function searchAll(q, opts = {}) {
  const tasks = [
    searchOpenAlex(q, opts),
    searchCrossref(q, opts),
    searchEPMC(q, opts),
  ];
  if (opts.includeReviews) tasks.push(searchOpenAlex(q, opts, { reviewsOnly: true }));

  const [oa, cr, ep, rev] = await settle(tasks);
  const status = {
    OpenAlex: oa.ok ? oa.value.length : 'fail',
    Crossref: cr.ok ? cr.value.length : 'fail',
    'Europe PMC': ep.ok ? ep.value.length : 'fail',
  };
  const lists = [
    oa.ok ? oa.value : [],
    ep.ok ? ep.value : [],
    cr.ok ? cr.value : [],
    rev?.ok ? rev.value : [],
  ];
  const papers = rank(dedupe(lists), q).filter((p) => p.title !== 'Untitled');
  return { papers, status };
}

/* ------------------------------------------------------------------ *
 * Single-paper enrichment
 * ------------------------------------------------------------------ */
/** Fill in OpenAlex id / abstract / topics for a paper found elsewhere. */
export async function enrich(paper) {
  if (paper._enriched) return paper;
  paper._enriched = true;
  try {
    if (!paper.openalexId && paper.doi) {
      const w = await getJSON(`${OA}/works/doi:${paper.doi}?${mailto().slice(1)}`);
      mergeInto(paper, fromOpenAlex(w));
      paper.openalexId = (w.id || '').split('/').pop();
      paper.referenced = (w.referenced_works || []).map((u) => u.split('/').pop());
      paper.related = (w.related_works || []).map((u) => u.split('/').pop());
    } else if (paper.openalexId) {
      const w = await getJSON(`${OA}/works/${paper.openalexId}?${mailto().slice(1)}`);
      mergeInto(paper, fromOpenAlex(w));
      paper.referenced = (w.referenced_works || []).map((u) => u.split('/').pop());
      paper.related = (w.related_works || []).map((u) => u.split('/').pop());
    }
  } catch { /* enrichment is best-effort */ }

  // Abstracts are the raw material for everything else — try harder for one.
  if (!paper.abstract && (paper.doi || paper.pmid)) {
    try {
      const query = paper.doi ? `DOI:"${paper.doi}"` : `EXT_ID:${paper.pmid}`;
      const d = await getJSON(`${EPMC}/search?query=${encodeURIComponent(query)}&format=json&resultType=core&pageSize=1`);
      const r = (d.resultList?.result || [])[0];
      if (r) mergeInto(paper, fromEPMC(r));
    } catch {}
  }
  return paper;
}

/** Papers that cite this one (the field's reaction to it). */
export async function citingWorks(paper, limit = 50) {
  if (!paper.openalexId) return [];
  const url = `${OA}/works?filter=${encodeURIComponent(`cites:${paper.openalexId}`)}`
    + `&per_page=${limit}&sort=cited_by_count:desc${mailto()}`;
  const d = await getJSON(url);
  return (d.results || []).map(fromOpenAlex);
}

/** Key works this paper itself leaned on. */
export async function referencedWorks(paper, limit = 25) {
  const ids = (paper.referenced || []).slice(0, limit);
  if (!ids.length) return [];
  const url = `${OA}/works?filter=${encodeURIComponent(`openalex_id:${ids.join('|')}`)}`
    + `&per_page=${limit}&sort=cited_by_count:desc${mailto()}`;
  const d = await getJSON(url);
  return (d.results || []).map(fromOpenAlex);
}

/** Independent work on the same question — the replication / rival-lab set. */
export async function siblingWorks(paper, topicQuery, limit = 40) {
  const q = topicQuery || keywords(paper.title, 8).join(' ');
  const filters = ['type:article|review'];
  const url = `${OA}/works?search=${encodeURIComponent(q)}&per_page=${limit}`
    + `&filter=${encodeURIComponent(filters.join(','))}&sort=relevance_score:desc${mailto()}`;
  const d = await getJSON(url);
  const own = new Set([paper.openalexId, paper.doi]);
  return (d.results || []).map(fromOpenAlex)
    .filter((p) => !own.has(p.openalexId) && !own.has(p.doi));
}

/** Reviews & meta-analyses — the closest thing to a field-level verdict. */
export async function consensusWorks(topicQuery, limit = 12) {
  const url = `${OA}/works?search=${encodeURIComponent(topicQuery)}`
    + `&filter=${encodeURIComponent('type:review')}&per_page=${limit}&sort=cited_by_count:desc${mailto()}`;
  const d = await getJSON(url);
  return (d.results || []).map(fromOpenAlex);
}

/**
 * Semantic Scholar citation contexts: the actual sentence in which a later
 * paper cited this one, plus S2's own support/contrast intent labels.
 * Optional — unauthenticated access is rate-limited.
 */
export async function s2Contexts(paper, limit = 60) {
  if (!paper.doi) return [];
  const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${paper.doi}/citations`
    + `?fields=title,year,abstract,venue,externalIds,citationCount,contexts,intents,isInfluential&limit=${limit}`;
  const d = await getJSON(url, { timeout: 12000 });
  return (d.data || []).map((c) => ({
    contexts: c.contexts || [],
    intents: c.intents || [],
    isInfluential: !!c.isInfluential,
    paper: {
      id: c.citingPaper?.externalIds?.DOI ? `doi:${doiKey(c.citingPaper.externalIds.DOI)}` : `s2:${c.citingPaper?.paperId}`,
      doi: doiKey(c.citingPaper?.externalIds?.DOI),
      title: c.citingPaper?.title || '',
      year: c.citingPaper?.year || null,
      venue: c.citingPaper?.venue || '',
      abstract: c.citingPaper?.abstract || '',
      cites: c.citingPaper?.citationCount ?? null,
      authors: [],
      sources: ['Semantic Scholar'],
      url: c.citingPaper?.externalIds?.DOI ? `https://doi.org/${doiKey(c.citingPaper.externalIds.DOI)}` : '',
    },
  })).filter((c) => c.paper.title);
}

/* ------------------------------------------------------------------ *
 * Scientists talking out loud
 * ------------------------------------------------------------------ */
/** Journal-indexed interviews, news features, editorials and commentary. */
export async function mediaPieces(topicQuery, limit = 25) {
  const types = '(PUB_TYPE:"interview" OR PUB_TYPE:"news" OR PUB_TYPE:"editorial" OR PUB_TYPE:"comment" OR PUB_TYPE:"portrait")';
  const q = `(${topicQuery}) AND ${types}`;
  const d = await getJSON(`${EPMC}/search?query=${encodeURIComponent(q)}&format=json&resultType=core&pageSize=${limit}&sort=P_PDATE_D desc`);
  return (d.resultList?.result || []).map(fromEPMC);
}

/** Who actually publishes on this topic, ranked by volume of work. */
export async function topAuthors(topicQuery, limit = 8) {
  const url = `${OA}/works?search=${encodeURIComponent(topicQuery)}`
    + `&group_by=authorships.author.id&per_page=200${mailto()}`;
  const d = await getJSON(url);
  return (d.group_by || [])
    .filter((g) => g.key_display_name && g.key_display_name !== 'unknown')
    .slice(0, limit)
    .map((g) => ({ openalexId: (g.key || '').split('/').pop(), name: g.key_display_name, papersOnTopic: g.count }));
}

export async function authorProfile(id) {
  const a = await getJSON(`${OA}/authors/${id}?${mailto().slice(1)}`);
  return {
    openalexId: id,
    name: a.display_name,
    institution: a.last_known_institutions?.[0]?.display_name || a.last_known_institution?.display_name || '',
    country: a.last_known_institutions?.[0]?.country_code || '',
    works: a.works_count,
    cited: a.cited_by_count,
    hIndex: a.summary_stats?.h_index,
    orcid: (a.orcid || '').replace('https://orcid.org/', ''),
    topics: (a.topics || []).slice(0, 4).map((t) => t.display_name),
  };
}

const SCIENCE_RE = /\b(scientist|researcher|research|professor|physicist|biolog|chemist|psycholog|epidemiolog|neuroscien|academic|physician|ecolog|geolog|statistic|engineer|immunolog|microbiolog|nutrition|medicine|laborator|university|institute|ph\.?d)\b/i;

/**
 * Wikipedia blurb + portrait for a named scientist.
 * Uses search rather than an exact title, then insists the page really is
 * about that person and really is about a scientist — a wrong photo next to
 * a researcher's name is worse than no photo.
 */
export async function wikiPerson(name) {
  try {
    const url = 'https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*'
      + '&generator=search&gsrlimit=3&gsrnamespace=0'
      + '&prop=extracts|pageimages&exintro=1&explaintext=1&piprop=thumbnail&pithumbsize=120'
      + `&gsrsearch=${encodeURIComponent(`${name} scientist researcher`)}`;
    const d = await getJSON(url);
    const pages = Object.values(d.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
    const surname = name.trim().split(/\s+/).pop().toLowerCase();
    const given = name.trim().split(/\s+/)[0].toLowerCase();

    for (const page of pages) {
      const title = (page.title || '').toLowerCase();
      const extract = page.extract || '';
      // The page must name this person, not merely mention their field.
      if (!title.includes(surname)) continue;
      if (given.length > 2 && !title.includes(given) && !extract.toLowerCase().slice(0, 200).includes(given)) continue;
      if (!SCIENCE_RE.test(extract)) continue;
      if (/\b(is a (film|song|album|band|village|town|genus|species|company))\b/i.test(extract)) continue;
      return {
        bio: extract.split('. ').slice(0, 2).join('. ').slice(0, 320),
        thumb: page.thumbnail?.source || '',
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
      };
    }
    return null;
  } catch { return null; }
}
