/*
The editor of a scroll (edit.html?id=<uuid>; edit.html?local: a test mode without login, kept in this browser only).

A scroll is sections of blocks: doc > section+ > (paragraph | heading)+. A section is horizontal (flowing text) or vertical
(columns of `cols` characters, right to left, continued in bands below). Two-column text (warichu) is a mark; editor.js lays it
out as segments (inline decorations), the bands of vertical sections get their height here. ProseMirror comes from js/prosemirror.js
(window.PM, built in the private repository), the Telex input from /chunom/js/ime.js (no candidate list).
*/
(() => {
'use strict';
const { Schema, EditorState, EditorView, Plugin, PluginKey, TextSelection, Decoration, DecorationSet, keymap, history, undo, redo,
        baseKeymap, toggleMark, setBlockType, dropCursor, Fragment, Slice } = PM;
const QATT = 'https://qatt.org';

const T = (en, vi) => (window.Lang ? Lang.t(en, vi) : en);
const MIN_COLS = 2, MAX_COLS = 40, DEFAULT_COLS = 10;
const COLS_OPTIONS = [4, 6, 8, 10, 12, 16, 20, 24, 30, 36, 42];
const clampCols = n => Math.max(MIN_COLS, Math.min(MAX_COLS, Math.round(n) || DEFAULT_COLS));
const el = (tag, props = {}, ...children) => { const e = Object.assign(document.createElement(tag), props); e.append(...children); return e; };
// a text in a tag of its own with its Vietnamese text (translated by Lang of navigation.js)
const vi = (en, viText, tag = 'span') => { const e = el(tag, { textContent: en }); e.setAttribute('data-vi', viText); return e; };
const titled = (e, en, viText) => { e.title = en; e.setAttribute('data-vi-title', viText); e.setAttribute('aria-label', en); e.setAttribute('data-vi-aria-label', viText); return e; };

// ---------------------------------------------------------------- schema
const schema = new Schema({
    nodes: {
        doc: { content: 'section+' },
        section: {
            content: 'block+',
            isolating: true,
            attrs: { dir: { default: 'v' }, cols: { default: DEFAULT_COLS } },
            parseDOM: [{ tag: 'section.sec', getAttrs: d => ({ dir: d.dataset.dir === 'h' ? 'h' : 'v', cols: clampCols(+d.dataset.cols) }) }],
            toDOM: n => ['section', { class: 'sec shadow p-3 ' + n.attrs.dir, 'data-dir': n.attrs.dir, 'data-cols': n.attrs.cols, style: `--cols: ${n.attrs.cols}` }, 0],
        },
        paragraph: { group: 'block', content: 'inline*', parseDOM: [{ tag: 'p' }], toDOM: () => ['p', 0] },
        heading: {
            group: 'block', content: 'inline*', defining: true,
            attrs: { level: { default: 1 } },
            parseDOM: [{ tag: 'h1', attrs: { level: 1 } }, { tag: 'h2', attrs: { level: 2 } }, { tag: 'h3', attrs: { level: 2 } }],
            toDOM: n => ['h' + n.attrs.level, 0],
        },
        text: { group: 'inline' },
    },
    marks: {
        warichu: { excludes: 'warichu ruby', parseDOM: [{ tag: 'span.wari' }], toDOM: () => ['span', { class: 'wari' }, 0] },
        // ruby: rt = the text shown (Quốc Ngữ, PA or QATT), qn = the reading in Quốc Ngữ (to edit it again), side = over (vertical: right) or under (left)
        ruby: {
            attrs: { rt: { default: '' }, qn: { default: '' }, side: { default: 'over' } },
            inclusive: false,
            excludes: 'ruby warichu',
            parseDOM: [{ tag: 'span.rb', contentElement: '.rb-b', getAttrs: d => ({ rt: d.getAttribute('data-rt') || '', qn: d.getAttribute('data-qn') || '', side: d.getAttribute('data-side') === 'under' ? 'under' : 'over' }) }],
            toDOM: m => ['span', { class: 'rb', 'data-rt': m.attrs.rt, 'data-qn': m.attrs.qn, 'data-side': m.attrs.side }, ['span', { class: 'rb-b' }, 0], ['span', { class: 'rt', contenteditable: 'false' }, m.attrs.rt]],
        },
    },
});
const S = schema.nodes;
const emptyDoc = (dir = 'v') => S.doc.create(null, S.section.create({ dir, cols: DEFAULT_COLS }, S.paragraph.create()));

// a section keeps its element when its text changes; the height that the layout sets is not a change of the document
class SectionView {
    constructor(node) { this.dom = this.contentDOM = document.createElement('section'); this.node = null; this.set(node); }
    set(node) {
        const d = this.dom, a = node.attrs;
        if (!this.node || this.node.attrs.dir !== a.dir) d.style.height = '';
        d.className = 'sec shadow p-3 ' + a.dir;
        d.dataset.dir = a.dir;
        d.dataset.cols = a.cols;
        d.style.setProperty('--cols', a.cols);
        this.node = node;
    }
    update(node) {
        if (node.type !== S.section) return false;
        if (node.attrs.dir !== this.node.attrs.dir || node.attrs.cols !== this.node.attrs.cols) this.set(node); else this.node = node;
        return true;
    }
    ignoreMutation(m) { return m.type === 'attributes' && m.target === this.dom; }
}

// ---------------------------------------------------------------- commands
const sectionAt = $pos => ({ node: $pos.node(1), pos: $pos.before(1), index: $pos.index(0) });

// Backspace at the start of a section joins it with the one before (whose settings win); Delete at its end with the next one
function joinSectionBackward(state, dispatch) {
    const { $cursor } = state.selection;
    if (!$cursor || $cursor.parentOffset > 0 || $cursor.depth !== 2 || $cursor.index(1) !== 0 || $cursor.index(0) === 0) return false;
    if (dispatch) dispatch(state.tr.join($cursor.before(1)).scrollIntoView());
    return true;
}
function joinSectionForward(state, dispatch) {
    const { $cursor } = state.selection;
    if (!$cursor || $cursor.depth !== 2 || $cursor.parentOffset < $cursor.parent.content.size) return false;
    const sec = $cursor.node(1);
    if ($cursor.index(1) !== sec.childCount - 1 || $cursor.index(0) === state.doc.childCount - 1) return false;
    if (dispatch) dispatch(state.tr.join($cursor.after(1)).scrollIntoView());
    return true;
}
const setHeading = level => (state, dispatch) => {
    const { $from } = state.selection;
    const on = $from.parent.type === S.heading && $from.parent.attrs.level === level;
    return on ? setBlockType(S.paragraph)(state, dispatch) : setBlockType(S.heading, { level })(state, dispatch);
};
const toggleWari = toggleMark(schema.marks.warichu);
const openRuby = () => { RubyBox.open(); return true; };

// the empty paragraph with the caret becomes a section of its own (dir); the text before and after keeps the old section and its settings
function insertSection(view, dir) {
    const { state } = view, { $from } = state.selection;
    if ($from.depth !== 2) return;
    const sec = sectionAt($from), para = $from.parent;
    const lastV = (() => { let c = null; state.doc.forEach(s => { if (s.attrs.dir === 'v' && c === null) c = s.attrs.cols; }); return c; })();
    const cols = sec.node.attrs.dir === 'v' ? sec.node.attrs.cols : (lastV || DEFAULT_COLS);
    let tr = state.tr;
    if (sec.node.childCount === 1) {
        tr.setNodeMarkup(sec.pos, null, { ...sec.node.attrs, dir, cols });
        tr.setSelection(TextSelection.create(tr.doc, sec.pos + 2));
    } else {
        const before = sec.node.content.cut(0, $from.before(2) - sec.pos - 1);
        const after = sec.node.content.cut($from.after(2) - sec.pos - 1);
        const parts = [];
        if (before.size) parts.push(S.section.create(sec.node.attrs, before));
        const fresh = S.section.create({ dir, cols }, S.paragraph.create(null, para.content));
        parts.push(fresh);
        if (after.size) parts.push(S.section.create(sec.node.attrs, after));
        tr.replaceWith(sec.pos, sec.pos + sec.node.nodeSize, parts);
        const freshPos = sec.pos + (before.size ? before.size + 2 : 0);
        tr.setSelection(TextSelection.create(tr.doc, freshPos + 2));
    }
    view.dispatch(tr.scrollIntoView());
    view.focus();
}

// ---------------------------------------------------------------- two-column text and bands: the layout
const layoutKey = new PluginKey('layout');

// The advance of every character at the size of the two-column text: Latin letters are not as long as a cell, so the lines cannot be counted
// in characters.
const measure = {
    cache: new Map(), probe: null,
    // the advance of every character along the line, measured in the DOM as it is set (in a vertical section upright: Latin letters
    // then take their vertical advance, which a canvas cannot measure)
    widths(chars, cs, half, vertical) {
        const font = `${cs.fontStyle} ${cs.fontWeight} ${half}px ${cs.fontFamily}`, orient = vertical ? 'v' : 'h';
        const keyOf = c => orient + font + '\n' + c;
        const missing = [...new Set(chars.filter(c => !this.cache.has(keyOf(c))))];
        if (missing.length) {
            if (!this.probe) {
                this.probe = el('div', { ariaHidden: 'true' });
                this.probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;line-height:1;';
                document.body.append(this.probe);
            }
            const pr = this.probe;
            pr.style.font = font;
            pr.style.writingMode = vertical ? 'vertical-rl' : 'horizontal-tb';
            pr.style.textOrientation = vertical ? 'upright' : 'mixed';
            const spans = missing.map(c => el('span', { textContent: c }));
            pr.replaceChildren(...spans);
            spans.forEach((sp, k) => { const r = sp.getBoundingClientRect(); this.cache.set(keyOf(missing[k]), vertical ? r.height : r.width); });
            pr.replaceChildren();
        }
        return chars.map(c => this.cache.get(keyOf(c)));
    },
};

// The segments of a run of two-column text (chars: code points, widths: their advances in px). The grid of the old prints: a segment takes
// whole cells; the first one fills the rest of the column, the next ones whole columns, the last one is balanced (the first line is the
// longer one); what is left of its last cell stays empty. from/to are offsets in UTF-16 units from the start of the run.
function segments(chars, widths, offset, len, half) {
    const cell = 2 * half, tol = half * 0.05;
    let startPad = Math.ceil((offset - tol) / cell) * cell - offset;
    if (startPad < tol) startPad = 0;
    const cells = px => Math.floor((px + tol) / cell) * cell;
    const full = Math.max(cell, cells(len));
    let cap = cells(len - offset - startPad);
    if (cap < cell) { cap = full; startPad = 0; }
    const em = px => (px / half).toFixed(3) + 'em';
    const out = [];
    let i = 0, u = 0;
    while (i < chars.length) {
        // two lines of at most cap, filled as the browser fills them
        let j = i, lines = 0;
        while (lines < 2 && j < chars.length) {
            let sum = 0, k = j;
            while (k < chars.length && (k === j || sum + widths[k] <= cap + tol)) sum += widths[k++];
            j = k; lines++;
        }
        let style;
        if (j < chars.length) style = `inline-size: ${em(cap)};`;
        else {
            // the last segment: the shortest first line that leaves no more for the second one
            let total = 0, first = 0, k = i;
            for (let x = i; x < j; x++) total += widths[x];
            while (k < j && first < total / 2 - tol) first += widths[k++];
            const size = Math.min(cap, first + 0.5), whole = Math.max(cell, Math.ceil((first - tol) / cell) * cell);
            style = `inline-size: ${em(size)};`;
            if (whole - size > tol) style += ` padding-inline-end: ${em(whole - size)};`;
        }
        if (!out.length && startPad) style += ` margin-inline-start: ${startPad.toFixed(2)}px;`;
        const units = chars.slice(i, j).join('').length;
        out.push({ from: u, to: u + units, style });
        i = j; u += units;
        cap = full;
    }
    return out;
}

// the runs of two-column text: [{ from, to, text }] in document order
function wariRuns(doc) {
    const runs = [], mark = schema.marks.warichu;
    doc.descendants((node, pos) => {
        if (!node.isTextblock) return true;
        let run = null;
        node.forEach((child, offset) => {
            const start = pos + 1 + offset;
            if (child.isText && mark.isInSet(child.marks)) {
                if (run && run.to === start) { run.to += child.nodeSize; run.text += child.text; }
                else { run = { from: start, to: start + child.nodeSize, text: child.text }; runs.push(run); }
            } else run = null;
        });
        return false;
    });
    return runs;
}

const layoutPlugin = new Plugin({
    key: layoutKey,
    state: {
        init: () => DecorationSet.empty,
        apply(tr, segs) {
            const m = tr.getMeta(layoutKey);
            if (m) return m;
            return tr.docChanged ? segs.map(tr.mapping, tr.doc) : segs;
        },
    },
    props: {
        decorations(state) {
            // a marker before every run: the layout measures where the run starts in its column
            const marks = wariRuns(state.doc).map(r => Decoration.widget(r.from, () => el('i', { className: 'mk' }), { side: -1, marks: [], ignoreSelection: true, key: 'mk' }));
            return layoutKey.getState(state).add(state.doc, marks);
        },
        nodeViews: { section: node => new SectionView(node) },
        markViews: { ruby: mark => rubyView(mark) },
// text with the annotation of the QATT fonts (CJK, U+F00B0 over / U+F00B1 under, a PA syllable) becomes ruby
        transformPasted: slice => new Slice(annotToRuby(slice.content), slice.openStart, slice.openEnd),
    },
    view(view) {
        const layout = new Layout(view);
        return { update: (v, prev) => layout.schedule(v.state.doc !== prev.doc), destroy: () => layout.destroy() };
    },
});

class Layout {
    constructor(view) {
        this.view = view;
        this.frame = 0;
        this.passes = 0;
        this.onResize = () => this.schedule(true);
        window.addEventListener('resize', this.onResize);
        document.fonts?.addEventListener?.('loadingdone', () => { measure.cache.clear(); this.schedule(true); });   // measured again in the loaded font
        view.dom.addEventListener('compositionend', () => this.schedule(true));
        Layout.current = this;
        this.schedule(true);
    }
    destroy() { window.removeEventListener('resize', this.onResize); cancelAnimationFrame(this.frame); }
    schedule(fresh) {
        if (fresh) this.passes = 0;
        if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.run(); });
    }
    run() {
        const view = this.view;
        if (view.composing) return;   // after the composition (compositionend)
        const sections = [...view.dom.children].filter(e => e.matches('section.sec'));
        const info = new Map();
        for (const sec of sections) {
            const v = sec.dataset.dir === 'v', cs = getComputedStyle(sec), em = parseFloat(cs.fontSize);
            const gap = v ? parseFloat(cs.columnGap) || 0 : 0;
            const pad = { t: parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth), b: parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth),
                l: parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth), r: parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth) };
            const len = v ? (+sec.dataset.cols || DEFAULT_COLS) * em : sec.offsetWidth - pad.l - pad.r;
            info.set(sec, { v, gap, len, pad, pitch: len + gap });
            if (v) sec.style.height = (200 * (len + gap) + pad.t + pad.b) + 'px';   // generous first, cut to whole bands below
        }
        const runs = wariRuns(view.state.doc), mks = view.dom.querySelectorAll('i.mk');
        const decos = [], sig = [];
        if (mks.length === runs.length) {
            runs.forEach((run, k) => {
                const mk = mks[k], sec = mk.closest('section.sec'), inf = info.get(sec);
                if (!inf) return;
                const pcs = getComputedStyle(mk.parentElement), half = parseFloat(pcs.fontSize) / 2;   // a character of the two-column text
                const chars = [...run.text];
                const box = sec.getBoundingClientRect(), r = mk.getBoundingClientRect();
                let offset = inf.v ? (r.top - box.top - inf.pad.t) % inf.pitch : (r.left - box.left - inf.pad.l);
                if (offset < 0) offset = 0;
                for (const s of segments(chars, measure.widths(chars, pcs, half, inf.v), offset, inf.len, half)) {
                    const from = run.from + s.from, to = run.from + s.to;
                    decos.push(Decoration.inline(from, to, { class: 'seg', style: s.style }, { style: s.style }));
                    sig.push(`${from}:${to}:${s.style}`);
                }
            });
        }
        // compared with the segments in place (mapped through the edits since; a replaced block has lost its own)
        const have = layoutKey.getState(view.state).find().sort((a, b) => a.from - b.from).map(d => `${d.from}:${d.to}:${d.spec.style}`).join('|');
        if (sig.join('|') !== have && this.passes < 40) {
            this.passes++;
            view.dispatch(view.state.tr.setMeta(layoutKey, DecorationSet.create(view.state.doc, decos)).setMeta('addToHistory', false));
            return;   // the update schedules the next pass: a run moves when the runs before it have changed
        }
        // the bands: cut every vertical section to the bands that hold text
        for (const sec of sections) {
            const inf = info.get(sec);
            if (!inf.v) continue;
            const top = sec.getBoundingClientRect().top + inf.pad.t, range = document.createRange();
            range.selectNodeContents(sec);
            let bottom = top;
            for (const rc of range.getClientRects()) if (rc.width || rc.height) bottom = Math.max(bottom, rc.bottom);
            const bands = Math.max(1, Math.floor((bottom - top - 1) / inf.pitch) + 1);
            sec.style.height = (bands * inf.pitch - inf.gap + inf.pad.t + inf.pad.b) + 'px';
        }
        // ruby longer than its base is narrowed (the base keeps its cell)
        for (const rb of view.dom.querySelectorAll('.rb')) {
            const base = rb.firstElementChild, rt = rb.lastElementChild;
            if (!base || !rt || !rt.textContent) continue;
            const v = !!rb.closest('.sec.v'), r = base.getBoundingClientRect();
            const baseLen = v ? r.height : r.width, rtLen = v ? rt.offsetHeight : rt.offsetWidth;
            const allowed = baseLen + 0.2 * parseFloat(getComputedStyle(base).fontSize);
            const scale = rtLen > allowed ? (allowed / rtLen).toFixed(3) : '1';
            if (rt.style.getPropertyValue('--rs') !== scale) rt.style.setProperty('--rs', scale);
        }
        UI.refresh();
    }
}

