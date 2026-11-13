/*
The language of Nôm Notes (app/), English or Vietnamese (taken over from Qatt.org Notes); the app has no code of the website. Same idea as Lang of the site:
every tag with data-vi (and no tags inside) shows that text in Vietnamese, the English text stays in the tag and returns; the attributes
data-vi-aria-label, data-vi-placeholder, data-vi-title and data-vi-label do the same for the attribute without the prefix.
The language is the choice kept on this device (localStorage "nomNotesLang", and a cookie of the same name as a second copy: the browser may drop the storage of a site that is not
persistent, then the cookie still has the choice, and it is written to the storage again), else the main language of the browser (the first of its list): Vietnamese if that is
Vietnamese, any other language English (a list like German, Vietnamese, English no longer gives Vietnamese).

  Lang.current     "en" or "vi"
  Lang.set("vi")   choose and keep it; the page changes at once; the event "langchange" goes to the document
  Lang.t(en, vi)   the text for a string that is not in a tag
*/
window.Lang = (() => {
  const KEY = 'nomNotesLang', ATTRS = ['aria-label', 'placeholder', 'title', 'label'];
  let current = 'en';
  const ok = v => v === 'vi' || v === 'en' ? v : null;
  const fromCookie = () => { try { return ok((document.cookie.match(/(?:^|;\s*)nomNotesLang=(\w+)/) || [])[1]); } catch (e) { return null; } };
  const toCookie = l => { try { document.cookie = `${KEY}=${l}; max-age=31536000; path=/; SameSite=Lax`; } catch (e) { /* no cookies */ } };
  try { current = ok(localStorage.getItem(KEY)); } catch (e) { current = null; }
  if (!current) {   // the storage has no choice: the cookie may have it (the storage was dropped), then it is kept in the storage again
    current = fromCookie();
    if (current) try { localStorage.setItem(KEY, current); } catch (e) { /* storage may be blocked */ }
  } else toCookie(current);
  if (!current) {
    const main = (navigator.languages && navigator.languages[0]) || navigator.language || '';
    current = main.slice(0, 2).toLowerCase() === 'vi' ? 'vi' : 'en';
  }
  const SELECTOR = ['[data-vi]'].concat(ATTRS.map(a => `[data-vi-${a}]`)).join(',');

  function apply(el) {
    const vi = current === 'vi';
    if (el.hasAttribute('data-vi') && !el.children.length) {
      if (!el.hasAttribute('data-en')) el.setAttribute('data-en', el.textContent);
      const text = vi ? el.getAttribute('data-vi') : el.getAttribute('data-en');
      if (el.textContent !== text) el.textContent = text;
    }
    for (const a of ATTRS) {
      if (!el.hasAttribute('data-vi-' + a)) continue;
      if (!el.hasAttribute('data-en-' + a)) el.setAttribute('data-en-' + a, el.getAttribute(a) || '');
      const text = vi ? el.getAttribute('data-vi-' + a) : el.getAttribute('data-en-' + a);
      if (el.getAttribute(a) !== text) el.setAttribute(a, text);
    }
  }
  function applyTree(root) {
    if (root.nodeType !== 1) return;
    if (root.matches(SELECTOR)) apply(root);
    root.querySelectorAll(SELECTOR).forEach(apply);
  }
  function all() { document.documentElement.lang = current; applyTree(document.documentElement); }

  new MutationObserver(list => {
    for (const m of list) {
      if (m.type === 'childList') { m.addedNodes.forEach(applyTree); if (m.target.nodeType === 1 && m.target.matches('[data-vi]')) apply(m.target); }
      else if (m.type === 'attributes') apply(m.target);
    }
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-vi'] });
  document.addEventListener('DOMContentLoaded', all);

  return {
    get current() { return current; },
    set(l) {
      if (l !== 'en' && l !== 'vi') return;
      current = l;
      try { localStorage.setItem(KEY, l); } catch (e) { /* storage may be blocked */ }
      toCookie(l);
      all();
      document.dispatchEvent(new Event('langchange'));
    },
    t: (en, vi) => (current === 'vi' ? vi : en),
  };
})();
