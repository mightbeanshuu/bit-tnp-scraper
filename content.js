// BIT TNP Scraper — content script (v6)
// Walks all pagination pages, fetches detail/notice/result pages, returns
// structured rows JSON. Formatting (CSV/XLSX/PDF) happens in popup.js.
// v5 (2.6.0): fetch both first-round (applicants) and final-round (selects)
// result pages; fix pickFinalLink which was picking the FIRST resultlist.
// v6 (2.6.2): switch to panel-based result-link extraction (round anchors
// don't use /resultlist/ URLs — find the panel by "Result" + "Last Updated"
// co-occurrence, grab every anchor inside). Adds __BIT_TNP_INSPECT_NOTICE__
// debug hook.
// v6.1 (2.6.3): strict result-table picker (require Roll+Branch headers) and
// per-row student validator — drops company-metadata rows like "TRAINING
// AND PLACEMENT...", "Dead Line: …", URLs, and empty "()" entries that were
// inflating selectedCount and polluting branch tallies.
// v7 (2.6.4): fetch ALL /resultlist/ links on each notice page (not just
// the ones in the green Result panel) and assign roles by student count —
// smallest = final selected, largest = initial applicants. Fixes Arcesium:
// the Final Result link there is published as a yellow Notifications entry
// ("Shortlisted Students for Interview"), not in the Result panel, so the
// panel-only extractor was reporting 17 selected (actually applicants) and
// 0 applicants. Label hints ("Initial Short listing", "Final Result") take
// precedence over the count heuristic when present.
// v8 (2.6.5): multi-strategy "deep scrape" — Pass 1 scans notice page for
// known result-URL patterns; Pass 2 deep-dives into sub-notice pages for
// companies that had no direct match; Pass 3 fetches discovered URLs. Adds
// parseResultPagePermissive (Tier-3 pattern-only parser) as a fallback when
// the strict header-based picker rejects a table. Tracks sourcesChecked per
// row so the viewer can distinguish "no results published yet" from
// "scraper bug" in the funnel UI.

