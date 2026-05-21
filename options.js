const keyInput = document.getElementById("apiKey");
const modelSelect = document.getElementById("model");
const saveBtn = document.getElementById("save");
const clearBtn = document.getElementById("clear");
const toggleBtn = document.getElementById("toggle");
const statusEl = document.getElementById("status");

function setStatus(msg, kind = "ok") {
  statusEl.textContent = msg;
  statusEl.className = "status " + kind;
  statusEl.style.display = "block";
}

async function loadFromStorage() {
  const { groqApiKey, groqModel } = await chrome.storage.local.get(["groqApiKey", "groqModel"]);
  if (groqApiKey) keyInput.value = groqApiKey;
  if (groqModel) modelSelect.value = groqModel;
}

async function seedFromLocalFileIfPresent() {
  // If local-key.js was loaded and chrome.storage.local has no key yet,
  // seed it once. The file is gitignored and only exists on the user's machine.
  if (window.__LOCAL_KEY_MISSING__) return;
  const localKey = window.__LOCAL_GROQ_KEY__;
  if (!localKey) return;
  const { groqApiKey } = await chrome.storage.local.get("groqApiKey");
  if (!groqApiKey) {
    await chrome.storage.local.set({ groqApiKey: localKey });
    keyInput.value = localKey;
    setStatus("Loaded key from local-key.js and saved to chrome.storage.local.", "ok");
  }
}

saveBtn.addEventListener("click", async () => {
  const key = keyInput.value.trim();
  const model = modelSelect.value;
  if (key && !/^gsk_[A-Za-z0-9]+/.test(key)) {
    setStatus("Doesn't look like a Groq key (expected to start with gsk_). Saved anyway.", "warn");
  }
  await chrome.storage.local.set({ groqApiKey: key, groqModel: model });
  setStatus(key ? "Saved." : "Key cleared (AI enrichment disabled).", "ok");
});

clearBtn.addEventListener("click", async () => {
  keyInput.value = "";
  await chrome.storage.local.remove("groqApiKey");
  setStatus("Key removed from chrome.storage.local.", "ok");
});

toggleBtn.addEventListener("click", () => {
  if (keyInput.type === "password") {
    keyInput.type = "text";
    toggleBtn.textContent = "Hide";
  } else {
    keyInput.type = "password";
    toggleBtn.textContent = "Show";
  }
});

(async () => {
  await loadFromStorage();
  await seedFromLocalFileIfPresent();
})();
