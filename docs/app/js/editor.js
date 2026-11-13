/*
The editor of Nôm Notes (app/): the editor of Scrolls as a part that the app (app.js) mounts once and gives every document to (NomEditor below).

A document is doc > section+ > group+ > (paragraph | heading)+. A section is a box (kind 'text'; later pictures or tables). A group is what the
user sees as a page: paragraphs in a row with the same direction (horizontal: flowing text; vertical: columns of `cols` characters, right to
left, continued in bands below), with a dotted line between pages. Without a selection the drop-downs set the page with the caret; with a
selection the paragraphs it touches (their page is split around them). Neighbouring pages with the same settings are joined (normalizePlugin)
unless the second one starts with a page break (brk, Ctrl+Enter). Two-column text (warichu) is a mark; the layout lays it out as segments
(inline decorations), the bands of vertical groups get their height here. ProseMirror comes from js/prosemirror.js (window.PM, built in the
private repository), the Telex input and the dictionaries from /chunom/js/ime.js.
*/

(() => {
'use strict';
const { Schema, EditorState, EditorView, Plugin, PluginKey, TextSelection, Decoration, DecorationSet, keymap, history, undo, redo,
        baseKeymap, toggleMark, setBlockType, dropCursor, Fragment, Slice, joinBackward, joinForward } = PM;
const QATT = 'https://qatt.org';

const T = (en, vi) => (window.Lang ? Lang.t(en, vi) : en);
const MIN_COLS = 2, MAX_COLS = 40, DEFAULT_COLS = 12;
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
        // the box; kind 'text' holds the groups of paragraphs (other kinds later: a picture, a table)
        section: {
            content: 'group+',
            isolating: true,
            attrs: { kind: { default: 'text' } },
            parseDOM: [{ tag: 'section.sec' }],
            toDOM: n => ['section', { class: 'sec shadow p-3', 'data-kind': n.attrs.kind }, 0],
        },
        // a page: paragraphs in a row with the same direction and characters per column (kept by the editor, see above)
        group: {
            content: 'block+',
            // brk: the page starts with a page break (it is not joined with the page before when the settings are the same)
            attrs: { dir: { default: 'v' }, cols: { default: DEFAULT_COLS }, brk: { default: false } },
            parseDOM: [{ tag: 'div.grp', getAttrs: d => ({ dir: d.dataset.dir === 'h' ? 'h' : 'v', cols: clampCols(+d.dataset.cols), brk: d.dataset.brk === '1' }) }],
            toDOM: n => ['div', { class: 'grp ' + n.attrs.dir, 'data-dir': n.attrs.dir, 'data-cols': n.attrs.cols, 'data-brk': n.attrs.brk ? '1' : '0', style: `--cols: ${n.attrs.cols}` }, 0],
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
const emptyDoc = (dir = 'v') => S.doc.create(null, S.section.create(null, S.group.create({ dir, cols: DEFAULT_COLS }, S.paragraph.create())));
// two groups with these settings are one (horizontal text has no characters per column)
const sameSettings = (a, b) => a.dir === b.dir && (a.dir === 'h' || a.cols === b.cols);
// the group of a position (null outside the text)
const groupOf = $pos => { for (let d = $pos.depth; d > 0; d--) if ($pos.node(d).type === S.group) return { node: $pos.node(d), pos: $pos.before(d), depth: d }; return null; };

// a stored scroll of the first version (doc > section{dir, cols} > blocks) becomes one section with a page for each of its sections
function upgrade(json) {
    const secs = (json && json.content) || [];
    if (!secs.length || !secs[0].content || !secs[0].content.length || secs[0].content[0].type === 'group') return json;
    const groups = [];
    for (const sec of secs) {
        // every old section becomes a page of its own (a page break where the settings are the same)
        const a = sec.attrs || {}, attrs = { dir: a.dir === 'h' ? 'h' : 'v', cols: clampCols(+a.cols), brk: groups.length > 0 };
        groups.push({ type: 'group', attrs, content: [...(sec.content || [])] });
    }
    return { type: 'doc', content: [{ type: 'section', attrs: { kind: 'text' }, content: groups }] };
}

// a group keeps its element when its text changes; the height that the layout sets is not a change of the document
class GroupView {
    constructor(node) { this.dom = this.contentDOM = document.createElement('div'); this.node = null; this.set(node); }
    set(node) {
        const d = this.dom, a = node.attrs;
        if (!this.node || this.node.attrs.dir !== a.dir) d.style.height = '';
        d.className = 'grp ' + a.dir;
        d.dataset.dir = a.dir;
        d.dataset.cols = a.cols;
        d.style.setProperty('--cols', a.cols);
        this.node = node;
    }
    update(node) {
        if (node.type !== S.group) return false;
        if (node.attrs.dir !== this.node.attrs.dir || node.attrs.cols !== this.node.attrs.cols) this.set(node); else this.node = node;
        return true;
    }
    ignoreMutation(m) { return m.type === 'attributes' && m.target === this.dom; }
}

// ---------------------------------------------------------------- commands
// The settings (dir, cols) of a page or of paragraphs. Without a selection: the page with the caret (it may join a neighbour with the same
// settings). With a selection (or paragraphs: true): the paragraphs it touches, as in a word processor; their page is split around them.
function setSettings(change, { paragraphs = null } = {}) {
    return (state, dispatch) => {
        const { from, to, empty } = state.selection, touched = [];
        const whole = paragraphs === null ? empty : !paragraphs;
        state.doc.nodesBetween(from, to, (node, pos, parent, index) => {
            if (node.type === S.group) { touched.push({ pos, node, first: -1, last: -1 }); return true; }
            if (node.isTextblock) { const g = touched[touched.length - 1]; if (g && parent === g.node) { if (g.first < 0) g.first = index; g.last = index; } return false; }
            return true;
        });
        const tr = state.tr;
        for (let k = touched.length - 1; k >= 0; k--) {   // from the end: the positions before stay
            const g = touched[k], a = g.node.attrs;
            if (g.first < 0) continue;
            const attrs = { ...a, ...change };
            if (attrs.dir === a.dir && attrs.cols === a.cols && attrs.brk === a.brk) continue;
            if (whole) { tr.setNodeMarkup(g.pos, null, attrs); continue; }
            let start = g.pos + 1;
            for (let i = 0; i < g.first; i++) start += g.node.child(i).nodeSize;
            let end = start;
            for (let i = g.first; i <= g.last; i++) end += g.node.child(i).nodeSize;
            // the parts split off continue the page: no page break
            if (g.last < g.node.childCount - 1) tr.split(end, 1, [{ type: S.group, attrs: { ...a, brk: false } }]);
            let at = g.pos, own = attrs;
            if (g.first > 0) { tr.split(start, 1, [{ type: S.group, attrs: { ...a, brk: false } }]); at = start + 1; own = { ...attrs, brk: change.brk ?? false }; }
            tr.setNodeMarkup(at, null, own);
        }
        if (!tr.docChanged) return false;
        if (dispatch) dispatch(tr.scrollIntoView());
        return true;
    };
}

// Ctrl+Enter: a new page from the caret on (the paragraph is split there; at its start the page begins before it), same settings
function pageBreak(state, dispatch) {
    if (!groupOf(state.selection.$from)) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    if (!state.selection.empty) tr.deleteSelection();
    if (tr.selection.$from.parentOffset > 0) tr.split(tr.selection.from);
    const $p = tr.selection.$from, g = groupOf($p);
    if ($p.index(g.depth) > 0) tr.split($p.before($p.depth), 1, [{ type: S.group, attrs: { ...g.node.attrs, brk: true } }]);
    else if ($p.index(g.depth - 1) > 0 && !g.node.attrs.brk) tr.setNodeMarkup(g.pos, null, { ...g.node.attrs, brk: true });
    else return false;
    dispatch(tr.scrollIntoView());
    return true;
}

// Backspace at the start of the first paragraph of a group: the paragraph first takes the settings of the one before (it joins it),
// so that only it changes, not the rest of its group. Delete at the end of the last paragraph of a group: the same with the next one.
function joinGroupBackward(state, dispatch, view) {
    const { $cursor } = state.selection;
    if (!$cursor || $cursor.parentOffset > 0) return false;
    const g = groupOf($cursor);
    if (!g || $cursor.index(g.depth) !== 0 || $cursor.index(g.depth - 1) === 0) return false;
    const prev = $cursor.node(g.depth - 1).child($cursor.index(g.depth - 1) - 1);
    if (!dispatch) return true;
    // a page break between pages with the same settings: Backspace takes the break away (the paragraphs stay)
    if (g.node.attrs.brk && sameSettings(prev.attrs, g.node.attrs)) { dispatch(state.tr.setNodeMarkup(g.pos, null, { ...g.node.attrs, brk: false })); return true; }
    setSettings({ dir: prev.attrs.dir, cols: prev.attrs.cols, brk: false }, { paragraphs: true })(state, dispatch);
    if (view) joinBackward(view.state, view.dispatch);
    return true;
}
function joinGroupForward(state, dispatch, view) {
    const { $cursor } = state.selection;
    if (!$cursor || $cursor.parentOffset < $cursor.parent.content.size) return false;
    const g = groupOf($cursor);
    if (!g) return false;
    const box = $cursor.node(g.depth - 1), gi = $cursor.index(g.depth - 1);
    if ($cursor.index(g.depth) !== g.node.childCount - 1 || gi === box.childCount - 1) return false;
    if (!dispatch) return true;
    const next = box.child(gi + 1), nextPos = g.pos + g.node.nodeSize;
    if (next.attrs.brk && sameSettings(next.attrs, g.node.attrs)) { dispatch(state.tr.setNodeMarkup(nextPos, null, { ...next.attrs, brk: false })); return true; }
    const nextStart = nextPos + 2;   // in the first paragraph of the next group
    const tr = state.tr.setSelection(TextSelection.create(state.doc, nextStart));
    const moved = state.apply(tr);
    setSettings({ dir: g.node.attrs.dir, cols: g.node.attrs.cols, brk: false }, { paragraphs: true })(moved, t => {
        // the settings on the next paragraph, the caret back where it was
        for (const step of t.steps) tr.step(step);
        tr.setSelection(TextSelection.create(tr.doc, $cursor.pos));
        dispatch(tr);
    });
    if (view) joinForward(view.state, view.dispatch);
    return true;
}

// pages next to each other with the same settings become one (after every change), unless the second one starts with a page break
const normalizePlugin = new Plugin({
    appendTransaction(trs, old, state) {
        if (!trs.some(t => t.docChanged)) return null;
        const joins = [];
        state.doc.forEach((sec, secPos) => {
            if (sec.type !== S.section) return;
            let pos = secPos + 1, prev = null;
            sec.forEach(child => {
                if (prev && prev.type === S.group && child.type === S.group && !child.attrs.brk && sameSettings(prev.attrs, child.attrs)) joins.push(pos);
                prev = child;
                pos += child.nodeSize;
            });
        });
        if (!joins.length) return null;
        const tr = state.tr;
        for (let i = joins.length - 1; i >= 0; i--) tr.join(joins[i]);
        return tr;
    },
});

const setHeading = level => (state, dispatch) => {
    const { $from } = state.selection;
    const on = $from.parent.type === S.heading && $from.parent.attrs.level === level;
    return on ? setBlockType(S.paragraph)(state, dispatch) : setBlockType(S.heading, { level })(state, dispatch);
};
const toggleWari = toggleMark(schema.marks.warichu);
const openRuby = () => { RubyBox.open(); return true; };

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
            const whole = Math.max(cell, Math.ceil((first - tol) / cell) * cell), size = Math.min(cap, whole, first + 0.5);   // never longer than its cells
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
        nodeViews: { group: node => new GroupView(node) },
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
        const sections = [...view.dom.querySelectorAll('div.grp')];   // the groups (a vertical one is laid out in bands)
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
                const mk = mks[k], sec = mk.closest('div.grp'), inf = info.get(sec);
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
        // the bands: cut every vertical group to the bands that hold text
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
            const v = !!rb.closest('.grp.v'), r = base.getBoundingClientRect();
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
            .then(() => { this.parser = new VietnameseParser(this.decoding || 'qatt'); })
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
            const sec = doc.firstChild, grp = sec && sec.firstChild, para = grp && grp.firstChild;
            if (doc.childCount !== 1 || sec.childCount !== 1 || grp.type !== S.group || grp.childCount !== 1 || para.content.size) return null;
            return DecorationSet.create(doc, [Decoration.node(2, 2 + para.nodeSize, { class: 'is-empty', 'data-placeholder': T('Write…', 'Viết…') })]);
        },
    },
});