// ---------------------------------------------------------------- ruby
function rubyView(mark) {
    const dom = el('span', { className: 'rb' }), contentDOM = el('span', { className: 'rb-b' }), rt = el('span', { className: 'rt', textContent: mark.attrs.rt });
    dom.dataset.side = mark.attrs.side;
    rt.contentEditable = 'false';
    dom.append(contentDOM, rt);
    return { dom, contentDOM, ignoreMutation: m => m.type !== 'selection' && !contentDOM.contains(m.target) };
}

// the scripts of a reading: Quốc Ngữ as it is, PA and QATT from parser.js, pa-text.js, qatt-text.js of qatt.org (loaded when first needed)
const Scripts = {
    KINDS: [['qn', 'QN'], ['pa', 'PA'], ['qatt', 'QATT']],
    ready: null, parser: null,
    load() {
        const js = (name, has) => has() ? Promise.resolve() : new Promise((ok, fail) => {
            const sc = el('script', { src: `${QATT}/js/${name}` }); sc.onload = ok; sc.onerror = () => fail(new Error(name)); document.head.append(sc);
        });
        return this.ready || (this.ready = js('parser.js', () => typeof VietnameseParser !== 'undefined')
            .then(() => Promise.all([js('pa-text.js', () => typeof PaText !== 'undefined'), js('qatt-text.js', () => typeof QattText !== 'undefined')]))
            .then(() => { this.parser = new VietnameseParser('qatt'); })
            .catch(e => { console.error('The scripts of the readings could not be loaded:', e); this.ready = null; }));
    },
    text(qn, kind) {
        if (kind === 'qn' || !this.parser) return qn;
        const f = kind === 'pa' ? PaText.word : QattText.word;
        return qn.replace(/[\p{L}\p{M}]+/gu, w => f(w.toLowerCase(), this.parser) || w);
    },
    // the reading in Quốc Ngữ of a PA text (for ruby pasted with the annotation of the fonts)
    fromPa(pa) { return this.parser && typeof PaText !== 'undefined' ? PaText.read(pa, this.parser) : ''; },
};

