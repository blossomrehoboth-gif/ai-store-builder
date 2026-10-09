const form = document.getElementById("builder-form");
const productInput = document.getElementById("product");
const aliLinkInput = document.getElementById("ali-link");
const audienceInput = document.getElementById("audience");
const storeNameInput = document.getElementById("store-name-input");
const toneGroup = document.getElementById("tone-group");
const generateBtn = document.getElementById("generate-btn");
const generateIcon = document.getElementById("generate-icon");
const generateLabel = document.getElementById("generate-label");
const errorMsg = document.getElementById("error-msg");
const postActions = document.getElementById("post-actions");
const regenerateBtn = document.getElementById("regenerate-btn");
const startOverBtn = document.getElementById("start-over-btn");

const emptyState = document.getElementById("empty-state");
const loadingState = document.getElementById("loading-state");
const storePreview = document.getElementById("store-preview");

let selectedTone = "Premium";
let loading = false;
let currentStore = null;

// Keeps the last generated store so it survives a page refresh or
// leaving the tab — saved right after each successful generation.
function saveDraft(store, heroImages, perProduct, layoutIndex) {
  try {
    localStorage.setItem("lastStoreDraft", JSON.stringify({ store, heroImages, perProduct, layoutIndex }));
  } catch (e) {}
}

async function restoreDraft() {
  try {
    const raw = localStorage.getItem("lastStoreDraft");
    if (!raw) return;
    const draft = JSON.parse(raw);
    if (!draft?.store) return;
    await showTemplatePreview(draft.store, draft.perProduct || []);
  } catch (e) {}
}

const shopDomainInput = document.getElementById("shop-domain");
const publishBtn = document.getElementById("publish-btn");
const publishLabel = document.getElementById("publish-label");
const publishStatus = document.getElementById("publish-status");

const params = new URLSearchParams(window.location.search);
if (params.get("shop")) {
  shopDomainInput.value = params.get("shop");
}
if (params.get("connected") === "1") {
  publishStatus.textContent = "Connected to " + params.get("shop") + ". Generate a store, then publish it below.";
}

