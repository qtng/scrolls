/*
The styles of the pages of Nôm Notes (app/), taken over from Qatt.org Notes: background (colour, gradients, textures), ink and the effect of the writing (shadow, glow,
embossing). The effects are only faint here (a document is read and edited, the strong ones of Notes blur the characters); Light has none. A document stores the css of its
style; one of a built-in style (known by its background) gets the effect of the list as it is now, so older documents lose their strong effects too.
Only the pages have a style; the bars and the list keep the look of the app. Textures are small SVG noise patterns drawn by the browser (no image files).

  DocStyles.list         [{ id, en, vi, bg, ink, shadow, seal? }] (bg is a value of the CSS property background; seal the colour of the seal of a note, default seal red)
  DocStyles.defaultId    the style of a document that has none (Cherry blossom dusk)
  DocStyles.random()     the style of a new document: any style except the plain ones (white on black, black on white; `plain: true`)
  DocStyles.css(style)   the css text of a style: "background: …;\ncolor: …;\ntext-shadow: …;" and "\n--seal: …;" if it has a seal colour (what a document stores, not the name of the style)
  DocStyles.encode(css)  / decode(base64): the css text as base64 (UTF-8) and back (null if it is no base64)
  DocStyles.parse(css)   { bg, ink, shadow, seal } of css text (seal '' if none or no colour), or null if it is not plain css of this kind (no address in it: only the built-in data: textures)
  DocStyles.apply(parsed) sets --field-bg, --field-ink, --field-shadow and --seal-color (removed without a seal colour) on <html>
*/
const DocStyles = (() => {
  // fibres of paper: noise in the colour r g b (0 to 1) with the opacity a
  const noise = (r, g, b, a) => `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n' x='0' y='0' width='100%25' height='100%25'><feTurbulence type='fractalNoise' baseFrequency='.75' numOctaves='3' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 ${r} 0 0 0 0 ${g} 0 0 0 0 ${b} 0 0 0 ${a} 0'/></filter><rect width='220' height='220' filter='url(%23n)'/></svg>")`;
  const list = [
    { id: 'dark', en: 'Dark', vi: 'Tối', bg: '#000', ink: '#fff', shadow: 'none', plain: true },
    { id: 'light', en: 'Light', vi: 'Sáng', bg: 'linear-gradient(#ececec, #dcdcdc)', ink: '#111', shadow: 'none', plain: true },
    { id: 'rice-paper', en: 'Calligraphy on rice paper', vi: 'Thư pháp trên giấy dó',
      bg: `radial-gradient(ellipse at 50% 30%, rgba(255,250,235,0) 40%, rgba(160,130,80,.24) 100%), ${noise(.45, .36, .22, .3)}, #efe6cf`,
      ink: '#1b1814', shadow: '0 0 1px rgba(20,16,10,.35)' },
    { id: 'neon-glow', en: 'Neon night', vi: 'Đêm neon',
      bg: 'radial-gradient(circle at 12% 18%, rgba(37,244,238,.28), transparent 42%), radial-gradient(circle at 88% 82%, rgba(254,44,85,.32), transparent 44%), linear-gradient(160deg, #11111a, #05050a)',
      ink: '#ffffff', shadow: '0 0 4px rgba(255,255,255,.18)' },
    { id: 'red-lacquer', en: 'Red lacquer and gold', vi: 'Sơn mài đỏ và vàng',
      bg: 'radial-gradient(ellipse at 30% 0%, rgba(255,120,90,.38), transparent 55%), linear-gradient(160deg, #8e1b17, #5c0f0d 70%, #3c0a09)',
      ink: '#f3d27a', shadow: '0 1px 0 rgba(125,84,18,.7)', seal: '#2b0b08' },
    { id: 'jade', en: 'Jade', vi: 'Ngọc bích',
      bg: `radial-gradient(circle at 20% 15%, rgba(190,255,220,.24), transparent 40%), radial-gradient(circle at 80% 85%, rgba(0,60,40,.5), transparent 50%), ${noise(.7, 1, .85, .14)}, linear-gradient(145deg, #2f6f5a, #173f33)`,
      ink: '#eaf7ee', shadow: '0 0 3px rgba(190,255,225,.3)' },
    { id: 'gold-on-ink', en: 'Gold on ink black', vi: 'Vàng trên mực tàu',
      bg: `radial-gradient(circle at 50% 120%, rgba(212,175,55,.2), transparent 60%), ${noise(1, .85, .4, .12)}, linear-gradient(#17140f, #050504)`,
      ink: '#e6c15a', shadow: '0 1px 1px rgba(0,0,0,.6)' },
    { id: 'ink-wash', en: 'Ink wash mountains', vi: 'Tranh thủy mặc',
      bg: 'radial-gradient(ellipse 120% 40% at 20% 100%, rgba(40,55,70,.7), transparent 70%), radial-gradient(ellipse 100% 35% at 85% 100%, rgba(60,75,90,.6), transparent 70%), linear-gradient(180deg, #dfe6e8 0%, #b9c6cb 55%, #8fa1a9 100%)',
      ink: '#10181d', shadow: '0 0 1px rgba(255,255,255,.5)' },
    { id: 'sakura-dusk', en: 'Cherry blossom dusk', vi: 'Hoa anh đào lúc hoàng hôn',
      bg: 'radial-gradient(circle at 80% 10%, rgba(255,214,225,.38), transparent 45%), linear-gradient(170deg, #5a2a52, #2b1537 75%)',
      ink: '#ffe9f0', shadow: '0 0 3px rgba(255,170,200,.3)' },
    { id: 'peony', en: 'Peony', vi: 'Mẫu đơn',
      bg: 'radial-gradient(ellipse at 50% 0%, rgba(255,200,215,.4), transparent 60%), linear-gradient(165deg, #d6336c, #a21e4f 70%, #7a1238)',
      ink: '#fff0f4', shadow: '0 1px 1px rgba(0,0,0,.3)', seal: '#4a0a24' },
    { id: 'moon-night', en: 'Mid-autumn moon night', vi: 'Đêm trăng Trung thu',
      bg: 'radial-gradient(circle at 78% 25%, rgba(255,245,200,.95) 0 28px, rgba(255,245,200,.25) 29px 70px, transparent 120px), linear-gradient(180deg, #0e1b3d, #1e2f5c)',
      ink: '#fdf6d8', shadow: '0 0 3px rgba(255,240,180,.3)' },
    { id: 'ginkgo', en: 'Ginkgo', vi: 'Bạch quả',
      bg: `${noise(.9, 1, .7, .12)}, radial-gradient(circle at 20% 10%, rgba(255,255,220,.35), transparent 45%), linear-gradient(160deg, #a9c47f, #6f9440)`,
      ink: '#1f2e0e', shadow: '0 1px 0 rgba(255,255,220,.35)' },
    { id: 'gold', en: 'Gold', vi: 'Vàng',
      bg: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'><filter id='n' x='0' y='0' width='100%25' height='100%25'><feTurbulence type='fractalNoise' baseFrequency='.004 .9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 .35 0 0 0 0 .22 0 0 0 0 .02 0 0 0 .5 -.1'/></filter><rect width='300' height='300' filter='url(%23n)'/></svg>"), linear-gradient(115deg, #8a5a12 0%, #d9a932 14%, #fbe38a 26%, #e1b23e 38%, #a8741a 52%, #e9c25a 66%, #fff0a8 76%, #c8932a 88%, #8a5a12 100%)`,
      ink: '#3b2606', shadow: '1px 1px 0 rgba(255,238,160,.5)' },
    { id: 'cinnabar-seal', en: 'Cinnabar on paper', vi: 'Chu sa trên giấy',
      bg: `${noise(.5, .35, .3, .22)}, linear-gradient(#f4ead7, #eadcc0)`,
      ink: '#b3261e', shadow: '1px 1px 0 rgba(255,255,255,.5)' },
  ];
  const defaultId = 'sakura-dusk';
  const css = s => `background: ${s.bg};\ncolor: ${s.ink};\ntext-shadow: ${s.shadow};` + (s.seal ? `\n--seal: ${s.seal};` : '');
  const encode = text => btoa(unescape(encodeURIComponent(text)));
  const decode = b64 => { try { return decodeURIComponent(escape(atob(b64))); } catch (e) { return null; } };
  const parse = text => {
    if (typeof text !== 'string' || text.length > 50000) return null;
    // no address to load: a file of somebody else must not make the app fetch anything. Allowed are only the quoted data: images (the textures); the rest may not load images at all.
    const rest = text.replace(/url\(\s*"data:image\/[^"]*"\s*\)/gi, '');
    if (/url\(|image-set\(|image\(|src\(|paint\(|element\(|cross-fade\(|@import/i.test(rest)) return null;
    const probe = document.createElement('div').style;
    probe.cssText = text;   // the browser reads it as css: anything it does not understand is dropped
    const bg = probe.getPropertyValue('background'), ink = probe.getPropertyValue('color');
    const seal = probe.getPropertyValue('--seal').trim(), colour = document.createElement('div').style;
    colour.color = seal;   // only a colour
    return bg && ink ? { bg, ink, shadow: probe.getPropertyValue('text-shadow') || 'none', seal: seal && colour.color ? colour.color : '' } : null;
  };
  const random = () => { const pool = list.filter(s => !s.plain); return pool[Math.floor(Math.random() * pool.length)]; };
  // the built-in styles by their background as the browser writes it: the effect of the list replaces the one stored with a document
  let known = null;
  const shadowOf = parsed => {
    if (!known) {
      known = new Map();
      const probe = document.createElement('div').style;
      for (const st of list) { probe.background = st.bg; known.set(probe.getPropertyValue('background'), st.shadow); }
    }
    return known.has(parsed.bg) ? known.get(parsed.bg) : parsed.shadow;
  };
  const apply = parsed => {
    const root = document.documentElement.style;
    parsed = { ...parsed, shadow: shadowOf(parsed) };
    root.setProperty('--field-bg', parsed.bg);
    root.setProperty('--field-ink', parsed.ink);
    root.setProperty('--field-shadow', parsed.shadow);
    if (parsed.seal) root.setProperty('--seal-color', parsed.seal); else root.removeProperty('--seal-color');
  };
  return { list, defaultId, random, css, encode, decode, parse, apply };
})();
