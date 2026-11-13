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
        baseKeymap, toggleMark, setBlockType, chainCommands, dropCursor } = PM;

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
        warichu: { parseDOM: [{ tag: 'span.wari' }], toDOM: () => ['span', { class: 'wari' }, 0] },
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
        UI.refresh();
    }
}

// The segments of a run of two-column text (chars: code points). The grid of the old prints: it takes whole cells; the first segment fills
// the rest of the column, the next ones whole columns, the last one is balanced (the right line gets the extra character); half a cell left over stays empty.
// from/to are offsets in UTF-16 units from the start of the run.
function segments(chars, offset, len, half) {
    const cell = 2 * half, tol = half * 0.05;
    let startPad = Math.ceil((offset - tol) / cell) * cell - offset;
    if (startPad < tol) startPad = 0;
    const fit = px => Math.floor((px + tol) / half);
    let perLine = fit(len - offset - startPad);
    if (perLine < 1) { perLine = fit(len); startPad = 0; }
    const full = Math.max(1, fit(len));
    const out = [];
    let i = 0, u = 0, cap = 2 * Math.max(1, perLine);
    while (i < chars.length) {
        const take = Math.min(cap, chars.length - i);
        const units = chars.slice(i, i + take).join('').length;
        const line = Math.ceil(take / 2);
        let style = `inline-size: ${line}em;`;
        if (line % 2) style += ' padding-inline-end: 1em;';
        if (!out.length && startPad) style += ` margin-inline-start: ${startPad.toFixed(2)}px;`;
        out.push({ from: u, to: u + units, style });
        i += take; u += units;
        cap = 2 * full;
    }
    return out;
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
        this.bubble = el('div', { className: 'scroll-ui', hidden: true }, this.bH1, this.bH2, el('span', { className: 'sep' }), this.bWari);

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
        document.addEventListener('pointerdown', e => {
            if (this.menuOpen && !this.plusMenu.contains(e.target) && !this.plus.contains(e.target)) { this.menuOpen = false; this.refresh(); }
        });
    },
    place(box, left, top) {
        const w = box.offsetWidth, vw = document.documentElement.clientWidth;
        box.style.left = Math.max(8, Math.min(left, vw - w - 8)) + scrollX + 'px';
        box.style.top = Math.max(8, top) + scrollY + 'px';
    },
    refresh() {
        const view = this.view;
        if (!view || !view.state) return;
        const { state } = view, sel = state.selection, focused = view.hasFocus();
        const show = (box, on) => { box.hidden = !on; return on; };

        // bubble
        if (show(this.bubble, focused && !sel.empty && sel instanceof TextSelection)) {
            const a = view.coordsAtPos(sel.from), b = view.coordsAtPos(sel.to);
            const p = sel.$from.parent;
            this.bH1.classList.toggle('on', p.type === S.heading && p.attrs.level === 1);
            this.bH2.classList.toggle('on', p.type === S.heading && p.attrs.level === 2);
            const wari = schema.marks.warichu;
            this.bWari.classList.toggle('on', state.doc.rangeHasMark(sel.from, sel.to, wari));
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
        if (show(this.tools, focused && sel.empty && sel.$from.depth >= 1)) {
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
