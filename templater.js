const fs = require('fs');
const path = require('path');

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

// Injects real store data into one of the 35 static templates. Never
// invents prices/images — only uses what's passed in. If a template
// has more product card slots than real products, the extra slots
// reuse the products cyclically rather than left showing fake ones.
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
    // placeholder token, processing its name/price/image as before.
    // This stops the next step (hero/banner images) from re-touching
    // or mis-cycling images that already belong to a specific card.
    const extractedCards = [];
    let cardIndex = 0;
    out = out.replace(/<article class="card"[\s\S]*?<\/article>/g, (cardHtml) => {
      const p = products[cardIndex % products.length];
      cardIndex += 1;
      let card = cardHtml;
      card = card.replace(/(class="cn">)([^<]*)(<)/, (m, a, _o, c) => `${a}${escapeHtml(p.name)}${c}`);
      card = card.replace(/(class="cp">)([^<]*)(<)/, (m, a, _o, c) => `${a}${escapeHtml(p.priceDisplay)}${c}`);
      if (p.image) {
        card = card.replace(/style="[^"]*"/, `style="background-image:url('${p.image}');background-size:cover;background-position:center"`);
      }
      card = card.replace(/data-n="[^"]*"/, `data-n="${escapeHtml(p.name)}"`);
      card = card.replace(/data-p="[^"]*"/, `data-p="${p.priceNumber || ''}"`);
      const token = `@@CARD${extractedCards.length}@@`;
      extractedCards.push(card);
      return token;
    });

    // Step 2: everything still showing a plain `.img` box at this
    // point is a hero/banner image, not a product card (cards were
    // already pulled out above) — give those real photos too,
    // cycling through the same product list.
    let heroImgIndex = 0;
    out = out.replace(/class="img" style="[^"]*"/g, () => {
      const p = products[heroImgIndex % products.length];
      heroImgIndex += 1;
      return p.image
        ? `class="img" style="background-image:url('${p.image}');background-size:cover;background-position:center"`
        : `class="img" style=""`;
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
