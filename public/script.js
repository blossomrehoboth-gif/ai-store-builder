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

// If we just came back from a successful Shopify install, remember the shop.
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
    try {
      const imgRes = await fetch(`/api/aliexpress-search?q=${encodeURIComponent(product)}`);
      const imgData = await imgRes.json();
      const withImage = (imgData.items || []).find((it) => it.images && it.images.length > 0);
      if (withImage) {
        heroImages = withImage.images
          .filter(Boolean)
          .map((u) => (u.startsWith("//") ? "https:" + u : u))
          .slice(0, 6);
      }
    } catch (e) {
      console.warn("Hero image fetch failed:", e);
    }

    renderStore(data, heroImages);
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
  const heroSection = document.getElementById("hero-section");
  heroSection.style.backgroundImage = `url(${url})`;
  heroSection.style.backgroundSize = "cover";
  heroSection.style.backgroundPosition = "center";
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

function renderStore(store, heroImages) {
  document.getElementById("domain-hint").textContent = store.domainHint || "yourstore.com";
  document.getElementById("store-name").textContent = store.storeName || "";
  document.getElementById("store-name").style.color = store.accentColor || "#8C6A30";
  document.getElementById("store-tagline").textContent = store.tagline || "";
  document.getElementById("store-hero").textContent = store.heroHeadline || "";
  document.getElementById("store-story").textContent = store.brandStory || "";

  if (heroImages && heroImages.length > 0) {
    setHeroImage(heroImages[0]);
  }
  renderHeroThumbs(heroImages);

  const productList = document.getElementById("product-list");
  productList.innerHTML = "";
  (store.products || []).forEach((p) => {
    const row = document.createElement("div");
    row.className = "product-row";
    row.innerHTML = `
      <div>
        <p class="product-name">${escapeHtml(p.name)}</p>
        <p class="product-desc">${escapeHtml(p.description)}</p>
      </div>
      <p class="product-price" style="color:${store.accentColor || "#8C6A30"}">${escapeHtml(p.price)}</p>
    `;
    productList.appendChild(row);
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
    