// the readings of a character or word in the dictionaries of ime.js, in Quốc Ngữ
async function readingsOf(text) {
    if (!window.VietIme || !text) return [];
    try { await VietIme.load(); } catch (e) { return []; }
    const seen = new Set();
    for (const e of VietIme.lookupGlyph(text)) if (e.glyph === text && e.reading) seen.add(e.reading);
    return [...seen];
}

// text with the annotation of the QATT fonts: a character, U+F00B0 (over) or U+F00B1 (under), a PA syllable, maybe U+F00B2 (end)
const ANNOT = /(\P{M})([\u{F00B0}\u{F00B1}])([\u{F00D0}-\u{F010E}]+)\u{F00B2}?/gu;
function annotToRuby(fragment) {
    const out = [];
    fragment.forEach(node => {
        if (!node.isText) { out.push(node.isLeaf ? node : node.copy(annotToRuby(node.content))); return; }
        const text = node.text;
        let last = 0, m;
        ANNOT.lastIndex = 0;
        while ((m = ANNOT.exec(text))) {
            if (m.index > last) out.push(schema.text(text.slice(last, m.index), node.marks));
            const mark = schema.marks.ruby.create({ rt: m[3], qn: Scripts.fromPa(m[3]), side: m[2] === '\u{F00B1}' ? 'under' : 'over' });
            out.push(schema.text(m[1], mark.addToSet(node.marks)));
            last = m.index + m[0].length;
        }
        if (!last) out.push(node);
        else if (last < text.length) out.push(schema.text(text.slice(last), node.marks));
    });
    return Fragment.fromArray(out);
}

