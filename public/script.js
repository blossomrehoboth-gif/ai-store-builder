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

    renderStore(data);
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

function renderStore(store) {
  document.getElementById("domain-hint").textContent = store.domainHint || "yourstore.com";
  document.getElementById("store-name").textContent = store.storeName || "";
  document.getElementById("store-name").style.color = store.accentColor || "#8C6A30";
  document.getElementById("store-tagline").textContent = store.tagline || "";
  document.getElementById("store-hero").textContent = store.heroHeadline || "";
  document.getElementById("store-story").textContent = store.brandStory || "";

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