toneGroup.addEventListener("click", (e) => {
  const btn = e.target.closest(".tone-btn");
  if (!btn) return;
  selectedTone = btn.dataset.tone;
  toneGroup.querySelectorAll(".tone-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  generateStore();
});

regenerateBtn.addEventListener("click", generateStore);

startOverBtn.addEventListener("click", () => {
  localStorage.removeItem("lastStoreDraft");
  currentStore = null;
  productInput.value = "";
  aliLinkInput.value = "";
  storeNameInput.value = "";
  audienceInput.value = "";
  selectedTone = "Premium";
  toneGroup.querySelectorAll(".tone-btn").forEach((b) => b.classList.remove("active"));
  toneGroup.querySelector('[data-tone="Premium"]').classList.add("active");
  errorMsg.hidden = true;
  postActions.hidden = true;
  storePreview.hidden = true;
  document.getElementById("layout-chooser").hidden = true;
  document.getElementById("template-preview").hidden = true;
  document.getElementById("publish-box").hidden = true;
  loadingState.hidden = true;
  emptyState.hidden = false;
});

// Pulls the numeric AliExpress product ID out of a link, if it's there.
function extractAliItemId(text) {
  const patterns = [
    /item\/(\d{8,})/i,
    /[?&](?:itemId|productId|productIds|item_id)=(\d{8,})/i,
    /x_object_id(?:%3A|:)(\d{8,})/i,
    /\/(\d{13,})\.html/i,
  ];
  for (const p of patterns) {
    const m = String(text).match(p);
    if (m) return m[1];
  }
  return null;
}

async function generateStore() {
  const linkText = aliLinkInput.value.trim();
  const rawInput = productInput.value.trim() || linkText;
  if (!rawInput || loading) return;

  loading = true;
  setLoadingUI(true);
  errorMsg.hidden = true;

  try {
    // If the seller pasted an AliExpress product link, build the store
    // around that exact product using its real photos, price, rating.
    let linkedItem = null;
    let product = rawInput;
    const linkSource = linkText || rawInput;
    let itemId = null;
    const cjMatch = String(linkSource).match(/cjdropshipping\.com\/.*?-p-([0-9a-fA-F-]{20,})\.html/i);
    if (cjMatch) itemId = cjMatch[1];
    if (linkText && !itemId) {
      throw new Error("Couldn't find a CJ product in that link. Paste a CJ Dropshipping product link, or leave it blank and type the product name above.");
    }
    if (itemId) {
      const itemRes = await fetch(`/api/cj-item/${itemId}`);
      const itemData = await itemRes.json();
      if (!itemData.ok || !itemData.item) {
        throw new Error("CJ did not return details for that product. Try a different CJ product link.");
      }
      linkedItem = itemData.item;
      product = (linkedItem.title || "CJ product").slice(0, 90);
    }

    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        product,
        audience: audienceInput.value.trim(),
        tone: selectedTone,
      }),
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      throw new Error(data.error || "Request failed");
    }

    if (linkedItem) {
      const first = (data.products || [])[0] || { name: data.storeName, description: data.tagline };
      first.price = linkedItem.price != null ? `$${linkedItem.price.toFixed(2)}` : first.price;
      first.aliItemId = linkedItem.itemId || null;
      first.aliImage = linkedItem.image || null;
      first.aliPrice = linkedItem.price != null ? linkedItem.price : null;
      first.name = String(linkedItem.title || first.name || "").slice(0, 120);
      first.cjPid = linkedItem.itemId || null;
      first.cjImage = linkedItem.image || null;
      first.cjCost = linkedItem.cost != null ? linkedItem.cost : null;
      data.products = [first];
      if (storeNameInput.value.trim()) {
        data.storeName = storeNameInput.value.trim();
      }
      data.sourceNiche = product;
      await showTemplatePreview(data, [linkedItem]);
      return;
    }

    // Real AliExpress data: photo, price, rating, sold — per listing.
    // If a listing is missing, that product slot just keeps the AI's
    // made-up description/price and shows a blank photo box.
    let aliItems = [];
    try {
      const imgRes = await fetch(`/api/cj-search?q=${encodeURIComponent(product)}`);
      const imgData = await imgRes.json();
      aliItems = imgData.items || [];
    } catch (e) {
      console.warn("CJ search failed:", e);
    }

    const heroImages = aliItems.map((it) => it.image).filter(Boolean).slice(0, 6);
    let perProduct = (data.products || []).map((_, i) => aliItems[i] || null);

    // If a product's own listing has price/rating but no photo, borrow
    // a photo from another real listing rather than leaving it blank.
    // Never invents an image — only reuses a real one we already have.
    const fallbackImagePool = aliItems.map((it) => it.image).filter(Boolean);
    let fallbackIdx = 0;
    perProduct = perProduct.map((item) => {
      if (item && !item.image && fallbackImagePool.length > 0) {
        const borrowedImage = fallbackImagePool[fallbackIdx % fallbackImagePool.length];
        fallbackIdx += 1;
        return { ...item, image: borrowedImage };
      }
      return item;
    });

    // Real price replaces the AI's made-up one wherever we have one —
    // this is also what actually gets published to Shopify.
    (data.products || []).forEach((p, i) => {
      const real = perProduct[i];
      if (real?.price != null) {
        p.price = `$${real.price.toFixed(2)}`;
      }
      // Carried through to Shopify so a real order can be matched back
      // to the exact AliExpress listing for fulfillment.
      if (real?.itemId) {
        p.aliItemId = real.itemId;
        p.aliImage = real.image || null;
        p.aliPrice = real.price != null ? real.price : null;
        p.name = String(real.title || p.name || "").slice(0, 120);
        p.cjPid = real.itemId;
        p.cjImage = real.image || null;
        p.cjCost = real.cost != null ? real.cost : null;
      }
    });

    if (storeNameInput.value.trim()) {
      data.storeName = storeNameInput.value.trim();
    }

    data.sourceNiche = product;
    await showTemplatePreview(data, perProduct);
  } catch (err) {
    errorMsg.textContent = /CJ/.test(err.message || "")
      ? err.message
      : "Couldn't build the store from that input. Try rephrasing the product or niche and generate again.";
    errorMsg.hidden = false;
    emptyState.hidden = storePreview.hidden ? false : true;
  } finally {
    loading = false;
    setLoadingUI(false);
  }
}

