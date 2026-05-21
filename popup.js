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

async function runInTab(tabId, func, args) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  return result.result;
}

function buildOptions() {
  return {
    yearFilter: document.getElementById("yearFilter").value.trim(),
    branches: {
      CSE: document.getElementById("branchCSE").checked,
      AIML: document.getElementById("branchAIML").checked,
      ECE: document.getElementById("branchECE").checked,
    },
  };
}

scrapeBtn.addEventListener("click", async () => {
  scrapeBtn.disabled = true;
  log("Scraping...");
  try {
    const tab = await getActiveTab();
    if (!tab?.url?.includes("bitmesra")) {
      log("WARN: active tab is not a bitmesra URL. Continuing anyway.");
    }

    // Inject the scraper and run it.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });

    const opts = buildOptions();
    const result = await runInTab(tab.id, (options) => window.__BIT_TNP_SCRAPE__(options), [opts]);

    if (!result) {
      log("ERROR: scraper returned nothing. Try the Inspect button.");
      return;
    }

    log(`Found ${result.rawCount} rows on page.`);
    log(`After year filter (${opts.yearFilter}): ${result.afterYear} rows.`);
    log(`After branch filter (${Object.keys(opts.branches).filter(k => opts.branches[k]).join("/")}): ${result.afterBranch} rows.`);
    log(`Sorted by CTC ascending. Triggering CSV download.`);

    // Trigger CSV download via background.
    const blob = new Blob([result.csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    await chrome.downloads.download({
      url,
      filename: `bit-tnp-${opts.yearFilter}-${Date.now()}.csv`,
      saveAs: true,
    });
  } catch (e) {
    log("ERROR: " + e.message);
    console.error(e);
  } finally {
    scrapeBtn.disabled = false;
  }
});

inspectBtn.addEventListener("click", async () => {
  try {
    const tab = await getActiveTab();
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
    const report = await runInTab(tab.id, () => window.__BIT_TNP_INSPECT__());
    log(report);
  } catch (e) {
    log("ERROR: " + e.message);
  }
});
