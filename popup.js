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
  const [r] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  return r.result;
}

function buildOptions() {
  return {
    branches: {
      CSE: document.getElementById("branchCSE").checked,
      AIML: document.getElementById("branchAIML").checked,
      ECE: document.getElementById("branchECE").checked,
    },
  };
}

async function injectContent(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
}

scrapeBtn.addEventListener("click", async () => {
  scrapeBtn.disabled = true;
  statusEl.textContent = "";
  log("Starting scrape...");
  let pollHandle = null;
  try {
    const tab = await getActiveTab();
    if (!tab?.url?.includes("bitmesra")) {
      log("Warning: active tab is not a bitmesra URL. Continuing.");
    }
    await injectContent(tab.id);

    const opts = buildOptions();

    // Poll for progress while scrape runs.
    let lastProgress = "";
    pollHandle = setInterval(async () => {
      try {
        const p = await runInTab(tab.id, () => window.__BIT_TNP_GET_PROGRESS__?.() || "");
        if (p && p !== lastProgress) {
          lastProgress = p;
          log(p);
        }
      } catch {
        // ignore poll errors
      }
    }, 600);

    const result = await runInTab(
      tab.id,
      (options) => window.__BIT_TNP_SCRAPE__(options),
      [opts]
    );

    clearInterval(pollHandle);
    pollHandle = null;

    if (!result) {
      log("ERROR: scraper returned nothing.");
      return;
    }
    if (result.error) {
      log("ERROR: " + result.error);
      return;
    }

    log(`Dashboard rows: ${result.rawCount}`);
    log(`Detail pages fetched: ${result.detailFetched}`);
    log(`After branch filter: ${result.afterBranch}`);
    log("Triggering CSV download...");

    const blob = new Blob([result.csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    await chrome.downloads.download({
      url,
      filename: `bit-tnp-${Date.now()}.csv`,
      saveAs: true,
    });
  } catch (e) {
    log("ERROR: " + e.message);
    console.error(e);
  } finally {
    if (pollHandle) clearInterval(pollHandle);
    scrapeBtn.disabled = false;
  }
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