function setLoadingUI(isLoading) {
  generateBtn.disabled = isLoading || !productInput.value.trim();
  generateIcon.textContent = isLoading ? "" : "✦";
  generateLabel.textContent = isLoading ? "Building your store" : "Generate store";

  if (isLoading) {
    emptyState.hidden = true;
    storePreview.hidden = true;
    document.getElementById("layout-chooser").hidden = true;
    document.getElementById("template-preview").hidden = true;
    document.getElementById("publish-box").hidden = true;
    loadingState.hidden = false;
  } else {
    loadingState.hidden = true;
  }
}

productInput.addEventListener("input", () => {
  generateBtn.disabled = !productInput.value.trim();
});

function setHeroImage(url) {
  const heroEl = document.getElementById("hero-image");
  if (url) {
    heroEl.src = url;
    heroEl.style.display = "";
  } else {
    heroEl.removeAttribute("src");
    heroEl.style.display = "none";
  }
}

function renderHeroThumbs(images) {
  const thumbsBox = document.getElementById("hero-thumbs");
  thumbsBox.innerHTML = "";

  if (!images || images.length < 2) {
    thumbsBox.hidden = true;
    return;
  }

  images.forEach((url, i) => {
    const img = document.createElement("img");
    img.src = url;
    img.className = "hero-thumb" + (i === 0 ? " active" : "");
    img.alt = "Product photo " + (i + 1);
    img.addEventListener("click", () => {
      setHeroImage(url);
      thumbsBox.querySelectorAll(".hero-thumb").forEach((t) => t.classList.remove("active"));
      img.classList.add("active");
    });
    thumbsBox.appendChild(img);
  });

  thumbsBox.hidden = false;
}

function starString(rating) {
  const rounded = Math.round(rating);
  return "★".repeat(Math.max(1, Math.min(5, rounded))) + "☆".repeat(5 - Math.max(1, Math.min(5, rounded)));
}

async function showTemplatePreview(store, perProduct) {
  loadingState.hidden = true;
  emptyState.hidden = true;
  storePreview.hidden = true;
  document.getElementById("layout-chooser").hidden = true;

  const products = (store.products || []).map((p, i) => {
    const real = perProduct[i];
    return {
      name: p.name,
      priceDisplay: p.price || "",
      priceNumber: real?.price != null ? real.price : null,
      image: real?.image || null,
    };
  });

  async function fetchAndShow(preferredFile) {
    const res = await fetch("/api/render-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storeName: store.storeName,
        tagline: store.tagline,
        accentColor: store.accentColor,
        products,
        templateChoice: preferredFile,
      }),
    });
    const result = await res.json();
    if (!res.ok || result.error) {
      errorMsg.textContent = "Couldn't render the store design. Try generating again.";
      errorMsg.hidden = false;
      return;
    }
    const iframe = document.getElementById("template-iframe");
    iframe.srcdoc = result.html;
    store.__templateFile = result.templateFile;
    document.getElementById("template-preview").hidden = false;
    document.getElementById("publish-box").hidden = false;
    currentStore = store;
    postActions.hidden = false;
    saveDraft(store, [], perProduct);
    localStorage.setItem("lastTemplateProducts", JSON.stringify(products));
  }

  await fetchAndShow(null); // always random, ignore Groq's pick

  document.getElementById("reroll-template-btn").onclick = () => {
    fetchAndShow(null); // null = pick a new random one, ignore Groq's original pick
  };
}

