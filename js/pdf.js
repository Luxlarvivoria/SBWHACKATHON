const PAGE = { w: 595.28, h: 841.89 };
const MARGIN = { top: 64, bottom: 64, left: 56, right: 56 };
const COL = PAGE.w - MARGIN.left - MARGIN.right;

const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

const STYLES = {
  h1:   { font: 'F2', size: 19, lead: 24, gap: 6,  gray: 0 },
  h2:   { font: 'F2', size: 10, lead: 14, gap: 16, gray: 0.35 },
  p:    { font: 'F1', size: 10.5, lead: 15, gap: 8, gray: 0.12 },
  lead: { font: 'F1', size: 12, lead: 17, gap: 10, gray: 0.12 },
  li:   { font: 'F1', size: 10.5, lead: 15, gap: 5, gray: 0.12, indent: 16, bullet: '•' },
  meta: { font: 'F1', size: 9, lead: 13, gap: 4, gray: 0.45 },
  quote:{ font: 'F1', size: 10.5, lead: 15.5, gap: 8, gray: 0.2, indent: 14, bar: true },
};

const FOLD = [
  [/[‘’‚′]/g, "'"], [/[“”„″]/g, '"'],
  [/[–—‒]/g, '-'], [/…/g, '...'], [/[   ]/g, ' '],
  [/[≤]/g, '<='], [/[≥]/g, '>='], [/×/g, 'x'], [/±/g, '+/-'],
  [/→/g, '->'], [/[•▪▸]/g, '-'], [/µ/g, 'u'], [/−/g, '-'],
];

function ascii(s) {
  let out = String(s ?? '');
  for (const [re, sub] of FOLD) out = out.replace(re, sub);

  return out.replace(/[^\x20-\x7E]/g, '');
}

const escapePDF = (s) => s.replace(/([\\()])/g, '\\$1');

function widthOf(text, font, size) {
  const table = font === 'F2' ? W_BOLD : W_REG;
  let w = 0;
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    w += (c >= 32 && c <= 126) ? table[c - 32] : 500;
  }
  return (w / 1000) * size;
}

function wrap(text, font, size, maxWidth) {
  const words = ascii(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const trial = line ? `${line} ${word}` : word;
    if (widthOf(trial, font, size) <= maxWidth || !line) line = trial;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function layout(blocks, footer) {
  const pages = [];
  let ops = [];
  let y = PAGE.h - MARGIN.top;

  const newPage = () => { pages.push(ops); ops = []; y = PAGE.h - MARGIN.top; };
  const room = (need) => { if (y - need < MARGIN.bottom) newPage(); };

  for (const block of blocks) {
    if (block.style === 'rule') {
      room(14);
      y -= 8;
      ops.push(`0.85 0.85 0.85 RG 0.7 w ${MARGIN.left} ${y.toFixed(2)} m ${(PAGE.w - MARGIN.right).toFixed(2)} ${y.toFixed(2)} l S`);
      y -= 10;
      continue;
    }
    if (block.style === 'gap') { y -= block.size || 10; continue; }

    const st = STYLES[block.style] || STYLES.p;
    const indent = st.indent || 0;
    const lines = wrap(block.text, st.font, st.size, COL - indent);
    y -= st.gap;

    lines.forEach((line, i) => {
      room(st.lead);
      const x = MARGIN.left + indent;
      if (st.bullet && i === 0) {
        ops.push(`BT /F1 ${st.size} Tf ${st.gray} ${st.gray} ${st.gray} rg 1 0 0 1 ${MARGIN.left} ${(y - st.size).toFixed(2)} Tm (-) Tj ET`);
      }
      if (st.bar) {
        ops.push(`0.55 0.72 0.70 RG 2 w ${(MARGIN.left + 3).toFixed(2)} ${(y - st.size - 2).toFixed(2)} m ${(MARGIN.left + 3).toFixed(2)} ${(y + 2).toFixed(2)} l S`);
      }
      ops.push(`BT /${st.font} ${st.size} Tf ${st.gray} ${st.gray} ${st.gray} rg 1 0 0 1 ${x.toFixed(2)} ${(y - st.size).toFixed(2)} Tm (${escapePDF(line)}) Tj ET`);
      y -= st.lead;
    });
  }
  pages.push(ops);

  return pages.map((page, i) => [
    ...page,
    `BT /F1 8 Tf 0.55 0.55 0.55 rg 1 0 0 1 ${MARGIN.left} ${(MARGIN.bottom - 26).toFixed(2)} Tm (${escapePDF(ascii(footer))}) Tj ET`,
    `BT /F1 8 Tf 0.55 0.55 0.55 rg 1 0 0 1 ${(PAGE.w - MARGIN.right - 40).toFixed(2)} ${(MARGIN.bottom - 26).toFixed(2)} Tm (${i + 1} / ${pages.length}) Tj ET`,
  ]);
}

export function buildPDF(blocks, { title = 'Summary', footer = 'Consilium' } = {}) {
  const pages = layout(blocks, footer);
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };

  const catalogId = add('');
  const pagesId = add('');
  const fontRegId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontBoldId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  const pageIds = [];
  for (const ops of pages) {
    const stream = ops.join('\n');
    const contentId = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] `
      + `/Resources << /Font << /F1 ${fontRegId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }

  const infoId = add(`<< /Title (${escapePDF(ascii(title))}) /Producer (Consilium) /Creator (Consilium) >>`);
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  const enc = new TextEncoder();
  const chunks = [];
  let offset = 0;
  const push = (str) => { const bytes = enc.encode(str); chunks.push(bytes); offset += bytes.length; };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const offsets = [];
  objects.forEach((body, i) => {
    offsets[i] = offset;
    push(`${i + 1} 0 obj\n${body}\nendobj\n`);
  });

  const xrefStart = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

export function downloadPDF(blocks, meta, filename) {
  const blob = new Blob([buildPDF(blocks, meta)], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
