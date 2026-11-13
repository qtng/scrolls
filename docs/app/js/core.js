/*
The logic of Nôm Notes (app/) that needs no browser: titles, search text, export and import (after NotesCore of Qatt.org Notes).
A document is { id, content, text, created, updated } (milliseconds): content = the ProseMirror JSON of the editor (editor.js), text = its plain text (one block a line;
kept for the list and the search). It may have title (set by hand, at most 80 code points), format: { font, size, decoding } (only what differs from the defaults) and
style: the css of its style (background, color, text-shadow) as base64 (styles.js).

  DocsCore.title(text, custom)               the title set by hand if it has a character that is no space, else the first line with one, trimmed, at most 80 code points
  DocsCore.preview(text, custom)             the text after the title line (all of it with a title set by hand) on one line, at most 120 code points
  DocsCore.matches(text, query, cellReading) whether the folded query is in the text or in its readings (QATT cells read with cellReading(cell))
  DocsCore.exportJSON(docs)                  the file { app: 'nom-notes', version: 1, docs }
  DocsCore.parseImport(json)                 { ok: true, docs } or { ok: false, error }; one bad document refuses the file
  DocsCore.merge(existing, incoming)         by id, the larger `updated` wins: { docs, added, updated }
*/
const DocsCore = (() => {
  const cleanFormat = f => {
    if (!f || typeof f !== 'object') return null;
    const out = {};
    if (typeof f.font === 'string' && f.font.length <= 60) out.font = f.font;
    if (Number.isFinite(f.size)) out.size = Math.min(300, Math.max(50, f.size));
    if (typeof f.decoding === 'string' && /^[a-z][a-z0-9_-]*$/.test(f.decoding) && f.decoding.length <= 40) out.decoding = f.decoding;
    return Object.keys(out).length ? out : null;
  };
  const cut = (s, n) => Array.from(s).slice(0, n).join('');
  const lines = text => text.split(/\r?\n/);
  const titleIndex = text => lines(text).findIndex(l => /\S/.test(l));
  const title = (text, custom) => {
    if (typeof custom === 'string' && /\S/.test(custom)) return cut(custom.trim(), 80);
    const i = titleIndex(text);
    return i < 0 ? '' : cut(lines(text)[i].trim(), 80);
  };
  const preview = (text, custom) => {
    const i = typeof custom === 'string' && /\S/.test(custom) ? -1 : titleIndex(text);
    return i < 0 && !/\S/.test(text) ? '' : cut(lines(text).slice(i + 1).map(l => l.trim()).filter(Boolean).join(' '), 120);
  };
  const fold = s => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd');
  const readingText = (text, cellReading) => (typeof QattText === 'undefined' ? text : text.replace(QattText.CELL, cell => {
    const r = cellReading(cell);
    return r && r !== '?' ? ` ${r} ` : cell;
  }));
  const matches = (text, query, cellReading) => {
    const q = fold(query).trim();
    return !q || fold(text).includes(q) || fold(readingText(text, cellReading)).includes(q);
  };
  const exportJSON = docs => JSON.stringify({ app: 'nom-notes', version: 1, docs });
  const valid = d => d && typeof d === 'object' && typeof d.id === 'string' && d.id !== '' && d.content && typeof d.content === 'object' && d.content.type === 'doc'
    && Number.isFinite(d.created) && Number.isFinite(d.updated);
  const parseImport = json => {
    let data;
    try { data = JSON.parse(json); } catch (e) { return { ok: false, error: 'Not a file of Nôm Notes' }; }
    if (!data || data.app !== 'nom-notes' || data.version !== 1 || !Array.isArray(data.docs)) return { ok: false, error: 'Not a file of Nôm Notes' };
    if (!data.docs.every(valid)) return { ok: false, error: 'The file has an invalid document' };
    return { ok: true, docs: data.docs.map(d => ({ id: d.id, content: d.content, text: typeof d.text === 'string' ? d.text : '', created: d.created, updated: d.updated,
      ...(typeof d.style === 'string' && d.style.length <= 50000 ? { style: d.style } : {}), ...(typeof d.title === 'string' && /\S/.test(d.title) ? { title: cut(d.title.trim(), 80) } : {}),
      ...(cleanFormat(d.format) ? { format: cleanFormat(d.format) } : {}) })) };
  };
  const merge = (existing, incoming) => {
    const byId = new Map(existing.map(d => [d.id, { ...d }]));
    let added = 0, updated = 0;
    for (const d of incoming) {
      const old = byId.get(d.id);
      if (!old) { byId.set(d.id, { ...d }); added++; continue; }
      if (d.updated > old.updated) { byId.set(d.id, { ...d }); updated++; }
    }
    return { docs: Array.from(byId.values()).sort((a, b) => b.updated - a.updated), added, updated };
  };
  return { title, preview, fold, matches, exportJSON, parseImport, merge };
})();
if (typeof module !== 'undefined') module.exports = DocsCore;
