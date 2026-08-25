import { settle, searchUrl, keywords, truncate } from './util.js';
import { topAuthors, authorProfile, wikiPerson, mediaPieces } from './sources.js';

export function interviewLinks(name, topic) {
  const t = keywords(topic, 5).join(' ');
  return [
    { label: 'Video interviews', icon: '▶', url: searchUrl.youtube(`${name} interview ${t}`) },
    { label: 'Podcasts', icon: '🎙', url: searchUrl.podcast(`${name}`) },
    { label: 'News & quotes', icon: '📰', url: searchUrl.news(`"${name}" ${t}`) },
    { label: 'Talks & lectures', icon: '🎤', url: searchUrl.youtube(`${name} lecture talk ${t}`) },
    { label: 'Scholar profile', icon: '🎓', url: searchUrl.scholar(`author:"${name}"`) },
  ];
}

export function topicLinks(topic) {
  return [
    { label: 'Interviews on this topic', icon: '▶', url: searchUrl.youtube(`${topic} scientist interview`) },
    { label: 'Expert reaction & news', icon: '📰', url: searchUrl.news(`${topic} scientists`) },
    { label: 'Podcast episodes', icon: '🎙', url: searchUrl.podcast(topic) },
    { label: 'Science Media Centre', icon: '🗣', url: searchUrl.google(`site:sciencemediacentre.org ${topic}`) },
    { label: 'Debate & criticism', icon: '⚖', url: searchUrl.google(`${topic} "critics say" OR "disputed" OR "debate" scientist`) },
  ];
}

export async function findVoices(topic, { limit = 6 } = {}) {
  let leaders = [];
  try { leaders = await topAuthors(topic, limit); } catch { return []; }
  if (!leaders.length) return [];

  const profiles = await settle(leaders.map((l) => authorProfile(l.openalexId)));
  const wikis = await settle(leaders.map((l) => wikiPerson(l.name)));

  return leaders.map((l, i) => {
    const p = profiles[i].ok ? profiles[i].value : {};
    const w = wikis[i].ok ? wikis[i].value : null;
    return {
      name: l.name,
      papersOnTopic: l.papersOnTopic,
      institution: p.institution || '',
      hIndex: p.hIndex,
      cited: p.cited,
      works: p.works,
      orcid: p.orcid || '',
      topics: p.topics || [],
      bio: w?.bio || '',
      thumb: w?.thumb || '',
      wiki: w?.url || '',
      openalex: `https://openalex.org/${l.openalexId}`,
      links: interviewLinks(l.name, topic),
    };
  });
}

const KIND_RE = [
  [/interview|portrait/, 'Interview'],
  [/news/, 'News feature'],
  [/editorial/, 'Editorial'],
  [/comment/, 'Commentary'],
];

export async function findCommentary(topic, limit = 20) {
  let items = [];
  try { items = await mediaPieces(topic, limit); } catch { return []; }
  return items.map((p) => {
    const types = (p.pubTypes || []).join(' ');
    const kind = (KIND_RE.find(([re]) => re.test(types)) || [null, 'Commentary'])[1];
    return {
      kind,
      title: p.title,
      venue: p.venue,
      year: p.year,
      authors: (p.authors || []).map((a) => a.name).slice(0, 3),
      snippet: truncate(p.abstract || '', 260),
      url: p.url,
      isInterview: kind === 'Interview',
    };
  }).sort((a, b) => (b.isInterview - a.isInterview) || (b.year || 0) - (a.year || 0));
}
