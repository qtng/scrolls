/*
The sync of Nôm Notes (app/) with the account: the table `scrolls` of the Supabase project (private repository: tools/db/scrolls.sql; RLS: every user sees his own rows).
The app works on the documents in the browser (db.js); signed in, it compares them with the rows of the account (at the start, when it comes to the front,
some seconds after a change and by hand) and takes the newer side of each document. A row: id (= the id of the document), title (the title shown, for other
lists), content (the ProseMirror JSON), settings: { app: 'nom-notes', updated, created, text, title?, format?, style? } (`updated` in milliseconds is the
version that is compared). Rows of the first editor of Scrolls (no settings.app) are taken over as they are (their content is converted by the editor).
Both sides changed since the last sync: the newer one wins, the other one is dropped (no copies). Just before a document is saved in the account
its row there is read again: if another device saved a newer version meanwhile, that one is loaded and nothing is saved. The open document is not replaced under the hands of
the user: run() hands its newer version to the app, which takes it only if nothing was typed meanwhile (else the next sync uploads what was typed).
A document deleted here is deleted in the account at the next sync (its id and version wait in localStorage "nomNotesDeleted"), unless it was changed
there after the version known here (then it comes back); one deleted in the account (by another device) goes here too if it had been synced before and
was not changed here since (else it is uploaded again).

  await DocsSync.init()          the user (signed in for real) or null
  DocsSync.user, DocsSync.service the SupabaseService (js/supabase.js of qatt.org) for the login dialog
  await DocsSync.run(local, store, { skip })   local: the documents of the browser; store: db.js; skip: the id of the open document (its newer version comes as incoming)
                                 returns { docs, changed, incoming }: the documents after the sync, whether any changed here, and the newer version of
                                 the open document from the account (or null)
  await DocsSync.take(doc, store)  the app took incoming: kept in the browser and marked as synced
  DocsSync.shareCode(id)         the code of the link of a document of the account (null: not shared); shareCreate(id) makes it, shareEnd(id) deletes it
  await DocsSync.shareGet(code)  the shared document (as a document of the app) or null; works without an account
  DocsSync.forget(id, rev)       a document deleted here (rev: its synced version): delete it in the account at the next sync (unforget(id): it came back)
*/
const DocsSync = (() => {
  const DEL_KEY = 'nomNotesDeleted';
  let sp = null, user = null;
  // the documents deleted here: { id, rev } (rev: the version known here; an old entry is only the id)
  const deletedIds = () => { try { return (JSON.parse(localStorage.getItem(DEL_KEY)) || []).map(g => (typeof g === 'string' ? { id: g, rev: null } : g)); } catch (e) { return []; } };
  const keepDeleted = list => { try { localStorage.setItem(DEL_KEY, JSON.stringify(list)); } catch (e) { /* not kept */ } };
  const newId = () => crypto.randomUUID();
  // the version of each document that is known to be the same in the account ("synced up to here"): kept apart from the documents, so that a save of
  // the open document (which may have an older value of `synced`) cannot lose it; without it the next start would see a conflict that is none
  const SYNCED_KEY = 'nomNotesSynced';
  const loadSynced = () => { try { return JSON.parse(localStorage.getItem(SYNCED_KEY)) || {}; } catch (e) { return {}; } };
  const keepSynced = map => { try { localStorage.setItem(SYNCED_KEY, JSON.stringify(map)); } catch (e) { /* not kept */ } };

  async function init() {
    if (typeof SupabaseService === 'undefined' || typeof supabase === 'undefined') return null;
    if (!sp) sp = new SupabaseService();
    try { await sp.init(); } catch (e) { console.error('Sign-in failed:', e); }
    user = sp.user && !sp.isAnonymous ? sp.user : null;
    return user;
  }

  const revOf = row => (Number.isFinite(row.rev) ? row.rev : row.settings && Number.isFinite(row.settings.updated) ? row.settings.updated : Date.parse(row.updated_at));
  const toRow = d => ({
    id: d.id,
    title: DocsCore.title(d.text || '', d.title),
    content: d.content || {},
    settings: { app: 'nom-notes', updated: d.updated, created: d.created, text: d.text || '', ...(d.title ? { title: d.title } : {}), ...(d.format ? { format: d.format } : {}), ...(d.style ? { style: d.style } : {}) },
  });
  const fromRow = row => {
    const s = row.settings || {}, ours = s.app === 'nom-notes', content = row.content && row.content.type === 'doc' ? row.content : null, rev = revOf(row);
    const doc = { id: row.id, content, text: ours && typeof s.text === 'string' ? s.text : DocsCore.textOf(content), created: Number.isFinite(s.created) ? s.created : Date.parse(row.created_at || row.updated_at), updated: rev, synced: rev };
    if (ours) {
      if (s.title) doc.title = s.title;
      if (s.format) doc.format = s.format;
      if (s.style) doc.style = s.style;
    } else {   // a scroll of the first editor: its title, font and size (pixels; 100% is 32 pixels here)
      if (row.title) doc.title = row.title;
      const format = {};
      if (typeof s.font === 'string' && s.font) format.font = s.font;
      if (Number.isFinite(+s.size) && +s.size > 0) format.size = Math.min(300, Math.max(50, Math.round(+s.size / 0.32 / 10) * 10));
      if (Object.keys(format).length) doc.format = format;
    }
    return doc;
  };

  async function run(local, store, { skip } = {}) {
    if (!user) return { docs: local, changed: false, incoming: null };
    const db = sp.client;
    const { data, error } = await db.from('scrolls').select('id, updated_at, rev:settings->updated');
    if (error) throw error;
    const remote = new Map(data.map(r => [r.id, revOf(r)]));
    const marks = loadSynced();
    // what was deleted here goes in the account too, unless it was changed there after the version known here (then it comes back)
    const toDelete = deletedIds().filter(g => remote.has(g.id) && (g.rev == null || remote.get(g.id) <= g.rev)).map(g => g.id);
    if (toDelete.length) {
      const { error: e } = await db.from('scrolls').delete().in('id', toDelete);
      if (e) throw e;
      toDelete.forEach(id => { remote.delete(id); delete marks[id]; });
    }
    keepDeleted([]);
    const docs = new Map(local.map(d => [d.id, { ...d }]));
    const download = [], upload = [];
    let changed = false, incoming = null;
    const take_ = async row => {   // a row of the account replaces the document here
      const doc = fromRow(row);
      if (doc.id === skip) { incoming = doc; return; }
      docs.set(doc.id, doc);
      await store.put(doc);
      marks[doc.id] = doc.synced;
      changed = true;
    };
    for (const [id, rev] of remote) {
      const l = docs.get(id);
      if (!l) { download.push(id); continue; }
      const base = Math.max(l.synced || 0, marks[id] || 0), here = l.updated > base, there = rev > base;
      if (here && there && rev === l.updated) { marks[id] = rev; l.synced = rev; continue; }   // the same version on both sides
      if (here && there) { if (l.updated > rev) upload.push(l); else download.push(id); }   // both changed: the newer one wins (no copy)
      else if (there) download.push(id);
      else if (here) upload.push(l);
    }
    for (const l of docs.values()) if (!remote.has(l.id)) {
      const base = Math.max(l.synced || 0, marks[l.id] || 0);
      if (base && l.updated <= base) {   // deleted in the account, not changed here since (the open document goes when it is closed)
        if (l.id !== skip) { docs.delete(l.id); delete marks[l.id]; await store.remove(l.id); changed = true; }
      }
      else upload.push(l);   // new here, or changed here after it was deleted in the account: it stays
    }
    // the rows that are newer there; the open document is handed to the app (it takes it if nothing was typed meanwhile, see take())
    for (let i = 0; i < download.length; i += 50) {
      const part = download.slice(i, i + 50);
      const { data: rows, error: e } = await db.from('scrolls').select('id, title, settings, content, created_at, updated_at').in('id', part);
      if (e) throw e;
      for (const row of rows) await take_(row);
    }
    keepSynced(marks);
    // the documents that are newer here
    for (const d of upload) {
      // just before saving: has another device saved a newer version since the list was read? then that one is loaded and nothing is saved
      const { data: now0, error: e0 } = await db.from('scrolls').select('id, title, settings, content, created_at, updated_at').in('id', [d.id]);
      if (e0) throw e0;
      if (now0 && now0[0] && revOf(now0[0]) > d.updated) { await take_(now0[0]); keepSynced(marks); continue; }
      const { error: e } = await db.from('scrolls').upsert(toRow(d));
      if (e) throw e;
      const now = docs.get(d.id) || d;
      now.synced = d.updated;   // in memory and in the marks only: a put here would write the old text over what was typed while it was uploaded
      docs.set(now.id, now);
      marks[d.id] = d.updated;
      keepSynced(marks);
    }
    return { docs: [...docs.values()].sort((a, b) => b.updated - a.updated), changed, incoming };
  }
  // the app took the newer version of the open document from the account (run() gave it as incoming)
  async function take(doc, store) {
    await store.put(doc);
    const marks = loadSynced();
    marks[doc.id] = doc.synced;
    keepSynced(marks);
  }

  // the links: the table scroll_shares (the owner reads, makes and deletes his own) and the function share_get(code) (everybody; the code is the secret)
  async function shareCode(id) {
    if (!user) return null;
    const { data, error } = await sp.client.from('scroll_shares').select('code').eq('scroll_id', id).maybeSingle();
    if (error) throw error;
    return data ? data.code : null;
  }
  async function shareCreate(id) {
    const { data, error } = await sp.client.from('scroll_shares').insert({ scroll_id: id }).select('code').single();
    if (error) throw error;
    return data.code;
  }
  async function shareEnd(id) {
    const { error } = await sp.client.from('scroll_shares').delete().eq('scroll_id', id);
    if (error) throw error;
  }
  async function shareGet(code) {
    if (!sp || !sp.client) await init();
    if (!sp || !sp.client) return null;
    const { data, error } = await sp.client.rpc('share_get', { p_code: code });
    if (error) throw error;
    return data ? fromRow({ ...data, created_at: data.updated_at }) : null;
  }

  return {
    init, run, take, shareCode, shareCreate, shareEnd, shareGet,
    get user() { return user; },
    get service() { return sp; },
    forget(id, rev) { keepDeleted([...deletedIds().filter(g => g.id !== id), { id, rev: Number.isFinite(rev) ? rev : null }]); },
    unforget(id) { keepDeleted(deletedIds().filter(g => g.id !== id)); },
    async signOut() { if (sp) await sp.signOut(); user = null; },
  };
})();
