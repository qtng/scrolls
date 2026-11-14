/*
Service worker of Nôm Notes (app/; after the service worker of Qatt.org Notes): the app works offline.
Raise CACHE when a file of PRECACHE changes (a new name = a new cache; the old ones are deleted when the new worker takes over, the open page keeps what it has and
the next start uses the new files). Keep PRECACHE equal to what index.html loads. The addresses are relative to this file (the app may move with its repository).
  - the files of PRECACHE: from the cache, renewed in the background
  - the fonts of cdn.qatt.org: cached when first used (a file with ?v= for ever, others renewed in the background)
  - the Nôm fonts of the Chunom site: cached for ever, the small ones at install, the big one when first needed
  - the dictionaries of ime.js: cached when first loaded and at install
  - the account (supabase.co) is never cached
*/
const CACHE = 'nom-notes-v51';
const HERE = new URL('./', self.location).href;
const at = p => new URL(p, HERE).href;
const CDN = 'https://cdn.qatt.org/fonts/';
const QATT = 'https://qatt.org/';
const FA = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/';
const PRECACHE = [
  './', 'css/app.css', 'js/lang.js', 'js/styles.js', 'js/core.js', 'js/db.js', 'js/sync.js', 'js/input.js', 'js/editor.js', 'js/app.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', '../js/prosemirror.js', '../css/prosemirror.css',
].map(at).concat([
  QATT + 'js/parser.js', QATT + 'js/qatt-text.js', QATT + 'js/pa-text.js', QATT + 'js/fonts.js', QATT + 'vendor/supabase/supabase.min.js', QATT + 'js/supabase.js', QATT + 'js/login.js',
  FA + 'css/all.min.css', FA + 'webfonts/fa-solid-900.woff2',
  ...['qatt-pen-letters.woff2', 'qatt-pen-medium-letters.woff2', 'celluloid-letters.woff2', 'migoi-letters.woff2', 'phongthao-letters.woff2'].map(n => CDN + n),
]);
const IME = [at('/chunom/js/ime.js'), at('/chunom/js/generated_chars.json'), at('/chunom/js/base_chars.json')];
const NOM_NA_TONG = at('/chunom-assets/fonts/nomnatong-supplement.woff2?v=2');   // 8 MB: cached when a character needs it, not at install
const NOM_FONTS = [at('/chunom-assets/fonts/hannom-gothic-supplement.woff2'), at('/chunom-assets/fonts/nomkhai-supplement.woff2'), NOM_NA_TONG];
const FOREVER = 'nom-fonts';   // shared with nothing else on this origin; the files never change
const FONT_FILE = /^https:\/\/cdn\.qatt\.org\/fonts\/(?:web\/)?[\w.-]+\.woff2(?:\?v=[\w%.-]+)?$/;
const PAGE = at('./');
const strip = u => u.split('#')[0].split('?')[0];

const staleCaches = (keys, current) => keys.filter(k => k.startsWith('nom-notes-') && k !== current);

self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  await Promise.all(PRECACHE.map(async url => {
    const res = await fetch(new Request(url, { cache: 'reload', mode: url.startsWith(HERE.split('/').slice(0, 3).join('/')) ? 'same-origin' : 'cors' })).catch(() => null);
    if (!res || !res.ok) throw new Error(url + ' ' + (res && res.status));
    await cache.put(url, res);
  }));
  await Promise.all(IME.map(async url => { try { const res = await fetch(new Request(url, { cache: 'reload' })); if (res.ok) await cache.put(url, res); } catch (e) { /* cached when the page loads it */ } }));
  try {
    const forever = await caches.open(FOREVER);
    await Promise.all(NOM_FONTS.filter(u => u !== NOM_NA_TONG).map(async url => { if (await forever.match(url)) return; const res = await fetch(url); if (res.ok) await forever.put(url, res); }));
  } catch (e) { /* cached when the page loads them */ }
  await self.skipWaiting();
})()));

self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of staleCaches(await caches.keys(), CACHE)) await caches.delete(key);
  await self.clients.claim();
})()));

const known = req => {
  const url = strip(req.url);
  if (req.mode === 'navigate') return url === PAGE || url === at('index.html');
  return PRECACHE.some(p => strip(p) === url) || IME.includes(url) || FONT_FILE.test(req.url);
};

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (NOM_FONTS.includes(req.url)) {   // cache first, for ever
    event.respondWith((async () => {
      const forever = await caches.open(FOREVER), hit = await forever.match(req.url);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) forever.put(req.url, res.clone());
      return res;
    })());
    return;
  }
  if (!known(req)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE), key = req.mode === 'navigate' ? PAGE : req.url;
    const font = FONT_FILE.test(req.url);
    if (font && req.url.includes('?v=')) {   // a font with its version: a new date is a new address, so cache first; older versions of the file go
      const hit = await cache.match(req.url);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) {
          for (const k of await cache.keys()) if (k.url !== req.url && strip(k.url) === strip(req.url)) await cache.delete(k);
          cache.put(req.url, res.clone());
        }
        return res;
      } catch (e) { const old = await cache.match(strip(req.url)); if (old) return old; throw e; }
    }
    const hit = await cache.match(key, { ignoreSearch: !font });
    const refresh = fetch(new Request(req, { cache: 'no-cache' })).then(res => { if (res.ok) cache.put(key, res.clone()); return res; });   // asks the server (a 304 costs nothing): a new file is there at the next start
    if (hit) { event.waitUntil(refresh.catch(() => {})); return hit; }
    return refresh;
  })());
});