// the ruby mark at a position (the character after it, else the one before) and the range it covers in its block
function rubyAt(state, pos) {
    const $pos = state.doc.resolve(pos), type = schema.marks.ruby;
    const after = $pos.nodeAfter, before = $pos.nodeBefore;
    const mark = (after && type.isInSet(after.marks)) || (before && type.isInSet(before.marks));
    if (!mark) return null;
    const start = $pos.start();
    let found = null, cur = null;
    $pos.parent.forEach((child, offset) => {
        const a = start + offset, b = a + child.nodeSize;
        if (!mark.isInSet(child.marks)) { cur = null; return; }
        if (cur && cur.to === a) cur.to = b; else cur = { from: a, to: b };
        if (cur.from <= pos && pos <= cur.to) found = { mark, from: cur.from, to: cur.to };
    });
    return found;
}

// ---------------------------------------------------------------- placeholder
const placeholderPlugin = new Plugin({
    props: {
        decorations(state) {
            const doc = state.doc;
            if (doc.childCount !== 1 || doc.firstChild.childCount !== 1 || doc.firstChild.firstChild.content.size) return null;
            return DecorationSet.create(doc, [Decoration.node(1, 1 + doc.firstChild.firstChild.nodeSize, { class: 'is-empty', 'data-placeholder': T('Write…', 'Viết…') })]);
        },
    },
});