function showLayoutChooser(store, heroImages, perProduct) {
  loadingState.hidden = true;
  storePreview.hidden = true;
  emptyState.hidden = true;

  const chooser = document.getElementById("layout-chooser");
  const cardsEl = document.getElementById("layout-chooser-cards");
  const thumb = heroImages && heroImages[0];
  const firstPrice = (store.products && store.products[0] && store.products[0].price) || "";

  const layouts = [
    { label: "Classic", desc: "Clean product grid, no extras." },
    { label: "Announcement + FAQ", desc: "Scrolling banner, delivery tracker, FAQ accordion." },
    { label: "Checkout-style", desc: "Payment icons, bundle deal pricing, single-product focus." },
    { label: "Minimal + Sticky Bar", desc: "Stripped down, price/CTA follows you while scrolling." },
    { label: "Gallery + Accordion", desc: "Photo gallery, collapsible description/FAQ rows." },
    { label: "Story First", desc: "Brand story leads, then products, then proof." },
    { label: "How It Works First", desc: "Usage steps lead, builds trust before the price." },
    { label: "Social Proof First", desc: "Reviews and comparison table lead the page." },
  ];

  cardsEl.innerHTML = layouts
    .map(
      (l, i) => `
    <div class="layout-choice-card" data-index="${i}">
      ${thumb ? `<img src="${thumb}" />` : `<div style="width:64px;height:64px;border-radius:8px;background:#eee;flex-shrink:0;"></div>`}
      <div class="layout-choice-info">
        <p class="layout-choice-title">${escapeHtml(l.label)}</p>
        <p class="layout-choice-desc">${escapeHtml(l.desc)}${firstPrice ? " · " + escapeHtml(firstPrice) : ""}</p>
      </div>
      <button type="button" class="layout-choice-btn" data-index="${i}">Choose</button>
    </div>
  `
    )
    .join("");

  cardsEl.querySelectorAll("[data-index]").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = parseInt(el.dataset.index, 10);
      chooser.hidden = true;
      renderStore(store, heroImages, perProduct, idx);
      currentStore = store;
      postActions.hidden = false;
      saveDraft(store, heroImages, perProduct, idx);
    });
  });

  chooser.hidden = false;
}

