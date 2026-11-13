/*
The editor of a scroll (edit.html?id=<uuid>; edit.html?local: a test mode without login, kept in this browser only).

A scroll is sections of blocks: doc > section+ > (paragraph | heading)+. A section is horizontal (flowing text) or vertical
(columns of `cols` characters, right to left, continued in bands below). Two-column text (warichu) is a mark; editor.js lays it
out as segments (inline decorations), the bands of vertical sections get their height here. ProseMirror comes from js/prosemirror.js
(window.PM, built in the private repository), the Telex input and the Chữ Nôm candidates from /chunom/js/ime.js.
*/
(() => {
'use strict';
const { Schema, EditorState, EditorView, Plugin, PluginKey, TextSelection, Decoration, DecorationSet, keymap, history, undo, redo,
        baseKeymap, toggleMark, setBlockType, dropCursor, Fragment, Slice } = PM;
const QATT = 'https://qatt.org';

const T = (en, vi) => (window.Lang ? Lang.t(en, vi) : en);
const MIN_COLS = 2, MAX_COLS = 40, DEFAULT_COLS = 10;
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
            toDOM: n => ['section', { class: 'sec ' + n.attrs.dir, 'data-dir': n.attrs.dir, 'data-cols': n.attrs.cols, style: `--cols: ${n.attrs.cols}` }, 0],
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
        d.className = 'sec ' + a.dir;
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
        document.fonts?.addEventListener?.('loadingdone', this.onResize);
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
            const len = v ? (+sec.dataset.cols || DEFAULT_COLS) * em : sec.clientWidth;
            info.set(sec, { v, gap, len, pitch: len + gap });
            if (v) sec.style.height = (200 * (len + gap)) + 'px';   // generous first, cut to whole bands below
        }
        const runs = wariRuns(view.state.doc), mks = view.dom.querySelectorAll('i.mk');
        const decos = [], sig = [];
        if (mks.length === runs.length) {
            runs.forEach((run, k) => {
                const mk = mks[k], sec = mk.closest('section.sec'), inf = info.get(sec);
                if (!inf) return;
                const half = parseFloat(getComputedStyle(mk.parentElement).fontSize) / 2;   // a character of the two-column text
                const box = sec.getBoundingClientRect(), r = mk.getBoundingClientRect();
                let offset = inf.v ? (r.top - box.top) % inf.pitch : (r.left - box.left);
                if (offset < 0) offset = 0;
                for (const s of segments([...run.text], offset, inf.len, half)) {
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
            const top = sec.getBoundingClientRect().top, range = document.createRange();
            range.selectNodeContents(sec);
            let bottom = top;
            for (const rc of range.getClientRects()) if (rc.width || rc.height) bottom = Math.max(bottom, rc.bottom);
            const bands = Math.max(1, Math.floor((bottom - top - 1) / inf.pitch) + 1);
            sec.style.height = (bands * inf.pitch - inf.gap) + 'px';
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

// ---------------------------------------------------------------- the floating controls: bubble menu, plus, section tools
const UI = {
    view: null,
    init(view) {
        this.view = view;
        const btn = (content, en, viText, run, extra = '') => {
            const b = el('button', { type: 'button', className: extra });
            b.append(content);
            titled(b, en, viText);
            b.addEventListener('mousedown', e => e.preventDefault());   // keep the selection in the text
            b.addEventListener('click', () => { run(); this.view.focus(); });
            return b;
        };
        const cmd = c => () => c(this.view.state, this.view.dispatch, this.view);

        // the bubble over a selection
        this.bH1 = btn('H1', 'Heading', 'Tiêu đề', cmd(setHeading(1)));
        this.bH2 = btn('H2', 'Subheading', 'Tiêu đề phụ', cmd(setHeading(2)));
        this.bWari = btn(el('span', { className: 'han-btn', textContent: '雙' }), 'Two-column text', 'Chữ hai dòng', cmd(toggleWari));
        this.bRuby = btn(el('span', { className: 'han-btn', textContent: '注' }), 'Ruby (reading)', 'Chú âm', () => RubyBox.open());
        this.bubble = el('div', { className: 'scroll-ui', hidden: true }, this.bH1, this.bH2, el('span', { className: 'sep' }), this.bWari, this.bRuby);

        // the plus on an empty line: a new section
        this.plus = el('button', { type: 'button', className: 'scroll-plus', hidden: true });
        this.plus.append(el('i', { className: 'bi bi-plus-lg' }));
        titled(this.plus, 'New section', 'Phần mới');
        this.plus.addEventListener('mousedown', e => e.preventDefault());
        this.plus.addEventListener('click', () => { this.menuOpen = !this.menuOpen; this.refresh(); });
        const item = (icon, en, viText, dir) => {
            const b = btn(el('i', { className: 'bi ' + icon }), en, viText, () => { this.menuOpen = false; insertSection(this.view, dir); });
            b.append(vi(en, viText));
            return b;
        };
        this.plusMenu = el('div', { className: 'scroll-ui scroll-plus-menu', hidden: true },
            item('bi-text-paragraph', 'Horizontal section', 'Phần ngang', 'h'),
            item('bi-layout-three-columns', 'Vertical section', 'Phần dọc', 'v'));

        // the tools of the section with the caret
        this.bH = btn(el('span', { className: 'han-btn', textContent: '橫' }), 'Horizontal', 'Ngang', () => this.setSection({ dir: 'h' }));
        this.bV = btn(el('span', { className: 'han-btn', textContent: '直' }), 'Vertical', 'Dọc', () => this.setSection({ dir: 'v' }));
        this.colsNum = el('span', { className: 'num' });
        titled(this.colsNum, 'Characters per column', 'Số chữ mỗi cột');
        this.bLess = btn(el('i', { className: 'bi bi-dash' }), 'Fewer characters per column', 'Ít chữ hơn mỗi cột', () => this.setSection({ step: -1 }));
        this.bMore = btn(el('i', { className: 'bi bi-plus' }), 'More characters per column', 'Nhiều chữ hơn mỗi cột', () => this.setSection({ step: 1 }));
        this.colsBox = el('span', { className: 'd-inline-flex align-items-center' }, el('span', { className: 'sep' }), this.bLess, this.colsNum, this.bMore);
        this.bDel = btn(el('i', { className: 'bi bi-trash' }), 'Delete section', 'Xóa phần', () => this.deleteSection());
        this.tools = el('div', { className: 'scroll-ui', hidden: true }, this.bH, this.bV, this.colsBox, el('span', { className: 'sep' }), this.bDel);

        document.body.append(this.bubble, this.plus, this.plusMenu, this.tools);
        if (window.visualViewport) for (const ev of ['resize', 'scroll']) visualViewport.addEventListener(ev, () => this.refresh());
        document.addEventListener('pointerdown', e => {
            if (this.menuOpen && !this.plusMenu.contains(e.target) && !this.plus.contains(e.target)) { this.menuOpen = false; this.refresh(); }
        });
    },
    // a touch screen: the system menu (Translate, Cut, Copy) and the selection handles sit over and under the selection, so the menus of the
    // editor are docked at the bottom of the visible area (above the keyboard) instead
    coarse: matchMedia('(pointer: coarse)').matches,
    dock(box) {
        const vv = window.visualViewport, w = box.offsetWidth, h = box.offsetHeight;
        const vw = vv ? vv.width : innerWidth, vh = vv ? vv.height : innerHeight, ox = vv ? vv.offsetLeft : 0, oy = vv ? vv.offsetTop : 0;
        box.classList.add('docked');
        box.style.left = Math.max(ox + 8, ox + (vw - w) / 2) + 'px';
        // above the bottom bar of the site (phone), if it is shown (it hides itself while the keyboard is open)
        const bar = document.querySelector('.bottom-bar'), barTop = bar && getComputedStyle(bar).display !== 'none' ? bar.getBoundingClientRect().top : Infinity;
        box.style.top = Math.max(oy + 8, Math.min(oy + vh, barTop) - h - 10) + 'px';
    },
    place(box, left, top) {
        if (this.coarse && box !== this.plus && box !== this.plusMenu) return this.dock(box);
        const w = box.offsetWidth, vw = document.documentElement.clientWidth;
        box.style.left = Math.max(8, Math.min(left, vw - w - 8)) + scrollX + 'px';
        box.style.top = Math.max(8, top) + scrollY + 'px';
    },
    refresh() {
        const view = this.view;
        if (!view || !view.state) return;
        const { state } = view, sel = state.selection, focused = view.hasFocus();
        const show = (box, on) => { box.hidden = !on; return on; };

        // bubble: over a selection, or with the caret in a ruby (to edit it)
        const inRuby = sel.empty && rubyAt(state, sel.from);
        if (show(this.bubble, focused && !RubyBox.isOpen() && sel instanceof TextSelection && (!sel.empty || !!inRuby))) {
            const a = view.coordsAtPos(sel.from), b = view.coordsAtPos(sel.to);
            const p = sel.$from.parent;
            this.bH1.classList.toggle('on', p.type === S.heading && p.attrs.level === 1);
            this.bH2.classList.toggle('on', p.type === S.heading && p.attrs.level === 2);
            const wari = schema.marks.warichu;
            this.bWari.classList.toggle('on', state.doc.rangeHasMark(sel.from, sel.to, wari));
            this.bRuby.classList.toggle('on', !!inRuby || state.doc.rangeHasMark(sel.from, sel.to, schema.marks.ruby));
            this.bRuby.disabled = !sel.empty && (sel.$from.parent !== sel.$to.parent || state.doc.rangeHasMark(sel.from, sel.to, wari));
            const top = Math.min(a.top, b.top) - this.bubble.offsetHeight - 8;
            this.place(this.bubble, (Math.min(a.left, b.left) + Math.max(a.right, b.right)) / 2 - this.bubble.offsetWidth / 2, top < 8 ? Math.max(a.bottom, b.bottom) + 8 : top);
        }

        // plus on an empty paragraph
        const $c = sel.empty ? sel.$from : null;
        const emptyLine = focused && $c && $c.depth === 2 && $c.parent.type === S.paragraph && !$c.parent.content.size;
        if (!emptyLine) this.menuOpen = false;
        if (show(this.plus, emptyLine)) {
            const c = view.coordsAtPos($c.pos), vert = $c.node(1).attrs.dir === 'v';
            const size = this.plus.offsetWidth || 32;
            if (vert) this.place(this.plus, (c.left + c.right) / 2 - size / 2, c.top - size - 10);
            else this.place(this.plus, c.left - size - 12, (c.top + c.bottom) / 2 - size / 2);
            this.plus.classList.toggle('open', !!this.menuOpen);
        }
        if (show(this.plusMenu, emptyLine && !!this.menuOpen)) {
            const r = this.plus.getBoundingClientRect();
            this.place(this.plusMenu, r.left, r.bottom + 6);
        }

        // section tools
        if (show(this.tools, focused && sel.empty && !inRuby && sel.$from.depth >= 1)) {
            const sec = sectionAt(sel.$from), dom = view.nodeDOM(sec.pos);
            const a = sec.node.attrs;
            this.bH.classList.toggle('on', a.dir === 'h');
            this.bV.classList.toggle('on', a.dir === 'v');
            this.colsBox.hidden = a.dir !== 'v';
            this.colsBox.classList.toggle('d-none', a.dir !== 'v');
            this.colsNum.textContent = a.cols;
            this.bLess.disabled = a.cols <= MIN_COLS;
            this.bMore.disabled = a.cols >= MAX_COLS;
            this.bDel.disabled = state.doc.childCount < 2;
            if (dom) {
                // above the section on the left: the plus of a vertical section sits above its column, mostly further right
                const r = dom.getBoundingClientRect();
                let top = r.top - this.tools.offsetHeight - 8;
                if (!this.plus.hidden) {
                    const pr = this.plus.getBoundingClientRect();
                    if (pr.left < r.left + this.tools.offsetWidth + 8 && pr.bottom > top) top = Math.min(top, pr.top - this.tools.offsetHeight - 6);
                }
                this.place(this.tools, r.left, top);
            }
        }
    },
    setSection({ dir, step }) {
        const view = this.view, sec = sectionAt(view.state.selection.$from), a = sec.node.attrs;
        const attrs = { ...a, ...(dir ? { dir } : {}), ...(step ? { cols: clampCols(a.cols + step) } : {}) };
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
        this.ok = btn(el('i', { className: 'bi bi-check-lg' }), 'Apply', 'Áp dụng', () => this.apply(this.input.value));
        this.del = btn(el('i', { className: 'bi bi-trash' }), 'Remove the ruby', 'Bỏ chú âm', () => this.apply(''));
        this.shown = el('span', { className: 'rt-preview' });
        this.sugg = el('div', { className: 'rt-sugg' });
        this.kindBtns = Scripts.KINDS.map(([k, label]) => {
            const b = btn(label, { qn: 'Quốc Ngữ', pa: 'PA', qatt: 'QATT' }[k], { qn: 'Quốc Ngữ', pa: 'PA', qatt: 'QATT' }[k], () => this.setKind(k));
            b.dataset.k = k;
            return b;
        });
        this.overBtn = btn(el('span', { className: 'han-btn' }), 'Over (vertical: right)', 'Trên (dọc: bên phải)', () => this.setSide('over'));
        this.underBtn = btn(el('span', { className: 'han-btn' }), 'Under (vertical: left)', 'Dưới (dọc: bên trái)', () => this.setSide('under'));
        this.eachBtn = btn(el('span', { className: 'han-btn', textContent: '字字' }), 'Each character its reading from the dictionary', 'Từng chữ theo từ điển', () => this.eachChar());
        this.box = el('div', { className: 'scroll-ui ruby-box', hidden: true },
            el('div', { className: 'rt-row' }, this.input, this.ok, this.del),
            el('div', { className: 'rt-row' }, this.shown),
            this.sugg,
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
        this.sugg.replaceChildren();
        if (this.kind !== 'qn') await Scripts.load();
        this.preview();
        const list = await readingsOf(this.base);
        if (this.range !== range) return;
        this.suggestions = list;
        this.sugg.replaceChildren(...list.slice(0, 12).map(r => {
            const b = el('button', { type: 'button', className: 'rt-chip', textContent: Scripts.text(r, this.kind) });
            b.title = r;
            b.addEventListener('click', () => this.apply(r));
            return b;
        }));
        if (!this.input.value && list.length) { this.input.value = list[0]; this.input.select(); this.preview(); }
        this.place();
    },
    place() {
        const v = this.view, r = this.range;
        const a = v.coordsAtPos(r.from), b = v.coordsAtPos(r.to);
        UI.place(this.box, Math.min(a.left, b.left) - 10, Math.max(a.bottom, b.bottom) + 10);
    },
    preview() {
        const t = Scripts.text(this.input.value.trim(), this.kind);
        this.shown.textContent = this.kind === 'qn' ? '' : t;
        this.shown.hidden = this.kind === 'qn';
    },
    markKind() {
        for (const b of this.kindBtns) b.classList.toggle('on', b.dataset.k === this.kind);
        for (const b of this.sugg.querySelectorAll('.rt-chip')) b.textContent = Scripts.text(b.title, this.kind);
    },
    markSide() {
        const vert = this.view.state.doc.resolve(this.range ? this.range.from : 0).node(1)?.attrs.dir === 'v';
        this.overBtn.firstChild.textContent = vert ? '右' : '上';
        this.underBtn.firstChild.textContent = vert ? '左' : '下';
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

// ---------------------------------------------------------------- ime.js (Telex, Chữ Nôm candidates) on the editor
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
            if (e.key === 'Enter' && ime.active >= 0 && !(e.shiftKey || e.ctrlKey || e.metaKey || e.altKey)) return true;
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
    UI.init({});   // the elements first, the view below
    editor = new EditorView(editorEl, {
        state,
        dispatchTransaction(tr) {
            editor.updateState(editor.state.apply(tr));
            if (tr.docChanged) store.changed();
        },
    });
    UI.view = editor;
    RubyBox.init(editor);
    window.scrollsEditor = editor;   // for tests

    // Telex and the candidates: on unless switched off (kept in this browser)
    const telexBtn = $('telex');
    let telexOn = true;
    try { telexOn = localStorage.getItem('scrollsTelex') !== '0'; } catch (e) { /* default */ }
    const adapter = new ImeAdapter(editor);
    ime = new VietIme(adapter, { defer: true, telex: telexOn, candidates: telexOn });
    adapter.ime = ime;
    const setTelex = on => {
        telexOn = on;
        telexBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        ime.update({ telex: on, candidates: on });
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
        document.fonts.ready.then(() => Layout.current && Layout.current.schedule(true));
    });
    sizeSel.addEventListener('change', () => { store.settings.size = +sizeSel.value; applySettings(); store.changed(); Layout.current && Layout.current.schedule(true); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') store.save(); });
    window.addEventListener('beforeunload', e => { if (store.dirty || store.saving) { store.save(); e.preventDefault(); e.returnValue = ''; } });
    document.fonts.ready.then(() => Layout.current && Layout.current.schedule(true));
    if (!doc || !doc.textContent) editor.focus();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
