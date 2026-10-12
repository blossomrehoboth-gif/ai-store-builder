// templater.js — builds the store page preview.
//
// Designs live in the "public/themes" folder. Every
// .html file in it is a design, and one is picked at random for each store
// ("Try a different design" picks another). Two kinds of design file work:
//
//  1. TOKEN designs (like 19-sleep.html): the page contains {{TITLE}}, {{LOGO}},
//     {{HEADLINE}}, {{TAGLINE}}, {{ACCENT}}, {{HERO_ART}} and {{PRODUCTS_JSON}},
//     and this file fills them in with the store name and the real CJ products.
//  2. CLASSIC designs (the older 35 files): cards written as
//     <article class="card"> with class="cn" (name) and class="cp" (price).
//
// No fake ratings, discounts or shipping promises are added. If the folder is
// empty or missing, a simple built-in design is used, so the app never crashes.
const fs = require('fs');
const path = require('path');

// Most product cards a store page will show.
const MAX_CARDS = 15;

const TEMPLATES_DIR = path.join(__dirname, 'public', 'themes');

function listTemplateFiles() {
  try {
    return fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.html')).sort();
  } catch (e) {
    return []; // folder missing
  }
}

function pickTemplate(preferredFile) {
  const files = listTemplateFiles();
  if (!files.length) return { file: 'built-in', html: null };
  const file = preferredFile && files.includes(preferredFile)
    ? preferredFile
    : files[Math.floor(Math.random() * files.length)];
  try {
    return { file, html: fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8') };
  } catch (e) {
    console.error(`Could not read template ${file}:`, e.message);
    return { file: 'built-in', html: null };
  }
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Built-in store design, used when the templates folder is empty or missing.
// It uses the same class names as the template files (logo, sub, card, cn, cp,
// buybar, copy), so renderTemplate fills it in exactly like any other template.
const BUILT_IN_TEMPLATE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>My Store</title>
<style>
:root{--ac:#2E3F94}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1d1d1f;background:#fff;padding-bottom:84px}
header{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid #eee;position:sticky;top:0;background:#fff;z-index:5}
.logo{font-weight:800;font-size:20px;color:var(--ac);text-decoration:none}
.cartlink{font-size:14px;font-weight:600}
.cartlink span{display:inline-block;min-width:22px;text-align:center;background:var(--ac);color:#fff;border-radius:99px;padding:2px 7px;margin-left:6px}
.hero{padding:34px 18px 26px;text-align:center;background:#f6f6f8}
.hero h1{margin:0 0 10px;font-size:30px;line-height:1.15}
.sub{margin:0 auto;max-width:520px;color:#5b5b63;font-size:16px}
.banner{height:210px;margin:20px auto 0;max-width:520px;border-radius:16px}
h2{margin:26px 18px 12px;font-size:22px}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;padding:0 18px}
@media(min-width:700px){.grid{grid-template-columns:repeat(3,1fr)}}
@media(min-width:1000px){.grid{grid-template-columns:repeat(4,1fr)}}
.card{position:relative;display:flex;flex-direction:column}
.img{aspect-ratio:1/1;border-radius:14px;background-color:#eee}
.cn{margin-top:9px;font-size:14px;font-weight:600;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.cp{margin-top:4px;color:#5b5b63;font-size:15px}
.add{position:absolute;right:8px;top:8px;width:36px;height:36px;border-radius:50%;border:0;background:#fff;color:var(--ac);font-size:22px;line-height:1;box-shadow:0 1px 6px rgba(0,0,0,.2);cursor:pointer}
.buybar{position:fixed;left:0;right:0;bottom:0;display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 18px;background:#fff;border-top:1px solid #eee}
.buybar b{font-size:14px;display:block}
.buybar span{color:#5b5b63;font-size:14px}
.buy{background:var(--ac);color:#fff;border:0;border-radius:10px;padding:12px 20px;font-size:15px;font-weight:700;cursor:pointer}
footer{padding:24px 18px;color:#8a8a93;font-size:13px;text-align:center}
</style></head><body>
<header><a class="logo" href="#">My Store</a><div class="cartlink">Cart<span id="cartcount">0</span></div></header>
<section class="hero"><h1>Welcome</h1><p class="sub">Great products</p>
<div class="banner" style="background:linear-gradient(135deg,#ddd,#f0f0f0)"></div></section>
<h2>Best sellers</h2>
<div class="grid">
<article class="card" data-n="Product" data-p="0"><div class="img" style="background:linear-gradient(135deg,#ddd,#f0f0f0)"></div><div class="cn">Product</div><div class="cp">$0.00</div><button class="add" type="button" aria-label="Add to cart">+</button></article>
<article class="card" data-n="Product" data-p="0"><div class="img" style="background:linear-gradient(135deg,#ddd,#f0f0f0)"></div><div class="cn">Product</div><div class="cp">$0.00</div><button class="add" type="button" aria-label="Add to cart">+</button></article>
<article class="card" data-n="Product" data-p="0"><div class="img" style="background:linear-gradient(135deg,#ddd,#f0f0f0)"></div><div class="cn">Product</div><div class="cp">$0.00</div><button class="add" type="button" aria-label="Add to cart">+</button></article>
<article class="card" data-n="Product" data-p="0"><div class="img" style="background:linear-gradient(135deg,#ddd,#f0f0f0)"></div><div class="cn">Product</div><div class="cp">$0.00</div><button class="add" type="button" aria-label="Add to cart">+</button></article>
</div>
<footer><p class="copy">© 2026 My Store.</p></footer>
<div class="buybar"><div><b>Product</b><span>$0.00</span></div><button class="buy" type="button">Add to cart</button></div>
<script>
(function(){
  var n=0,el=document.getElementById('cartcount');
  function add(){n+=1;el.textContent=n;}
  Array.prototype.forEach.call(document.querySelectorAll('.add'),function(b){b.addEventListener('click',add);});
  var buy=document.querySelector('.buy'); if(buy) buy.addEventListener('click',add);
})();
</script>
</body></html>`;

// Replace every {{TOKEN}} with a value, without treating "$" specially.
function fill(html, token, value) {
  return html.split(`{{${token}}}`).join(value);
}

// "Mint Fresh Gear" -> Mint Fresh <b>Gear</b>   (last word in the accent colour)
function logoHtml(name) {
  const words = String(name || 'My Store').trim().split(/\s+/);
  if (words.length < 2) return escapeHtml(words[0]);
  const last = words.pop();
  return `${escapeHtml(words.join(' '))} <b>${escapeHtml(last)}</b>`;
}

// JSON that is safe to put inside a <script> tag.
function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const isUrl = (u) => /^https?:\/\//i.test(String(u || ''));

function renderTokenDesign(html, storeName, tagline, accentColor, products) {
  const safeName = String(storeName || 'My Store');
  const safeTagline = String(tagline || '');
  const accent = /^#[0-9A-Fa-f]{3,8}$/.test(accentColor || '') ? accentColor : '#2E3F94';

  const list = products.slice(0, MAX_CARDS).map((p) => ({
    name: String(p.name || ''),
    price: String(p.priceDisplay || ''),
    image: isUrl(p.image) ? p.image : '',
  }));

  // Three photos for the hero (reuses products if there are fewer than three).
  const heroImgs = list.map((p) => p.image).filter(Boolean);
  const heroClasses = ['ph', 'ph b', 'ph c'];
  const heroArt = heroClasses
    .map((cls, i) => {
      const img = heroImgs.length ? heroImgs[i % heroImgs.length] : '';
      return `<div class="${cls}">${img ? `<img src="${escapeHtml(img)}" alt="">` : ''}</div>`;
    })
    .join('\n        ');

  let out = html;
  out = fill(out, 'TITLE', escapeHtml(safeTagline ? `${safeName} – ${safeTagline}` : safeName));
  out = fill(out, 'ACCENT', accent);
  out = fill(out, 'LOGO', logoHtml(safeName));
  out = fill(out, 'HEADLINE', escapeHtml(safeTagline || safeName));
  out = fill(out, 'TAGLINE', escapeHtml(safeTagline));
  out = fill(out, 'HERO_ART', heroArt);
  out = fill(out, 'PRODUCTS_JSON', safeJson(list));
  return out;
}


// Fills one product card (name, price, photo, add-to-cart data) with a product.
function fillCard(cardHtml, p) {
  let card = cardHtml;
  card = card.replace(/(class="cn">)([^<]*)(<)/, (m, a, _o, c) => `${a}${escapeHtml(p.name)}${c}`);
  card = card.replace(/(class="cp">)([^<]*)(<)/, (m, a, _o, c) => `${a}${escapeHtml(p.priceDisplay)}${c}`);
  if (p.image) {
    card = card.replace(/style="[^"]*"/, `style="background-image:url('${p.image}');background-size:cover;background-position:center"`);
  }
  card = card.replace(/data-n="[^"]*"/, `data-n="${escapeHtml(p.name)}"`);
  card = card.replace(/data-p="[^"]*"/, `data-p="${p.priceNumber || ''}"`);
  return card;
}

function renderClassic(html, storeName, tagline, accentColor, products) {
  let out = html;

  const safeName = escapeHtml(storeName || 'My Store');
  const safeTagline = escapeHtml(tagline || '');
  const safeColor = /^#[0-9A-Fa-f]{3,6}$/.test(accentColor || '') ? accentColor : '#2E3F94';

  // Accent color
  out = out.replace(/--ac:#[0-9A-Fa-f]{3,6}/g, `--ac:${safeColor}`);

  // Title tag
  out = out.replace(/<title>[^<]*<\/title>/, `<title>${safeName}</title>`);

  // Logo text (header + footer both use class="logo")
  out = out.replace(/(class="logo"[^>]*>)([^<]*)(<\/a>)/g, (m, a, _old, c) => `${a}${safeName}${c}`);

  // First H1 (hero headline)
  out = out.replace(/<h1>[^<]*<\/h1>/, `<h1>${safeTagline || safeName}</h1>`);

  // First element with class="sub" (hero sub-line)
  out = out.replace(/(class="sub">)([^<]*)(<)/, (m, a, _old, c) => `${a}${safeTagline}${c}`);

  if (products && products.length > 0) {
    // Step 1: pull every product card OUT of the document into a
    // placeholder token. This stops the next step (hero/banner images)
    // from re-touching or mis-cycling images that already belong to a
    // specific card.
    const slots = []; // the template's own card markup, in order
    out = out.replace(/<article class="card"[\s\S]*?<\/article>/g, (cardHtml) => {
      slots.push(cardHtml);
      return `@@CARD${slots.length - 1}@@`;
    });

    const extractedCards = slots.map((cardHtml, i) => fillCard(cardHtml, products[i % products.length]));

    // Add extra cards (copies of the template's card markup) after the last
    // card, so they sit in the same grid, until every product has a card.
    if (slots.length > 0) {
      const total = Math.min(products.length, MAX_CARDS);
      const extra = [];
      for (let i = slots.length; i < total; i++) {
        extra.push(fillCard(slots[i % slots.length], products[i]));
      }
      if (extra.length) {
        extractedCards[extractedCards.length - 1] += '\n' + extra.join('\n');
      }
    }

    // Step 2: every remaining placeholder image uses a CSS gradient
    // as its background — true across all 35 templates regardless of
    // the class name on the box (some use "img", others "d-big",
    // etc). Cards were already pulled out above, so anything left
    // with a gradient background is a hero/banner decoration.
    let heroImgIndex = 0;
    out = out.replace(/style="background:(?:repeating-)?(?:linear|radial|conic)-gradient\([^"]*"/g, () => {
      const p = products[heroImgIndex % products.length];
      heroImgIndex += 1;
      return p.image
        ? `style="background-image:url('${p.image}');background-size:cover;background-position:center"`
        : `style=""`;
    });

    // Step 3: put the processed cards back where they came from.
    out = out.replace(/@@CARD(\d+)@@/g, (m, idx) => extractedCards[Number(idx)]);

    // Sticky buy bar (uses the first real product)
    const first = products[0];
    out = out.replace(/(class="buybar"[\s\S]*?<b>)([^<]*)(<\/b>)/, (m, a, _o, c) => `${a}${escapeHtml(first.name)}${c}`);
    out = out.replace(/(<\/b><span>)([^<]*)(<\/span>)/, (m, a, _o, c) => `${a}${escapeHtml(first.priceDisplay)}${c}`);
  }

  // Footer copyright line: "© 2026 {Name}."
  out = out.replace(/(class="copy">©\s*\d{4}\s*)([^.]*)(\.)/, (m, a, _o, c) => `${a}${safeName}${c}`);

  return out;
}


// Used only when the templates folder is empty or missing.
function renderFallback(storeName, tagline, accentColor, products) {
  let out = BUILT_IN_TEMPLATE;
  const safeName = escapeHtml(storeName || 'My Store');
  const safeTagline = escapeHtml(tagline || '');
  const safeColor = /^#[0-9A-Fa-f]{3,6}$/.test(accentColor || '') ? accentColor : '#2E3F94';
  out = out.replace(/--ac:#[0-9A-Fa-f]{3,6}/g, `--ac:${safeColor}`);
  out = out.replace(/<title>[^<]*<\/title>/, `<title>${safeName}</title>`);
  out = out.replace(/(class="logo"[^>]*>)([^<]*)(<\/a>)/g, (m, a, _o, c) => `${a}${safeName}${c}`);
  out = out.replace(/<h1>[^<]*<\/h1>/, `<h1>${safeTagline || safeName}</h1>`);
  out = out.replace(/(class="sub">)([^<]*)(<)/, (m, a, _o, c) => `${a}${safeTagline}${c}`);

  const list = products.slice(0, MAX_CARDS);
  const card = (p) =>
    `<article class="card" data-n="${escapeHtml(p.name)}" data-p="${p.priceNumber || ''}">` +
    `<div class="img" style="${isUrl(p.image) ? `background-image:url('${escapeHtml(p.image)}');background-size:cover;background-position:center` : 'background:#ddd'}"></div>` +
    `<div class="cn">${escapeHtml(p.name)}</div><div class="cp">${escapeHtml(p.priceDisplay)}</div>` +
    `<button class="add" type="button" aria-label="Add to cart">+</button></article>`;
  out = out.replace(/<div class="grid">[\s\S]*?<\/div>\s*<footer>/, () => `<div class="grid">\n${list.map(card).join('\n')}\n</div>\n<footer>`);
  out = out.replace(/(class="buybar"[\s\S]*?<b>)([^<]*)(<\/b>)/, (m, a, _o, c) => `${a}${escapeHtml(list[0].name)}${c}`);
  out = out.replace(/(<\/b><span>)([^<]*)(<\/span>)/, (m, a, _o, c) => `${a}${escapeHtml(list[0].priceDisplay)}${c}`);
  out = out.replace(/(class="copy">©\s*\d{4}\s*)([^.]*)(\.)/, (m, a, _o, c) => `${a}${safeName}${c}`);
  return out;
}


// Same signature as before, so server.js and script.js need no changes.
function renderTemplate(storeName, tagline, accentColor, products, preferredFile) {
  const list = Array.isArray(products) ? products : [];
  const { file, html } = pickTemplate(preferredFile);
  try {
    if (html) {
      const out = html.includes('{{PRODUCTS_JSON}}')
        ? renderTokenDesign(html, storeName, tagline, accentColor, list)
        : renderClassic(html, storeName, tagline, accentColor, list);
      return { html: out, templateFile: file };
    }
  } catch (e) {
    console.error(`Rendering ${file} failed, using the built-in design:`, e.message);
  }
  return { html: renderFallback(storeName, tagline, accentColor, list), templateFile: 'built-in' };
}

module.exports = { renderTemplate };
