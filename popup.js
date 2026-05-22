// JUST TNP Scraper — popup script (v2.1)
// Drives the content script; persists results to chrome.storage.local for the Viewer.
// NOTE: This file is loaded as an external script per Chrome MV3 CSP (which
// blocks inline <script> in extension pages). Any DOM wiring that was
// previously inline in popup.html now lives here.

// ---------- Pill / switch visual mirroring ----------
function mirrorVisual(visualId, inputId) {
  const v = document.getElementById(visualId);
  const i = document.getElementById(inputId);
  if (!v || !i) return;
  const apply = () => v.classList.toggle("on", i.checked);
  apply();
  i.addEventListener("change", apply);
}
const BRANCH_IDS = [
  ["pill-cse", "branchCSE"],
  ["pill-it", "branchIT"],
  ["pill-aiml", "branchAIML"],
  ["pill-mc", "branchMC"],
  ["pill-ece", "branchECE"],
  ["pill-eee", "branchEEE"],
  ["pill-me", "branchME"],
  ["pill-ce", "branchCE"],
  ["pill-chem", "branchCHEM"],
  ["pill-bt", "branchBT"],
];
BRANCH_IDS.forEach(([p, i]) => mirrorVisual(p, i));
mirrorVisual("sw-results", "fetchResults");
mirrorVisual("sw-ai", "useAI");

const branchAllBtn = document.getElementById("branchAll");
const branchNoneBtn = document.getElementById("branchNone");
if (branchAllBtn) {
  branchAllBtn.addEventListener("click", () => {
    BRANCH_IDS.forEach(([, id]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.checked = true;
      el.dispatchEvent(new Event("change"));
    });
  });
}
if (branchNoneBtn) {
  branchNoneBtn.addEventListener("click", () => {
    BRANCH_IDS.forEach(([, id]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.checked = false;
      el.dispatchEvent(new Event("change"));
    });
  });
}


const statusEl = document.getElementById("status");
const scrapeBtn = document.getElementById("scrapeBtn");
const inspectBtn = document.getElementById("inspectBtn");

function log(msg) {
  statusEl.textContent = msg + "\n" + statusEl.textContent;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function runInTab(tabId, func, args = []) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return r.result;
}

async function injectContent(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

async function buildOptions() {
  const { groqApiKey, groqModel } = await chrome.storage.local.get(["groqApiKey", "groqModel"]);
  const useAI = document.getElementById("useAI").checked;
  const minStr = document.getElementById("minCTC").value.trim();
  const maxStr = document.getElementById("maxCTC").value.trim();
  return {
    branches: {
      CSE: document.getElementById("branchCSE").checked,
      IT: document.getElementById("branchIT").checked,
      AIML: document.getElementById("branchAIML").checked,
      MC: document.getElementById("branchMC").checked,
      ECE: document.getElementById("branchECE").checked,
      EEE: document.getElementById("branchEEE").checked,
      ME: document.getElementById("branchME").checked,
      CE: document.getElementById("branchCE").checked,
      CHEM: document.getElementById("branchCHEM").checked,
      BT: document.getElementById("branchBT").checked,
    },
    fetchResults: document.getElementById("fetchResults").checked,
    useAI: useAI && !!groqApiKey,
    apiKey: useAI ? (groqApiKey || "") : "",
    model: groqModel || "llama-3.1-8b-instant",
    minCTC: minStr === "" ? null : parseFloat(minStr),
    maxCTC: maxStr === "" ? null : parseFloat(maxStr),
  };
}

function filterByCTCRange(rows, minLPA, maxLPA) {
  if (minLPA == null && maxLPA == null) return rows;
  const minR = minLPA != null ? minLPA * 100000 : null;
  const maxR = maxLPA != null ? maxLPA * 100000 : null;
  return rows.filter((r) => {
    const v = r.annualCTC;
    if (v == null) return minLPA == null || minLPA === 0;
    if (minR != null && v < minR) return false;
    if (maxR != null && v > maxR) return false;
    return true;
  });
}

// ---------- Version pill (read from manifest — single source of truth) ----------
try {
  const v = chrome.runtime.getManifest()?.version;
  if (v) document.getElementById("versionPill").textContent = "v" + v;
} catch {}

// ---------- AI status indicator ----------
(async () => {
  const { groqApiKey } = await chrome.storage.local.get("groqApiKey");
  const aiStatus = document.getElementById("aiStatus");
  if (groqApiKey) {
    aiStatus.textContent = "key set";
    aiStatus.classList.add("ok");
  } else {
    aiStatus.textContent = "no key — open Settings";
    aiStatus.classList.add("bad");
  }

  const { lastScrape } = await chrome.storage.local.get("lastScrape");
  const btn = document.getElementById("viewerBtn");
  if (lastScrape?.rows?.length) {
    btn.textContent = `📊 Open Viewer (${lastScrape.rows.length}) ↗`;
  } else {
    btn.textContent = "📊 Open Viewer (no data yet)";
    btn.disabled = true;
  }
})();

// ---------- Buttons ----------
document.getElementById("settingsBtn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("viewerBtn").addEventListener("click", async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") });
});