// ---------------------------------------------------------------- the toolbar (fixed: under the title bar, on a phone at the bottom)
const UI = {
    view: null,
    // the phone (narrow or touch): the toolbar sits at the bottom, above the keyboard and above the bottom bar of the site
    bottom: matchMedia('(max-width: 767.98px), (pointer: coarse)'),
    init() {
        this.bar = document.getElementById('toolbar');
        const btn = (content, en, viText, run) => {
            const b = el('button', { type: 'button' });
            b.append(content);
            titled(b, en, viText);
            b.addEventListener('mousedown', e => e.preventDefault());   // keep the caret and the keyboard in the text
            b.addEventListener('click', () => { if (!this.view) return; run(); if (!RubyBox.isOpen()) this.view.focus(); });
            return b;
        };
        const icon = c => el('i', { className: 'fa-solid ' + c });
        const hIcon = n => el('span', { className: 'h-icon' }, icon('fa-heading'), el('sub', {}, String(n)));
        const sep = () => el('span', { className: 'sep' });
        const cmd = c => () => c(this.view.state, this.view.dispatch, this.view);

        this.bH1 = btn(hIcon(1), 'Heading', 'Tiêu đề', cmd(setHeading(1)));
        this.bH2 = btn(hIcon(2), 'Subheading', 'Tiêu đề phụ', cmd(setHeading(2)));
        this.bWari = btn(vi('split', 'chia'), 'Two-column text', 'Chữ hai dòng', cmd(toggleWari));
        this.bWari.classList.add('txt');
        this.bRuby = btn(icon('fa-pencil'), 'Ruby (reading)', 'Chú âm', () => RubyBox.open());
        // the section settings are drop-downs; the group label says what the option is
        const select = (label, labelVi, options, change) => {
            const sel = el('select', { className: 'form-select form-select-sm' });
            const g = el('optgroup', { label });
            g.setAttribute('data-vi-label', labelVi);
            for (const [value, en, viText] of options) { const o = el('option', { value }); o.textContent = en; if (viText) o.setAttribute('data-vi', viText); g.append(o); }
            sel.append(g);
            titled(sel, label, labelVi);
            sel.addEventListener('change', () => { if (this.view) { change(sel.value); this.view.focus(); } });
            return sel;
        };
        this.selDir = select('Text direction', 'Hướng chữ', [['h', 'Horizontal', 'Ngang'], ['v', 'Vertical', 'Dọc']], v => this.setSection({ dir: v }));
        this.selCols = select('Characters per column', 'Số chữ mỗi cột', COLS_OPTIONS.map(n => [String(n), String(n)]), v => this.setSection({ cols: +v }));
        this.bDel = btn(icon('fa-trash'), 'Delete section', 'Xóa phần', () => this.deleteSection());
        this.bar.append(this.bH1, this.bH2, this.bWari, this.bRuby, sep(), this.selDir, this.selCols, sep(), this.bDel);

        // the plus on an empty line (floating, as on Medium): a new section there
        this.plus = el('button', { type: 'button', className: 'scroll-plus', hidden: true });
        this.plus.append(icon('fa-plus'));
        titled(this.plus, 'New section', 'Phần mới');
        this.plus.addEventListener('mousedown', e => e.preventDefault());
        this.plus.addEventListener('click', () => { this.menuOpen = !this.menuOpen; this.refresh(); });
        const item = (ic, en, viText, dir) => {
            const b = btn(icon(ic), en, viText, () => { this.menuOpen = false; insertSection(this.view, dir); });
            b.append(vi(en, viText));
            return b;
        };
        this.plusMenu = el('div', { className: 'scroll-ui scroll-plus-menu', hidden: true },
            item('fa-grip-lines', 'Horizontal section', 'Phần ngang', 'h'), item('fa-grip-lines-vertical', 'Vertical section', 'Phần dọc', 'v'));
        document.body.append(this.plus, this.plusMenu);
        document.addEventListener('pointerdown', e => {
            if (this.menuOpen && !this.plusMenu.contains(e.target) && !this.plus.contains(e.target)) { this.menuOpen = false; this.refresh(); }
        });

        const pos = () => this.position();
        if (window.visualViewport) for (const ev of ['resize', 'scroll']) visualViewport.addEventListener(ev, pos);
        window.addEventListener('resize', pos);
        this.bottom.addEventListener?.('change', pos);
    },
    show() { this.bar.hidden = false; this.position(); },
    // on the phone: fixed at the bottom of the visible area (the keyboard shrinks it), above the bottom bar of the site where it is shown
    position() {
        const bar = this.bar;
        if (!bar || bar.hidden) return;
        const low = this.bottom.matches;
        bar.classList.toggle('bottom', low);
        document.body.classList.toggle('toolbar-bottom', low);
        if (!low) { bar.style.top = ''; return; }
        const vv = window.visualViewport, vh = vv ? vv.height : innerHeight, oy = vv ? vv.offsetTop : 0;
        const site = document.querySelector('.bottom-bar');
        let limit = oy + vh;
        if (site && getComputedStyle(site).display !== 'none') limit = Math.min(limit, site.getBoundingClientRect().top);
        bar.style.top = Math.max(0, limit - bar.offsetHeight) + 'px';
        if (RubyBox.isOpen()) RubyBox.place();
    },
    refresh() {
        const view = this.view;
        if (!view || !view.state || !this.bar) return;
        const { state } = view, sel = state.selection, $f = sel.$from, p = $f.parent;
        const wari = schema.marks.warichu, ruby = schema.marks.ruby;
        const on = (b, v) => b.classList.toggle('on', !!v);
        on(this.bH1, p.type === S.heading && p.attrs.level === 1);
        on(this.bH2, p.type === S.heading && p.attrs.level === 2);
        on(this.bWari, sel.empty ? wari.isInSet(state.storedMarks || $f.marks()) : state.doc.rangeHasMark(sel.from, sel.to, wari));
        const inRuby = sel.empty && rubyAt(state, sel.from);
        on(this.bRuby, inRuby || (!sel.empty && state.doc.rangeHasMark(sel.from, sel.to, ruby)));
        this.bRuby.disabled = !(inRuby || (!sel.empty && $f.parent === sel.$to.parent && !state.doc.rangeHasMark(sel.from, sel.to, wari)));
        const a = $f.depth >= 1 ? $f.node(1).attrs : null;
        const vert = !!a && a.dir === 'v';
        if (a) {
            this.selDir.value = a.dir;
            const have = [...this.selCols.options].some(o => o.value === String(a.cols));
            if (!have) {   // a value from before (or typed by hand) that the list does not have
                const o = el('option', { value: String(a.cols) }); o.textContent = String(a.cols);
                const opts = [...this.selCols.options];
                const at = opts.find(x => +x.value > a.cols);
                this.selCols.firstChild.insertBefore(o, at || null);
            }
            this.selCols.value = String(a.cols);
        }
        this.selDir.disabled = !a;
        this.selCols.disabled = !vert;
        this.bDel.disabled = state.doc.childCount < 2;
        this.position();

        // the plus on an empty paragraph (vertical: above the column, horizontal: left of the line) and its menu under it
        const emptyLine = view.hasFocus() && sel.empty && $f.depth === 2 && p.type === S.paragraph && !p.content.size;
        if (!emptyLine) this.menuOpen = false;
        this.plus.hidden = !emptyLine;
        this.plusMenu.hidden = !(emptyLine && this.menuOpen);
        if (emptyLine) {
            const c = view.coordsAtPos($f.pos), size = this.plus.offsetWidth || 32;
            const x = vert ? (c.left + c.right) / 2 - size / 2 : c.left - size - 12, y = vert ? c.top - size - 10 : (c.top + c.bottom) / 2 - size / 2;
            this.plus.style.left = Math.max(4, x) + scrollX + 'px';
            this.plus.style.top = Math.max(4, y) + scrollY + 'px';
            this.plus.classList.toggle('open', !!this.menuOpen);
            if (this.menuOpen) {
                const r = this.plus.getBoundingClientRect(), w = this.plusMenu.offsetWidth, vw = document.documentElement.clientWidth;
                this.plusMenu.style.left = Math.max(8, Math.min(r.left, vw - w - 8)) + 'px';
                this.plusMenu.style.top = r.bottom + 6 + 'px';
            }
        }
    },
    setSection({ dir, cols }) {
        const view = this.view, sec = sectionAt(view.state.selection.$from), a = sec.node.attrs;
        const attrs = { ...a, ...(dir ? { dir } : {}), ...(cols ? { cols: clampCols(cols) } : {}) };
        if (attrs.dir === a.dir && attrs.cols === a.cols) return;
        view.dispatch(view.state.tr.setNodeMarkup(sec.pos, null, attrs));
    },
    deleteSection() {
        const view = this.view, { state } = view;
        if (state.doc.childCount < 2) return;
        const sec = sectionAt(state.selection.$from);
        if (sec.node.textContent && !confirm(T('Delete this section with its text?', 'Xóa phần này cùng với chữ trong đó?'))) return;
        const tr = state.tr.delete(sec.pos, sec.pos + sec.node.nodeSize);
        const at = Math.min(sec.pos, tr.doc.content.size - 1);
        tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(0, at)), 1));
        view.dispatch(tr.scrollIntoView());
    },
};

