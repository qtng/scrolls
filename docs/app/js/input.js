/*
The input of Nôm Notes (app/) on the editor (editor.js): the logic of Qatt.org Notes (notes-editor.js) for ProseMirror instead of a text area.
Needs VietnameseParser (parser.js), QattText (qatt-text.js), PaText (pa-text.js), VietIme (ime.js) and PM.

Modes (the dropdown in the menu, app.js):
  'telex'   Telex: Vietnamese is typed with Telex in the text; the words stay Latin
  'off'     no Telex: for a keyboard or system method that writes Quốc Ngữ itself
In both the key bar shows the candidates of the word before the caret: QATT first, PA second, then the Chữ Nôm characters (the first of them marked);
after QATT characters the variants. Space and Enter take the first Chữ Nôm candidate (Shift+Space, Shift+Enter do not). The QATT and PA cells stay whole: the caret does not stop inside one, Backspace and Delete remove a whole cell,
joiners that join nothing go.

  NomInput.plugin            the ProseMirror plugin (editor.js puts it first)
  NomInput.setMode(m), .mode
  NomInput.candidates()      the word before the caret as QATT and PA { glyph, script, run() }, then the Chữ Nôm characters { glyph, reading, definition, first?, run() }
  NomInput.variants()        the three slots [neutral, tham, plain]: { id, view, en, vi, run() } or undefined
  NomInput.setDecoding(name, recode)  the rhyme table; recode: every cell of the document is read with the old one and written with the new one
  NomInput.onUpdate          called after every change of the editor (the key bar follows it)
*/
const NomInput = (() => {
  const { Plugin, TextSelection } = PM;
  const NOT_LETTER = /[^\p{Script=Latin}\p{M}]/u, WORD_END = /[\p{Script=Latin}\p{M}]+$/u;   // Han characters are letters too, but no Quốc Ngữ
  const LETTER = c => c >= 0xF0000 && c <= 0xF0099, JOINER = 0xF009A, COMBINER = 0xF009B, NEUTRAL = 0xF009C;
  const PA_J = 0xF00D0, PA_K = 0xF00D1, PA_ONSET = c => c >= 0xF00D2 && c <= 0xF00E8, PA_NUC = c => c >= 0xF00E9 && c <= 0xF00FE, PA_END = c => c >= 0xF00FF && c <= 0xF010E;
  const IS_LINK = s => /^[\u{F009A}\u{F009B}\u{F00D0}\u{F00D1}]$/u.test(s);
  const RUBY_OVER = 0xF00B0, RUBY_UNDER = 0xF00B1, RUBY_BASE = c => (c >= 0x2E80 && c <= 0xD7FF) || (c >= 0xF900 && c <= 0xFAFF) || (c >= 0x20000 && c <= 0x3FFFF);
  const RUBY_BASE_RE = '[\\u{2E80}-\\u{D7FF}\\u{F900}-\\u{FAFF}\\u{20000}-\\u{3FFFF}]', RUBY_START = new RegExp('^' + RUBY_BASE_RE + '[\\u{F00B0}\\u{F00B1}]', 'u');
  const rubyUnit = () => RUBY_BASE_RE + '[\\u{F00B0}\\u{F00B1}](?:' + (typeof PaText === 'undefined' ? '' : PaText.CELL.source + '(?:[\\u{F00FF}-\\u{F0108}][\\u{F0109}-\\u{F010E}]?)?|') + QattText.CELL.source + ')';
  const cellAny = () => new RegExp(rubyUnit() + '|' + QattText.CELL.source + '|' + (typeof PaText === 'undefined' ? '' : PaText.CELL.source + '|') + '[\\u{F009A}-\\u{F00A3}]+|[\\u{F00D0}\\u{F00D1}]|[^]', 'gu');
  const WINDOW = 64;

  let view = null, mode = 'telex';
  const parser = new VietnameseParser('qatt');
  const telexOn = () => mode === 'telex';

  // the textblock with the caret: its text (all inline content is text, so offsets in it are positions from its start) and the caret in it
  const block = state => {
    const sel = state.selection;
    if (!sel.empty || !sel.$from.parent.isTextblock) return null;
    const $c = sel.$from, p = $c.parent;
    return { start: $c.start(), text: p.textBetween(0, p.content.size, null, '￼'), at: $c.parentOffset };
  };
  // a word in QATT or PA characters (or null)
  const inScript = (word, sc) => (sc === 'pa' ? (typeof PaText !== 'undefined' && PaText.word(word, parser, { stacked: true })) : QattText.word(word, parser)) || null;

  // ----- the cells -----
  const cellAt = (text, pos, which) => {
    const from = Math.max(0, pos - WINDOW), part = text.slice(from, pos + WINDOW);
    for (const m of part.matchAll(cellAny())) {
      const start = from + m.index, end = start + m[0].length;
      if (which === 'before' ? (start < pos && pos <= end) : which === 'after' ? (start <= pos && pos < end) : (start < pos && pos < end)) return { start, end };
    }
    return null;
  };
  // the joiners and combiners of a textblock that join nothing: [offset, length] from the end
  const orphans = text => {
    const cps = Array.from(text, ch => ch.codePointAt(0)), out = [];
    let open = false, prev = 0, i = 0;
    cps.forEach((c, k) => {
      const next = cps[k + 1], len = c > 0xFFFF ? 2 : 1;
      let keep = true;
      if (LETTER(c)) open = prev !== JOINER && prev !== COMBINER;
      else if (c === JOINER) { keep = open && LETTER(next); open = false; }
      else if (c === COMBINER) { keep = LETTER(prev) && LETTER(next); open = false; }
      else if (c === RUBY_OVER || c === RUBY_UNDER) { keep = RUBY_BASE(prev) && (PA_ONSET(next) || LETTER(next)); open = false; }
      else if (c === PA_J) { keep = PA_ONSET(prev) && PA_NUC(next); open = false; }
      else if (c === PA_K) { keep = PA_NUC(prev) && PA_END(next); open = false; }
      else open = false;
      if (keep) prev = c; else out.push([i, len]);
      i += len;
    });
    return out.reverse();
  };
  const tidy = (tr, start, text) => { for (const [i, len] of orphans(text)) tr.delete(start + i, start + i + len); return tr; };
  const blockOf = (doc, pos) => { const $p = doc.resolve(pos); const p = $p.parent; return p.isTextblock ? { start: $p.start(), text: p.textBetween(0, p.content.size, null, '￼') } : null; };

  const put = (from, to, text) => {   // a change of the textblock with the caret (offsets in it)
    const b = block(view.state);
    if (!b) return;
    view.dispatch(view.state.tr.insertText(text, b.start + from, b.start + to).scrollIntoView());
    view.focus();
  };

  // Space and Enter take the preselected candidate (the first Chữ Nôm character of the word before the caret); without one they are as usual,
  // and so are Shift+Space and Shift+Enter (a plain space or line break after a word that stays Latin)
  const takeFirst = () => {
    const c = candidates().find(k => k.first);
    if (!c) return false;
    c.run();
    return true;
  };

  let shiftDown = false;
  const plugin = new Plugin({
    props: {
      handleTextInput(v, from, to, text) {   // a space from a keyboard that sends no key
        return from === to && text === ' ' && !shiftDown && takeFirst();
      },
      handleKeyDown(v, e) {
        shiftDown = e.shiftKey;
        if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return false;
        if (!e.shiftKey && (e.key === ' ' || e.key === 'Enter') && takeFirst()) return true;
        const b = block(v.state);
        if (!b) return false;
        if (e.key !== 'Backspace' && e.key !== 'Delete') return false;
        const back = e.key === 'Backspace', pos = b.at;
        const cell = cellAt(b.text, pos, back ? 'before' : 'after');
        if (!cell || (b.text.codePointAt(cell.start) < 0xF0000 && !RUBY_START.test(b.text.slice(cell.start, cell.end)))) return false;   // other text: as usual
        if (back && cell.end === pos && RUBY_START.test(b.text.slice(cell.start, cell.end))) {   // behind an annotation of the fonts: first only its control goes
          const control = cell.start + Array.from(b.text.slice(cell.start, cell.end))[0].length;
          v.dispatch(v.state.tr.delete(b.start + control, b.start + control + 2));
          return true;
        }
        let from = cell.start, to = cell.end;
        while (from >= 2 && IS_LINK(b.text.slice(from - 2, from))) from -= 2;
        while (to < b.text.length && IS_LINK(b.text.slice(to, to + 2))) to += 2;
        const tr = v.state.tr.delete(b.start + from, b.start + to);
        const nb = blockOf(tr.doc, b.start + from);
        if (nb) tidy(tr, nb.start, nb.text);
        v.dispatch(tr.scrollIntoView());
        return true;
      },
      handleDOMEvents: {
        // keyboards that compose whole words (Android, a system method for Quốc Ngữ): the space comes with the end of the composition and takes the
        // preselected candidate of the word before it
        compositionend(v, e) {
          setTimeout(() => {
            if (!e.data || !e.data.endsWith(' ') || typeof VietIme === 'undefined') return;
            const b = block(v.state);
            if (!b || b.at < 2 || b.text[b.at - 1] !== ' ') return;
            const m = WORD_END.exec(b.text.slice(0, b.at - 1));
            if (!m) return;
            const c = VietIme.lookup(m[0])[0];
            if (c) v.dispatch(v.state.tr.insertText(c.glyph, b.start + b.at - 1 - m[0].length, b.start + b.at).scrollIntoView());
          }, 0);
          return false;
        },
      },
    },
    // a deletion that cut a cell in two becomes the deletion of the whole cell (keyboards that bypass Backspace); joiners that join nothing go;
    // the caret never stays inside a cell (forward: to its end, else to its start)
    appendTransaction(trs, old, state) {
      const tr = state.tr;
      const last = trs[trs.length - 1];
      if (trs.length === 1 && last.docChanged && last.steps.length === 1 && !last.getMeta('nomInput')) {
        const step = last.steps[0], j = step.toJSON();
        if (j.stepType === 'replace' && !j.slice && j.from < j.to) {
          const $a = old.doc.resolve(j.from), $b = old.doc.resolve(j.to);
          if ($a.parent === $b.parent && $a.parent.isTextblock) {
            const start = $a.start(), text = $a.parent.textBetween(0, $a.parent.content.size, null, '￼'), a = j.from - start, z = j.to - start;
            let s = a, e = z;
            for (const m of text.matchAll(cellAny())) { const c0 = m.index, c1 = c0 + m[0].length; if (c0 < a && a < c1) s = c0; if (c0 < z && z < c1) e = c1; }
            if (s < a || e > z) tr.delete(start + s, start + s + (a - s) + (e - z));
          }
        }
      }
      if (trs.some(t => t.docChanged)) {
        const b = blockOf(tr.doc, tr.selection.from);
        if (b) tidy(tr, b.start, b.text);
      }
      if (!(view && view.composing) && tr.selection.empty) {
        const b = block(tr), head = tr.selection.head;
        const cell = b && cellAt(b.text, b.at);
        if (cell) tr.setSelection(TextSelection.create(tr.doc, b.start + (head > old.selection.head ? cell.end : cell.start)));
      }
      return tr.docChanged || tr.selectionSet ? tr.setMeta('nomInput', true) : null;
    },
    view(v) { view = v; return { update: () => api.onUpdate && api.onUpdate() }; },
  });
  // block() also takes a transaction (its selection and doc)
  const blockFrom = block;

  // ----- the key bar -----
  // the word before the caret (not in the middle of a word), as Latin letters: { word, from, at } or null
  const wordBefore = () => {
    if (!view || typeof VietIme === 'undefined') return null;
    const b = block(view.state);
    if (!b) return null;
    const next = b.text.charAt(b.at);
    if (next && !NOT_LETTER.test(next)) return null;
    const m = WORD_END.exec(b.text.slice(0, b.at));
    if (!m) return null;
    return { word: view.composing && telexOn() ? VietIme.telex(m[0]) : m[0], from: b.at - m[0].length, at: b.at };
  };
  // QATT first, PA second, then the Chữ Nôm characters (the first of them marked)
  const candidates = () => {
    const w = wordBefore();
    if (!w) return [];
    const out = [];
    for (const sc of ['qatt', 'pa']) { const glyph = inScript(w.word, sc); if (glyph) out.push({ glyph, script: sc, run: () => put(w.from, w.at, glyph) }); }
    VietIme.lookup(w.word).forEach((c, i) => out.push({ ...c, first: i === 0, run: () => put(w.from, w.at, c.glyph) }));
    return out;
  };
  // the variants of the QATT characters before the caret (Tham Thư, Neutral tone, Unmarked)
  const variants = () => {
    const SLOTS = ['neutral', 'tham', 'plain'];
    if (!view) return SLOTS.map(() => undefined);
    const b = block(view.state);
    if (!b) return SLOTS.map(() => undefined);
    const at = b.at, utf16 = c => (c > 0xFFFF ? 2 : 1);
    const before = Array.from(b.text.slice(0, at), ch => ch.codePointAt(0)), after = b.text.codePointAt(at);
    if (after === JOINER || after === COMBINER) return SLOTS.map(() => undefined);
    let j = before.length - 1;
    while (j >= 0 && before[j] >= 0xF009C && before[j] <= 0xF00A3) j--;
    const pos = i => before.slice(0, i).reduce((n, c) => n + utf16(c), 0);
    const edit = (from, length, text, caret) => {
      const tr = view.state.tr.insertText(text, b.start + from, b.start + from + length);
      tr.setSelection(TextSelection.create(tr.doc, b.start + caret));
      view.dispatch(tr);
      view.focus();
    };
    const list = [], str = (...cps) => String.fromCodePoint(...cps);
    const cellEnding = k => before.slice(before[k - 1] === JOINER && k >= 2 && LETTER(before[k - 2]) ? k - 2 : k, k + 1);
    const tones = before.slice(j + 1);
    if (j >= 1 && LETTER(before[j]) && (before[j] - 0xF0000) % 7 !== 1 && LETTER(before[j - 1]) && before[j - 2] !== COMBINER)
      list.push({ id: 'tham', en: 'Tham Thư', vi: 'Tham Thư', view: str(...cellEnding(j - 1), COMBINER, before[j], ...tones), run: () => edit(pos(j), 0, str(COMBINER), at + 2) });
    if (j >= 0 && LETTER(before[j]) && (before[j] - 0xF0000) % 7 === 1 && before[j - 1] !== JOINER && before[j - 1] !== COMBINER)
      list.push({ id: 'plain', en: 'Unmarked', vi: 'Dạng không đánh dấu', view: str(before[j] - 1, ...tones), run: () => edit(pos(j), 2, str(before[j] - 1), at) });
    if (j === before.length - 1 && j >= 0 && LETTER(before[j]))
      list.push({ id: 'neutral', en: 'Neutral tone', vi: 'Thanh ngang', view: str(...cellEnding(j), NEUTRAL), run: () => edit(at, 0, str(NEUTRAL), at + 2) });
    return SLOTS.map(id => list.find(v => v.id === id));
  };

  // the rhyme table; recode: every QATT cell of the document is read with the old table and written with the new one
  function setDecoding(name, recode) {
    if (recode && view && name !== parser.decoding) {
      const next = new VietnameseParser(name, parser.extra), tr = view.state.tr, nodes = [];
      view.state.doc.descendants((node, pos) => { if (node.isText && /[\u{F0000}-\u{F00A3}]/u.test(node.text)) nodes.push([node, pos]); });
      for (const [node, pos] of nodes.reverse()) {
        const text = QattText.recode(node.text, parser, next);
        if (text !== node.text) tr.replaceWith(pos, pos + node.nodeSize, view.state.schema.text(text, node.marks));
      }
      if (tr.docChanged) view.dispatch(tr);
    }
    parser.setDecoding(name);
  }

  const api = {
    plugin, parser, candidates, variants, setDecoding, onUpdate: null,
    cells: text => Array.from(text.matchAll(cellAny()), m => m[0]),   // the cells of a text (a QATT or PA cell whole)
    get mode() { return mode; },
    setMode(m) { mode = m === 'off' ? 'off' : 'telex'; return mode; },
    telexOn,
  };
  void blockFrom;
  return api;
})();
