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
    let productImages = [];
    try {
      const imgRes = await fetch(`/api/aliexpress-search?q=${encodeURIComponent(product)}`);
      const imgData = await imgRes.json();
      const items = (imgData.items || []).filter((it) => it.images && it.images.length > 0);

      const pool = items
        .flatMap((it) => it.images)
        .filter(Boolean)
        .map((u) => (u.startsWith("//") ? "https:" + u : u));

      heroImages = pool.slice(0, 6);
      productImages = (data.products || []).map((_, i) =>
        pool.length ? pool[(i + 1) % pool.length] : null
      );
    } catch (e) {
      console.warn("Image fetch failed:", e);
    }

    // Fall back to placeholder photos if AliExpress gave us nothing.
    if (heroImages.length === 0) {
      heroImages = placeholderImages(product, 4);
    }
    if (productImages.length === 0 || productImages.every((u) => !u)) {
      const fallback = placeholderImages(product + "-product", (data.products || []).length || 3);
      productImages = (data.products || []).map((_, i) => fallback[i]);
    }

    renderStore(data, heroImages, productImages);
    data.sourceNiche = product;
    currentStore = data;
    postActions.hidden = false;
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

function renderStore(store, heroImages, productImages) {
  document.getElementById("domain-hint").textContent = store.domainHint || "yourstore.com";
  document.getElementById("store-name").textContent = store.storeName || "";
  document.getElementById("store-name").style.color = store.accentColor || "#8C6A30";
  document.getElementById("store-tagline").textContent = store.tagline || "";
  document.getElementById("store-hero").textContent = store.heroHeadline || "";
  document.getElementById("store-story").textContent = store.brandStory || "";

  const ratingEl = document.getElementById("store-rating");
  if (store.rating) {
    const rounded = Math.round(parseFloat(store.rating));
    const stars = "★".repeat(Math.max(1, Math.min(5, rounded))) + "☆".repeat(5 - Math.max(1, Math.min(5, rounded)));
    ratingEl.textContent = `${stars}  Rated ${store.rating} out of 5${store.reviewsLine ? " by " + store.reviewsLine : ""}`;
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
    const card = document.createElement("div");
    card.className = "product-card";
    card.innerHTML = `
      ${imgUrl ? `<img class="product-card-image" src="${imgUrl}" alt="${escapeHtml(p.name)}" />` : `<div class="product-card-image"></div>`}
      <div class="product-card-body">
        <p class="product-name">${escapeHtml(p.name)}</p>
        <p class="product-desc">${escapeHtml(p.description)}</p>
        <p class="product-price" style="color:${store.accentColor || "#8C6A30"}">${escapeHtml(p.price)}</p>
      </div>
    `;
    productList.appendChild(card);
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
