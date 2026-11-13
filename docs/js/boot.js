/*
The start of every page of Scrolls, loaded first in the <head> (a normal script, not defer: it writes the next ones while the page is parsed).

- On the web page: https://qatt.org/js/navigation.js (the menu of the site, Lang, js/fonts.js, the readings).
- In the installed app (display-mode standalone; for tests ?app, kept for the tab): no navigation of the site; /scrolls/js/lang.js (a copy of Lang)
  and https://qatt.org/js/fonts.js (the @font-face rules and the font selects) instead. <html> gets the class scrolls-app.
Scrolls has no theme of the site: its own look is css/scrolls.css (navigation.js themes only /chunom/ of the Chunom site).
*/
(function () {
    var QATT = 'https://qatt.org';
    var app = false;
    try {
        if (/[?&]app(=|&|$)/.test(location.search)) sessionStorage.setItem('scrollsApp', '1');
        app = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true || sessionStorage.getItem('scrollsApp') === '1';
    } catch (e) { /* the web page */ }
    window.SCROLLS_APP = app;
    var html = document.documentElement;
    if (app) html.classList.add('scrolls-app');
    document.write(app
        ? '<script src="/scrolls/js/lang.js"><\/script><script src="' + QATT + '/js/fonts.js"><\/script>'
        : '<script src="' + QATT + '/js/navigation.js"><\/script>');
})();