function renderStore(store, heroImages, perProduct, layoutIndex) {
  document.getElementById("domain-hint").textContent = store.domainHint || "yourstore.com";
  document.getElementById("store-name").textContent = store.storeName || "";
  document.getElementById("store-name").style.color = store.accentColor || "#8C6A30";
  document.getElementById("store-tagline").textContent = store.tagline || "";
  document.getElementById("store-hero").textContent = store.heroHeadline || "";
  document.getElementById("store-story").textContent = store.brandStory || "";

  // Spotlight price/rating — from the first real AliExpress listing when
  // we have one, otherwise falls back to the AI's made-up price.
  const firstProduct = (store.products || [])[0];
  const firstAli = perProduct && perProduct[0];
  const priceEl = document.getElementById("price");
  const originalPriceEl = document.getElementById("original-price");
  const discountEl = document.getElementById("discount-badge");

  const displayPrice = firstAli?.price ?? (firstProduct?.price ? parseFloat(String(firstProduct.price).replace(/[^0-9.]/g, "")) : null);
  const displayOriginal = firstAli?.originalPrice ?? (displayPrice != null ? displayPrice * 1.35 : null);

  if (displayPrice != null) {
    priceEl.textContent = `$${displayPrice.toFixed(2)}`;
    if (displayOriginal != null && displayOriginal > displayPrice) {
      const pct = Math.round((1 - displayPrice / displayOriginal) * 100);
      originalPriceEl.textContent = `$${displayOriginal.toFixed(2)}`;
      originalPriceEl.style.display = "inline";
      discountEl.textContent = `${pct}% OFF`;
      discountEl.style.display = "inline-block";
    } else {
      originalPriceEl.style.display = "none";
      discountEl.style.display = "none";
    }
  } else {
    priceEl.textContent = "";
    originalPriceEl.style.display = "none";
    discountEl.style.display = "none";
  }

  // Feature checklist
  const checklist = document.getElementById("feature-checklist");
  checklist.innerHTML = "";
  (store.featureChecklist || []).forEach((f) => {
    const li = document.createElement("li");
    li.textContent = f;
    checklist.appendChild(li);
  });

  // Comparison table
  const comparisonSection = document.getElementById("comparison-section");
  const comparisonTable = document.getElementById("comparison-table");
  if (store.comparisonTable && store.comparisonTable.length > 0) {
    comparisonTable.innerHTML = `
      <tr><th></th><th class="us-col">${escapeHtml(store.storeName || "Us")}</th><th class="them-col">Others</th></tr>
      ${store.comparisonTable
        .map(
          (row) => `
        <tr>
          <th>${escapeHtml(row.category)}</th>
          <td class="us-col">${escapeHtml(row.us)}</td>
          <td class="them-col">${escapeHtml(row.them)}</td>
        </tr>
      `
        )
        .join("")}
    `;
    comparisonSection.hidden = false;
  } else {
    comparisonSection.hidden = true;
  }

  // Usage steps
  const usageSection = document.getElementById("usage-section");
  const usageSteps = document.getElementById("usage-steps");
  if (store.usageSteps && store.usageSteps.length > 0) {
    usageSteps.innerHTML = store.usageSteps
      .map(
        (s, i) => `
      <div class="usage-step">
        <span class="usage-step-number">${i + 1}</span>
        <div>
          <p class="usage-step-title">${escapeHtml(s.title)}</p>
          <p class="usage-step-detail">${escapeHtml(s.detail)}</p>
        </div>
      </div>
    `
      )
      .join("");
    usageSection.hidden = false;
  } else {
    usageSection.hidden = true;
  }

  if (heroImages && heroImages.length > 0) {
    setHeroImage(heroImages[0]);
  }
  renderHeroThumbs(heroImages);

  const productList = document.getElementById("product-list");
  productList.innerHTML = "";
  (store.products || []).forEach((p, i) => {
    const ali = perProduct && perProduct[i];
    const imgUrl = ali?.image;

    let ratingLine = "";
    if (ali?.rating != null) {
      const soldText = ali.sold != null ? ` · ${ali.sold} sold` : "";
      ratingLine = `<p class="product-rating">${starString(ali.rating)} ${ali.rating.toFixed(1)}${soldText}</p>`;
    }

    const card = document.createElement("div");
    card.className = "product-card";
    card.innerHTML = `
      ${imgUrl ? `<img class="product-card-image" src="${imgUrl}" alt="${escapeHtml(p.name)}" />` : `<div class="product-card-image"></div>`}
      <div class="product-card-body">
        <p class="product-name">${escapeHtml(p.name)}</p>
        ${ratingLine}
        <p class="product-desc">${escapeHtml(p.description)}</p>
        <p class="product-price" style="color:${store.accentColor || "#8C6A30"}">${escapeHtml(p.price)}</p>
      </div>
    `;
    productList.appendChild(card);
  });

  // Reviews
  const reviewsSection = document.getElementById("reviews-section");
  const reviewsList = document.getElementById("reviews-list");
  if (store.reviews && store.reviews.length > 0) {
    reviewsList.innerHTML = store.reviews
      .map((r) => {
        const stars = "★".repeat(Math.max(1, Math.min(5, r.rating || 5)));
        return `
        <div class="review-card">
          <p class="review-name">${escapeHtml(r.name || "Verified buyer")} ${stars}</p>
          <p class="review-quote">"${escapeHtml(r.quote)}"</p>
        </div>
      `;
      })
      .join("");
    reviewsSection.hidden = false;
  } else {
    reviewsSection.hidden = true;
  }

  const adBox = document.getElementById("ad-box");
  if (store.adLine) {
    document.getElementById("ad-line").textContent = store.adLine;
    adBox.hidden = false;
  } else {
    adBox.hidden = true;
  }

  // Three layout variants, guaranteed to cycle A → B → C → A... on
  // every generate, instead of random chance that could repeat.
  // Explicit choice (from the layout picker) wins; otherwise fall
  // back to auto-rotating, e.g. when restoring a saved draft.
  if (layoutIndex == null) {
    window.__layoutIndex = ((window.__layoutIndex ?? -1) + 1) % 3;
    layoutIndex = window.__layoutIndex;
  }
  const isLayoutB = layoutIndex === 1;
  const isLayoutC = layoutIndex === 2;

  document.getElementById("progress-tracker").hidden = !isLayoutB;

  const faqSection = document.getElementById("faq-section");
  const faqList = document.getElementById("faq-list");
  if (isLayoutB && store.faq && store.faq.length > 0) {
    faqList.innerHTML = store.faq
      .map(
        (f, i) => `
      <div class="faq-item">
        <button type="button" class="faq-question">${escapeHtml(f.question)}</button>
        <div class="faq-answer">${escapeHtml(f.answer)}</div>
      </div>
    `
      )
      .join("");
    faqList.querySelectorAll(".faq-item").forEach((item) => {
      item.querySelector(".faq-question").addEventListener("click", () => {
        item.classList.toggle("open");
      });
    });
    faqSection.hidden = false;
  } else {
    faqSection.hidden = true;
  }

  // Layout C extras — EverOrb-style: payment icon row + a bundle deal
  // block, built from the same real price already shown above (never
  // a separate invented number).
  document.getElementById("payment-icons").hidden = !isLayoutC;
  const bundleSection = document.getElementById("bundle-section");
  if (isLayoutC && displayPrice != null) {
    const bundleOptionsEl = document.getElementById("bundle-options");
    const tiers = [
      { label: "Buy 1", qty: 1, mult: 1 },
      { label: "Buy 2 & Save", qty: 2, mult: 1.8 },
      { label: "Buy 3 & Save More", qty: 3, mult: 2.5 },
    ];
    bundleOptionsEl.innerHTML = tiers
      .map((t, i) => {
        const total = displayPrice * t.mult;
        return `
        <div class="bundle-option${i === 1 ? " best" : ""}">
          <span>${t.label}</span>
          <span class="bundle-price">$${total.toFixed(2)}</span>
        </div>
      `;
      })
      .join("");
    bundleSection.hidden = false;
  } else {
    bundleSection.hidden = true;
  }

  emptyState.hidden = true;
  loadingState.hidden = true;
  storePreview.hidden = false;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

publishBtn.addEventListener("click", async () => {
  const shop = shopDomainInput.value.trim();

  if (!currentStore) {
    publishStatus.textContent = "Generate a store first.";
    return;
  }
  if (!shop || !shop.endsWith(".myshopify.com")) {
    publishStatus.textContent = "Enter a valid *.myshopify.com domain above.";
    return;
  }

  publishBtn.disabled = true;
  publishLabel.textContent = "Publishing...";
  publishStatus.textContent = "";

  try {
    const response = await fetch("/api/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shop, concept: currentStore }),
    });
    const data = await response.json();

    if (!response.ok || data.error) {
      throw new Error(data.error || "Publish failed.");
    }

    const succeeded = (data.results || []).filter((r) => r.ok).length;
    const failed = (data.results || []).filter((r) => !r.ok);
    let msg = `Published ${succeeded} product${succeeded === 1 ? "" : "s"} to ${shop}.`;
    if (failed.length) {
      msg += ` ${failed.length} failed: ` + failed.map((f) => `${f.name} (${f.error})`).join("; ");
    }
    publishStatus.textContent = msg;
  } catch (err) {
    publishStatus.textContent =
      "Couldn't publish: " + err.message + ". Make sure you installed the app on this store first.";
  } finally {
    publishBtn.disabled = false;
    publishLabel.textContent = "Publish to Shopify";
  }
});

restoreDraft();
