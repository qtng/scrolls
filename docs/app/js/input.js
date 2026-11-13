/*
The input of Nôm Notes (app/) on the editor (editor.js): the logic of Qatt.org Notes (notes-editor.js) for ProseMirror instead of a text area.
Needs VietnameseParser (parser.js), QattText (qatt-text.js), PaText (pa-text.js), VietIme (ime.js) and PM.

Modes (the dropdown of the format bar, app.js):
  'qn'      Quốc Ngữ: Telex, the words stay Latin; the key bar shows the Chữ Nôm candidates of the word before the caret
  'qatt'    QATT Telex: a word becomes QATT characters at a space or any other character that is no letter (the space goes: the cells are squares);
            Enter turns it into PA instead (the first slot of the key bar). The key bar: PA, then the Chữ Nôm candidates; after a QATT word the variants
  'pa'      PA Telex: a word becomes PA at a space; Enter and the first slot give QATT
  'direct'  QATT direct input: no Telex; the 22 shapes in a bar of their own; a digit 1–8 behind a letter is its tone
  'off'     no Telex
In every mode the QATT and PA cells stay whole: the caret does not stop inside one, Backspace and Delete remove a whole cell, joiners that join nothing go.

  NomInput.plugin            the ProseMirror plugin (editor.js puts it first)
  NomInput.setMode(m), .mode
  NomInput.candidates()      [{ glyph, reading, definition, run() }] of the word before the caret
  NomInput.alternate()       { glyph, script, run() } or null: the word before the caret in the other script
  NomInput.variants()        the three slots [neutral, tham, plain]: { id, view, en, vi, run() } or undefined
  NomInput.shapes, .typeShape(k)   direct input
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
  const DIRECT_ORDER = [5, 0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
  const MARK_CYCLE = [0, 2, 3, 4, 5, 6, 1], DIRECT_TONES = [null, 160, 157, 158, 159, 161, 162, 163, 156];
  const WINDOW = 64;

  let view = null, mode = 'qn';
  const parser = new VietnameseParser('qatt');
  const telexOn = () => mode !== 'direct' && mode !== 'off';
  const script = () => (mode === 'pa' ? 'pa' : 'qatt');
  const enterScript = () => (mode === 'pa' ? 'qatt' : 'pa');
  const converts = () => mode === 'qatt' || mode === 'pa';

  // the textblock with the caret: its text (all inline content is text, so offsets in it are positions from its start) and the caret in it
  const block = state => {
    const sel = state.selection;
    if (!sel.empty || !sel.$from.parent.isTextblock) return null;
    const $c = sel.$from, p = $c.parent;
    return { start: $c.start(), text: p.textBetween(0, p.content.size, null, '￼'), at: $c.parentOffset };
  };
  // the word that ends at `end` of a text in the script: { from, text } or null
  const convertWord = (text, end, sc) => {
    const m = WORD_END.exec(text.slice(0, end));
    if (!m) return null;
    const out = sc === 'pa' ? (typeof PaText !== 'undefined' && PaText.word(m[0], parser, { stacked: true })) : QattText.word(m[0], parser);
    return out ? { from: end - m[0].length, text: out } : null;
  };

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

  // ----- typing -----
  function convertAt(view, pos, typed) {   // the character `typed` comes at `pos`: the word before it converts; a space goes
    const b = blockOf(view.state.doc, pos);
    if (!b) return false;
    const end = pos - b.start, w = convertWord(b.text, end, script());
    if (!w) return false;
    const tr = view.state.tr.insertText(w.text, b.start + w.from, pos);
    if (typed && !/^\s$/.test(typed)) tr.insertText(typed);
    view.dispatch(tr.scrollIntoView());
    return true;
  }
  const cpBefore = (text, at) => { const c = text.codePointAt(at - 2); return c > 0xFFFF ? c : text.charCodeAt(at - 1); };
  const put = (from, to, text) => {   // a change of the textblock with the caret (offsets in it)
    const b = block(view.state);
    if (!b) return;
    const tr = view.state.tr.insertText(text, b.start + from, b.start + to);
    view.dispatch(tr.scrollIntoView());
    view.focus();
  };

  const plugin = new Plugin({
    props: {
      handleTextInput(v, from, to, text) {
        if (from !== to || text.length < 1) return false;
        if (mode === 'direct' && /^[1-8]$/.test(text)) {   // a digit behind a letter (and its tone marks) gives that tone; another digit replaces it
          const b = blockOf(v.state.doc, from);
          if (!b) return false;
          const at = from - b.start;
          let f = at;
          while (f >= 2 && cpBefore(b.text, f) >= 0xF009C && cpBefore(b.text, f) <= 0xF00A3) f -= 2;
          if (f < 2 || !LETTER(cpBefore(b.text, f))) return false;
          v.dispatch(v.state.tr.insertText(String.fromCodePoint(0xF0000 + DIRECT_TONES[+text]), b.start + f, from));
          return true;
        }
        if (!converts() || v.composing || !NOT_LETTER.test(text)) return false;
        return convertAt(v, from, text);
      },
      handleKeyDown(v, e) {
        if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return false;
        const b = block(v.state);
        if (!b) return false;
        if (e.key === 'Enter' && !e.shiftKey && converts()) {   // Enter takes the first slot: the word in the other script
          const w = convertWord(b.text, b.at, enterScript());
          if (!w) return false;
          v.dispatch(v.state.tr.insertText(w.text, b.start + w.from, b.start + b.at).scrollIntoView());
          return true;
        }
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
        // keyboards that compose whole words (Android): the space comes with the end of the composition
        compositionend(v, e) {
          setTimeout(() => {
            if (!converts() || !e.data || !NOT_LETTER.test(e.data.slice(-1))) return;
            const b = block(v.state);
            if (!b || b.at < 1) return;
            const typed = b.text.slice(b.at - 1, b.at);
            if (!NOT_LETTER.test(typed)) return;
            const w = convertWord(b.text, b.at - 1, script());
            if (!w) return;
            const tr = v.state.tr.insertText(w.text + (/^\s$/.test(typed) ? '' : typed), b.start + w.from, b.start + b.at);
            v.dispatch(tr.scrollIntoView());
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
  const candidates = () => {
    if (!view || mode === 'direct' || mode === 'off' || typeof VietIme === 'undefined') return [];
    const b = block(view.state);
    if (!b) return [];
    const next = b.text.charAt(b.at);
    if (next && !NOT_LETTER.test(next)) return [];   // in the middle of a word
    const m = WORD_END.exec(b.text.slice(0, b.at));
    if (!m) return [];
    const from = b.at - m[0].length, word = view.composing ? VietIme.telex(m[0]) : m[0];
    return VietIme.lookup(word).map(c => ({ ...c, run: () => put(from, b.at, c.glyph) }));
  };
  const alternate = () => {
    if (!view || !converts()) return null;
    const b = block(view.state);
    if (!b) return null;
    const next = b.text.charAt(b.at);
    if (next && !NOT_LETTER.test(next)) return null;
    const m = WORD_END.exec(b.text.slice(0, b.at));
    if (!m) return null;
    const sc = enterScript(), word = view.composing ? VietIme.telex(m[0]) : m[0];
    const glyph = sc === 'pa' ? (typeof PaText !== 'undefined' && PaText.word(word, parser, { stacked: true })) : QattText.word(word, parser);
    if (!glyph) return null;
    const from = b.at - m[0].length;
    return { glyph, script: sc, run: () => put(from, b.at, glyph) };
  };
  // the variants of the QATT characters before the caret (Tham Thư, Neutral tone, Unmarked)
  const variants = () => {
    const SLOTS = ['neutral', 'tham', 'plain'];
    if (!view || mode === 'pa') return SLOTS.map(() => undefined);
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

  // ----- direct input: the shape k (the order of VietnameseParser.SHAPES), as in Qatt.org Notes -----
  function typeShape(k) {
    const b = view && block(view.state);
    if (!b) return;
    const text = b.text, at = b.at, base = 7 * DIRECT_ORDER[k];
    const prev = at >= 2 ? cpBefore(text, at) : 0;
    const J = String.fromCodePoint(JOINER), mark = c => (c - 0xF0000) % 7;
    const marked = c => LETTER(c) && mark(c) !== 0;
    const firstPart = end => end >= 2 && marked(cpBefore(text, end)) && mark(cpBefore(text, end)) !== 1 && !(end >= 4 && (cpBefore(text, end - 2) === JOINER || cpBefore(text, end - 2) === COMBINER));
    let from, cp;
    if (prev >= 0xF0000 + base && prev < 0xF0000 + base + 7) {   // iterate the letter before the caret
      const inPair = at >= 4 && cpBefore(text, at - 2) === JOINER;
      let i = MARK_CYCLE.indexOf(prev - 0xF0000 - base);
      do i = (i + 1) % MARK_CYCLE.length; while (inPair && MARK_CYCLE[i] === 1);
      cp = 0xF0000 + base + MARK_CYCLE[i]; from = at - 2;
      if (inPair && MARK_CYCLE[i] !== 0 && marked(cpBefore(text, at - 4))) { put(at - 4, at, String.fromCodePoint(cp)); return; }
    } else if (LETTER(prev) && mark(prev) !== 1 && !(at >= 4 && (cpBefore(text, at - 2) === JOINER || cpBefore(text, at - 2) === COMBINER))) {
      put(at, at, J + String.fromCodePoint(0xF0000 + base)); return;   // behind a letter: a pair
    } else {
      from = text[at - 1] === ' ' ? at - 1 : at;   // a space right before it goes
      cp = 0xF0000 + base;
    }
    put(from, at, (mark(cp) === 0 && firstPart(from) ? J : '') + String.fromCodePoint(cp));
  }

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
    plugin, parser, candidates, alternate, variants, typeShape, setDecoding, onUpdate: null,
    shapes: DIRECT_ORDER.map(i => String.fromCodePoint(0xF0000 + 7 * i)),
    get mode() { return mode; },
    setMode(m) { mode = ['qn', 'qatt', 'pa', 'direct', 'off'].includes(m) ? m : 'qn'; if (m === 'pa' && typeof PaText === 'undefined') mode = 'qatt'; return mode; },
    telexOn,
  };
  void blockFrom;
  return api;
})();
