let allRows = [];
let maxLPA = 100;

const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function compValue(r) {
  return (typeof r.annualCTC === "number" && isFinite(r.annualCTC)) ? r.annualCTC : null;
}

function compInLPA(r) {
  const v = compValue(r);
  return v == null ? null : v / 100000;
}

function payDisplay(r) {
  // Show the source format the company posted, with the computed annual in parens
  // when source was a monthly stipend (so users can compare apples-to-apples).
  if (r.ctc) return r.ctc;
  if (r.basePay) return r.basePay;
  if (r.stipendUG) return `₹${r.stipendUG}/mo  ·  ${r.annualCTCDisplay || ""}`.trim();
  return "—";
}

function deriveBranchSet(rows) {
  const set = new Set();
  rows.forEach((r) => {
    (r.courses || "").split(",").forEach((s) => {
      const t = s.trim();
      if (t) set.add(t);
    });
  });
  return [...set];
}

(async () => {
  const data = await chrome.storage.local.get(["lastScrape"]);
  const last = data.lastScrape;
  if (!last || !last.rows || !last.rows.length) {
    document.getElementById("cards").innerHTML =
      `<div class="empty">No scrape data found yet.<br/>Open the extension popup, run a scrape, then click "Open Viewer".</div>`;
    return;
  }
  allRows = last.rows;
  $("stamp").textContent = `Scraped ${new Date(last.timestamp).toLocaleString()}`;
  const branches = last.options?.branches || {};
  const enabled = Object.entries(branches).filter(([, v]) => v).map(([k]) => k);
  $("branchPill").textContent = enabled.length ? `Branches: ${enabled.join(" / ")}` : "All branches";

  initSlider();
  bindEvents();
  render();
})();

function initSlider() {
  const valid = allRows.map(compInLPA).filter((v) => v != null);
  maxLPA = valid.length ? Math.max(...valid) : 100;
  maxLPA = Math.ceil(maxLPA);
  $("minRange").max = maxLPA;
  $("maxRange").max = maxLPA;
  $("minRange").value = 0;
  $("maxRange").value = maxLPA;
  updateSliderUI();
}

function updateSliderUI() {
  const min = parseFloat($("minRange").value);
  const max = parseFloat($("maxRange").value);
  $("rangeDisplay").textContent = `₹${min} LPA – ₹${max} LPA`;
  const leftPct = (min / maxLPA) * 100;
  const rightPct = 100 - (max / maxLPA) * 100;
  $("active").style.left = leftPct + "%";
  $("active").style.right = rightPct + "%";
}

function bindEvents() {
  $("minRange").addEventListener("input", () => {
    let min = parseFloat($("minRange").value);
    const max = parseFloat($("maxRange").value);
    if (min > max) { $("minRange").value = max; min = max; }
    updateSliderUI();
    render();
  });
  $("maxRange").addEventListener("input", () => {
    const min = parseFloat($("minRange").value);
    let max = parseFloat($("maxRange").value);
    if (max < min) { $("maxRange").value = min; max = min; }
    updateSliderUI();
    render();
  });
  $("search").addEventListener("input", render);
  $("sort").addEventListener("change", render);

  document.addEventListener("click", (e) => {
    if (e.target.closest("a")) return; // links don't toggle
    const card = e.target.closest(".card");
    if (!card) return;
    card.classList.toggle("expanded");
  });
}

