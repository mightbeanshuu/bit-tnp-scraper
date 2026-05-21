// BIT TNP Scraper — popup script
// Drives the content script and converts returned rows to CSV / XLSX / PDF.

const COLUMNS = [
  ["Company", "company"],
  ["Type", "type"],
  ["Designation", "designation"],
  ["AI Summary", "jdSummary"],
  ["Job Description", "jobDescription"],
  ["Place of Posting", "placeOfPosting"],
  ["Eligible Courses", "courses"],
  ["UG Criteria", "criteriaUG"],
  ["PG Criteria", "criteriaPG"],
  ["Stipend UG (₹/mo)", "stipendUG"],
  ["Stipend PG (₹/mo)", "stipendPG"],
  ["Base Pay", "basePay"],
  ["CTC", "ctc"],
  ["Final Selected (count)", "selectedCount"],
  ["Final Selected (by branch)", "selectedByBranch"],
  ["Final Selected (names)", "selectedList"],
  ["Deadline", "deadline"],
  ["Posted On", "postedOn"],
  ["Company URL", "companyURL"],
  ["Detail Page", "viewApplyUrl"],
  ["Updates Page", "updatesUrl"],
];

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
      AIML: document.getElementById("branchAIML").checked,
      ECE: document.getElementById("branchECE").checked,
    },
    fetchResults: document.getElementById("fetchResults").checked,
    format: document.getElementById("format").value,
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
    const v = r._comp;
    if (v == null || v === Infinity) return false;
    if (minR != null && v < minR) return false;
    if (maxR != null && v > maxR) return false;
    return true;
  });
}

(async () => {
  const { groqApiKey } = await chrome.storage.local.get("groqApiKey");
  const aiStatus = document.getElementById("aiStatus");
  if (groqApiKey) {
    aiStatus.textContent = "(key set)";
    aiStatus.style.color = "#137333";
  } else {
    aiStatus.textContent = "(no key — open Settings)";
    aiStatus.style.color = "#c5221f";
  }
})();

document.getElementById("settingsBtn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("viewerBtn").addEventListener("click", async () => {
  const url = chrome.runtime.getURL("viewer.html");
  await chrome.tabs.create({ url });
});

(async () => {
  const { lastScrape } = await chrome.storage.local.get("lastScrape");
  const btn = document.getElementById("viewerBtn");
  if (lastScrape?.rows?.length) {
    btn.textContent = `Open Viewer (${lastScrape.rows.length} companies) ↗`;
  } else {
    btn.textContent = "Open Viewer (no data yet)";
    btn.disabled = true;
    btn.style.opacity = "0.55";
  }
})();

