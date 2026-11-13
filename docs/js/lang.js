// Lang for the installed app of Scrolls (no navigation.js there): a copy of Lang of https://qatt.org/js/navigation.js (keep it in step with it).
// On the web page navigation.js defines Lang and this file is not loaded (js/boot.js decides).
// The rules: a tag with data-vi (and no tags inside) shows that text in Vietnamese; data-vi-label, -title, -placeholder, -aria-label the same for attributes.
//   Lang.current  "en" or "vi";  Lang.set("vi");  Lang.t("Next", "Tiếp");  the event "langchange" on the document
window.Lang = window.Lang || (function() {
    const KEY = "lang";
    const valid = l => l === "en" || l === "vi";
    const stored = () => { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
    const store = l => { try { localStorage.setItem(KEY, l); } catch (e) {} };
    const detect = () => {
        for (const l of navigator.languages || [navigator.language || "en"]) {
            const primary = String(l).toLowerCase().split("-")[0];
            if (valid(primary)) return primary;
        }
        return "en";
    };
    const asked = new URLSearchParams(location.search).get("lang");
    if (valid(asked)) store(asked);
    // a page can ask for its language: <html data-page-lang="vi"> (the Vietnamese copy of the homepage, vi.html, for a visitor from a search)
    const pageLang = document.documentElement.getAttribute("data-page-lang");
    if (valid(pageLang)) store(pageLang);   // visiting vi.html switches the site to Vietnamese (EN there goes to index.html in English)
    let current = valid(stored()) ? stored() : detect();

    const states = new WeakMap();   // per tag: the English text and the text shown last (to tell a change of the page from our own change)
    const waiting = new Set();      // tags the parser may not have finished (no tag after them yet)
    const apply = el => {
        if (!el.hasAttribute("data-vi")) return;
        if (el.children.length) return;   // tags inside: not translated (the rule: data-vi only on tags without tags inside)
        const text = el.textContent;
        if (text === "") return;          // not filled yet: the change of its content will come
        if (document.readyState === "loading" && !el.nextSibling) { waiting.add(el); return; }   // the parser may still be writing its text
        waiting.delete(el);
        let st = states.get(el);
        if (!st) states.set(el, st = { en: text, shown: text });
        else if (text !== st.shown) st.en = text;   // a new text from the page: the English one
        const want = current === "vi" ? el.getAttribute("data-vi") : st.en;
        if (text !== want) el.textContent = want;
        st.shown = want;
    };
    const ATTRS = ["label", "title", "placeholder", "aria-label"];
    const attrStates = new WeakMap();   // per tag and attribute: the English value and the value shown last
    const applyAttr = (el, name) => {
        const vi = el.getAttribute("data-vi-" + name), cur = el.getAttribute(name);
        if (vi === null || cur === null) return;
        let sts = attrStates.get(el);
        if (!sts) attrStates.set(el, sts = {});
        let st = sts[name];
        if (!st) sts[name] = st = { en: cur, shown: cur };
        else if (cur !== st.shown) st.en = cur;
        const want = current === "vi" ? vi : st.en;
        if (cur !== want) el.setAttribute(name, want);
        st.shown = want;
    };
    const applyAll = el => { apply(el); ATTRS.forEach(a => applyAttr(el, a)); };
    const SELECTOR = ["data-vi", ...ATTRS.map(a => "data-vi-" + a)].map(a => `[${a}]`).join(",");
    const all = root => {
        if (root.nodeType !== 1 && root.nodeType !== 9) return;
        if (root.nodeType === 1) applyAll(root);
        root.querySelectorAll(SELECTOR).forEach(applyAll);
    };
    const flush = () => { for (const el of [...waiting]) if (el.nextSibling || document.readyState !== "loading") apply(el); };
    new MutationObserver(records => {
        for (const r of records) {
            if (r.type === "attributes") {
                const name = r.attributeName.replace(/^data-vi-/, "");
                if (ATTRS.includes(name)) applyAttr(r.target, name); else apply(r.target);
            }
            else if (r.type === "characterData") r.target.parentElement && apply(r.target.parentElement);
            else {
                if (r.target.nodeType === 1) apply(r.target);   // its content changed
                r.addedNodes.forEach(all);
            }
        }
        flush();
    }).observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-vi", ...ATTRS, ...ATTRS.map(a => "data-vi-" + a)] });
    document.addEventListener("DOMContentLoaded", () => { flush(); all(document); });

    const setLang = l => {
        if (!valid(l)) return;
        store(l);
        current = l;
        document.documentElement.lang = l;
        all(document);
        document.dispatchEvent(new CustomEvent("langchange", { detail: l }));
    };
    if (current === "vi") document.documentElement.lang = "vi";
    return { get current() { return current; }, set: setLang, t: (en, vi) => current === "vi" ? vi : en, valid };
})();