// the box to write a ruby: a field (Quốc Ngữ, with Telex), the readings of the dictionary, the script (QN, PA, QATT), the side, each character
const RubyBox = {
    view: null, range: null, kind: 'qn', side: 'over',
    init(view) {
        this.view = view;
        try { this.kind = localStorage.getItem('scrollsRubyKind') || (window.Readings && Readings.shown && Readings.shown()[0]) || 'qn'; } catch (e) { /* default */ }
        if (!Scripts.KINDS.some(k => k[0] === this.kind)) this.kind = 'qn';
        const btn = (content, en, viText, run, cls = '') => {
            const b = el('button', { type: 'button', className: cls });
            b.append(content);
            titled(b, en, viText);
            b.addEventListener('click', run);
            return b;
        };
        this.input = el('input', { type: 'text', className: 'form-control form-control-sm rt-input', autocomplete: 'off' });
        this.input.placeholder = 'Reading';
        this.input.setAttribute('data-vi-placeholder', 'Cách đọc');
        this.input.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !(this.ime && this.ime.visible)) { e.preventDefault(); this.apply(this.input.value); }
            else if (e.key === 'Escape' && !(this.ime && this.ime.visible)) { e.preventDefault(); this.close(true); }
        });
        this.input.addEventListener('input', () => this.preview());
        this.ok = btn(el('i', { className: 'fa-solid fa-check' }), 'Apply', 'Áp dụng', () => this.apply(this.input.value));
        this.del = btn(el('i', { className: 'fa-solid fa-trash' }), 'Remove the ruby', 'Bỏ chú âm', () => this.apply(''));
        this.shown = el('span', { className: 'rt-preview' });
        this.eachBtn = btn(el('i', { className: 'fa-solid fa-wand-magic-sparkles' }), 'Each character its reading from the dictionary', 'Từng chữ theo từ điển', () => this.eachChar());
        this.kindBtns = Scripts.KINDS.map(([k, label]) => {
            const b = btn(label, { qn: 'Quốc Ngữ', pa: 'PA', qatt: 'QATT' }[k], { qn: 'Quốc Ngữ', pa: 'PA', qatt: 'QATT' }[k], () => this.setKind(k));
            b.dataset.k = k;
            return b;
        });
        this.overBtn = btn(el('i', { className: 'bi' }), 'Over (vertical: right)', 'Trên (dọc: bên phải)', () => this.setSide('over'));
        this.underBtn = btn(el('i', { className: 'bi' }), 'Under (vertical: left)', 'Dưới (dọc: bên trái)', () => this.setSide('under'));
        this.box = el('div', { className: 'scroll-ui ruby-box', hidden: true },
            el('div', { className: 'rt-row' }, this.input, this.ok, this.del),
            el('div', { className: 'rt-row' }, this.shown),
            el('div', { className: 'rt-row' }, ...this.kindBtns, el('span', { className: 'sep' }), this.overBtn, this.underBtn, el('span', { className: 'sep' }), this.eachBtn));
        this.box.addEventListener('mousedown', e => { if (e.target !== this.input) e.preventDefault(); });
        document.body.append(this.box);
        document.addEventListener('pointerdown', e => { if (this.isOpen() && !this.box.contains(e.target)) this.close(false); });
        if (window.VietIme) this.ime = new VietIme(this.input, { candidates: false, defer: true });
    },
    isOpen() { return this.box && !this.box.hidden; },
    async open() {
        const { state } = this.view, sel = state.selection;
        let range;
        if (sel.empty) range = rubyAt(state, sel.from);
        else if (sel.$from.parent === sel.$to.parent && !state.doc.rangeHasMark(sel.from, sel.to, schema.marks.warichu)) {
            const r = rubyAt(state, sel.from);   // a selection inside one ruby edits it
            range = { from: sel.from, to: sel.to, mark: r && r.from <= sel.from && sel.to <= r.to ? r.mark : null };
        }
        if (!range) return;
        this.range = range;
        const mark = range.mark || null;
        this.side = mark ? mark.attrs.side : this.side;
        this.input.value = mark ? (mark.attrs.qn || mark.attrs.rt) : '';
        this.base = state.doc.textBetween(range.from, range.to);
        this.del.hidden = !mark;
        this.eachBtn.hidden = [...this.base].length < 2;
        this.markKind(); this.markSide();
        this.box.hidden = false;
        this.place();
        this.input.focus();
        this.input.select();
        if (this.kind !== 'qn') await Scripts.load();
        this.preview();
        this.place();
    },
    // fixed at the toolbar: under it, on the phone above it
    place() {
        const t = UI.bar.getBoundingClientRect(), b = UI.bRuby.getBoundingClientRect(), w = this.box.offsetWidth, h = this.box.offsetHeight;
        const vw = document.documentElement.clientWidth;
        this.box.style.left = Math.max(8, Math.min(b.left, vw - w - 8)) + 'px';
        this.box.style.top = (UI.bottom.matches ? Math.max(8, t.top - h - 6) : t.bottom + 6) + 'px';
    },
    preview() {
        const t = Scripts.text(this.input.value.trim(), this.kind);
        this.shown.textContent = this.kind === 'qn' ? '' : t;
        this.shown.hidden = this.kind === 'qn';
    },
    markKind() {
        for (const b of this.kindBtns) b.classList.toggle('on', b.dataset.k === this.kind);
    },
    markSide() {
        const vert = this.view.state.doc.resolve(this.range ? this.range.from : 0).node(1)?.attrs.dir === 'v';
        this.overBtn.firstChild.className = 'fa-solid ' + (vert ? 'fa-arrow-right' : 'fa-arrow-up');
        this.underBtn.firstChild.className = 'fa-solid ' + (vert ? 'fa-arrow-left' : 'fa-arrow-down');
        this.overBtn.classList.toggle('on', this.side === 'over');
        this.underBtn.classList.toggle('on', this.side === 'under');
    },
    async setKind(k) {
        this.kind = k;
        try { localStorage.setItem('scrollsRubyKind', k); } catch (e) { /* only now */ }
        if (k !== 'qn') await Scripts.load();
        this.markKind(); this.preview();
        this.input.focus();
    },
    setSide(s) { this.side = s; this.markSide(); this.input.focus(); },
    async apply(qn) {
        qn = (qn || '').trim();
        if (qn && this.kind !== 'qn') await Scripts.load();
        const { from, to } = this.range, type = schema.marks.ruby, tr = this.view.state.tr.removeMark(from, to, type);
        if (qn) tr.addMark(from, to, type.create({ rt: Scripts.text(qn, this.kind), qn, side: this.side }));
        this.view.dispatch(tr);
        this.close(true);
    },
    // each character of the selection gets its own ruby: its first reading in the dictionary
    async eachChar() {
        const { from } = this.range, chars = [...this.base];
        if (this.kind !== 'qn') await Scripts.load();
        const readings = await Promise.all(chars.map(c => readingsOf(c)));
        const type = schema.marks.ruby, tr = this.view.state.tr.removeMark(this.range.from, this.range.to, type);
        let pos = from;
        chars.forEach((c, i) => {
            const qn = readings[i][0];
            if (qn) tr.addMark(pos, pos + c.length, type.create({ rt: Scripts.text(qn, this.kind), qn, side: this.side }));
            pos += c.length;
        });
        this.view.dispatch(tr);
        this.close(true);
    },
    close(focus) {
        if (!this.box || this.box.hidden) return;
        this.box.hidden = true;
        if (this.ime) this.ime.hide();
        this.range = null;
        if (focus) this.view.focus();
        UI.refresh();
    },
};