(function () {
  if (window.__BIT_TNP_LOADED__) return;
  window.__BIT_TNP_LOADED__ = true;
  window.__BIT_TNP_PROGRESS__ = "";

  function setProgress(msg) {
    window.__BIT_TNP_PROGRESS__ = msg;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- Dashboard ----------
  function pickDashboardTable() {
    const tables = Array.from(document.querySelectorAll("table"));
    for (const t of tables) {
      const headers = Array.from(t.querySelectorAll("th, thead td"))
        .map((c) => (c.innerText || "").toLowerCase().trim());
      if (headers.some((h) => /company|organi/.test(h)) &&
          headers.some((h) => /action/.test(h))) {
        return t;
      }
    }
    return tables[0] || null;
  }

  function extractCurrentPage(table) {
    if (!table) return [];
    // IMPORTANT: use textContent (works on hidden rows too). innerText returns
    // "" for display:none rows, so DataTables-paginated tables would lose
    // 90% of their data. Anchors' href attributes are readable regardless.
    const bodyRows = table.querySelectorAll("tbody tr").length
      ? Array.from(table.querySelectorAll("tbody tr"))
      : Array.from(table.querySelectorAll("tr")).slice(1);

    return bodyRows
      .map((tr) => {
        const cells = Array.from(tr.querySelectorAll("td"));
        if (cells.length < 2) return null;
        const company = (cells[0].textContent || "").trim();
        if (!company) return null;
        const deadline = cells[1] ? (cells[1].textContent || "").trim() : "";
        const postedOn = cells[2] ? (cells[2].textContent || "").trim() : "";

        let viewApplyUrl = null;
        let updatesUrl = null;
        for (const cell of cells) {
          for (const a of cell.querySelectorAll("a")) {
            const href = a.getAttribute("href");
            if (!href) continue;
            const abs = new URL(href, location.origin).href;
            if (/\/job\/info\//i.test(abs)) viewApplyUrl = abs;
            else if (/\/job\/notice\//i.test(abs)) updatesUrl = abs;
          }
        }
        if (!viewApplyUrl && !updatesUrl) return null;
        return { company, deadline, postedOn, viewApplyUrl, updatesUrl };
      })
      .filter(Boolean);
  }

  function getTotalEntries() {
    const m = (document.body.innerText || "").match(
      /showing\s+\d+\s+to\s+\d+\s+of\s+([\d,]+)\s+entries/i
    );
    return m ? parseInt(m[1].replace(/,/g, "")) : null;
  }

  function findNextButton() {
    const candidates = Array.from(document.querySelectorAll(
      ".paginate_button.next, li.next, a.next, button.next, [aria-label='Next']"
    ));
    for (const c of candidates) {
      if (c.offsetParent !== null) return c;
    }
    // Fallback: scan for "Next" text inside a pagination-like container.
    const all = document.querySelectorAll("a, button, li, span");
    for (const el of all) {
      const t = (el.innerText || "").trim().toLowerCase();
      if (t === "next" || t === ">" || t === "›") {
        let p = el;
        for (let i = 0; i < 5 && p; i++) {
          if (/pagin/i.test(p.className || "")) return el;
          p = p.parentElement;
        }
      }
    }
    return null;
  }

  function isDisabled(el) {
    if (!el) return true;
    if (el.classList.contains("disabled")) return true;
    if (el.getAttribute("aria-disabled") === "true") return true;
    if (el.hasAttribute("disabled")) return true;
    return false;
  }

  async function walkAllPages() {
    const all = [];
    const seen = new Set();
    const table = pickDashboardTable();
    if (!table) return all;

    const total = getTotalEntries();
    setProgress(`Total entries reported: ${total ?? "unknown"}`);

    // First, try assuming client-side DataTables (all rows in DOM).
    const firstPass = extractCurrentPage(table);
    if (total && firstPass.length >= total) {
      // All rows are already in DOM — done.
      for (const r of firstPass) {
        const key = r.viewApplyUrl || r.company;
        if (!seen.has(key)) { seen.add(key); all.push(r); }
      }
      return all;
    }

    // Otherwise, walk pagination clicking Next.
    let pageNum = 1;
    const maxPages = 60;
    while (pageNum <= maxPages) {
      const rows = extractCurrentPage(table);
      let added = 0;
      for (const r of rows) {
        const key = r.viewApplyUrl || r.company + "|" + r.postedOn;
        if (!seen.has(key)) { seen.add(key); all.push(r); added++; }
      }
      setProgress(`Page ${pageNum}: +${added} (total ${all.length}${total ? `/${total}` : ""})`);

      if (total && all.length >= total) break;

      const nextBtn = findNextButton();
      if (!nextBtn) break;
      // The next button might be on a parent li; check its parent for disabled too.
      if (isDisabled(nextBtn) || isDisabled(nextBtn.parentElement)) break;

      const prevKey = rows[0]?.viewApplyUrl || rows[0]?.company;
      const clickEl = nextBtn.tagName === "A" || nextBtn.tagName === "BUTTON"
        ? nextBtn
        : nextBtn.querySelector("a, button") || nextBtn;
      clickEl.click();

      // Wait until the first row of the table changes.
      const start = Date.now();
      let changed = false;
      while (Date.now() - start < 8000) {
        await sleep(150);
        const fresh = extractCurrentPage(table);
        const newKey = fresh[0]?.viewApplyUrl || fresh[0]?.company;
        if (newKey && newKey !== prevKey) { changed = true; break; }
      }
      if (!changed) break;
      pageNum++;
    }
    return all;
  }

  // ---------- Section text mining ----------
  const SECTIONS = [
    "REGISTRATION", "JOB PROFILE DETAILS", "STIPEND DETAILS",
    "SALARY DETAILS", "CTC DETAILS", "REMUNERATION", "SELECTION PROCESS",
    "ELIGIBILITY", "CAMPUSES CONSIDERED", "COMPANY DETAILS", "Note:",
  ];

  function getSection(text, start) {
    const upper = text.toUpperCase();
    const i = upper.indexOf(start.toUpperCase());
    if (i === -1) return "";
    const after = i + start.length;
    let end = text.length;
    for (const next of SECTIONS) {
      if (next.toUpperCase() === start.toUpperCase()) continue;
      const j = upper.indexOf(next.toUpperCase(), after);
      if (j !== -1 && j < end) end = j;
    }
    return text.slice(after, end).trim();
  }

  // Split a course string by degree-prefix tokens (BArch, BTech, MSc, etc.).
  // Used as fallback when newline/comma splitting yields one mega-blob.
  const DEGREE_TOKEN = /\b(?:B(?:Arch|Tech|Pharm|Sc|Com|BA|CA)|M(?:Sc|Tech|Pharm|BA|CA|UP|S|A)|IMSc|PhD)\b/g;
  function splitCoursesByDegree(text) {
    if (!text) return [];
    const delimited = text.replace(new RegExp(`\\s*(?=${DEGREE_TOKEN.source})`, "g"), "");
    return delimited.split("").map((s) => s.trim()).filter(Boolean);
  }

  // Validate CGPA value is in the plausible range (4.0–10.0).
  function validCGPA(s) {
    const n = parseFloat(s);
    if (isNaN(n) || n < 4.0 || n > 10.0) return null;
    return n.toFixed(2);
  }

  // Parse criteria text into circuital / non-circuital CGPAs.
  // STRICT: requires an explicit circuital/non-circuital keyword OR a
  // CGPA/GPA keyword adjacent to the number. Never harvests random body
  // numbers (which was the bug that produced '10.00 / 10.00').
  function parseCGPA(text) {
    if (!text || text.length > 800) return null;
    const nonCircM = text.match(/non[\s\-]?circuital[^a-z\d]{0,30}(\d+(?:\.\d+)?)/i);
    const circM = text.match(/(?:^|[^a-z])circuital[^a-z\d]{0,30}(\d+(?:\.\d+)?)/i);
    if (circM || nonCircM) {
      const circ = circM ? validCGPA(circM[1]) : null;
      const nonCirc = nonCircM ? validCGPA(nonCircM[1]) : null;
      if (circ || nonCirc) return { circuital: circ, nonCircuital: nonCirc };
    }
    // Single CGPA — must have CGPA/GPA keyword nearby (before).
    const kwBefore = text.match(/(?:min(?:imum)?\s*)?(?:CGPA|GPA|aggregate)[^\d]{0,20}(\d+(?:\.\d+)?)/i);
    if (kwBefore) {
      const v = validCGPA(kwBefore[1]);
      if (v) return { both: v };
    }
    // ...or right after ("7.0 CGPA")
    const kwAfter = text.match(/(\d+(?:\.\d+)?)\s*(?:CGPA|GPA)/i);
    if (kwAfter) {
      const v = validCGPA(kwAfter[1]);
      if (v) return { both: v };
    }
    return null;
  }

  function cleanJD(s) {
    if (!s) return "";
    let t = s.replace(/click\s*here.*$/gi, "").trim();
    t = t.replace(/\s*\|\s*/g, " · ");
    if (t.length > 600) t = t.slice(0, 600) + "…";
    return t;
  }

  // Scan a block of text for the LARGEST CTC-adjacent number. The free-text
  // parser used to match only the first occurrence — postings that list
  // "Base CTC: 18 LPA" before "Total CTC: 35 LPA" got under-parsed by half.
  // Keywords: CTC, Total CTC, Total Package, Total Compensation, Total Pay,
  // Annual Pay, Gross CTC, Gross Package. Returns the raw matched value
  // string so downstream parseAnnualPay can apply unit logic.
  // Strict validator: does this string actually look like a salary value?
  // Acceptable: "30 LPA", "23.5 Lakhs", "₹ 2350000", "₹400000", "1.2 Cr".
  // Rejected: dates ("30th Oct 2025", "31-10-2025"), page headers, prose,
  // bare small numbers ("30", "31"), counts. The previous parser was
  // matching dates near the word CTC and inflating them via the n<100
  // shortcut in parseAnnualPay (30 → 30 LPA). This is the single most
  // important guard preventing that.
  function isPlausibleSalaryString(s) {
    if (!s || typeof s !== "string") return false;
    if (s.length > 30) return false;
    const cleaned = s.toLowerCase().replace(/[₹\s,]/g, "").trim();
    if (!/^\d+(?:\.\d+)?(?:lpa|lakhs?|lacs?|cr|crore|l)?$/.test(cleaned)) return false;
    const numeric = parseFloat(cleaned);
    if (isNaN(numeric) || numeric <= 0) return false;
    const hasUnit = /(?:lpa|lakhs?|lacs?|cr|crore|l)$/.test(cleaned);
    // Bare number must be ≥ ₹1L. A CTC under 1L p.a. is implausible and
    // small numbers are almost always dates / counts / vacancy numbers.
    if (!hasUnit && numeric < 100000) return false;
    return true;
  }

  function extractMaxCTC(text) {
    if (!text) return null;
    // Two regex passes to keep each pattern simple:
    // 1) Strong keywords: CTC / Total CTC / Total Package / Annual Pay / Gross CTC.
    // 2) "Compensation Offered:" / "Compensation:" / "Comp:" — anchored on
    //    a colon or "offered" suffix to avoid matching bare "compensation"
    //    in prose like "the compensation is competitive".
    const patterns = [
      /(?:total\s*(?:ctc|package|compensation|comp|pay)|\bctc\b|annual\s*pay|gross\s*(?:ctc|package))[\s\S]{0,15}?(?:₹|rs\.?|inr)?\s*([\d][\d,.]*\s*(?:LPA|Lakhs?|Lacs?|Cr|Crore|L|K)?)/gi,
      /\bcompensation\s*(?:offered|package|details)?\s*[:\-]\s*(?:₹|rs\.?|inr)?\s*([\d][\d,.]*\s*(?:LPA|Lakhs?|Lacs?|Cr|Crore|L|K)?)/gi,
    ];
    let bestText = null, bestValue = 0;
    for (const re of patterns) {
      let m;
      while ((m = re.exec(text)) !== null) {
        const raw = m[1].trim().replace(/\s+/g, " ");
        // STRICT: reject anything that doesn't look like a real salary
        // value. This is where dates like "30th Oct" used to slip through.
        if (!isPlausibleSalaryString(raw)) continue;
        const v = parseAnnualPay(raw);
        if (v != null && v > bestValue) { bestValue = v; bestText = raw; }
      }
    }
    return bestText;
  }

  // Extract a bonus / variable / target component (e.g., "+ 2.5 Lakhs Annual
  // Targeted Bonus", "Variable Pay: 5 L", "Joining Bonus: 2 Lakhs"). Kept
  // SEPARATE from CTC — most postings already roll the bonus into the main
  // CTC number, so auto-adding would double-count. The viewer just shows
  // bonus as its own line so users can read the full breakdown.
  function extractBonus(text) {
    if (!text) return null;
    const patterns = [
      // "+ 2.5 Lakhs Annual Targeted Bonus" / "+ 5 LPA Variable"
      /\+\s*(?:₹|rs\.?|inr)?\s*([\d][\d,.]*\s*(?:LPA|Lakhs?|Lacs?|Cr|Crore|L|K))\s*(?:annual|annually|p\.?a\.?|per\s*annum)?\s*(?:target|targeted|bonus|variable|performance|joining|sign|incentive)/gi,
      // "Variable Pay: 5 L" / "Targeted Bonus: 2.5 Lakhs" / "Joining Bonus: 2L"
      /(?:variable\s*(?:pay|comp(?:ensation)?)?|target(?:ed)?\s*bonus|annual\s*targeted?\s*bonus|performance\s*bonus|sign[\-\s]*on\s*bonus|joining\s*bonus|incentive)\s*[:\-]\s*(?:₹|rs\.?|inr)?\s*([\d][\d,.]*\s*(?:LPA|Lakhs?|Lacs?|Cr|Crore|L|K)?)/gi,
    ];
    let bestText = null, bestValue = 0;
    for (const re of patterns) {
      let m;
      while ((m = re.exec(text)) !== null) {
        const raw = m[1].trim().replace(/\s+/g, " ");
        const v = parseAnnualPay(raw);
        if (v != null && v > bestValue) { bestValue = v; bestText = raw; }
      }
    }
    return bestText;
  }

  // Same as extractMaxCTC, but for fixed/base/basic pay. Meesho's table puts
  // ₹0 in the Basic Pay column and "Fixed: 14,00,000" in the Other Details
  // column; without this we report basePay as 0.
  function extractFixedPay(text) {
    if (!text) return null;
    const re = /(?:fixed\s*(?:pay|comp(?:ensation)?)?|base\s*(?:pay|salary)|basic\s*(?:pay|salary))[\s\S]{0,10}?(?:₹|rs\.?|inr)?\s*([\d][\d,.]*\s*(?:LPA|Lakhs?|Lacs?|Cr|Crore|L|K)?)/gi;
    let bestText = null, bestValue = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const raw = m[1].trim().replace(/\s+/g, " ");
      if (!isPlausibleSalaryString(raw)) continue;
      const v = parseAnnualPay(raw);
      if (v != null && v > bestValue) { bestValue = v; bestText = raw; }
    }
    return bestText;
  }

  // Some companies (FTE roles like VISA, Meesho) publish salary as a TABLE
  // with columns Programmes / CTC / Basic Pay / Joining Bonus / RSU / ESOP /
  // Other Details, and rows UG / PG. The header-keyword-then-number regex
  // misses these because the word 'CTC' is in a header cell, far from the
  // actual value in a data cell.
  //
  // The "Other Details / Benefits" column often contains the authoritative
  // breakdown (e.g., "Fixed: 14,00,000 ... CTC: 23,50,000") even when the
  // main CTC/Basic Pay cells are missing or under-stated. We cross-check
  // both and take the larger value.
  function parseSalaryTable(doc) {
    const tables = Array.from(doc.querySelectorAll("table"));
    for (const t of tables) {
      let headerCells = Array.from(t.querySelectorAll("thead th, thead td"));
      if (headerCells.length === 0) {
        const firstTr = t.querySelector("tr");
        if (firstTr) headerCells = Array.from(firstTr.querySelectorAll("th, td"));
      }
      const headers = headerCells.map((c) => (c.textContent || "").trim().toLowerCase());
      // Prefer "Total CTC" / "Total Pay" / "Total Package" over plain "CTC"
      // when both columns exist.
      let ctcIdx = headers.findIndex((h) => /\btotal\s*(?:ctc|pay|comp(?:ensation)?|package)\b/.test(h));
      if (ctcIdx < 0) ctcIdx = headers.findIndex((h) => /\bctc\b/.test(h));
      if (ctcIdx < 0) continue;
      const basePayIdx = headers.findIndex((h) => /basic\s*pay|base\s*pay|fixed\s*pay/.test(h));
      const programIdx = headers.findIndex((h) => /programm?es?|category|level/.test(h));
      const otherIdx = headers.findIndex((h) => /other.*(?:detail|benefit)|^benefits?$|^remarks?$|^notes?$/.test(h));

      const allRows = t.querySelector("thead")
        ? Array.from(t.querySelectorAll("tbody tr"))
        : Array.from(t.querySelectorAll("tr")).slice(1);

      const out = { ugCTC: "", pgCTC: "", ugBasePay: "", pgBasePay: "" };
      for (const tr of allRows) {
        const cells = Array.from(tr.querySelectorAll("td"));
        if (cells.length <= ctcIdx) continue;
        // Look for UG/PG marker in the program column if known; otherwise
        // fall back to the row's first cell (some tables omit the header).
        // Optional-chain every cell access — header indices may exceed a
        // given row's cell count on malformed/summary rows; that used to
        // throw and kill the entire scrape.
        const programText = programIdx >= 0
          ? (cells[programIdx]?.textContent || "").trim().toLowerCase()
          : (cells[0]?.textContent || "").trim().toLowerCase();
        let ctcText = (cells[ctcIdx]?.textContent || "").trim().replace(/\s+/g, " ");
        let bpText = basePayIdx >= 0 ? (cells[basePayIdx]?.textContent || "").trim().replace(/\s+/g, " ") : "";

        // Cross-check the Other Details/Benefits column — if it contains a
        // CTC mention with a larger value than the main column, prefer it.
        // Same for Fixed/Base pay (catches Meesho's ₹0 Basic Pay + "Fixed: 14L"
        // in the notes column).
        if (otherIdx >= 0 && cells[otherIdx]) {
          const otherText = cells[otherIdx].textContent || "";
          const altCTC = extractMaxCTC(otherText);
          if (altCTC) {
            const mainVal = parseAnnualPay(ctcText) || 0;
            const altVal = parseAnnualPay(altCTC) || 0;
            if (altVal > mainVal) ctcText = altCTC;
          }
          const bpMainVal = parseAnnualPay(bpText) || 0;
          if (bpMainVal <= 0) {
            const altBP = extractFixedPay(otherText);
            if (altBP) bpText = altBP;
          }
        }

        // STRICT cell-content check — the cell at the CTC column must look
        // like a salary value, not a notice blob with a stray digit. Without
        // this, a non-salary table whose first row coincidentally has "CTC"
        // as a header could plant a long text string into ctcText, which
        // parseAnnualPay would then mine for a 2-digit number (e.g. "30"
        // from "30th Oct 2025") and inflate to 30 LPA.
        if (!isPlausibleSalaryString(ctcText)) continue;
        // Sanity-clean bpText too — keep it only if it's a real salary string.
        if (bpText && !isPlausibleSalaryString(bpText)) bpText = "";
        if (/\bug\b/.test(programText)) { out.ugCTC = ctcText; out.ugBasePay = bpText; }
        else if (/\bpg\b/.test(programText)) { out.pgCTC = ctcText; out.pgBasePay = bpText; }
        else if (!out.ugCTC) { out.ugCTC = ctcText; out.ugBasePay = bpText; }
      }
      if (out.ugCTC || out.pgCTC) return out;
    }
    return null;
  }

  function parseDetailPage(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const data = {
      type: "", designation: "", jobDescription: "", placeOfPosting: "",
      stipendUG: "", stipendPG: "", basePay: "", ctc: "",
      ugCTC: "", pgCTC: "", ugBasePay: "", pgBasePay: "",
      bonus: "",
      courses: "", criteriaUG: "", criteriaPG: "",
      cgpaCirc: "", cgpaNonCirc: "", cgpaSame: false,
      skillSet: "",
      companyURL: "", yearOfEstablishment: "",
    };

    doc.querySelectorAll("tr").forEach((tr) => {
      const cells = Array.from(tr.querySelectorAll("td, th"));
      if (cells.length < 2) return;
      const label = (cells[0].innerText || "").toLowerCase().trim();
      // Skip if label is too long — it's not a real label cell, just data
      if (label.length > 40) return;
      const value = cells.slice(1).map((c) => (c.innerText || "").trim()).filter(Boolean).join(" | ");
      if (!value || value.length > 1500) return; // skip mega-cells
      if (/job ?designation|^designation$/.test(label)) data.designation ||= value;
      else if (/^job ?description$|^description$/.test(label)) data.jobDescription ||= value;
      else if (/place ?of ?posting|^location$/.test(label)) data.placeOfPosting ||= value;
      else if (/^url$/.test(label) && !data.companyURL) data.companyURL = value;
      else if (/year ?of ?establishment/.test(label)) data.yearOfEstablishment ||= value;
      else if (/^required\s*skill ?set$|^skill ?set$|^skills$/.test(label)) data.skillSet ||= value;
    });

    const bodyText = (doc.body?.innerText || "").replace(/\r/g, "");

    const jpd = getSection(bodyText, "JOB PROFILE DETAILS");
    if (jpd) {
      const first = jpd.split("\n").map((s) => s.trim()).find(Boolean);
      if (first && first.length < 60) data.type = first;
    }

    const stipend = getSection(bodyText, "STIPEND DETAILS");
    if (stipend) {
      const ug = stipend.match(/For\s+UG\s*₹?\s*([\d,]+)/i);
      const pg = stipend.match(/For\s+PG\s*₹?\s*([\d,]+)/i);
      if (ug) data.stipendUG = ug[1].replace(/,/g, "");
      if (pg) data.stipendPG = pg[1].replace(/,/g, "");
    }

    // First: try the tabular salary layout (used by VISA, Meesho, DE Shaw,
    // etc. for FTE roles). Store UG/PG values separately so the viewer can
    // surface them distinctly when they differ — the primary "data.ctc" /
    // "data.basePay" picks the LARGER of the two (most companies match,
    // but a few have separate UG vs PG bands and we want sorting to use
    // the better offer).
    const salaryTable = parseSalaryTable(doc);
    if (salaryTable) {
      data.ugCTC = salaryTable.ugCTC || "";
      data.pgCTC = salaryTable.pgCTC || "";
      data.ugBasePay = salaryTable.ugBasePay || "";
      data.pgBasePay = salaryTable.pgBasePay || "";
      const ugCTCval = parseAnnualPay(data.ugCTC) || 0;
      const pgCTCval = parseAnnualPay(data.pgCTC) || 0;
      data.ctc = pgCTCval > ugCTCval ? data.pgCTC : (data.ugCTC || data.pgCTC);
      const ugBPval = parseAnnualPay(data.ugBasePay) || 0;
      const pgBPval = parseAnnualPay(data.pgBasePay) || 0;
      data.basePay = pgBPval > ugBPval ? data.pgBasePay : (data.ugBasePay || data.pgBasePay);
    }

    // Fallback: free-text scan for inline salary mentions. We scan the
    // SALARY DETAILS / CTC DETAILS / REMUNERATION section (or the whole
    // body if no such section exists) for the LARGEST CTC-adjacent value.
    // Picking the max — not the first match — handles postings that list
    // base/fixed pay before the total, like "Base CTC: 18 LPA ... Total
    // CTC: 35 LPA".
    const salary = getSection(bodyText, "SALARY DETAILS") ||
                   getSection(bodyText, "CTC DETAILS") ||
                   getSection(bodyText, "REMUNERATION");
    const sText = salary || bodyText;
    if (!data.ctc) {
      const best = extractMaxCTC(sText);
      if (best) data.ctc = best;
    }
    if (!data.basePay) {
      const best = extractFixedPay(sText);
      if (best) data.basePay = best;
    }

    // Bonus / variable / target extraction — separate field, not auto-added
    // to CTC (most postings already include variable in the total CTC; we
    // don't want to double-count). Viewer shows it as its own breakdown row.
    if (!data.bonus) {
      const bonus = extractBonus(sText);
      if (bonus) data.bonus = bonus;
    }

    const elig = getSection(bodyText, "ELIGIBILITY");
    if (elig) {
      const coursesM = elig.match(/Courses\s*:?\s*([\s\S]*?)(?=Criteria|$)/i);
      if (coursesM) {
        let parts = coursesM[1].split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
        // Fallback: if newline/comma split gave one mega-blob, split by degree prefix.
        if (parts.length === 1 && parts[0].length > 30) {
          parts = splitCoursesByDegree(parts[0]);
        }
        data.courses = Array.from(new Set(parts)).join(", ");
      }
      // Capture the UG line (e.g. "UG - 70%") AND any "Other Criteria" text
      // that follows (where companies put the real CGPA cutoffs).
      const ugLine = elig.match(/(?:^|\n)\s*UG\s*[-:]\s*([^\n]*)/i);
      const pgLine = elig.match(/(?:^|\n)\s*PG\s*[-:]\s*([^\n]*)/i);
      // Match "Other Criteria:" block after UG/PG until the next blank line or section.
      const ugBlock = elig.match(/UG\s*[-:][\s\S]*?Other\s*Criteria\s*:\s*([\s\S]*?)(?=\n\s*PG\s*[-:]|\n\s*Other|\n\s*CAMPUSES|\n\s*COMPANY|$)/i);
      const pgBlock = elig.match(/PG\s*[-:][\s\S]*?Other\s*Criteria\s*:\s*([\s\S]*?)(?=\n\s*CAMPUSES|\n\s*COMPANY|$)/i);
      const ugParts = [];
      if (ugLine) ugParts.push(ugLine[1].trim());
      if (ugBlock) ugParts.push(ugBlock[1].replace(/\s+/g, " ").trim());
      const pgParts = [];
      if (pgLine) pgParts.push(pgLine[1].trim());
      if (pgBlock) pgParts.push(pgBlock[1].replace(/\s+/g, " ").trim());
      data.criteriaUG = ugParts.filter(Boolean).join(" · ");
      data.criteriaPG = pgParts.filter(Boolean).join(" · ");
    }

    // Parse circuital vs non-circuital CGPA from the criteria text.
    // ONLY parse CGPA from criteriaUG or the eligibility section — never the
    // whole body (that's how we ended up with '10' from random page text).
    // Skip single-number parsing when criteria has multiple CGPA references
    // (e.g. DE Shaw's "7 CGPA (CS, IT) and 8 CGPA (Circuital)") — any single
    // pick would be misleading. The raw text is preserved in criteriaUG and
    // rendered verbatim by the viewer.
    const criteriaForCGPA = data.criteriaUG || elig || "";
    const multiCGPA = (criteriaForCGPA.match(/\bCGPA\b/gi) || []).length >= 2;
    const cgInfo = multiCGPA ? null : parseCGPA(criteriaForCGPA);
    if (cgInfo) {
      if (cgInfo.both) {
        data.cgpaCirc = cgInfo.both;
        data.cgpaNonCirc = cgInfo.both;
        data.cgpaSame = true;
      } else {
        data.cgpaCirc = cgInfo.circuital || "";
        data.cgpaNonCirc = cgInfo.nonCircuital || "";
        data.cgpaSame = cgInfo.circuital && cgInfo.nonCircuital && cgInfo.circuital === cgInfo.nonCircuital;
      }
    }

    // SkillSet fallback: bodyText pattern.
    if (!data.skillSet) {
      const m = bodyText.match(/Required\s*Skill ?Set\s*[:\-]\s*([^\n]+)/i);
      if (m) {
        let s = m[1].replace(/click\s*here.*$/i, "").trim();
        if (s.length > 4 && s.length < 300) data.skillSet = s;
      }
    }

    // Clean up jobDescription: drop "Click Here" suffixes, replace | with ·, cap length.
    if (data.jobDescription) data.jobDescription = cleanJD(data.jobDescription);

    return data;
  }

  // ---------- Notice → result link discovery ----------
  // The BIT TNP notice page has a dedicated "Result" panel (green section)
  // listing each round with a link + date. Round anchors do NOT use a
  // predictable URL pattern — they're regular /job/notice/... or other
  // internal URLs. So path-based detection (/resultlist/) is unreliable.
  // PRIMARY strategy: find the panel by its heading + "Last Updated"
  // timestamp (those two strings co-occur ONLY in the result panel), then
  // grab every anchor inside it.
  function findResultsPanel(doc) {
    const candidates = Array.from(doc.querySelectorAll("div, section, article, table, tbody, tr, td"));
    let smallest = null;
    let smallestSize = Infinity;
    for (const el of candidates) {
      const text = el.textContent || "";
      if (text.length > 6000 || text.length < 30) continue;
      // Both markers must co-occur. "Result" alone matches too much; "Last
      // Updated" alone could be a generic timestamp elsewhere.
      if (!/(^|\n|>)\s*results?\b/i.test(text)) continue;
      if (!/last\s*updated/i.test(text)) continue;
      // Must contain at least one anchor — otherwise it's a heading or label.
      if (el.querySelectorAll("a[href]").length === 0) continue;
      if (text.length < smallestSize) {
        smallest = el;
        smallestSize = text.length;
      }
    }
    return smallest;
  }

  // Walk up to 4 ancestors looking for "Final Round" / "Final Result" text
  // adjacent to the anchor. The label is a sibling node so we need to check
  // the containing row/cell — not just the anchor's own text.
  function detectIsFinal(anchor) {
    let cur = anchor.parentElement;
    for (let i = 0; i < 4 && cur; i++) {
      const txt = cur.textContent || "";
      if (txt.length > 600) break; // walked out of the row, stop
      if (/\bfinal\s*(?:round|result)\b/i.test(txt)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function extractResultLinks(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const out = [];
    const seen = new Set();

    const collect = (a, source) => {
      const href = a.getAttribute("href");
      if (!href || href === "#" || href.startsWith("javascript:")) return;
      let abs;
      try { abs = new URL(href, location.origin).href; } catch { return; }
      if (seen.has(abs)) return;
      seen.add(abs);
      const text = (a.textContent || "").trim().slice(0, 200);
      const parentText = (a.parentElement?.textContent || "").trim().slice(0, 300);
      out.push({
        url: abs,
        label: text || parentText,
        source,
        isFinal: detectIsFinal(a),
      });
    };

    // STRATEGY A (primary): find the Result panel, grab every anchor inside.
    // Works regardless of the round links' URL scheme.
    const panel = findResultsPanel(doc);
    if (panel) {
      panel.querySelectorAll("a[href]").forEach((a) => collect(a, "panel"));
    }

    // STRATEGY B (fallback): canonical path patterns — for older portal
    // versions or pages where the panel can't be located.
    doc.querySelectorAll('a[href*="/resultlist/"], a[href*="/result/"], a[href*="/selection/"]')
      .forEach((a) => collect(a, "path"));

    // STRATEGY C (last resort): anchor text mentions result-y keywords.
    doc.querySelectorAll("a[href]").forEach((a) => {
      const t = (a.textContent || "").trim();
      if (/\b(final|hr\s*round|result|selected|selects|placed|offer|shortlist)\b/i.test(t)) {
        collect(a, "text");
      }
    });

    return out;
  }

  // Pick the FINAL-round result link.
  // Priority:
  //   1) Explicit "Final Round" / "Final Result" red marker — authoritative.
  //   2) Among panel-sourced links, the LAST one (chronological order:
  //      initial → assessment → final).
  //   3) Among /resultlist/ links, the LAST one (older portal layouts).
  //   4) Label-based fallbacks for unusual layouts.
  function pickFinalLink(links) {
    if (!links.length) return null;
    const finalMarked = links.find((l) => l.isFinal);
    if (finalMarked) return finalMarked;
    const panelLinks = links.filter((l) => l.source === "panel");
    if (panelLinks.length) return panelLinks[panelLinks.length - 1];
    const resultlinks = links.filter((l) => /\/resultlist\//i.test(l.url));
    if (resultlinks.length) return resultlinks[resultlinks.length - 1];
    return (
      links.find((l) => /final/i.test(l.label)) ||
      links.find((l) => /\bhr\b/i.test(l.label)) ||
      links.find((l) => /\b(selected|result)\b/i.test(l.label)) ||
      links[links.length - 1]
    );
  }

  // Pick the FIRST-round result link (initial shortlist / OA results /
  // assessment shortlist). Proxy for "total applicants" — the portal does
  // not publish raw application counts; this is the count of students who
  // CLEARED the first round.
  // Returns null when there's only one round (no separate first round exists).
  function pickFirstRoundLink(links) {
    if (!links.length) return null;
    // Prefer panel-sourced links (canonical for BIT TNP layout).
    const panelLinks = links.filter((l) => l.source === "panel");
    if (panelLinks.length) {
      const nonFinal = panelLinks.filter((l) => !l.isFinal);
      if (!nonFinal.length) return null;
      return nonFinal[0];
    }
    const resultlinks = links.filter((l) => /\/resultlist\//i.test(l.url));
    if (!resultlinks.length) return null;
    const nonFinal = resultlinks.filter((l) => !l.isFinal);
    if (!nonFinal.length) return null;
    return nonFinal[0];
  }

  // URL patterns that point to student-list pages. Broader than v2.6.4's
  // /resultlist/ + /result/ + /selection/ to catch /selected/, /finalresult/,
  // and /shortlist/ paths seen on some companies' notice pages.
  const RESULT_URL_RE = /\/(?:resultlist|result|selection|selected|finalresult|shortlist)\//i;

  // Scrape-time primary extractor: collect EVERY result-list link from the
  // entire notice page (Result panel AND yellow Notifications section). On
  // some companies (Arcesium being the discovery case) the Final Result
  // link is published as a Notification entry — titled "Shortlisted Students
  // for Interview" — NOT as a Result-panel row.
  function extractAllResultlistLinks(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const out = [];
    const seen = new Set();
    doc.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute("href");
      if (!href || href === "#" || href.startsWith("javascript:")) return;
      let abs;
      try { abs = new URL(href, location.origin).href; } catch { return; }
      if (!RESULT_URL_RE.test(abs)) return;
      if (seen.has(abs)) return;
      seen.add(abs);
      const text = (a.textContent || "").trim().slice(0, 200);
      const parentText = (a.parentElement?.textContent || "").trim().slice(0, 300);
      const ctx = text + " " + parentText;
      out.push({
        url: abs,
        label: text || parentText,
        isFinalMarked: detectIsFinal(a),
        isFinalLabel:
          /\bfinal\s*(?:result|round|selected|selection|list)\b/i.test(ctx) ||
          /\bselected\s*candidates?\b/i.test(ctx),
        // "Initial" must be explicit — pure "Shortlist" is ambiguous
        // (Arcesium's Final Result link is labeled "Shortlisted Students").
        isInitialLabel:
          /\binitial\s*(?:short|shortlist|listing)/i.test(ctx) ||
          /\b(?:first|1st)\s*round\b/i.test(ctx),
      });
    });
    return out;
  }

  // Sub-notice extractor: every other /job/notice/ link on the page (the
  // yellow notification entries). Used in the deep-dive pass when the
  // notice page itself has no /resultlist/ URLs.
  function extractSubNoticeUrls(html, excludeUrl) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const out = new Set();
    doc.querySelectorAll('a[href*="/job/notice/"]').forEach((a) => {
      const href = a.getAttribute("href");
      if (!href) return;
      try {
        const abs = new URL(href, location.origin).href;
        if (abs !== excludeUrl) out.add(abs);
      } catch {}
    });
    return [...out];
  }

  // Tier-3 permissive parser: no header requirement at all. Scans every <tr>
  // on the page; treats a row as a student if any cell matches a BIT roll
  // pattern (BTECH/01234/22) AND any other cell has a name-shaped string
  // (2+ capitalized words). Last-ditch fallback for layouts where the
  // strict header-based picker rejects the table entirely.
  const ROLL_CELL_RE = /^[A-Z]{2,8}[\/\-.][\w\/\-.]{3,}/i;
  const NAME_CELL_RE = /^[A-Z][a-zA-Z'.\-]+(?:\s+[A-Z][a-zA-Z'.\-]+){1,4}$/;
  const BRANCH_CELL_RE = /(?:Engineering|Computing|Science|Technology|Mathematics|Physics|Chemistry|Biotech|Architecture)/i;

  function parseResultPagePermissive(html) {
    if (!html) return [];
    const doc = new DOMParser().parseFromString(html, "text/html");
    const out = [];
    doc.querySelectorAll("tr").forEach((tr) => {
      const cells = Array.from(tr.querySelectorAll("td")).map((c) => (c.textContent || "").trim());
      if (cells.length < 2) return;
      const rollIdx = cells.findIndex((c) => ROLL_CELL_RE.test(c));
      if (rollIdx < 0) return;
      const nameIdx = cells.findIndex((c, i) => i !== rollIdx && NAME_CELL_RE.test(c) && c.length <= 60);
      if (nameIdx < 0) return;
      const branchIdx = cells.findIndex((c) => BRANCH_CELL_RE.test(c) && c.length <= 100);
      const degreeIdx = cells.findIndex((c) => /^(BTech|MTech|MSc|MBA|MCA|PhD|IMSc|BArch|BPharm)\b/i.test(c) && c.length < 30);
      out.push({
        rollNo: cells[rollIdx],
        name: cells[nameIdx],
        degree: degreeIdx >= 0 ? cells[degreeIdx] : "",
        branch: branchIdx >= 0 ? cells[branchIdx] : "",
        centre: "",
      });
    });
    return out;
  }

  // Multi-strategy parser: try strict first, fall back to permissive.
  // Returns the larger non-empty result.
  function parseResultPageMulti(html) {
    const strict = parseResultPage(html);
    if (strict.length >= 1) return strict;
    return parseResultPagePermissive(html);
  }

  // Some companies announce selects INLINE on the notice page (no separate
  // /resultlist/ page exists). Scan the notice HTML for any candidate table.
  function parseInlineCandidates(html) {
    if (!html) return [];
    return parseResultPage(html);
  }

  // ---------- Result page parsing ----------
  // Uses textContent throughout — innerText is unreliable on DOMParser-detached
  // documents (they have no layout, so block-level joining doesn't work).

  // Reject rows where the "name" field clearly isn't a person — common when
  // we land on a notice page whose header has a Roll+Name+Branch-like table
  // for company metadata (URL, Deadline, Posted By, etc.). NVIDIA bug: 6
  // selected reported but 4 were "TRAINING AND PLACEMENT...", "Dead Line: 22-
  // 09-2025", "NVIDIA Corporation (URL/www.nvidia.com)", and "()".
  const NAME_BLOCKLIST_RE =
    /^(?:training|placement|birla|mesra|recruitment|programme|department|institute|company\s*name|deadline|dead\s*line|url|website|posted\s*by|form\s*no|click\s*here|notification|important|update|notice|jaf-bitm|holiday)\b/i;

  function isPlausibleStudentRow(row) {
    const name = (row.name || "").trim();
    const roll = (row.rollNo || "").trim();
    // Strong roll signal: BIT formats like "BTECH/01234/22", "MTECH/IS/...",
    // "IMSC/...", or plain 5+ digit numbers used by some campuses.
    const looksLikeRoll = /^[A-Z]{2,8}[\/\-.][\w\/\-.]+/i.test(roll) || /^\d{5,}$/.test(roll);
    // Validate name (when present).
    if (name) {
      if (name.length > 60) return false;
      if (/@|www\.|https?:\/\//i.test(name)) return false;
      if (NAME_BLOCKLIST_RE.test(name)) return false;
      // Must have actual letters, not just punctuation / digits / "()".
      const letterCount = (name.match(/[a-zA-Z]/g) || []).length;
      if (letterCount < 3) return false;
    }
    return looksLikeRoll || (name && name.length >= 3 && (name.match(/[a-zA-Z]/g) || []).length >= 3);
  }

  function parseResultPage(html) {
    if (!html) return [];
    const doc = new DOMParser().parseFromString(html, "text/html");
    const tables = Array.from(doc.querySelectorAll("table"));
    // Tiered table selection:
    //   Tier 1 (strong): Roll + Branch headers. The Roll No header is what
    //     uniquely distinguishes a student-list table from a company-info
    //     table on the BIT portal.
    //   Tier 2 (weak): Name + Branch (some intern lists omit Roll).
    // Among matches in the same tier, pick the one with most data rows.
    let target = null, bestSize = 0;
    let weakTarget = null, weakBestSize = 0;
    for (const t of tables) {
      const headerRow = t.querySelector("thead tr") || t.querySelector("tr");
      if (!headerRow) continue;
      const headerCells = Array.from(headerRow.querySelectorAll("th, td"))
        .map((c) => (c.textContent || "").toLowerCase().trim());
      const hasRoll = headerCells.some((h) => /\broll/.test(h));
      const hasName = headerCells.some((h) => /^name$|student.*name|candidate.*name/i.test(h));
      const hasBranch = headerCells.some((h) => /\bbranch\b/.test(h));
      if (!hasBranch) continue;
      const nRows = t.querySelectorAll("tbody tr").length || (t.querySelectorAll("tr").length - 1);
      if (hasRoll) {
        if (nRows > bestSize) { target = t; bestSize = nRows; }
      } else if (hasName) {
        if (nRows > weakBestSize) { weakTarget = t; weakBestSize = nRows; }
      }
    }
    if (!target) target = weakTarget;
    if (!target) return [];

    const headerRow = target.querySelector("thead tr") || target.querySelector("tr");
    if (!headerRow) return [];
    const headerCells = Array.from(headerRow.querySelectorAll("th, td"))
      .map((c) => (c.textContent || "").toLowerCase().trim());
    const colOf = (re) => headerCells.findIndex((h) => re.test(h));
    const idx = {
      roll: colOf(/roll/),
      name: colOf(/^name$|student.*name/),
      degree: colOf(/degree/),
      branch: colOf(/branch/),
      centre: colOf(/centre|center|campus/),
    };

    const dataRows = target.querySelectorAll("tbody tr").length
      ? Array.from(target.querySelectorAll("tbody tr"))
      : Array.from(target.querySelectorAll("tr")).slice(1);

    return dataRows
      .map((tr) => {
        const cells = Array.from(tr.querySelectorAll("td")).map((c) => (c.textContent || "").trim());
        if (cells.length < 3) return null;
        const row = {
          rollNo: idx.roll >= 0 ? cells[idx.roll] : "",
          name: idx.name >= 0 ? cells[idx.name] : "",
          degree: idx.degree >= 0 ? cells[idx.degree] : "",
          branch: idx.branch >= 0 ? cells[idx.branch] : "",
          centre: idx.centre >= 0 ? cells[idx.centre] : "",
        };
        return isPlausibleStudentRow(row) ? row : null;
      })
      .filter(Boolean);
  }

  // Reject branches that are obviously URLs / numerics / metadata — these
  // sneak in when the table's branch column contains stray values like
  // "www.nvidia.com" on a header row (the row-level validator would
  // normally drop those, but belt-and-suspenders).
  function isPlausibleBranch(s) {
    if (!s) return false;
    if (s.length > 80) return false;
    if (/@|www\.|https?:\/\//i.test(s)) return false;
    if (/^\d/.test(s)) return false; // branches don't start with digits
    if (!/[a-zA-Z]{2,}/.test(s)) return false;
    return true;
  }

  function aggregateSelected(candidates) {
    if (!candidates.length) return { list: "", count: 0, byBranch: "" };
    const list = candidates
      .map((c) => `${c.name} (${[c.degree, c.branch].filter(Boolean).join(" / ")})`)
      .join("; ");
    const tally = {};
    candidates.forEach((c) => {
      const k = (c.branch || "").trim();
      if (!isPlausibleBranch(k)) return;
      tally[k] = (tally[k] || 0) + 1;
    });
    return {
      list,
      count: candidates.length,
      byBranch: Object.entries(tally).map(([b, n]) => `${b}: ${n}`).join(", "),
    };
  }

  // ---------- Fetch helpers ----------
  // Retries transient failures (network / 5xx) up to 2 times with backoff.
  async function fetchHTML(url, retries = 2) {
    if (!url) return null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, { credentials: "same-origin" });
        if (res.ok) return await res.text();
        if (res.status >= 400 && res.status < 500) return null; // permanent
      } catch { /* network blip, retry */ }
      if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    return null;
  }

  async function withLimit(items, limit, worker, label) {
    const results = new Array(items.length);
    let idx = 0, done = 0;
    const total = items.length;
    async function loop() {
      while (idx < total) {
        const i = idx++;
        try { results[i] = await worker(items[i], i); } catch { results[i] = null; }
        done++;
        if (label) setProgress(`${label}: ${done}/${total}`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, total || 1) }, loop));
    return results;
  }

  // ---------- Branch filter ----------
  const BRANCH_PATTERNS = {
    CSE: [/computer\s*science/i, /\bcse\b/i],
    IT: [/information\s*tech/i, /\bit\b(?!\w)/i],
    AIML: [
      /ai\s*&?\s*ml/i, /ai\s*and\s*ml/i, /aiml/i,
      /artificial\s*intelligence/i, /machine\s*learning/i,
    ],
    MC: [
      /math(?:ematics)?\s*(?:&|and)\s*computing/i, /\bm&c\b/i, /\bm\.?c\.?\b/i,
    ],
    ECE: [
      /electronics?\s*(?:&|and)\s*communication/i, /\bece\b/i, /\bvlsi\b/i,
      /electronics(?:\s*engineering)?(?!\s*(?:&|and)\s*electrical)/i,
    ],
    EEE: [
      /electrical\s*(?:&|and)\s*electronics/i, /\beee\b/i,
      /electrical\s*engineering/i,
    ],
    ME: [/mechanical\s*engineering/i, /\bme\b(?!\w)/i, /production\s*engineering/i],
    CE: [/civil\s*engineering/i, /\bce\b(?!\w)/i],
    CHEM: [/chemical\s*engineering/i, /\bchemical\b/i],
    BT: [/biotech/i, /\bbt\b(?!\w)/i, /bioengineering/i, /biological/i],
  };

  function isBranchEligible(row, enabled) {
    const list = Object.entries(enabled).filter(([, v]) => v).map(([k]) => k);
    if (list.length === 0) return true;
    if (!row.courses || !row.courses.trim()) return true;
    return list.some((b) => BRANCH_PATTERNS[b].some((re) => re.test(row.courses)));
  }

  // ---------- Compensation ----------
  // parseAnnualPay handles CTC/basePay strings.
  // SAFETY: we only accept values that have an explicit unit (LPA/Lakh/Cr),
  // OR are clearly tiny (<100 → lakhs, e.g. "12" → 12 LPA),
  // OR are clearly large (>=1L → rupees, e.g. "1200000" → 12 LPA).
  // Ambiguous middle-range numbers (100…99,999) are dropped — they are usually
  // monthly stipends mislabeled as CTC and would otherwise produce absurd
  // values like the 25,000 LPA bug. Result is also clamped at 5 Cr to catch
  // any remaining parser weirdness.
  const MAX_REASONABLE_CTC = 50000000; // ₹5 Cr / 500 LPA — practical ceiling
  function parseAnnualPay(s) {
    if (!s) return null;
    const t = String(s).toLowerCase().replace(/,/g, "").replace(/₹/g, "").trim();
    const hasPerMonth = /per\s*month|\/mo\b|monthly|p\.?m\.?/.test(t);

    let m = t.match(/(\d+(?:\.\d+)?)\s*(cr|crore)/);
    if (m) return clamp(parseFloat(m[1]) * 10000000);

    m = t.match(/(\d+(?:\.\d+)?)\s*(lpa|lakhs?|lacs?|\bl\b)/);
    if (m) return clamp(parseFloat(m[1]) * 100000);

    m = t.match(/(\d+(?:\.\d+)?)/);
    if (m) {
      const n = parseFloat(m[1]);
      if (isNaN(n) || n <= 0) return null;
      if (hasPerMonth) {
        // "8000 per month" → 96,000/year
        return clamp(n * 12);
      }
      if (n < 100) return clamp(n * 100000);           // "12" → 12 LPA
      if (n >= 100000) return clamp(n);                 // "1200000" → ₹12L
      return null;                                       // ambiguous (100…99999) — drop
    }
    return null;
  }
  function clamp(v) {
    if (v == null || !isFinite(v) || v <= 0) return null;
    if (v > MAX_REASONABLE_CTC) return null;
    return v;
  }

  // parseStipendMonthly handles bare monthly-stipend strings like "8000", "8,000".
  // Always returns rupees per month; never inflates to lakhs.
  function parseStipendMonthly(s) {
    if (!s) return null;
    const cleaned = String(s).replace(/[,\s₹]/g, "");
    const n = parseFloat(cleaned);
    return isNaN(n) || n <= 0 ? null : n;
  }

  // Compute the canonical annual CTC for a row.
  // Per user request: pick the LARGEST of {table CTC, basePay, stipend×12}.
  // Was a priority order — but for intern-heavy postings where stipend×12
  // exceeds the recorded "CTC" (or where the table CTC is just a basic
  // pay band and stipend already reflects the full offer), priority order
  // under-reports.
  // Returns { value: rupees|null, source: "ctc"|"basePay"|"stipendx12"|"unknown" }.
  function computeAnnualCTC(row) {
    const ctc = parseAnnualPay(row.ctc);
    const bp = parseAnnualPay(row.basePay);
    const stipend = parseStipendMonthly(row.stipendUG);
    const stipendAnnual = stipend != null ? clamp(stipend * 12) : null;
    const candidates = [];
    if (ctc != null) candidates.push({ value: ctc, source: "ctc" });
    if (bp != null) candidates.push({ value: bp, source: "basePay" });
    if (stipendAnnual != null) candidates.push({ value: stipendAnnual, source: "stipendx12" });
    if (!candidates.length) return { value: null, source: "unknown" };
    candidates.sort((a, b) => b.value - a.value);
    return candidates[0];
  }

  // ---------- AI enrichment (Groq) ----------
  const GROQ_PROMPT = `You will receive the text of a BIT Mesra job/internship posting. Extract structured info and return ONLY a JSON object with these keys (use null for missing):
{
  "designation": string|null,
  "jdSummary": string|null,                // one short sentence
  "cgpaCutoff": string|null,               // e.g. "7.0", "6.5"
  "branches": string|null,                 // comma-separated, e.g. "CSE, ECE, IT"
  "stipendUG": number|null,                // INR per month
  "stipendPG": number|null,
  "ctc": string|null,                      // with unit, e.g. "12 LPA"
  "basePay": string|null,
  "placeOfPosting": string|null,
  "type": string|null                       // "Internship" | "Full-Time" | "Both"
}
Do not invent fields not in the posting. Return strictly valid JSON, no prose.`;

  async function enrichWithGroq(bodyText, apiKey, model) {
    if (!apiKey || !bodyText) return null;
    const content = bodyText.slice(0, 6000);
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + apiKey,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: GROQ_PROMPT },
            { role: "user", content },
          ],
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const raw = data?.choices?.[0]?.message?.content;
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function mergeAIIntoRow(row, ai) {
    if (!ai || typeof ai !== "object") return row;
    // Prefer AI for missing-or-empty fields; trust regex when both exist.
    const useAI = (regex, aiVal) => (regex && String(regex).trim()) ? regex : (aiVal ?? "");
    // For salary fields, only accept the AI value if it actually looks like
    // a salary string. The Groq model occasionally returns junk such as
    // page-header text ("Posted By PATNA CAMPUS Dated: 30th Oct 2025…")
    // as ctc, which parseAnnualPay then mines for a stray "30" and
    // inflates to 30 LPA. The validator drops anything that isn't a clean
    // "30 LPA" / "₹2350000" / "1.2 Cr" shape.
    const useSalaryAI = (regex, aiVal) => {
      if (regex && String(regex).trim()) return regex;
      if (aiVal != null && isPlausibleSalaryString(String(aiVal))) return String(aiVal);
      return "";
    };
    row.designation = useAI(row.designation, ai.designation);
    row.placeOfPosting = useAI(row.placeOfPosting, ai.placeOfPosting);
    row.ctc = useSalaryAI(row.ctc, ai.ctc);
    row.basePay = useSalaryAI(row.basePay, ai.basePay);
    if (!row.stipendUG && ai.stipendUG != null) row.stipendUG = String(ai.stipendUG);
    if (!row.stipendPG && ai.stipendPG != null) row.stipendPG = String(ai.stipendPG);
    if (!row.type && ai.type) row.type = ai.type;
    // AI is the authoritative source for these two if regex didn't get them
    if ((!row.criteriaUG || !/\d/.test(row.criteriaUG)) && ai.cgpaCutoff) {
      row.criteriaUG = (row.criteriaUG ? row.criteriaUG + " | " : "") + "CGPA " + ai.cgpaCutoff;
    }
    if (!row.courses && ai.branches) row.courses = ai.branches;
    if (ai.jdSummary) row.jdSummary = ai.jdSummary;
    return row;
  }

  // ---------- Main ----------
  // The actual scrape body lives in _scrape — the exported entry point wraps
  // it in try/catch so any unexpected throw returns a structured error to
  // the popup instead of the bare `undefined` that surfaces as
  // "scraper returned nothing".
  async function _scrape(options) {
    setProgress("Walking dashboard pagination...");
    const dashboardRows = await walkAllPages();
    if (!dashboardRows.length) {
      return { error: "No dashboard rows found.", rawCount: 0 };
    }

    // Parallelise detail + notice fetches — they're independent.
    // For !fetchResults we skip notice entirely. For fetchResults we pre-fetch
    // ALL notice pages so the branch-filter pass can read them by index.
    setProgress(`Fetching ${dashboardRows.length} detail pages${options.fetchResults ? " + notice pages in parallel" : ""}...`);
    const detailURLs = dashboardRows.map((r) => r.viewApplyUrl);
    const noticeURLs = dashboardRows.map((r) => r.updatesUrl);

    const [detailHTMLs, noticeHTMLs] = await Promise.all([
      withLimit(detailURLs, 8, fetchHTML, "Detail"),
      options.fetchResults
        ? withLimit(noticeURLs, 8, fetchHTML, "Notice")
        : Promise.resolve(new Array(noticeURLs.length).fill(null)),
    ]);

    const merged = dashboardRows.map((row, i) => {
      // Per-row try/catch: one malformed detail page must not abort the
      // entire scrape (which would otherwise return undefined to the popup
      // and show "scraper returned nothing").
      let det = {};
      try { if (detailHTMLs[i]) det = parseDetailPage(detailHTMLs[i]); }
      catch (e) { console.warn("parseDetailPage failed for", row.company, e); }
      return { ...row, ...det, _detailHTML: detailHTMLs[i] || "", _origIdx: i };
    });

    if (options.useAI && options.apiKey) {
      // Skip rows that already have a complete-enough parse (saves API calls).
      const needsAI = merged.filter((r) =>
        r._detailHTML && (!r.designation || !r.courses || (!r.ctc && !r.stipendUG && !r.basePay))
      );
      const skipped = merged.length - needsAI.length;
      setProgress(`Enriching ${needsAI.length} rows via Groq (${options.model}); ${skipped} already complete`);
      await withLimit(needsAI, 6, async (row) => {
        const doc = new DOMParser().parseFromString(row._detailHTML, "text/html");
        const text = (doc.body?.innerText || "").replace(/\r/g, "");
        const ai = await enrichWithGroq(text, options.apiKey, options.model);
        mergeAIIntoRow(row, ai);
        return ai;
      }, "AI enrichment");
    }
    merged.forEach((r) => delete r._detailHTML);

    const branchFiltered = merged.filter((r) => isBranchEligible(r, options.branches));

    if (options.fetchResults) {
      // PASS 1 — direct: scan each company's notice page for result-list URLs,
      // fetch them, parse with strict-then-permissive multi-parser.
      const linksPerRow = branchFiltered.map((row) => {
        const html = noticeHTMLs[row._origIdx];
        return html ? extractAllResultlistLinks(html) : [];
      });

      const buildTasks = (lists) => {
        const tasks = [];
        lists.forEach((links, rowIdx) => {
          links.forEach((link, linkIdx) => {
            tasks.push({ url: link.url, rowIdx, linkIdx, meta: link });
          });
        });
        return tasks;
      };

      const pass1Tasks = buildTasks(linksPerRow);
      setProgress(`Pass 1: fetching ${pass1Tasks.length} result pages across ${branchFiltered.length} companies...`);
      const pass1Htmls = await withLimit(pass1Tasks.map((t) => t.url), 8, fetchHTML, "Pass 1");

      const parsedByRow = branchFiltered.map(() => []);
      pass1Tasks.forEach((task, i) => {
        const html = pass1Htmls[i];
        if (!html) return;
        let cands = [];
        try { cands = parseResultPageMulti(html); }
        catch (e) { console.warn("parseResultPageMulti failed:", e); }
        parsedByRow[task.rowIdx].push({
          url: task.url,
          label: task.meta.label,
          candidates: cands,
          count: cands.length,
          isFinalMarked: task.meta.isFinalMarked,
          isFinalLabel: task.meta.isFinalLabel,
          isInitialLabel: task.meta.isInitialLabel,
        });
      });

      // PASS 2 — deep dive: for rows that found NOTHING in pass 1, fetch
      // every sub-notice page from the Notifications section and rescan for
      // result-list URLs inside them. Some companies hide the Final Result
      // link behind a sub-notice instead of publishing it on the parent.
      const deepRowIdxs = branchFiltered
        .map((_, i) => i)
        .filter((i) => parsedByRow[i].length === 0 && noticeHTMLs[branchFiltered[i]._origIdx]);

      if (deepRowIdxs.length > 0) {
        setProgress(`Pass 2 (deep dive): scanning sub-notices for ${deepRowIdxs.length} companies with no direct result link...`);
        const subTasks = []; // { rowIdx, subUrl }
        deepRowIdxs.forEach((rowIdx) => {
          const row = branchFiltered[rowIdx];
          const noticeUrl = row.updatesUrl;
          const noticeHtml = noticeHTMLs[row._origIdx];
          const subs = extractSubNoticeUrls(noticeHtml, noticeUrl).slice(0, 6);
          subs.forEach((subUrl) => subTasks.push({ rowIdx, subUrl }));
        });
        const subHtmls = await withLimit(subTasks.map((t) => t.subUrl), 6, fetchHTML, "Sub-notices");

        // Discover /resultlist/ URLs in each sub-notice, dedupe per row.
        const discoveredByRow = new Map();
        subTasks.forEach((task, i) => {
          const h = subHtmls[i];
          if (!h) return;
          const links = extractAllResultlistLinks(h);
          if (!links.length) return;
          if (!discoveredByRow.has(task.rowIdx)) discoveredByRow.set(task.rowIdx, new Map());
          const m = discoveredByRow.get(task.rowIdx);
          links.forEach((l) => { if (!m.has(l.url)) m.set(l.url, l); });
        });

        // Fetch discovered URLs.
        const pass3Tasks = [];
        discoveredByRow.forEach((linkMap, rowIdx) => {
          linkMap.forEach((meta, url) => pass3Tasks.push({ url, rowIdx, meta }));
        });
        if (pass3Tasks.length > 0) {
          setProgress(`Pass 3: fetching ${pass3Tasks.length} sub-discovered result pages...`);
          const pass3Htmls = await withLimit(pass3Tasks.map((t) => t.url), 8, fetchHTML, "Pass 3");
          pass3Tasks.forEach((task, i) => {
            const html = pass3Htmls[i];
            if (!html) return;
            let cands = [];
            try { cands = parseResultPageMulti(html); }
            catch (e) { console.warn("parseResultPageMulti (pass 3) failed:", e); }
            parsedByRow[task.rowIdx].push({
              url: task.url,
              label: task.meta.label,
              candidates: cands,
              count: cands.length,
              isFinalMarked: task.meta.isFinalMarked,
              isFinalLabel: task.meta.isFinalLabel,
              isInitialLabel: task.meta.isInitialLabel,
            });
          });
        }
      }

      // Assign roles. User's rule:
      //   Applicants = Initial Short listing (largest count or "Initial" label)
      //   Selected   = Final Result (smallest count or "Final" label/marker)
      branchFiltered.forEach((row, i) => {
        // Track scrape attempts so the UI can show "checked X sources" even
        // when results are 0. Cleared before chrome.storage save.
        row.sourcesChecked = parsedByRow[i].length;

        const parsed = parsedByRow[i].filter((p) => p.count > 0);
        let finalPick = null, initialPick = null;

        if (parsed.length === 1) {
          const single = parsed[0];
          if (single.isInitialLabel && !(single.isFinalMarked || single.isFinalLabel)) {
            initialPick = single;
          } else {
            finalPick = single;
          }
        } else if (parsed.length >= 2) {
          finalPick = parsed.find((p) => p.isFinalMarked || p.isFinalLabel);
          initialPick = parsed.find((p) => p.isInitialLabel && p !== finalPick);
          const sortedAsc = [...parsed].sort((a, b) => a.count - b.count);
          if (!finalPick) finalPick = sortedAsc.find((p) => p !== initialPick) || sortedAsc[0];
          if (!initialPick) {
            const sortedDesc = [...parsed].sort((a, b) => b.count - a.count);
            initialPick = sortedDesc.find((p) => p !== finalPick) || null;
          }
        }

        if (finalPick) {
          const agg = aggregateSelected(finalPick.candidates);
          row.selectedCount = agg.count;
          row.selectedByBranch = agg.byBranch;
          row.selectedList = agg.list;
        }
        if (initialPick && initialPick !== finalPick) {
          const agg = aggregateSelected(initialPick.candidates);
          row.applicantCount = agg.count;
          row.applicantByBranch = agg.byBranch;
          row.applicantRoundLabel = initialPick.label;
        }

        // FALLBACK — inline parse the notice page itself (some companies put
        // the candidate table inside the notification panel). Only when both
        // counts are still empty.
        if (!row.selectedCount && !row.applicantCount) {
          const noticeHtml = noticeHTMLs[row._origIdx];
          if (noticeHtml) {
            let inlineCands = [];
            try { inlineCands = parseResultPageMulti(noticeHtml); }
            catch (e) { console.warn("inline parse failed:", e); }
            if (inlineCands.length > 0) {
              const agg = aggregateSelected(inlineCands);
              row.selectedCount = agg.count;
              row.selectedByBranch = agg.byBranch;
              row.selectedList = agg.list;
            }
          }
        }
      });

      const withFinal = branchFiltered.filter((r) => r.selectedCount > 0).length;
      const withInitial = branchFiltered.filter((r) => r.applicantCount > 0).length;
      const withAnySource = branchFiltered.filter((r) => r.sourcesChecked > 0).length;
      setProgress(`Done. Sources checked: ${withAnySource}/${branchFiltered.length}; selected parsed: ${withFinal}; applicants parsed: ${withInitial}.`);
    }
    branchFiltered.forEach((r) => delete r._origIdx);

    // Attach matchingCourses: subset of courses that match the user's selected branches.
    const enabledBranchList = Object.entries(options.branches || {}).filter(([, v]) => v).map(([k]) => k);
    branchFiltered.forEach((r) => {
      const list = (r.courses || "").split(",").map((s) => s.trim()).filter(Boolean);
      const matching = list.filter((c) =>
        enabledBranchList.some((b) => (BRANCH_PATTERNS[b] || []).some((re) => re.test(c)))
      );
      r.matchingCourses = matching.length ? Array.from(new Set(matching)).join(", ") : "";
    });

    // Attach explicit annualCTC + source on every row, then sort ascending.
    branchFiltered.forEach((r) => {
      const { value, source } = computeAnnualCTC(r);
      r.annualCTC = value;
      r.compSource = source;
      r.annualCTCDisplay = value != null ? `₹${(value / 100000).toFixed(2)} LPA` : "";
    });
    const sorted = branchFiltered.slice().sort((a, b) => {
      const av = a.annualCTC == null ? Infinity : a.annualCTC;
      const bv = b.annualCTC == null ? Infinity : b.annualCTC;
      return av - bv;
    });

    setProgress(`Done. ${sorted.length} rows ready.`);
    return {
      rawCount: dashboardRows.length,
      detailFetched: detailHTMLs.filter(Boolean).length,
      afterBranch: branchFiltered.length,
      rows: sorted,
    };
  }

  window.__BIT_TNP_SCRAPE__ = async function (options) {
    try {
      return await _scrape(options);
    } catch (e) {
      console.error("Scrape failed:", e);
      setProgress(`Scrape error: ${e?.message || e}`);
      return { error: `Scrape crashed: ${e?.message || String(e)}`, rawCount: 0 };
    }
  };

  window.__BIT_TNP_INSPECT__ = function () {
    const t = pickDashboardTable();
    const rows = extractCurrentPage(t);
    const total = getTotalEntries();
    return JSON.stringify({
      tablesFound: document.querySelectorAll("table").length,
      currentPageRows: rows.length,
      totalEntriesReported: total,
      firstRow: rows[0] || null,
    }, null, 2);
  };

  // Diagnostic: fetch a single notice page and show every /resultlist/ link
  // discovered, the parsed student count for each, and how the scraper
  // would assign roles (selected vs applicants).
  // Use from the browser console:
  //   await __BIT_TNP_INSPECT_NOTICE__("https://tp.bitmesra.co.in/job/notice/<id>")
  window.__BIT_TNP_INSPECT_NOTICE__ = async function (noticeUrl) {
    if (!noticeUrl) return "Pass a notice URL like /job/notice/<id>";
    const html = await fetchHTML(noticeUrl);
    if (!html) return `Failed to fetch ${noticeUrl}`;
    const links = extractAllResultlistLinks(html);
    const parsed = await Promise.all(links.map(async (l) => {
      const h = await fetchHTML(l.url);
      let count = 0;
      if (h) { try { count = parseResultPage(h).length; } catch {} }
      return { ...l, count };
    }));

    let finalPick = null, initialPick = null;
    const valid = parsed.filter((p) => p.count > 0);
    if (valid.length === 1) {
      const s = valid[0];
      if (s.isInitialLabel && !(s.isFinalMarked || s.isFinalLabel)) initialPick = s;
      else finalPick = s;
    } else if (valid.length >= 2) {
      finalPick = valid.find((p) => p.isFinalMarked || p.isFinalLabel);
      initialPick = valid.find((p) => p.isInitialLabel && p !== finalPick);
      const sortedAsc = [...valid].sort((a, b) => a.count - b.count);
      if (!finalPick) finalPick = sortedAsc.find((p) => p !== initialPick) || sortedAsc[0];
      if (!initialPick) {
        const sortedDesc = [...valid].sort((a, b) => b.count - a.count);
        initialPick = sortedDesc.find((p) => p !== finalPick) || null;
      }
    }

    return JSON.stringify({
      noticeUrl,
      totalLinksFound: links.length,
      rounds: parsed.map((p) => ({
        url: p.url,
        label: p.label.slice(0, 80),
        studentCount: p.count,
        isFinalMarked: p.isFinalMarked,
        isFinalLabel: p.isFinalLabel,
        isInitialLabel: p.isInitialLabel,
      })),
      assigned: {
        selected: finalPick ? { url: finalPick.url, label: finalPick.label, count: finalPick.count } : null,
        applicants: initialPick ? { url: initialPick.url, label: initialPick.label, count: initialPick.count } : null,
      },
    }, null, 2);
  };

  window.__BIT_TNP_GET_PROGRESS__ = function () {
    return window.__BIT_TNP_PROGRESS__ || "";
  };
})();
