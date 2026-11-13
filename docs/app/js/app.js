/*
Nôm Notes: the list, the editor view, the saving (taken over from Qatt.org Notes, notes.js; the editor is the one of Scrolls, editor.js).
Needs lang.js, parser.js, qatt-text.js, ime.js, fonts.js, prosemirror.js, styles.js, core.js, db.js, editor.js.
Routes (history, so the back button of Android works): "#/" the list, "#/n/<id>" a document. A new document is written to the store at its first autosave that is not empty.
window.notesApp = { store, ready, flush() } is for the tests.
*/
(() => {
  const $ = id => document.getElementById(id);
  const parser = new VietnameseParser('qatt');   // for the search in the readings of QATT cells
  const state = { store: null, docs: [], current: null, inStore: false, dirty: false };
  const app = window.notesApp = { store: null, ready: false, flush: () => save() };
  let saveTimer = null, snackTimer = null, deleted = null, persistAsked = false;
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));

  // ----- snackbar -----
  const hideSnack = () => { clearTimeout(snackTimer); $('snackbar').hidden = true; deleted = null; };
  const snack = (en, vi, { undo = false, sticky = false } = {}) => {
    clearTimeout(snackTimer);
    $('snackbar-text').textContent = Lang.t(en, vi);
    $('undo').hidden = !undo;
    $('snackbar').hidden = false;
    if (!sticky) snackTimer = setTimeout(hideSnack, 5000);
  };
  const warnUnsaved = () => snack('Notes cannot be saved on this device', 'Không thể lưu ghi chú trên thiết bị này', { sticky: true });

  // ----- list -----
  const when = ms => {
    const d = new Date(ms), now = new Date(), locale = Lang.current === 'vi' ? 'vi-VN' : undefined;
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString(locale, d.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
  };
  function renderList() {
    const list = $('notes');
    list.textContent = '';
    state.docs.sort((a, b) => b.updated - a.updated);
    const query = $('search').value, cellReading = cell => QattText.reading(cell, parser);
    const shown = state.docs.filter(d => DocsCore.matches((d.title ? d.title + '\n' : '') + (d.text || ''), query, cellReading));
    for (const doc of shown) {
      const li = document.createElement('li'), row = document.createElement('button');
      row.type = 'button'; row.className = 'note-row'; row.dataset.id = doc.id;
      const look = styleOf(doc);   // each document is drawn in its own style
      row.style.background = look.bg; row.style.color = look.ink; row.style.textShadow = look.shadow;
      row.style.setProperty('--row-font', fontStack(formatOf(doc).font));
      const title = document.createElement('span'), t = DocsCore.title(doc.text || '', doc.title);
      title.className = 'note-title';
      if (t) title.textContent = t;
      else { title.setAttribute('data-vi', 'Không có tiêu đề'); title.textContent = 'Untitled'; title.classList.add('untitled'); }
      const preview = document.createElement('span'), date = document.createElement('span');
      preview.className = 'note-preview'; preview.textContent = DocsCore.preview(doc.text || '', doc.title);
      date.className = 'note-date'; date.textContent = when(doc.updated);
      row.append(title, preview, date);
      li.append(row);
      list.append(li);
    }
    $('empty').hidden = state.docs.length > 0;
    $('no-results').hidden = state.docs.length === 0 || shown.length > 0;
  }

  // ----- saving -----
  const askPersist = () => {
    if (persistAsked || !navigator.storage || !navigator.storage.persist) return;
    persistAsked = true;
    navigator.storage.persist().catch(() => {});
  };
  function schedule() {
    state.dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  }
  let saving = Promise.resolve();
  function save() {
    clearTimeout(saveTimer); saveTimer = null;
    const doc = state.current;
    if (!doc || !state.dirty) return saving;
    state.dirty = false;
    const text = NomEditor.text();
    if (!/\S/.test(text) && !doc.title && !state.inStore) return saving;   // a new document that stays empty
    doc.content = NomEditor.json();
    doc.text = text;
    doc.updated = Date.now();
    const copy = { ...doc };
    saving = saving.then(async () => {
      try {
        await state.store.put(copy);
        state.inStore = true;
        const i = state.docs.findIndex(d => d.id === copy.id);
        if (i < 0) state.docs.push(copy); else state.docs[i] = copy;
        askPersist();
      } catch (e) { warnUnsaved(); }
    });
    return saving;
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });
  window.addEventListener('pagehide', () => { save(); });

  // ----- editor -----
  NomEditor.mount($('editor'), $('toolbar'));
  const edited = () => { schedule(); showTitle(); buttons(); };
  const showTitle = () => { $('editor-title').textContent = DocsCore.title(NomEditor.text(), state.current && state.current.title); };
  function buttons() { $('undo-btn').disabled = !NomEditor.editable || !NomEditor.canUndo(); $('redo-btn').disabled = !NomEditor.editable || !NomEditor.canRedo(); }
  for (const [id, step] of [['undo-btn', 'undo'], ['redo-btn', 'redo']]) {
    $(id).addEventListener('pointerdown', e => e.preventDefault());   // the keyboard stays
    $(id).addEventListener('click', () => { NomEditor[step](); buttons(); });
  }

  // a tap on the title in the bar sets the title by hand; a title like the first line, or an empty one, is no title of its own
  const titleInput = $('title-input');
  if (window.VietIme) new VietIme(titleInput, { telex: true, candidates: false });
  function editTitle(on, commit) {
    if (on) {
      if (!state.current) return;
      titleInput.value = DocsCore.title(NomEditor.text(), state.current.title);
      $('editor-title').hidden = true; titleInput.hidden = false; titleInput.focus(); titleInput.select();
      return;
    }
    if (titleInput.hidden) return;
    titleInput.hidden = true; $('editor-title').hidden = false;
    const doc = state.current, value = titleInput.value.trim(), auto = DocsCore.title(NomEditor.text());
    const next = value === '' || value === auto ? '' : value;
    if (commit && doc && next !== (doc.title || '')) { if (next) doc.title = next; else delete doc.title; schedule(); }
    showTitle();
  }
  $('editor-title').addEventListener('click', () => editTitle(true));
  titleInput.addEventListener('blur', () => editTitle(false, true));
  titleInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); editTitle(false, true); }
    else if (e.key === 'Escape') { e.preventDefault(); editTitle(false, false); }
  });

  // reading mode (an existing document opens read-only, no keyboard) and editing mode (a new document, the pencil of the bar, a double tap in the text)
  function setEditing(on) {
    NomEditor.setEditable(on);
    $('edit-btn').querySelector('i').className = on ? 'fa-solid fa-check' : 'fa-solid fa-pencil';
    $('edit-btn').setAttribute('aria-pressed', String(on));
    $('edit-btn').setAttribute('aria-label', on ? Lang.t('Done', 'Xong') : Lang.t('Edit', 'Chỉnh sửa'));
    $('view-editor').classList.toggle('reading', !on);
    buttons();
  }
  $('edit-btn').addEventListener('click', () => { const on = !NomEditor.editable; setEditing(on); if (on) NomEditor.focus(); else save(); });
  let lastTap = { t: 0, x: 0, y: 0 };
  $('field').addEventListener('pointerup', e => {   // a double tap in the reading view starts editing there (dblclick is not sent on every phone)
    if (NomEditor.editable) return;
    if (e.timeStamp - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
      lastTap.t = 0;
      setEditing(true);
      const view = NomEditor.view, at = view.posAtCoords({ left: e.clientX, top: e.clientY });
      NomEditor.focus();
      if (at) view.dispatch(view.state.tr.setSelection(PM.TextSelection.near(view.state.doc.resolve(at.pos))));
    } else lastTap = { t: e.timeStamp, x: e.clientX, y: e.clientY };
  });
  document.addEventListener('langchange', () => setEditing(NomEditor.editable));

  function showEditor(doc, fresh) {
    state.current = doc; state.inStore = !fresh; state.dirty = false;
    closeMenu();
    $('view-list').hidden = true;
    $('view-editor').hidden = false;
    applyStyle(doc);
    applyFormat(doc);
    if (!NomEditor.open(doc.content || null, edited)) snack('Parts of this document could not be read', 'Không đọc được một phần của ghi chú này', { sticky: true });
    $('field').scrollTop = 0;
    showTitle();
    setEditing(fresh);
    if (fresh) NomEditor.focus();
  }
  async function showList() {
    await save();
    state.current = null;
    closeMenu();
    NomEditor.setEditable(false);
    $('view-editor').hidden = true;
    $('view-list').hidden = false;
    renderList();
  }
  async function route() {
    const m = /^#\/n\/(.+)$/.exec(location.hash);
    if (!m) return showList();
    const id = decodeURIComponent(m[1]);
    if (state.current && state.current.id === id) return;
    await save();
    const doc = state.docs.find(d => d.id === id);
    if (!doc) { history.replaceState(null, '', '#/'); return showList(); }
    showEditor({ ...doc }, false);
  }
  window.addEventListener('popstate', route);
  const go = hash => { history.pushState({ fromList: true }, '', hash); return route(); };
  // a new document; the first one ever is on rice paper, later ones get a random style
  function openNew() {
    const now = Date.now(), doc = { id: newId(), content: null, text: '', created: now, updated: now, style: DocStyles.encode(DocStyles.css(state.docs.length === 0 ? styleById('rice-paper') : DocStyles.random())) };
    history.pushState({ fromList: true }, '', '#/n/' + encodeURIComponent(doc.id));
    showEditor(doc, true);
  }
  $('new-note').addEventListener('click', () => openNew());
  $('notes').addEventListener('click', e => {
    const row = e.target.closest('.note-row');
    if (row) go('#/n/' + encodeURIComponent(row.dataset.id));
  });
  $('back').addEventListener('click', () => {
    if (history.state && history.state.fromList) history.back();
    else { history.replaceState(null, '', '#/'); route(); }
  });

  // the input (for every document): Telex (Quốc Ngữ) or none
  const IME_KEY = 'nomNotesIme';
  function setIme(mode, keep) {
    mode = mode === 'off' ? 'off' : 'telex';
    NomEditor.setTelex(mode === 'telex');
    $('set-ime').value = mode;
    if (keep) try { localStorage.setItem(IME_KEY, mode); } catch (e) { /* not kept */ }
  }
  $('set-ime').addEventListener('change', () => { setIme($('set-ime').value, true); NomEditor.focus(); });
  try { setIme(localStorage.getItem(IME_KEY)); } catch (e) { setIme('telex'); }

  // the keyboard covers the lower part of the screen: the editor view ends above it
  const vv = window.visualViewport;
  function fitKeyboard() {
    const inset = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    $('view-editor').style.bottom = inset + 'px';
  }
  if (vv) { vv.addEventListener('resize', fitKeyboard); vv.addEventListener('scroll', fitKeyboard); }

  // ----- menus -----
  const MENUS = [['menu-btn', 'menu'], ['list-menu-btn', 'list-menu'], ['style-btn', 'style-menu'], ['size-btn', 'size-menu']];
  function closeMenu() { for (const [button, menu] of MENUS) { $(menu).hidden = true; $(button).setAttribute('aria-expanded', 'false'); } }
  for (const [button, menu] of MENUS) $(button).addEventListener('click', e => {
    e.stopPropagation();
    const open = $(menu).hidden;
    closeMenu();
    $(menu).hidden = !open;
    $(button).setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', e => { if (!e.target.closest('.menu')) closeMenu(); });
  $('size-btn').addEventListener('pointerdown', e => e.preventDefault());   // the keyboard stays
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });

  // ----- search, export, import -----
  let searchTimer = null;
  $('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderList, 150); });
  $('search-toggle').addEventListener('click', () => {
    const open = $('search-bar').hidden;
    $('search-bar').hidden = !open;
    if (open) $('search').focus(); else { $('search').value = ''; renderList(); }
  });
  const ERRORS_VI = { 'Not a file of Nôm Notes': 'Không phải tệp của Nôm Notes', 'The file has an invalid document': 'Tệp có ghi chú không hợp lệ' };
  $('export').addEventListener('click', async () => {
    closeMenu();
    await save();
    const d = new Date(), pad = n => String(n).padStart(2, '0');
    const name = `nom-notes-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
    const file = new File([DocsCore.exportJSON(state.docs)], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  });
  $('import').addEventListener('click', () => { closeMenu(); $('import-file').value = ''; $('import-file').click(); });
  $('import-file').addEventListener('change', async () => {
    const file = $('import-file').files[0];
    if (!file) return;
    const parsed = DocsCore.parseImport(await file.text());
    if (!parsed.ok) { snack(parsed.error, ERRORS_VI[parsed.error] || parsed.error); return; }
    const merged = DocsCore.merge(state.docs, parsed.docs);
    try { await state.store.putMany(merged.docs); } catch (e) { warnUnsaved(); return; }
    state.docs = merged.docs;
    renderList();
    snack(`Imported ${merged.added}, updated ${merged.updated}`, `Đã nhập ${merged.added}, cập nhật ${merged.updated}`);
  });

  // the language: EN | VI in the bar of the list, the current one is lit
  const langLabel = () => document.querySelectorAll('#lang-switch button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === Lang.current)));
  document.querySelectorAll('#lang-switch button').forEach(b => b.addEventListener('click', () => Lang.set(b.dataset.lang)));
  document.addEventListener('langchange', () => { langLabel(); renderList(); });
  langLabel();

  // ----- font, style, size, table: they belong to the document (doc.format: only what differs from the defaults) -----
  const FONTS = qattFontsShown();   // js/fonts.js decides which fonts this visitor has; its default is the default here
  const FORMAT_DEFAULTS = { font: (FONTS.find(f => f.default) || FONTS[0]).family, size: 100, decoding: 'qatt' };
  const formatOf = doc => ({ ...FORMAT_DEFAULTS, ...(doc && doc.format && typeof doc.format === 'object' ? doc.format : {}) });
  const keepFormat = (key, value) => { const doc = state.current; if (!doc) return; doc.format = { ...(doc.format || {}), [key]: value }; if (value === FORMAT_DEFAULTS[key]) delete doc.format[key]; schedule(); };
  // the font with its Latin, the PA behind it, then the Chữ Nôm fonts of the Chunom site (js/fonts.js)
  const fontStack = family => [typeof qattFieldFont === 'function' ? qattFieldFont(family) : `"${family}"`, ...paFontStack(family).map(f => `"${f}"`)].join(', ');
  const setFont = (family, user) => {
    if (typeof QATT_FONT_RENAMED !== 'undefined' && QATT_FONT_RENAMED[family]) family = QATT_FONT_RENAMED[family];
    if (!FONTS.some(f => f.family === family)) family = FORMAT_DEFAULTS.font;
    document.documentElement.style.setProperty('--doc-font', fontStack(family));
    if (user) keepFormat('font', family);
    document.querySelectorAll('#set-font button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.font === family)));
    NomEditor.relayout();
    document.fonts.ready.then(() => NomEditor.relayout());
  };
  for (const f of FONTS) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.font = f.family; b.setAttribute('role', 'radio');
    const q = document.createElement('span'), label = document.createElement('span');
    q.className = 'qsample'; q.style.fontFamily = fontStack(f.family) + ', var(--nom), serif';
    q.textContent = '𡨸喃';
    label.textContent = f.label;
    b.append(q, label);
    b.addEventListener('click', () => { setFont(f.family, true); closeMenu(); });
    $('set-font').append(b);
  }

  // the style of a document is stored in it as css (base64), not as a name
  const styleById = id => DocStyles.list.find(s => s.id === id) || DocStyles.list.find(s => s.id === DocStyles.defaultId);
  const styleOf = doc => DocStyles.parse(DocStyles.decode(doc.style || '')) || DocStyles.parse(DocStyles.css(styleById(DocStyles.defaultId)));
  function applyStyle(doc) {
    DocStyles.apply(styleOf(doc));
    const current = DocStyles.decode(doc.style || '') || DocStyles.css(styleById(DocStyles.defaultId));
    document.querySelectorAll('#set-style button').forEach(b => b.setAttribute('aria-checked', String(DocStyles.css(styleById(b.dataset.style)) === current)));
  }
  for (const s of DocStyles.list) {
    const b = document.createElement('button'), box = document.createElement('span'), label = document.createElement('span');
    b.type = 'button'; b.dataset.style = s.id; b.setAttribute('role', 'radio');
    box.className = 'style-sample'; box.textContent = '𡨸喃';
    box.style.background = s.bg; box.style.color = s.ink; box.style.textShadow = s.shadow;
    label.textContent = s.en; label.setAttribute('data-vi', s.vi);
    b.append(box, label);
    b.addEventListener('click', () => {
      const doc = state.current;
      if (!doc) return;
      doc.style = DocStyles.encode(DocStyles.css(styleById(s.id)));
      applyStyle(doc);
      schedule();
      closeMenu();
    });
    $('set-style').append(b);
  }

  // the size: 100% is 22 pixels (the size of Scrolls); the grid of the vertical pages follows it
  const setSize = (value, user) => {
    value = Math.min(300, Math.max(50, Number(value) || 100));
    $('set-size').value = value; $('size-label').textContent = $('size-btn-label').textContent = value + '%';
    document.documentElement.style.setProperty('--doc-size', Math.round(value * 0.22) + 'px');
    if (user) keepFormat('size', value);
    NomEditor.relayout();
  };
  $('set-size').addEventListener('input', () => setSize($('set-size').value, true));

  // the rhyme table of the document (the readings in QATT: the ruby, later the input)
  for (const [name, label, vi] of VietnameseParser.TABLES) { const o = new Option(label, name); o.setAttribute('data-vi', vi); $('set-decoding').append(o); }
  function useDecoding(name) {
    const select = $('set-decoding');
    if (!Array.from(select.options).some(o => o.value === name)) name = 'qatt';
    select.value = name;
    NomEditor.setDecoding(name);
  }
  $('set-decoding').addEventListener('change', () => { keepFormat('decoding', $('set-decoding').value); useDecoding($('set-decoding').value); closeMenu(); });

  function applyFormat(doc) {
    const f = formatOf(doc);
    setFont(f.font); setSize(f.size); useDecoding(f.decoding);
  }

  // ----- delete and undo -----
  $('menu-delete').addEventListener('click', async () => {
    const doc = state.current;
    if (!doc) return;
    clearTimeout(saveTimer); saveTimer = null; state.dirty = false;
    const wasStored = state.inStore, snapshot = { ...doc, content: NomEditor.json(), text: NomEditor.text() };
    state.current = null;
    closeMenu();
    await saving;   // a save that is already running ends before the document is removed
    if (wasStored) {
      try { await state.store.remove(doc.id); } catch (e) { warnUnsaved(); }
      state.docs = state.docs.filter(d => d.id !== doc.id);
    }
    if (/\S/.test(snapshot.text) || wasStored) { snack('Deleted', 'Đã xóa', { undo: true }); deleted = snapshot; }
    if (history.state && history.state.fromList) history.back(); else { history.replaceState(null, '', '#/'); route(); }
  });
  $('undo').addEventListener('click', async () => {
    const doc = deleted;
    if (!doc) return;
    hideSnack();
    try { await state.store.put(doc); } catch (e) { warnUnsaved(); }
    state.docs.push(doc);
    renderList();
  });

  document.addEventListener('gesturestart', e => e.preventDefault());   // Safari ignores user-scalable=no

  // ----- start -----
  (async () => {
    try { state.store = await DocsDB.open(); state.docs = await state.store.all(); }
    catch (e) { state.store = DocsDB.memory(); warnUnsaved(); }
    app.store = state.store;
    await route();
    if (state.docs.length === 0 && !state.current) $('new-note').click();   // nothing written yet: straight to the editor
    app.ready = true;
  })();
})();