const uiPlugin = new Plugin({
    view: () => ({ update: () => UI.refresh() }),
    props: { handleDOMEvents: { focus: () => { setTimeout(() => UI.refresh()); return false; }, blur: () => { setTimeout(() => UI.refresh()); return false; } } },
});

// ---------------------------------------------------------------- ime.js (Telex only) on the editor
// VietIme works on a field; this adapter shows it the text of the block with the caret
class ImeAdapter {
    constructor(view) { this.view = view; this.imeTarget = view.dom; this.style = {}; this.readOnly = false; this.tagName = 'DIV'; }
    get $from() { return this.view.state.selection.$from; }
    get value() { const p = this.$from.parent; return p.isTextblock ? p.textBetween(0, p.content.size, '', '￼') : ''; }
    get selectionStart() { return this.$from.parentOffset; }
    get selectionEnd() { const s = this.view.state.selection; return s.$to.parent === s.$from.parent ? s.$to.parentOffset : s.$from.parentOffset; }
    setSelectionRange(a, b) {
        const st = this.$from.start(), { state } = this.view;
        this.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, st + a, st + b)));
    }
    replaceRange(text, a, b) {
        const v = this.view, st = this.$from.start(), tr = v.state.tr;
        if (text) tr.insertText(text, st + a, st + b); else tr.delete(st + a, st + b);
        v.dispatch(tr.scrollIntoView());
        if (this.ime) setTimeout(() => this.ime.refresh());
    }
    setRangeText(text, a, b) { this.replaceRange(text, a, b); }
    getAttribute(n) { return this.view.dom.getAttribute(n); }
    hasAttribute(n) { return this.view.dom.hasAttribute(n); }
    setAttribute(n, v) { this.view.dom.setAttribute(n, v); }
    removeAttribute(n) { this.view.dom.removeAttribute(n); }
    addEventListener(...a) { this.view.dom.addEventListener(...a); }
    // where the candidate list goes: under the caret; in a vertical section to the left of the column, below the caret
    getBoundingClientRect() {
        const v = this.view, head = v.state.selection.head, c = v.coordsAtPos(head);
        const vert = v.state.selection.$head.depth >= 1 && v.state.selection.$head.node(1).attrs.dir === 'v';
        if (!vert) return { left: c.left, right: c.right, top: c.top, bottom: c.bottom };
        const size = parseFloat(getComputedStyle(v.dom).fontSize);
        const x = Math.min(c.left, c.right) - size * 0.4;
        return { left: x, right: x, top: c.top, bottom: c.bottom + size * 0.2 };
    }
}
let ime = null;
const imeKeys = new Plugin({
    props: {
        // while the list is open its keys belong to it (ime.js handles them after ProseMirror)
        handleKeyDown(view, e) {
            if (!ime || !ime.visible || e.isComposing) return false;
            if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Escape'].includes(e.key)) return true;
            if (e.key === 'Enter' && !(e.shiftKey || e.ctrlKey || e.metaKey || e.altKey)) return true;   // Enter takes the candidate (returnSelect)
            return false;
        },
    },
});

// ---------------------------------------------------------------- the page: load, save, settings
const params = new URLSearchParams(location.search);
const LOCAL = params.has('local'), ID = params.get('id');
const LOCAL_KEY = 'scrollsLocal1';
const $ = id => document.getElementById(id);
const titleInput = $('title'), statusEl = $('status'), fontSel = $('font'), sizeSel = $('size'), editorEl = $('editor');
const setStatus = (en, viText) => { statusEl.textContent = en; statusEl.setAttribute('data-vi', viText); };
const message = (en, viText, action) => {
    const m = $('message');
    m.hidden = false;
    m.replaceChildren(vi(en, viText, 'p'));
    if (action) m.append(action);
    editorEl.hidden = true;
};

