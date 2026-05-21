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

function render() {
  const filtered = applySort(applyFilters(allRows));
  $("counter").textContent = `${filtered.length} of ${allRows.length}`;
  const main = $("cards");
  if (filtered.length === 0) {
    main.innerHTML = `<div class="empty">No companies match the current filters. Try widening the CTC range or clearing the search.</div>`;
    return;
  }
  main.innerHTML = filtered.map(cardHTML).join("");
}