inspectBtn.addEventListener("click", async () => {
  try {
    const tab = await getActiveTab();
    await injectContent(tab.id);
    const report = await runInTab(tab.id, () => window.__BIT_TNP_INSPECT__());
    log(report);
  } catch (e) {
    log("ERROR: " + e.message);
  }
});

// ---------- Scrape ----------
scrapeBtn.addEventListener("click", async () => {
  scrapeBtn.disabled = true;
  statusEl.textContent = "";
  log("Starting…");
  let pollHandle = null;
  try {
    const tab = await getActiveTab();
    if (!tab?.url?.includes("bitmesra")) log("Warning: active tab is not bitmesra. Continuing.");
    await injectContent(tab.id);

    const opts = await buildOptions();
    if (opts.useAI) log(`AI enrichment ON · ${opts.model}`);

    let last = "";
    pollHandle = setInterval(async () => {
      try {
        const p = await runInTab(tab.id, () => window.__BIT_TNP_GET_PROGRESS__?.() || "");
        if (p && p !== last) { last = p; log(p); }
      } catch {}
    }, 700);

    const result = await runInTab(
      tab.id, (options) => window.__BIT_TNP_SCRAPE__(options), [opts]
    );
    clearInterval(pollHandle); pollHandle = null;

    if (!result) { log("ERROR: scraper returned nothing."); return; }
    if (result.error) { log("ERROR: " + result.error); return; }

    log(`Total on portal: ${result.rawCount}`);
    log(`Detail pages fetched: ${result.detailFetched}`);
    log(`After branch filter: ${result.afterBranch}`);

    const stamp = Date.now();
    let rows = result.rows;
    const beforeRange = rows.length;
    rows = filterByCTCRange(rows, opts.minCTC, opts.maxCTC);
    if (opts.minCTC != null || opts.maxCTC != null) {
      log(`CTC range: ${beforeRange} → ${rows.length}`);
    }

    await chrome.storage.local.set({
      lastScrape: {
        timestamp: stamp,
        rows,
        options: { branches: opts.branches, ctc: { min: opts.minCTC, max: opts.maxCTC } },
        stats: {
          rawCount: result.rawCount,
          detailFetched: result.detailFetched,
          afterBranch: result.afterBranch,
        },
      },
    });

    log(`✓ ${rows.length} companies saved. Click "Open Viewer ↗" to explore + download.`);
    const btn = document.getElementById("viewerBtn");
    btn.disabled = false;
    btn.textContent = `📊 Open Viewer (${rows.length}) ↗`;
  } catch (e) {
    log("ERROR: " + e.message);
    console.error(e);
  } finally {
    if (pollHandle) clearInterval(pollHandle);
    scrapeBtn.disabled = false;
  }
});
