const form = document.getElementById("builder-form");
const productInput = document.getElementById("product");
const audienceInput = document.getElementById("audience");
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
  productInput.value = "";
  audienceInput.value = "";
  selectedTone = "Premium";
  toneGroup.querySelectorAll(".tone-btn").forEach((b) => b.classList.remove("active"));
  toneGroup.querySelector('[data-tone="Premium"]').classList.add("active");
  errorMsg.hidden = true;
  postActions.hidden = true;
  storePreview.hidden = true;
  loadingState.hidden = true;
  emptyState.hidden = false;
});

// Deterministic-looking placeholder photos, used whenever the AliExpress
// image search comes back empty (it's currently unreliable on their end).
function placeholderImages(seed, count) {
  const urls = [];
  for (let i = 0; i < count; i++) {
    urls.push(`https://picsum.photos/seed/${encodeURIComponent(seed)}-${i}/700/700`);
  }
  return urls;
}

async function generateStore() {
  const product = productInput.value.trim();
  if (!product || loading) return;

  loading = true;
  setLoadingUI(true);
  errorMsg.hidden = true;

  const aiContainerReset = document.getElementById("ai-layout-container");
  aiContainerReset.hidden = true;
  if (aiContainerReset.shadowRoot) {
    aiContainerReset.shadowRoot.innerHTML = "";
  }
  document.getElementById("fixed-template").hidden = false;

  try {
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

    let heroImages = [];
    let aliItems = []; // one AliExpress item per AI product slot, or null
    try {
      const imgRes = await fetch(`/api/aliexpress-search?q=${encodeURIComponent(product)}&region=US`);
      const imgData = await imgRes.json();
      const found = (imgData.items || []).filter((it) => it.itemId);

      heroImages = found.map((it) => it.image).filter(Boolean).slice(0, 6);
      aliItems = (data.products || []).map((_, i) => found[i] || null);

      // Real AliExpress price replaces the AI's made-up one wherever we
      // have one — this is what actually gets published to Shopify too.
      (data.products || []).forEach((p, i) => {
        const real = aliItems[i];
        const realPrice = real?.promotionPrice ?? real?.price;
        if (realPrice != null) {
          p.price = `$${realPrice.toFixed(2)}`;
        }
      });
    } catch (e) {
      console.warn("AliExpress fetch failed:", e);
    }

    let productImages = aliItems.map((it) => it?.image || null);

    // Fall back to placeholder photos if AliExpress gave us nothing.
    if (heroImages.length === 0) {
      heroImages = placeholderImages(product, 4);
    }
    if (productImages.length === 0 || productImages.every((u) => !u)) {
      const fallback = placeholderImages(product + "-product", (data.products || []).length || 3);
      productImages = (data.products || []).map((_, i) => fallback[i]);
    }

    renderStore(data, heroImages, productImages, aliItems);
    data.sourceNiche = product;
    currentStore = data;
    postActions.hidden = false;

    // AI-designed layout — real creative freedom on top of the real
    // product data above. If this fails for any reason, the fixed
    // template we already rendered stays visible, so the store never
    // breaks or looks empty.
    try {
      const layoutProducts = (data.products || []).map((p, i) => ({
        name: p.name,
        description: p.description,
        price: p.price,
        image: productImages[i] || null,
        rating: aliItems[i]?.rating ?? null,
        sold: aliItems[i]?.sold ?? null,
        discountPercent: aliItems[i]?.discountPercent ?? null,
      }));

      const layoutRes = await fetch("/api/generate-layout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          concept: {
            storeName: data.storeName,
            tagline: data.tagline,
            tone: selectedTone,
            accentColor: data.accentColor,
          },
          products: layoutProducts,
        }),
      });
      const layoutData = await layoutRes.json();

      if (layoutRes.ok && layoutData.html) {
        const aiContainer = document.getElementById("ai-layout-container");
        // Shadow DOM keeps the AI's CSS completely sealed inside this
        // container — generic selectors like "h1" or "body" in its
        // <style> block cannot leak out and affect the rest of the
        // page (like the input panel on the left).
        const shadow = aiContainer.shadowRoot || aiContainer.attachShadow({ mode: "open" });
        shadow.innerHTML = layoutData.html;
        aiContainer.hidden = false;
        document.getElementById("fixed-template").hidden = true;
      }
      // If it failed or came back empty, we simply leave the fixed
      // template (already rendered above) as-is — no error shown to
      // the shopper, since the store still looks complete either way.
    } catch (e) {
      console.warn("AI layout generation failed, using fixed template:", e);
    }
  } catch (err) {
    errorMsg.textContent =
      "Couldn't build the store from that input. Try rephrasing the product or niche and generate again.";
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
    loadingState.hidden = false;
  } else {
    loadingState.hidden = true;
  }
}