// ---------- CSV ----------
function csvEscape(s) {
  if (s == null) return "";
  const str = String(s).replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  if (/[",]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function toCSV(rows) {
  const lines = [COLUMNS.map(([h]) => csvEscape(h)).join(",")];
  for (const r of rows) {
    lines.push(COLUMNS.map(([, k]) => csvEscape(r[k] ?? "")).join(","));
  }
  return lines.join("\n");
}

// ---------- HTML for PDF ----------
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// PDF uses a compact subset — only what matters at a glance.
function payDisplay(r) {
  if (r.ctc) return r.ctc;
  if (r.basePay) return r.basePay;
  if (r.stipendUG) return `₹${r.stipendUG}/mo`;
  return "—";
}

function selectedDisplay(r) {
  if (!r.selectedCount) return "—";
  return `${r.selectedCount} (${r.selectedByBranch || "—"})`;
}

const PDF_COLUMNS = [
  ["Company", (r) => r.company],
  ["Type", (r) => r.type || "—"],
  ["Role", (r) => r.designation || "—"],
  ["Summary", (r) => r.jdSummary || ""],
  ["Eligible", (r) => r.courses || "—"],
  ["CGPA", (r) => r.criteriaUG || "—"],
  ["Pay", (r) => payDisplay(r)],
  ["Selected", (r) => selectedDisplay(r)],
  ["Deadline", (r) => r.deadline || ""],
];

function toHTML(rows) {
  const head = PDF_COLUMNS.map(([h]) => `<th>${escapeHtml(h)}</th>`).join("");
  const body = rows
    .map((r) => `<tr>${PDF_COLUMNS.map(([, fn]) => `<td>${escapeHtml(fn(r) ?? "")}</td>`).join("")}</tr>`)
    .join("");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>BIT TNP — Placement Report</title>
<style>
  @page { size: A4 landscape; margin: 10mm; }
  body { font-family: -apple-system, sans-serif; font-size: 9.5px; margin: 0; padding: 12px; color: #222; }
  h1 { font-size: 17px; margin: 0 0 2px; background: linear-gradient(90deg,#5a1eb4,#f03c82,#ffb432); -webkit-background-clip: text; -webkit-text-fill-color: transparent; font-weight: 800; }
  .meta { font-size: 10px; color: #555; margin-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #bbb; padding: 4px 6px; vertical-align: top; text-align: left; }
  th { background: #5a1eb4; color: white; font-weight: 600; font-size: 10px; }
  tr:nth-child(even) td { background: #faf7ff; }
  td.company { font-weight: 600; white-space: nowrap; }
  td.pay { font-weight: 600; color: #137333; white-space: nowrap; }
  td.deadline { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .footer { margin-top: 14px; font-size: 9px; color: #888; }
</style></head>
<body>
  <h1>BIT Mesra TNP — Filtered Placement Report</h1>
  <div class="meta">Generated ${new Date().toLocaleString()} · ${rows.length} companies · Sorted ascending by compensation</div>
  <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
  <div class="footer">Use Cmd/Ctrl+P → Save as PDF if the print dialog did not open automatically.</div>
  <script>window.addEventListener("load", () => setTimeout(() => window.print(), 400));<\/script>
</body></html>`;
}

// ---------- XLSX (true .xlsx via minimal inline ZIP writer) ----------

// CRC32 — polynomial 0xedb88320, table-less
function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crc ^ bytes[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Build a ZIP archive (STORE method, no compression) from a list of files.
function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const { name, content } of files) {
    const nameBytes = enc.encode(name);
    const crc = crc32(content);
    const size = content.length;

    const lh = new Uint8Array(30 + nameBytes.length);
    const lhDV = new DataView(lh.buffer);
    lhDV.setUint32(0, 0x04034b50, true);
    lhDV.setUint16(4, 20, true);
    lhDV.setUint16(6, 0, true);
    lhDV.setUint16(8, 0, true); // STORE
    lhDV.setUint16(10, 0, true);
    lhDV.setUint16(12, 0, true);
    lhDV.setUint32(14, crc, true);
    lhDV.setUint32(18, size, true);
    lhDV.setUint32(22, size, true);
    lhDV.setUint16(26, nameBytes.length, true);
    lhDV.setUint16(28, 0, true);
    lh.set(nameBytes, 30);
    parts.push(lh, content);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cdDV = new DataView(cd.buffer);
    cdDV.setUint32(0, 0x02014b50, true);
    cdDV.setUint16(4, 20, true);
    cdDV.setUint16(6, 20, true);
    cdDV.setUint16(8, 0, true);
    cdDV.setUint16(10, 0, true);
    cdDV.setUint16(12, 0, true);
    cdDV.setUint16(14, 0, true);
    cdDV.setUint32(16, crc, true);
    cdDV.setUint32(20, size, true);
    cdDV.setUint32(24, size, true);
    cdDV.setUint16(28, nameBytes.length, true);
    cdDV.setUint16(30, 0, true);
    cdDV.setUint16(32, 0, true);
    cdDV.setUint16(34, 0, true);
    cdDV.setUint16(36, 0, true);
    cdDV.setUint32(38, 0, true);
    cdDV.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += lh.length + content.length;
  }

  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const centralOffset = offset;

  const eocd = new Uint8Array(22);
  const eocdDV = new DataView(eocd.buffer);
  eocdDV.setUint32(0, 0x06054b50, true);
  eocdDV.setUint16(4, 0, true);
  eocdDV.setUint16(6, 0, true);
  eocdDV.setUint16(8, files.length, true);
  eocdDV.setUint16(10, files.length, true);
  eocdDV.setUint32(12, centralSize, true);
  eocdDV.setUint32(16, centralOffset, true);
  eocdDV.setUint16(20, 0, true);

  const all = [...parts, ...central, eocd];
  const totalSize = all.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(totalSize);
  let p = 0;
  for (const part of all) { out.set(part, p); p += part.length; }
  return out;
}

function xmlEscape(s) {
  return String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);
}

function colLetter(idx) {
  let s = "", n = idx;
  while (true) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return s;
}

function toXLSX(rows) {
  const headers = COLUMNS.map(([h]) => h);
  const sst = []; const sstIdx = new Map();
  function s(v) {
    const str = String(v ?? "");
    if (!sstIdx.has(str)) { sstIdx.set(str, sst.length); sst.push(str); }
    return sstIdx.get(str);
  }

  const xmlRows = [];
  xmlRows.push(`<row r="1">${headers.map((h, i) => `<c r="${colLetter(i)}1" t="s"><v>${s(h)}</v></c>`).join("")}</row>`);
  rows.forEach((row, ri) => {
    const r = ri + 2;
    const cells = COLUMNS.map(([, k], i) => {
      const val = row[k];
      if (val === "" || val == null) return "";
      return `<c r="${colLetter(i)}${r}" t="s"><v>${s(val)}</v></c>`;
    }).join("");
    xmlRows.push(`<row r="${r}">${cells}</row>`);
  });

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${xmlRows.join("")}</sheetData></worksheet>`;

  const sstXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.length}" uniqueCount="${sst.length}">${
    sst.map((v) => `<si><t xml:space="preserve">${xmlEscape(v)}</t></si>`).join("")
  }</sst>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="BIT TNP" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;

  const enc = new TextEncoder();
  return makeZip([
    { name: "[Content_Types].xml", content: enc.encode(contentTypes) },
    { name: "_rels/.rels", content: enc.encode(rootRels) },
    { name: "xl/workbook.xml", content: enc.encode(workbookXml) },
    { name: "xl/_rels/workbook.xml.rels", content: enc.encode(workbookRels) },
    { name: "xl/worksheets/sheet1.xml", content: enc.encode(sheetXml) },
    { name: "xl/sharedStrings.xml", content: enc.encode(sstXml) },
  ]);
}

// ---------- Download / open helpers ----------
async function downloadBlob(blob, filename, saveAs = true) {
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({ url, filename, saveAs });
}

async function openHtmlInNewTab(html) {
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  await chrome.tabs.create({ url });
}

// ---------- Scrape flow ----------
scrapeBtn.addEventListener("click", async () => {
  scrapeBtn.disabled = true;
  statusEl.textContent = "";
  log("Starting...");
  let pollHandle = null;
  try {
    const tab = await getActiveTab();
    if (!tab?.url?.includes("bitmesra")) log("Warning: active tab is not bitmesra. Continuing.");
    await injectContent(tab.id);

    const opts = await buildOptions();
    if (opts.useAI) log("AI enrichment: ON (Groq " + opts.model + ")");
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

    log(`Total companies on portal: ${result.rawCount}`);
    log(`Detail pages fetched: ${result.detailFetched}`);
    log(`After branch filter: ${result.afterBranch}`);
    log(`Format: ${opts.format}`);

    const stamp = Date.now();
    let rows = result.rows;
    const beforeRange = rows.length;
    rows = filterByCTCRange(rows, opts.minCTC, opts.maxCTC);
    if (opts.minCTC != null || opts.maxCTC != null) {
      log(`CTC range filter: ${beforeRange} → ${rows.length} (min=${opts.minCTC ?? "any"} LPA, max=${opts.maxCTC ?? "any"} LPA)`);
    }

    // Persist for the Viewer page.
    try {
      await chrome.storage.local.set({
        lastScrape: {
          timestamp: stamp,
          rows,
          options: { branches: opts.branches },
          stats: {
            rawCount: result.rawCount,
            detailFetched: result.detailFetched,
            afterBranch: result.afterBranch,
          },
        },
      });
      log(`Saved ${rows.length} rows for the Viewer.`);
    } catch (e) {
      log("Could not persist for Viewer: " + e.message);
    }
    if (opts.format === "csv") {
      const blob = new Blob([toCSV(rows)], { type: "text/csv" });
      await downloadBlob(blob, `bit-tnp-${stamp}.csv`);
    } else if (opts.format === "xlsx") {
      const bytes = toXLSX(rows);
      const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      await downloadBlob(blob, `bit-tnp-${stamp}.xlsx`);
    } else if (opts.format === "pdf") {
      log("Opening print-ready report in a new tab. Use the print dialog to Save as PDF.");
      await openHtmlInNewTab(toHTML(rows));
    }
    log("Done.");
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
