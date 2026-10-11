const fs = require('fs');
const path = require('path');

// Most product cards a store page will show.
const MAX_CARDS = 15;

const TEMPLATES_DIR = path.join(__dirname, 'templates');
const templateFiles = fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.html'));

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pickRandomTemplate() {
  const file = templateFiles[Math.floor(Math.random() * templateFiles.length)];
  return { file, html: fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8') };
}

function pickTemplate(preferredFile) {
  if (preferredFile && templateFiles.includes(preferredFile)) {
    return { file: preferredFile, html: fs.readFileSync(path.join(TEMPLATES_DIR, preferredFile), 'utf8') };
  }
  return pickRandomTemplate();
}

// Short list Groq can use to pick a template by name/vibe, without
// needing to see the full HTML of all 35 files.
function listTemplateSummaries() {
  return templateFiles.map((file) => {
    const html = fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8');
    const titleMatch = html.match(/<title>([^<]*)<\/title>/);
    return { file, title: titleMatch ? titleMatch[1] : file };
  });
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

// Injects real store data into one of the 35 static templates. Never
// invents prices/images — only uses what's passed in. Templates only have
// a few product card slots (often 4), so when there are more products
// (up to MAX_CARDS) the card markup is copied to make room for them all.
// If there are fewer products than slots, the products are reused
// cyclically rather than leaving fake ones showing.
function renderTemplate(storeName, tagline, accentColor, products, preferredFile) {
  const { file, html } = pickTemplate(preferredFile);
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

  return { html: out, templateFile: file };
}

module.exports = { renderTemplate };