const store = {
    sp: null, updatedAt: null, dirty: false, saving: false, again: false, timer: 0, blocked: false,
    settings: { font: null, size: 22 },
    async load() {
        if (LOCAL) {
            let rec = null;
            try { rec = JSON.parse(localStorage.getItem(LOCAL_KEY)); } catch (e) { /* none */ }
            return rec || { title: '', settings: {}, content: null };
        }
        if (!ID) { message('No scroll given.', 'Không có cuốn nào được chọn.', backLink()); return null; }
        this.sp = new SupabaseService();
        try { await this.sp.init(); } catch (e) { console.error(e); }
        if (!this.sp.user || this.sp.isAnonymous) {
            const b = vi('Sign in', 'Đăng nhập', 'button');
            b.type = 'button';
            b.className = 'btn btn-cinnabar btn-sm';
            b.addEventListener('click', () => QattLogin.open(this.sp));
            message('Sign in to open your scrolls.', 'Đăng nhập để mở các cuốn của bạn.', b);
            return null;
        }
        const { data, error } = await this.sp.client.from('scrolls').select('id, title, settings, content, updated_at').eq('id', ID).maybeSingle();
        if (error || !data) { if (error) console.error(error); message('This scroll was not found.', 'Không tìm thấy cuốn này.', backLink()); return null; }
        this.updatedAt = data.updated_at;
        return data;
    },
    changed() {
        if (this.blocked) return;
        this.dirty = true;
        setStatus('Not saved yet', 'Chưa lưu');
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.save(), 1000);
    },
    payload() { return { title: titleInput.value.trim(), settings: this.settings, content: editor.state.doc.toJSON() }; },
    async save() {
        clearTimeout(this.timer);
        if (!this.dirty || this.blocked) return;
        if (this.saving) { this.again = true; return; }
        this.saving = true;
        this.dirty = false;
        if (LOCAL) {
            try { localStorage.setItem(LOCAL_KEY, JSON.stringify(this.payload())); setStatus('Saved in this browser', 'Đã lưu trong trình duyệt này'); }
            catch (e) { this.dirty = true; setStatus('Not saved', 'Chưa lưu'); }
        } else {
            setStatus('Saving…', 'Đang lưu…');
            // the row is only changed if nobody saved it since we read it (another window of the same user)
            const { data, error } = await this.sp.client.from('scrolls').update(this.payload()).eq('id', ID).eq('updated_at', this.updatedAt).select('updated_at');
            if (error) { console.error(error); this.dirty = true; setStatus('Not saved: no connection?', 'Chưa lưu: mất kết nối?'); clearTimeout(this.timer); this.timer = setTimeout(() => this.save(), 5000); }
            else if (!data.length) {
                this.blocked = true;
                setStatus('Changed in another window', 'Đã được sửa trong cửa sổ khác');
                const reload = vi('Load the newer version', 'Tải phiên bản mới hơn', 'button');
                reload.type = 'button';
                reload.className = 'btn btn-sm btn-quiet ms-2';
                reload.addEventListener('click', () => location.reload());
                statusEl.append(' ', reload);
            } else { this.updatedAt = data[0].updated_at; if (!this.dirty) setStatus('Saved', 'Đã lưu'); }
        }
        this.saving = false;
        if (this.again || this.dirty) { this.again = false; this.changed(); }
    },
};
const backLink = () => { const a = vi('All scrolls', 'Tất cả các cuốn', 'a'); a.href = '/scrolls/'; a.className = 'btn btn-sm btn-quiet'; return a; };

let editor = null;

function applySettings() {
    editorEl.style.setProperty('--doc-size', (store.settings.size || 22) + 'px');
    if (store.settings.font && [...fontSel.options].some(o => o.value === store.settings.font)) fontSel.value = store.settings.font;
    // the big fonts of js/fonts.js: CJK and QATT in "<family>", their Latin in "<family> Latin"
    const f = fontSel.value;
    if (f) editorEl.style.setProperty('--doc-font', `"${f}", "${f} Latin"`);
}

async function start() {
    // only the fonts with Chữ Nôm (cjk: true of js/fonts.js)
    if (window.QATT_FONTS) for (const o of [...fontSel.querySelectorAll('option')]) if (!QATT_FONTS.find(f => f.family === o.value && f.cjk)) o.remove();
    const rec = await store.load();
    if (!rec) return;
    titleInput.value = rec.title || '';
    document.title = rec.title || 'Scroll';
    store.settings = { font: null, size: 22, ...(rec.settings || {}) };
    if ([...sizeSel.options].some(o => +o.value === +store.settings.size)) sizeSel.value = String(store.settings.size);
    applySettings();

    let doc = null;
    if (rec.content && rec.content.type === 'doc') { try { doc = schema.nodeFromJSON(rec.content); doc.check(); } catch (e) { console.error('Content could not be read:', e); doc = null; } }
    const state = EditorState.create({
        schema,
        doc: doc || emptyDoc(),
        plugins: [
            imeKeys,
            keymap({
                'Mod-z': undo, 'Shift-Mod-z': redo, 'Mod-y': redo,
                'Mod-Alt-1': setHeading(1), 'Mod-Alt-2': setHeading(2), 'Mod-Alt-0': setBlockType(S.paragraph),
                'Mod-Shift-d': toggleWari,
                'Mod-Shift-r': openRuby,
                'Mod-Shift-Space': () => { document.getElementById('telex').click(); return true; },
                'Backspace': joinSectionBackward, 'Delete': joinSectionForward,
            }),
            keymap(baseKeymap),
            history(),
            dropCursor(),
            placeholderPlugin,
            layoutPlugin,
            uiPlugin,
        ],
    });
    UI.init();   // the buttons first, the view below
    editor = new EditorView(editorEl, {
        state,
        dispatchTransaction(tr) {
            editor.updateState(editor.state.apply(tr));
            if (tr.docChanged) store.changed();
        },
    });
    UI.view = editor;
    RubyBox.init(editor);
    UI.show();
    UI.refresh();
    window.scrollsEditor = editor;   // for tests

    // Telex (no Chữ Nôm candidates in the editor): on unless switched off (kept in this browser)
    const telexBtn = $('telex');
    let telexOn = true;
    try { telexOn = localStorage.getItem('scrollsTelex') !== '0'; } catch (e) { /* default */ }
    const adapter = new ImeAdapter(editor);
    ime = new VietIme(adapter, { defer: true, telex: telexOn, candidates: false });
    adapter.ime = ime;
    const setTelex = on => {
        telexOn = on;
        telexBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        ime.update({ telex: on, candidates: false });
        if (RubyBox.ime) RubyBox.ime.update({ telex: on, candidates: false });
        try { localStorage.setItem('scrollsTelex', on ? '1' : '0'); } catch (e) { /* only for this page */ }
    };
    setTelex(telexOn);
    telexBtn.addEventListener('click', () => { setTelex(!telexOn); editor.focus(); });

    titleInput.addEventListener('input', () => { document.title = titleInput.value.trim() || 'Scroll'; store.changed(); });
    titleInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); editor.focus(); } });
    fontSel.addEventListener('change', () => {
        if (store.settings.font !== fontSel.value) { store.settings.font = fontSel.value; store.changed(); }
        applySettings();
        document.fonts.ready.then(() => { measure.cache.clear(); if (Layout.current) Layout.current.schedule(true); });
    });
    sizeSel.addEventListener('change', () => { store.settings.size = +sizeSel.value; applySettings(); store.changed(); Layout.current && Layout.current.schedule(true); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') store.save(); });
    window.addEventListener('beforeunload', e => { if (store.dirty || store.saving) { store.save(); e.preventDefault(); e.returnValue = ''; } });
    document.fonts.ready.then(() => { measure.cache.clear(); if (Layout.current) Layout.current.schedule(true); });
    if (!doc || !doc.textContent) editor.focus();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