productInput.addEventListener("input", () => {
  generateBtn.disabled = !productInput.value.trim();
});

function setHeroImage(url) {
  document.getElementById("hero-image").src = url;
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

function renderStore(store, heroImages, productImages, aliItems) {
  document.getElementById("domain-hint").textContent = store.domainHint || "yourstore.com";
  document.getElementById("store-name").textContent = store.storeName || "";
  document.getElementById("store-name").style.color = store.accentColor || "#8C6A30";
  document.getElementById("store-tagline").textContent = store.tagline || "";
  // (headline + brand story intentionally not rendered — removed from template)

  const ratingEl = document.getElementById("store-rating");
  const realRatings = (aliItems || []).filter((it) => it && it.rating != null);
  const realSolds = (aliItems || []).filter((it) => it && it.sold != null);

  if (realRatings.length > 0) {
    const avgRating = realRatings.reduce((sum, it) => sum + it.rating, 0) / realRatings.length;
    const totalSold = realSolds.reduce((sum, it) => sum + it.sold, 0);
    const rounded = Math.round(avgRating);
    const stars = "★".repeat(Math.max(1, Math.min(5, rounded))) + "☆".repeat(5 - Math.max(1, Math.min(5, rounded)));
    const soldText = realSolds.length > 0 ? ` · ${totalSold.toLocaleString()} sold across our collection` : "";
    ratingEl.textContent = `${stars}  ${avgRating.toFixed(1)} average rating${soldText}`;
    ratingEl.hidden = false;
  } else {
    ratingEl.hidden = true;
  }

  if (heroImages && heroImages.length > 0) {
    setHeroImage(heroImages[0]);
  }
  renderHeroThumbs(heroImages);

  const productList = document.getElementById("product-list");
  productList.innerHTML = "";
  (store.products || []).forEach((p, i) => {
    const imgUrl = productImages && productImages[i];
    const ali = aliItems && aliItems[i];

    // Real AliExpress data only — never a made-up number. Lines are
    // simply omitted when we don't have a real value for this item.
    let ratingLine = "";
    if (ali?.rating != null) {
      const rounded = Math.round(ali.rating);
      const stars = "★".repeat(Math.max(1, Math.min(5, rounded))) + "☆".repeat(5 - Math.max(1, Math.min(5, rounded)));
      const soldText = ali.sold != null ? ` · ${ali.sold} sold` : "";
      ratingLine = `<p class="product-rating">${stars} ${ali.rating.toFixed(1)}${soldText}</p>`;
    }

    let discountBadge = "";
    if (ali?.discountPercent != null) {
      discountBadge = `<span class="discount-badge">Save ${ali.discountPercent}%</span>`;
    }

    const regionButtons = ali?.itemId
      ? `<div class="region-selector" data-item-id="${ali.itemId}">
          ${["US", "EU", "UK", "AU"]
            .map(
              (r, idx) =>
                `<button type="button" class="region-btn${idx === 0 ? " active" : ""}" data-region="${r}">${r}</button>`
            )
            .join("")}
        </div>`
      : "";

    const card = document.createElement("div");
    card.className = "product-card";
    card.innerHTML = `
      ${imgUrl ? `<img class="product-card-image" src="${imgUrl}" alt="${escapeHtml(p.name)}" />` : `<div class="product-card-image"></div>`}
      <div class="product-card-body">
        <p class="product-name">${escapeHtml(p.name)}</p>
        ${ratingLine}
        <p class="product-desc">${escapeHtml(p.description)}</p>
        <p class="product-price">
          <span class="price-value" style="color:${store.accentColor || "#8C6A30"}">${escapeHtml(p.price)}</span>
          ${discountBadge}
        </p>
        <div class="color-swatches" hidden></div>
        ${regionButtons}
      </div>
    `;
    productList.appendChild(card);

    // Fetch real color variants in the background — never blocks the
    // card from showing, and stays hidden if AliExpress has none.
    if (ali?.itemId) {
      fetch(`/api/aliexpress-colors/${encodeURIComponent(ali.itemId)}`)
        .then((r) => r.json())
        .then((info) => {
          const swatchBox = card.querySelector(".color-swatches");
          const colors = info.colors || [];
          if (!swatchBox || colors.length === 0) return;
          swatchBox.innerHTML = colors
            .map(
              (c, idx) =>
                `<span class="swatch${idx === 0 ? " active" : ""}" title="${escapeHtml(c.name)}"${
                  c.image ? ` style="background-image:url('${c.image}')"` : ""
                }></span>`
            )
            .join("");
          swatchBox.hidden = false;
          swatchBox.querySelectorAll(".swatch").forEach((el, idx) => {
            el.addEventListener("click", () => {
              swatchBox.querySelectorAll(".swatch").forEach((s) => s.classList.remove("active"));
              el.classList.add("active");
              if (colors[idx]?.image) {
                const img = card.querySelector(".product-card-image");
                if (img && img.tagName === "IMG") img.src = colors[idx].image;
              }
            });
          });
        })
        .catch(() => {});
    }
  });

  const adBox = document.getElementById("ad-box");
  if (store.adLine) {
    document.getElementById("ad-line").textContent = store.adLine;
    adBox.hidden = false;
  } else {
    adBox.hidden = true;
  }

  emptyState.hidden = true;
  loadingState.hidden = true;
  storePreview.hidden = false;
}

// One delegated listener handles every region button on every card,
// including ones added after a regenerate.
document.getElementById("product-list").addEventListener("click", async (e) => {
  const btn = e.target.closest(".region-btn");
  if (!btn) return;

  const selector = btn.closest(".region-selector");
  const card = btn.closest(".product-card");
  const itemId = selector.dataset.itemId;
  const region = btn.dataset.region;

  selector.querySelectorAll(".region-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");

  const priceValueEl = card.querySelector(".price-value");
  const priceLineEl = card.querySelector(".product-price");
  const originalText = priceValueEl.textContent;
  priceValueEl.textContent = "...";

  try {
    const res = await fetch(`/api/aliexpress-region-price/${encodeURIComponent(itemId)}?region=${region}`);
    const info = await res.json();

    if (!info.ok) {
      priceValueEl.textContent = originalText;
      return;
    }

    const realPrice = info.promotionPrice ?? info.price;
    if (realPrice == null) {
      priceValueEl.textContent = originalText;
      return;
    }

    const symbol = { USD: "$", EUR: "€", GBP: "£", AUD: "A$" }[info.currency] || "";
    priceValueEl.textContent = `${symbol}${realPrice.toFixed(2)}`;

    let badge = priceLineEl.querySelector(".discount-badge");
    if (info.discountPercent != null) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "discount-badge";
        priceLineEl.appendChild(badge);
      }
      badge.textContent = `Save ${info.discountPercent}%`;
    } else if (badge) {
      badge.remove();
    }
  } catch (e) {
    priceValueEl.textContent = originalText;
  }
});

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
