/*
The sync of Nôm Notes (app/) with the account: the table `scrolls` of the Supabase project (private repository: tools/db/scrolls.sql; RLS: every user sees his own rows).
The app works on the documents in the browser (db.js); signed in, it compares them with the rows of the account (at the start, when it comes to the front,
some seconds after a change and by hand) and takes the newer side of each document. A row: id (= the id of the document), title (the title shown, for other
lists), content (the ProseMirror JSON), settings: { app: 'nom-notes', updated, created, text, title?, format?, style? } (`updated` in milliseconds is the
version that is compared). Rows of the first editor of Scrolls (no settings.app) are taken over as they are (their content is converted by the editor).
Both sides changed since the last sync: the newer one stays where it is and the other one becomes a copy of its own (nothing is lost).
A document deleted here is deleted in the account at the next sync (its id waits in localStorage "nomNotesDeleted"); one deleted in the account
(by another device) goes here too if it had been synced before.

  await DocsSync.init()          the user (signed in for real) or null
  DocsSync.user, DocsSync.service the SupabaseService (js/supabase.js of qatt.org) for the login dialog
  await DocsSync.run(local, store, { skip })   local: the documents of the browser; store: db.js; skip: the id of the open document (not downloaded now)
                                 returns { docs, changed }: the documents after the sync and whether any changed here
  DocsSync.shareCode(id)         the code of the link of a document of the account (null: not shared); shareCreate(id) makes it, shareEnd(id) deletes it
  await DocsSync.shareGet(code)  the shared document (as a document of the app) or null; works without an account
  DocsSync.forget(id)            a document deleted here: delete it in the account at the next sync (unforget(id): it came back)
*/
const DocsSync = (() => {
  const DEL_KEY = 'nomNotesDeleted';
  let sp = null, user = null;
  const deletedIds = () => { try { return JSON.parse(localStorage.getItem(DEL_KEY)) || []; } catch (e) { return []; } };
  const keepDeleted = ids => { try { localStorage.setItem(DEL_KEY, JSON.stringify([...new Set(ids)])); } catch (e) { /* not kept */ } };
  const newId = () => crypto.randomUUID();

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
    } else {   // a scroll of the first editor: its title, font and size (pixels; 100% is 22 pixels here)
      if (row.title) doc.title = row.title;
      const format = {};
      if (typeof s.font === 'string' && s.font) format.font = s.font;
      if (Number.isFinite(+s.size) && +s.size > 0) format.size = Math.min(300, Math.max(50, Math.round(+s.size / 0.22 / 10) * 10));
      if (Object.keys(format).length) doc.format = format;
    }
    return doc;
  };

  async function run(local, store, { skip } = {}) {
    if (!user) return { docs: local, changed: false };
    const db = sp.client;
    const { data, error } = await db.from('scrolls').select('id, updated_at, rev:settings->updated');
    if (error) throw error;
    const remote = new Map(data.map(r => [r.id, revOf(r)]));
    // what was deleted here goes in the account too
    const gone = deletedIds(), toDelete = gone.filter(id => remote.has(id));
    if (toDelete.length) {
      const { error: e } = await db.from('scrolls').delete().in('id', toDelete);
      if (e) throw e;
      toDelete.forEach(id => remote.delete(id));
    }
    keepDeleted([]);
    const docs = new Map(local.map(d => [d.id, { ...d }]));
    const download = [], upload = [], copies = [];
    let changed = false;
    for (const [id, rev] of remote) {
      const l = docs.get(id);
      if (!l) { download.push(id); continue; }
      const base = l.synced || 0, here = l.updated > base, there = rev > base;
      if (here && there) {   // both changed: the newer stays, the other becomes a copy
        if (rev >= l.updated) { copies.push({ ...l, id: newId(), title: DocsCore.title(l.text || '', l.title) + ' (' + new Date(l.updated).toLocaleString() + ')', synced: 0 }); if (id !== skip) download.push(id); }
        else { download.push({ id, asCopy: true }); upload.push(l); }
      } else if (there) { if (id !== skip) download.push(id); }
      else if (here) upload.push(l);
    }
    for (const l of docs.values()) if (!remote.has(l.id)) {
      if (l.synced && l.id !== skip) { docs.delete(l.id); await store.remove(l.id); changed = true; }   // deleted in the account
      else upload.push(l);
    }
    // the rows that are newer there
    const ids = download.map(d => (typeof d === 'string' ? d : d.id));
    for (let i = 0; i < ids.length; i += 50) {
      const part = ids.slice(i, i + 50);
      const { data: rows, error: e } = await db.from('scrolls').select('id, title, settings, content, created_at, updated_at').in('id', part);
      if (e) throw e;
      for (const row of rows) {
        const doc = fromRow(row), copy = download.find(d => typeof d !== 'string' && d.id === row.id);
        if (copy) { const c = { ...doc, id: newId(), title: DocsCore.title(doc.text, doc.title) + ' (' + new Date(doc.updated).toLocaleString() + ')', synced: 0 }; copies.push(c); continue; }
        docs.set(doc.id, doc);
        await store.put(doc);
        changed = true;
      }
    }
    for (const c of copies) { docs.set(c.id, c); await store.put(c); upload.push(c); changed = true; }
    // the documents that are newer here
    for (const d of upload) {
      const { error: e } = await db.from('scrolls').upsert(toRow(d));
      if (e) throw e;
      const now = docs.get(d.id) || d;
      now.synced = d.updated;
      docs.set(now.id, now);
      await store.put(now);
    }
    return { docs: [...docs.values()].sort((a, b) => b.updated - a.updated), changed };
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
    init, run, shareCode, shareCreate, shareEnd, shareGet,
    get user() { return user; },
    get service() { return sp; },
    forget(id) { keepDeleted([...deletedIds(), id]); },
    unforget(id) { keepDeleted(deletedIds().filter(x => x !== id)); },
    async signOut() { if (sp) await sp.signOut(); user = null; },
  };
})();