function applyFilters(rows) {
  const min = parseFloat($("minRange").value);
  const max = parseFloat($("maxRange").value);
  const q = $("search").value.trim().toLowerCase();
  return rows.filter((r) => {
    const lpa = compInLPA(r);
    // Keep unknown-pay rows when min is 0 (no lower bound).
    if (lpa == null) {
      if (min > 0) return false;
    } else {
      if (lpa < min || lpa > max) return false;
    }
    if (q) {
      const hay = [
        r.company, r.designation, r.placeOfPosting,
        r.courses, r.jdSummary, r.jobDescription,
      ].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function applySort(rows) {
  const mode = $("sort").value;
  const arr = rows.slice();
  if (mode === "ctc-asc") arr.sort((a, b) => (compValue(a) || 0) - (compValue(b) || 0));
  else if (mode === "ctc-desc") arr.sort((a, b) => (compValue(b) || 0) - (compValue(a) || 0));
  else if (mode === "selected-desc") arr.sort((a, b) => (b.selectedCount || 0) - (a.selectedCount || 0));
  else if (mode === "deadline") arr.sort((a, b) => parseDeadline(a.deadline) - parseDeadline(b.deadline));
  else if (mode === "company-asc") arr.sort((a, b) => (a.company || "").localeCompare(b.company || ""));
  return arr;
}

function parseDeadline(s) {
  if (!s) return Infinity;
  // Handle dd/mm/yyyy or dd-mm-yyyy
  const m = String(s).match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (!m) return Infinity;
  let [, d, mo, y] = m;
  if (y.length === 2) y = "20" + y;
  return new Date(`${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`).getTime() || Infinity;
}

function cardHTML(r) {
  const pay = payDisplay(r);
  const courses = (r.courses || "").split(",").map((s) => s.trim()).filter(Boolean);
  const summary = r.jdSummary || (r.jobDescription || "").slice(0, 200);
  const subline = [r.designation, r.placeOfPosting].filter(Boolean).join(" · ");

  const badges = [];
  if (r.type) badges.push(`<span class="badge type">${escapeHtml(r.type)}</span>`);
  if (r.criteriaUG && /\d/.test(r.criteriaUG)) badges.push(`<span class="badge cgpa">${escapeHtml(r.criteriaUG)}</span>`);
  if (r.selectedCount) badges.push(`<span class="badge selected">✓ ${r.selectedCount} selected</span>`);
  courses.slice(0, 4).forEach((c) => badges.push(`<span class="badge">${escapeHtml(c)}</span>`));
  if (courses.length > 4) badges.push(`<span class="badge">+${courses.length - 4} more</span>`);

  // Build selected candidates grid
  let selectedGrid = "";
  if (r.selectedList) {
    const items = r.selectedList.split(";").map((s) => s.trim()).filter(Boolean);
    selectedGrid = `<div class="selected-grid">${items.map((it) => `<div>• ${escapeHtml(it)}</div>`).join("")}</div>`;
  }

  return `<div class="card">
    <div class="card-head">
      <span class="name">${escapeHtml(r.company)}</span>
      <span class="pay">${escapeHtml(pay)}</span>
    </div>
    ${subline ? `<div class="card-sub">${escapeHtml(subline)}</div>` : ""}
    <div class="badges">${badges.join("")}</div>
    ${summary ? `<div class="summary">${escapeHtml(summary)}</div>` : ""}
    <div class="toggle-hint">Click for full details ↓</div>

    <div class="details">
      ${r.jobDescription ? `<h4>Full Job Description</h4><div class="body">${escapeHtml(r.jobDescription)}</div>` : ""}
      ${r.stipendUG || r.stipendPG || r.basePay || r.ctc ? `
        <h4>Compensation breakdown</h4>
        <div class="body">${[
          r.ctc ? `CTC: ${escapeHtml(r.ctc)}` : "",
          r.basePay ? `Base Pay: ${escapeHtml(r.basePay)}` : "",
          r.stipendUG ? `Stipend UG: ₹${escapeHtml(r.stipendUG)}/mo` : "",
          r.stipendPG ? `Stipend PG: ₹${escapeHtml(r.stipendPG)}/mo` : "",
        ].filter(Boolean).join(" · ")}</div>` : ""}
      ${r.criteriaUG || r.criteriaPG ? `
        <h4>Eligibility criteria</h4>
        <div class="body">${[
          r.criteriaUG ? `UG: ${escapeHtml(r.criteriaUG)}` : "",
          r.criteriaPG ? `PG: ${escapeHtml(r.criteriaPG)}` : "",
        ].filter(Boolean).join("<br/>")}</div>` : ""}
      ${r.selectedCount ? `
        <h4>Selected candidates (${r.selectedCount})</h4>
        <div class="branch-tally">${(r.selectedByBranch || "").split(",").filter(Boolean)
          .map((s) => `<span class="b">${escapeHtml(s.trim())}</span>`).join("")}</div>
        ${selectedGrid}` : ""}
      <h4>Links</h4>
      <div class="body">
        ${r.viewApplyUrl ? `<a href="${escapeHtml(r.viewApplyUrl)}" target="_blank">View posting (apply page) ↗</a><br/>` : ""}
        ${r.updatesUrl ? `<a href="${escapeHtml(r.updatesUrl)}" target="_blank">Updates / Notifications ↗</a><br/>` : ""}
        ${r.companyURL ? `<a href="${escapeHtml(/^https?:/i.test(r.companyURL) ? r.companyURL : "https://" + r.companyURL)}" target="_blank">Company website ↗</a>` : ""}
      </div>
    </div>
  </div>`;
}

let lastFiltered = [];

function render() {
  lastFiltered = applySort(applyFilters(allRows));
  $("counter").textContent = `${lastFiltered.length} of ${allRows.length}`;
  renderInsightsRow(lastFiltered);
  renderCharts(lastFiltered);
  const main = $("cards");
  if (lastFiltered.length === 0) {
    main.innerHTML = `<div class="empty">No companies match the current filters. Try widening the CTC range or clearing the search.</div>`;
    return;
  }
  main.innerHTML = lastFiltered.map(cardHTML).join("");
}

// ============== Stats + AI Insights ==============

function computeStats(rows) {
  const total = rows.length;
  const ctcs = rows.map((r) => r.annualCTC).filter((v) => typeof v === "number" && v > 0).sort((a, b) => a - b);
  const avg = ctcs.length ? ctcs.reduce((s, v) => s + v, 0) / ctcs.length : null;
  const median = ctcs.length ? ctcs[Math.floor(ctcs.length / 2)] : null;
  const topPay = rows.slice().sort((a, b) => (b.annualCTC || 0) - (a.annualCTC || 0))[0] || null;

  const branchTally = {};
  let totalSelected = 0;
  rows.forEach((r) => {
    if (r.selectedCount) totalSelected += r.selectedCount;
    (r.selectedByBranch || "").split(",").forEach((s) => {
      const m = s.trim().match(/^(.+):\s*(\d+)$/);
      if (m) branchTally[m[1].trim()] = (branchTally[m[1].trim()] || 0) + parseInt(m[2]);
    });
  });
  const topBranches = Object.entries(branchTally).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const mostHires = rows.slice().sort((a, b) => (b.selectedCount || 0) - (a.selectedCount || 0))[0] || null;

  return { total, avg, median, topPay, totalSelected, topBranches, mostHires };
}

// ============== Charts ==============
const CHART_COLORS = [
  "#5a1eb4", "#f03c82", "#ffb432", "#1a73e8", "#137333",
  "#c4365e", "#8a6d00", "#2d8e7f", "#7c52d8", "#e85d04",
];

function pieSVG(items, size = 160) {
  const total = items.reduce((s, i) => s + i.value, 0);
  if (total === 0) return null;
  const r = size / 2 - 4;
  const cx = size / 2, cy = size / 2;
  let angle = -Math.PI / 2;
  const paths = items.map((it, idx) => {
    const fraction = it.value / total;
    if (fraction <= 0) return "";
    const color = it.color || CHART_COLORS[idx % CHART_COLORS.length];
    if (fraction >= 0.9999) {
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" />`;
    }
    const sweep = fraction * 2 * Math.PI;
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    angle += sweep;
    const x2 = cx + r * Math.cos(angle);
    const y2 = cy + r * Math.sin(angle);
    const large = sweep > Math.PI ? 1 : 0;
    return `<path d="M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${color}" />`;
  }).join("");
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${paths}<circle cx="${cx}" cy="${cy}" r="${r * 0.4}" fill="white"/><text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="14" font-weight="800" fill="#5a1eb4">${total}</text></svg>`;
}

function legendHTML(items) {
  return `<div class="chart-legend">${items.map((it, idx) => `
    <div class="li"><span class="sw" style="background:${it.color || CHART_COLORS[idx % CHART_COLORS.length]}"></span><span class="lbl">${escapeHtml(it.label)}</span><span class="v">${it.value}</span></div>
  `).join("")}</div>`;
}

function barChartSVG(items, w = 360, h = 200) {
  if (items.length === 0 || items.every((i) => i.value === 0)) return null;
  const max = Math.max(...items.map((i) => i.value)) || 1;
  const padL = 24, padR = 8, padT = 18, padB = 32;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;
  const gap = 8;
  const barW = Math.max(8, (chartW - gap * (items.length - 1)) / items.length);
  const bars = items.map((it, idx) => {
    const x = padL + idx * (barW + gap);
    const barH = (it.value / max) * chartH;
    const y = padT + chartH - barH;
    return `
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(2, barH).toFixed(1)}" fill="url(#barGrad)" rx="5"/>
      <text x="${(x + barW / 2).toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle" font-size="11" fill="#3a3a44" font-weight="700">${it.value}</text>
      <text x="${(x + barW / 2).toFixed(1)}" y="${(padT + chartH + 18).toFixed(1)}" text-anchor="middle" font-size="10" fill="#6c6a78">${escapeHtml(it.label)}</text>
    `;
  }).join("");
  return `<svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
    <defs>
      <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#5a1eb4"/>
        <stop offset="60%" stop-color="#f03c82"/>
        <stop offset="100%" stop-color="#ffb432"/>
      </linearGradient>
    </defs>
    <line x1="${padL}" y1="${padT + chartH}" x2="${padL + chartW}" y2="${padT + chartH}" stroke="#e8e3f3"/>
    ${bars}
  </svg>`;
}

function buildCTCBuckets(rows) {
  const bs = [
    { label: "<3L", min: 0, max: 3 },
    { label: "3-6L", min: 3, max: 6 },
    { label: "6-10L", min: 6, max: 10 },
    { label: "10-20L", min: 10, max: 20 },
    { label: "20-40L", min: 20, max: 40 },
    { label: "40L+", min: 40, max: Infinity },
  ];
  return bs.map((b) => ({
    label: b.label,
    value: rows.filter((r) => {
      const lpa = r.annualCTC ? r.annualCTC / 100000 : null;
      return lpa != null && lpa >= b.min && lpa < b.max;
    }).length,
  }));
}

function buildBranchPie(rows) {
  const tally = {};
  rows.forEach((r) => {
    (r.selectedByBranch || "").split(",").forEach((s) => {
      const m = s.trim().match(/^(.+):\s*(\d+)$/);
      if (!m) return;
      const key = m[1].trim().slice(0, 18);
      tally[key] = (tally[key] || 0) + parseInt(m[2]);
    });
  });
  return Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7)
    .map(([label, value]) => ({ label, value }));
}

function renderCharts(rows) {
  const bars = buildCTCBuckets(rows);
  const pie = buildBranchPie(rows);
  const barEl = $("ctcBarChart");
  const pieEl = $("branchPieChart");
  const barSvg = barChartSVG(bars);
  barEl.innerHTML = barSvg || `<div class="chart-empty">No CTC data in the current filter</div>`;
  if (pie.length === 0) {
    pieEl.innerHTML = `<div class="chart-empty">No selected-candidate data yet. Run a scrape with "Include final-round selected candidates" enabled.</div>`;
  } else {
    const svg = pieSVG(pie);
    pieEl.innerHTML = (svg || "") + legendHTML(pie);
  }
}

function renderInsightsRow(rows) {
  const s = computeStats(rows);
  const tile = (label, value, extra = "") => `
    <div class="stat">
      <div class="label">${label}</div>
      <div class="value">${value}</div>
      ${extra ? `<div class="extra">${extra}</div>` : ""}
    </div>`;
  const lpa = (v) => v == null ? "—" : `₹${(v / 100000).toFixed(2)} LPA`;
  const branchesStr = s.topBranches.length
    ? s.topBranches.map(([b, n]) => `${b.split(/[\s/]/)[0]}: ${n}`).join(" · ")
    : "—";

  $("insightsRow").innerHTML = [
    tile("Companies", String(s.total)),
    tile("Avg CTC", lpa(s.avg), s.median != null ? `median ${lpa(s.median)}` : ""),
    tile("Highest paying", s.topPay ? escapeHtml(s.topPay.company) : "—", s.topPay?.annualCTC != null ? lpa(s.topPay.annualCTC) : ""),
    tile("Total final selects", String(s.totalSelected), s.mostHires?.selectedCount ? `${escapeHtml(s.mostHires.company)} took ${s.mostHires.selectedCount}` : ""),
    tile("Top branches", branchesStr.length > 40 ? branchesStr.slice(0, 40) + "…" : branchesStr),
  ].join("");
}

function buildSummaryForLLM(rows) {
  const s = computeStats(rows);
  const lpa = (v) => v == null ? "n/a" : `₹${(v / 100000).toFixed(2)}L`;
  const topN = rows.slice().sort((a, b) => (b.annualCTC || 0) - (a.annualCTC || 0)).slice(0, 8);
  const topPayList = topN.map((r) => `- ${r.company} · ${lpa(r.annualCTC)} · ${r.type || ""} · ${r.designation || ""}`).join("\n");
  const mostList = rows.slice().sort((a, b) => (b.selectedCount || 0) - (a.selectedCount || 0))
    .filter((r) => r.selectedCount).slice(0, 6)
    .map((r) => `- ${r.company} · ${r.selectedCount} selected · ${r.selectedByBranch || ""}`).join("\n");

  return [
    `Total companies in current view: ${s.total}.`,
    `Average annual CTC: ${lpa(s.avg)}; median ${lpa(s.median)}.`,
    `Total final selects: ${s.totalSelected}.`,
    `Top-paying companies:\n${topPayList || "—"}`,
    `Companies with the most final selects:\n${mostList || "—"}`,
    `Branch-wise selection counts: ${s.topBranches.map(([b, n]) => `${b} ${n}`).join("; ") || "—"}.`,
  ].join("\n\n");
}

async function generateAIInsights() {
  const btn = $("genInsightsBtn");
  const out = $("aiContent");
  const { groqApiKey, groqModel } = await chrome.storage.local.get(["groqApiKey", "groqModel"]);
  if (!groqApiKey) {
    out.classList.remove("empty");
    out.textContent = "No Groq key set. Open the extension popup → Settings → paste a key, then retry.";
    return;
  }
  btn.disabled = true;
  btn.textContent = "Thinking…";
  out.classList.remove("empty");
  out.innerHTML = '<span class="ai-loading">Talking to Groq…</span>';

  try {
    const summary = buildSummaryForLLM(lastFiltered);
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + groqApiKey },
      body: JSON.stringify({
        model: groqModel || "llama-3.1-8b-instant",
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content: "You are a placement analyst for BIT Mesra students. Given a dataset summary, write a tight 4-6 bullet analysis: standouts in compensation, hiring leaders, branch-wise observations, and one actionable suggestion for a student exploring this list. Use Indian rupee notation (LPA / Lakh). Plain text, no markdown headers, just bullets starting with '•'.",
          },
          { role: "user", content: summary },
        ],
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || "(empty response)";
    out.textContent = text;
  } catch (e) {
    out.textContent = "Error: " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Regenerate";
  }
}

document.getElementById("genInsightsBtn").addEventListener("click", generateAIInsights);

// ============== Export — CSV / XLSX / PDF ==============

const EXPORT_COLUMNS = [
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
  ["Annual CTC (₹)", "annualCTC"],
  ["Annual CTC (display)", "annualCTCDisplay"],
  ["CTC Source", "compSource"],
  ["Final Selected (count)", "selectedCount"],
  ["Final Selected (by branch)", "selectedByBranch"],
  ["Final Selected (names)", "selectedList"],
  ["Deadline", "deadline"],
  ["Posted On", "postedOn"],
  ["Company URL", "companyURL"],
  ["Detail Page", "viewApplyUrl"],
  ["Updates Page", "updatesUrl"],
];

function csvEscape(s) {
  if (s == null) return "";
  const str = String(s).replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  return /[",]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}
function toCSV(rows) {
  const lines = [EXPORT_COLUMNS.map(([h]) => csvEscape(h)).join(",")];
  for (const r of rows) lines.push(EXPORT_COLUMNS.map(([, k]) => csvEscape(r[k] ?? "")).join(","));
  return lines.join("\n");
}

function xmlEscape(s) {
  return String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);
}
function colLetter(idx) {
  let s = "", n = idx;
  while (true) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; if (n < 0) break; }
  return s;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crc ^ bytes[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makeZip(files) {
  const enc = new TextEncoder();
  const parts = []; const central = []; let offset = 0;
  for (const { name, content } of files) {
    const nameBytes = enc.encode(name);
    const crc = crc32(content); const size = content.length;
    const lh = new Uint8Array(30 + nameBytes.length);
    const lhDV = new DataView(lh.buffer);
    lhDV.setUint32(0, 0x04034b50, true); lhDV.setUint16(4, 20, true);
    lhDV.setUint16(6, 0, true); lhDV.setUint16(8, 0, true);
    lhDV.setUint16(10, 0, true); lhDV.setUint16(12, 0, true);
    lhDV.setUint32(14, crc, true); lhDV.setUint32(18, size, true);
    lhDV.setUint32(22, size, true); lhDV.setUint16(26, nameBytes.length, true);
    lhDV.setUint16(28, 0, true); lh.set(nameBytes, 30);
    parts.push(lh, content);
    const cd = new Uint8Array(46 + nameBytes.length);
    const cdDV = new DataView(cd.buffer);
    cdDV.setUint32(0, 0x02014b50, true); cdDV.setUint16(4, 20, true);
    cdDV.setUint16(6, 20, true); cdDV.setUint16(8, 0, true);
    cdDV.setUint16(10, 0, true); cdDV.setUint16(12, 0, true);
    cdDV.setUint16(14, 0, true); cdDV.setUint32(16, crc, true);
    cdDV.setUint32(20, size, true); cdDV.setUint32(24, size, true);
    cdDV.setUint16(28, nameBytes.length, true); cdDV.setUint16(30, 0, true);
    cdDV.setUint16(32, 0, true); cdDV.setUint16(34, 0, true);
    cdDV.setUint16(36, 0, true); cdDV.setUint32(38, 0, true);
    cdDV.setUint32(42, offset, true); cd.set(nameBytes, 46);
    central.push(cd);
    offset += lh.length + content.length;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const eocdDV = new DataView(eocd.buffer);
  eocdDV.setUint32(0, 0x06054b50, true);
  eocdDV.setUint16(8, files.length, true); eocdDV.setUint16(10, files.length, true);
  eocdDV.setUint32(12, centralSize, true); eocdDV.setUint32(16, offset, true);
  const all = [...parts, ...central, eocd];
  const total = all.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total); let p = 0;
  for (const part of all) { out.set(part, p); p += part.length; }
  return out;
}
function toXLSX(rows) {
  const headers = EXPORT_COLUMNS.map(([h]) => h);
  const sst = []; const idx = new Map();
  const s = (v) => { const str = String(v ?? ""); if (!idx.has(str)) { idx.set(str, sst.length); sst.push(str); } return idx.get(str); };
  const xmlRows = [];
  xmlRows.push(`<row r="1">${headers.map((h, i) => `<c r="${colLetter(i)}1" t="s"><v>${s(h)}</v></c>`).join("")}</row>`);
  rows.forEach((row, ri) => {
    const r = ri + 2;
    const cells = EXPORT_COLUMNS.map(([, k], i) => {
      const v = row[k];
      if (v === "" || v == null) return "";
      return `<c r="${colLetter(i)}${r}" t="s"><v>${s(v)}</v></c>`;
    }).join("");
    xmlRows.push(`<row r="${r}">${cells}</row>`);
  });
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${xmlRows.join("")}</sheetData></worksheet>`;
  const sstXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.length}" uniqueCount="${sst.length}">${sst.map((v) => `<si><t xml:space="preserve">${xmlEscape(v)}</t></si>`).join("")}</sst>`;
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="JUST TNP" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;
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

const PDF_COLS = [
  ["Company", (r) => r.company],
  ["Type", (r) => r.type || "—"],
  ["Role", (r) => r.designation || "—"],
  ["Summary", (r) => r.jdSummary || ""],
  ["Eligible", (r) => r.courses || "—"],
  ["CGPA", (r) => r.criteriaUG || "—"],
  ["Pay", (r) => payDisplay(r)],
  ["Selected", (r) => r.selectedCount ? `${r.selectedCount} (${r.selectedByBranch || "—"})` : "—"],
  ["Deadline", (r) => r.deadline || ""],
];

function toPrintHTML(rows) {
  const head = PDF_COLS.map(([h]) => `<th>${escapeHtml(h)}</th>`).join("");
  const body = rows.map((r) => `<tr>${PDF_COLS.map(([, fn]) => `<td>${escapeHtml(fn(r) ?? "")}</td>`).join("")}</tr>`).join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>JUST TNP — Placement Report</title>
<style>
  @page { size: A4 landscape; margin: 10mm; }
  body { font-family: -apple-system, sans-serif; font-size: 9.5px; margin: 0; padding: 12px; color: #222; }
  h1 { font-size: 17px; margin: 0 0 2px; background: linear-gradient(90deg,#5a1eb4,#f03c82,#ffb432); -webkit-background-clip: text; -webkit-text-fill-color: transparent; font-weight: 800; }
  .meta { font-size: 10px; color: #555; margin-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #bbb; padding: 4px 6px; vertical-align: top; text-align: left; }
  th { background: #5a1eb4; color: white; font-weight: 600; font-size: 10px; }
  tr:nth-child(even) td { background: #faf7ff; }
  .footer { margin-top: 14px; font-size: 9px; color: #888; }
</style></head>
<body>
<h1>JUST TNP — Placement Report</h1>
<div class="meta">Generated ${new Date().toLocaleString()} · ${rows.length} companies · Sorted ascending by annual CTC</div>
<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
<div class="footer">Use Cmd/Ctrl+P → Save as PDF if the print dialog did not open automatically.</div>
<script>window.addEventListener("load", () => setTimeout(() => window.print(), 400));<\/script>
</body></html>`;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
}

document.getElementById("dlCSV").addEventListener("click", () => {
  const blob = new Blob([toCSV(lastFiltered)], { type: "text/csv" });
  triggerDownload(blob, `just-tnp-${Date.now()}.csv`);
});
document.getElementById("dlXLSX").addEventListener("click", () => {
  const bytes = toXLSX(lastFiltered);
  const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  triggerDownload(blob, `just-tnp-${Date.now()}.xlsx`);
});
document.getElementById("dlPDF").addEventListener("click", () => {
  const html = toPrintHTML(lastFiltered);
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
});