// ---------------------------------------------------------------- the toolbar (the format bar of the app)
const UI = {
    view: null,
    // parts: format (the format bar: headings, two-column text, ruby), dir (the direction, in the format bar), menu (characters per column), newPage (the title bar)
    init(parts) {
        this.bar = parts.format;
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
        // the settings of the paragraphs are drop-downs; the group label of the list says what the option is
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
        // the direction: one button in the title bar that turns the page (or the paragraphs of the selection) to the other direction
        this.bDir = btn(icon('fa-grip-lines-vertical'), 'Page direction', 'Hướng trang', () => this.setSettings({ dir: this.dir === 'v' ? 'h' : 'v' }));
        this.bDir.classList.add('dir-btn');
        this.selCols = select('Characters per column', 'Số chữ mỗi cột', COLS_OPTIONS.map(n => [String(n), String(n)]), v => this.setSettings({ cols: clampCols(+v) }));
        const colsRow = el('label', { className: 'menu-row' }, vi('Characters per column', 'Số chữ mỗi cột'), this.selCols);
        this.bPage = btn(icon('fa-file-circle-plus'), 'New page (Ctrl+Enter)', 'Trang mới (Ctrl+Enter)', cmd(pageBreak));
        this.bar.append(this.bH1, this.bH2, this.bWari, this.bRuby);
        parts.dir.append(this.bDir);
        parts.menu.append(colsRow);
        (parts.newPage || parts.menu).append(this.bPage);
        void sep;

        window.addEventListener('resize', () => this.position());
        if (window.visualViewport) visualViewport.addEventListener('resize', () => this.position());
    },
    position() { if (RubyBox.isOpen()) RubyBox.place(); },
    refresh() {
        const view = this.view;
        if (!view || !view.state || !this.bar) return;
        this.bar.classList.toggle('reading', !view.editable);   // the buttons only while editing
        const { state } = view, sel = state.selection, $f = sel.$from, p = $f.parent;
        const wari = schema.marks.warichu, ruby = schema.marks.ruby;
        const on = (b, v) => b.classList.toggle('on', !!v);
        on(this.bH1, p.type === S.heading && p.attrs.level === 1);
        on(this.bH2, p.type === S.heading && p.attrs.level === 2);
        on(this.bWari, sel.empty ? wari.isInSet(state.storedMarks || $f.marks()) : state.doc.rangeHasMark(sel.from, sel.to, wari));
        const inRuby = sel.empty && rubyAt(state, sel.from);
        on(this.bRuby, inRuby || (!sel.empty && state.doc.rangeHasMark(sel.from, sel.to, ruby)));
        this.bRuby.disabled = !(inRuby || (!sel.empty && $f.parent === sel.$to.parent && !state.doc.rangeHasMark(sel.from, sel.to, wari)));
        // the settings of the paragraphs in the selection: shown when they are the same, else the field is empty
        const dirs = new Set(), cols = new Set();
        state.doc.nodesBetween(sel.from, sel.to, node => {
            if (node.type === S.group) { dirs.add(node.attrs.dir); if (node.attrs.dir === 'v') cols.add(node.attrs.cols); return false; }
            return true;
        });
        const one = set => (set.size === 1 ? [...set][0] : null);
        const dir = one(dirs), c = one(cols);
        if (c !== null && ![...this.selCols.options].some(o => o.value === String(c))) {   // a value from before that the list does not have
            const o = el('option', { value: String(c) }); o.textContent = String(c);
            const at = [...this.selCols.options].find(x => +x.value > c);
            this.selCols.firstChild.insertBefore(o, at || null);
        }
        this.dir = dir;
        this.bDir.firstChild.className = 'fa-solid ' + (dir === 'h' ? 'fa-grip-lines' : dir === 'v' ? 'fa-grip-lines-vertical' : 'fa-shuffle');
        titled(this.bDir, dir === 'h' ? 'Horizontal page (tap: vertical)' : dir === 'v' ? 'Vertical page (tap: horizontal)' : 'Mixed (tap: vertical)',
            dir === 'h' ? 'Trang ngang (chạm: dọc)' : dir === 'v' ? 'Trang dọc (chạm: ngang)' : 'Lẫn lộn (chạm: dọc)');
        this.bDir.disabled = !dirs.size || !view.editable;
        this.selCols.value = c !== null ? String(c) : '';
        this.selCols.disabled = !cols.size || !view.editable;
        this.bPage.disabled = !view.editable;
        this.position();

    },
    setSettings(change) { setSettings(change)(this.view.state, this.view.dispatch); },   // the page, or the paragraphs of the selection
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
        this.box = el('div', { className: 'scroll-ui ruby-box bg-light', hidden: true },
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
    // fixed under the format bar, at its button
    place() {
        const t = UI.bar.getBoundingClientRect(), b = UI.bRuby.getBoundingClientRect(), w = this.box.offsetWidth;
        const vw = document.documentElement.clientWidth;
        this.box.style.left = Math.max(8, Math.min(b.left, vw - w - 8)) + 'px';
        this.box.style.top = t.bottom + 6 + 'px';
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
        const g = groupOf(this.view.state.doc.resolve(this.range ? this.range.from : 0)), vert = !!g && g.node.attrs.dir === 'v';
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
    // where the candidate list goes: under the caret; in a vertical group to the left of the column, below the caret
    getBoundingClientRect() {
        const v = this.view, head = v.state.selection.head, c = v.coordsAtPos(head);
        const g = groupOf(v.state.selection.$head), vert = !!g && g.node.attrs.dir === 'v';
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

// ---------------------------------------------------------------- the API for the app (app.js)
// NomEditor.mount(element, parts, extra)   once: the view in `element`, the buttons in parts (UI.init), more plugins first (the input)
// NomEditor.open(content, onChange)   a document (its JSON, or null for a new one); onChange() after every change of the document
// NomEditor.json(), .text()           the document as JSON, its text (blocks on lines of their own)
// NomEditor.setEditable(on), .editable, .focus(), .undo(), .redo(), .canUndo(), .canRedo(), .setTelex(on), .relayout()
let view = null, changed = null, editable = false;
const NomEditor = {
    schema, upgrade, emptyDoc,
    mount(element, parts, extra = []) {
        UI.init(parts);
        const plugins = [
            ...extra,   // the input (input.js) first: its keys before the keymaps
            imeKeys,
            keymap({
                'Mod-z': undo, 'Shift-Mod-z': redo, 'Mod-y': redo,
                'Mod-Alt-1': setHeading(1), 'Mod-Alt-2': setHeading(2), 'Mod-Alt-0': setBlockType(S.paragraph),
                'Mod-Shift-d': toggleWari,
                'Mod-Shift-r': openRuby,
                'Backspace': joinGroupBackward, 'Delete': joinGroupForward, 'Mod-Enter': pageBreak,
            }),
            keymap(baseKeymap),
            history(),
            dropCursor(),
            normalizePlugin,
            placeholderPlugin,
            layoutPlugin,
            uiPlugin,
        ];
        view = new EditorView(element, {
            state: EditorState.create({ schema, doc: emptyDoc(), plugins }),
            editable: () => editable,
            dispatchTransaction(tr) {
                view.updateState(view.state.apply(tr));
                if (tr.docChanged && changed) changed();
            },
        });
        UI.view = view;
        RubyBox.init(view);
        const adapter = new ImeAdapter(view);
        ime = new VietIme(adapter, { defer: true, telex: true, candidates: false });
        adapter.ime = ime;
        window.scrollsEditor = view;   // for tests
        document.fonts.ready.then(() => this.relayout());
    },
    // a document: a new state (its own history); the plugins and their views stay
    open(content, onChange) {
        changed = null;
        let doc = null;
        if (content && content.type === 'doc') { try { doc = schema.nodeFromJSON(upgrade(content)); doc.check(); } catch (e) { console.error('The document could not be read:', e); doc = null; } }
        RubyBox.close(false);
        view.updateState(EditorState.create({ schema, doc: doc || emptyDoc(), plugins: view.state.plugins }));
        changed = onChange || null;
        this.relayout();
        return !!doc || !content;
    },
    json: () => view.state.doc.toJSON(),
    text: () => view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\ufffc'),
    get editable() { return editable; },
    setEditable(on) { editable = !!on; view.setProps({}); if (!on) RubyBox.close(false); UI.refresh(); },
    focus() { view.focus(); },
    undo() { undo(view.state, view.dispatch); },
    redo() { redo(view.state, view.dispatch); },
    canUndo: () => undo(view.state),
    canRedo: () => redo(view.state),
    setTelex(on) { if (ime) ime.update({ telex: !!on, candidates: false }); if (RubyBox.ime) RubyBox.ime.update({ telex: !!on, candidates: false }); },
    relayout() { measure.cache.clear(); if (Layout.current) Layout.current.schedule(true); },
    // the rhyme table of the document (parser.js): the readings of the ruby in QATT
    setDecoding(name) { Scripts.decoding = name; if (Scripts.parser) Scripts.parser.setDecoding(name); },
    get view() { return view; },
};
window.NomEditor = NomEditor;
})();
