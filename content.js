// BIT TNP Scraper — content script (v4)
// Walks all pagination pages, fetches detail/notice/result pages, returns
// structured rows JSON. Formatting (CSV/XLSX/PDF) happens in popup.js.

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
    const bodyRows = table.querySelectorAll("tbody tr").length
      ? Array.from(table.querySelectorAll("tbody tr"))
      : Array.from(table.querySelectorAll("tr")).slice(1);

    return bodyRows
      .map((tr) => {
        // Skip rows hidden via CSS (DataTables pagination uses display:none).
        if (tr.offsetParent === null && !tr.hidden) {
          // offsetParent null in some cases isn't conclusive; double-check style
          const style = window.getComputedStyle(tr);
          if (style.display === "none" || style.visibility === "hidden") return null;
        }
        const cells = Array.from(tr.querySelectorAll("td"));
        if (cells.length < 2) return null;
        const company = (cells[0].innerText || "").trim();
        if (!company) return null;
        const deadline = cells[1] ? (cells[1].innerText || "").trim() : "";
        const postedOn = cells[2] ? (cells[2].innerText || "").trim() : "";

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

  function parseDetailPage(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const data = {
      type: "", designation: "", jobDescription: "", placeOfPosting: "",
      stipendUG: "", stipendPG: "", basePay: "", ctc: "",
      courses: "", criteriaUG: "", criteriaPG: "",
      companyURL: "", yearOfEstablishment: "",
    };

    doc.querySelectorAll("tr").forEach((tr) => {
      const cells = Array.from(tr.querySelectorAll("td, th"));
      if (cells.length < 2) return;
      const label = (cells[0].innerText || "").toLowerCase().trim();
      const value = cells.slice(1).map((c) => (c.innerText || "").trim()).filter(Boolean).join(" | ");
      if (!value) return;
      if (/job ?designation|^designation$/.test(label)) data.designation ||= value;
      else if (/^job ?description$|^description$/.test(label)) data.jobDescription ||= value;
      else if (/place ?of ?posting|^location$/.test(label)) data.placeOfPosting ||= value;
      else if (/^url$/.test(label)) data.companyURL ||= value;
      else if (/year ?of ?establishment/.test(label)) data.yearOfEstablishment ||= value;
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

    const salary = getSection(bodyText, "SALARY DETAILS") ||
                   getSection(bodyText, "CTC DETAILS") ||
                   getSection(bodyText, "REMUNERATION");
    const sText = salary || bodyText;
    if (!data.ctc) {
      const m = sText.match(/(?:CTC|Total\s*Pay|Package)[:\s]*([₹]?\s*[\d.,]+\s*(?:LPA|Lakh|Lac|Cr|Crore)?)/i);
      if (m) data.ctc = m[1].trim().replace(/\s+/g, " ");
    }
    if (!data.basePay) {
      const m = sText.match(/(?:Base\s*Pay|Base\s*Salary|Fixed\s*Pay)[:\s]*([₹]?\s*[\d.,]+\s*(?:LPA|Lakh|Lac|Cr|Crore)?)/i);
      if (m) data.basePay = m[1].trim().replace(/\s+/g, " ");
    }

    const elig = getSection(bodyText, "ELIGIBILITY");
    if (elig) {
      const coursesM = elig.match(/Courses\s*:?\s*([\s\S]*?)(?=Criteria|$)/i);
      if (coursesM) {
        const parts = coursesM[1].split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
        data.courses = Array.from(new Set(parts)).join(", ");
      }
      const ug = elig.match(/(?:^|\n)\s*UG\s*[-:]\s*([^\n]*)/i);
      const pg = elig.match(/(?:^|\n)\s*PG\s*[-:]\s*([^\n]*)/i);
      if (ug) data.criteriaUG = ug[1].trim();
      if (pg) data.criteriaPG = pg[1].trim();
    }

    return data;
  }

  // ---------- Notice → result link discovery ----------
  function extractResultLinks(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return Array.from(doc.querySelectorAll('a[href*="/resultlist/"]'))
      .map((a) => ({
        url: new URL(a.getAttribute("href"), location.origin).href,
        label: ((a.innerText || "").trim() ||
                (a.parentElement?.innerText || "").trim() || "").slice(0, 200),
      }));
  }

  function pickFinalLink(links) {
    if (!links.length) return null;
    return (
      links.find((l) => /final/i.test(l.label)) ||
      links.find((l) => /\bhr\b/i.test(l.label)) ||
      links[links.length - 1]
    );
  }

  // ---------- Result page parsing ----------
  function parseResultPage(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const tables = Array.from(doc.querySelectorAll("table"));
    let target = null;
    for (const t of tables) {
      const h = (t.innerText || "").toLowerCase().slice(0, 300);
      if (/roll\s*no/.test(h) && /branch/.test(h)) { target = t; break; }
    }
    if (!target) return [];

    const headerRow = target.querySelector("thead tr") || target.querySelector("tr");
    if (!headerRow) return [];
    const headerCells = Array.from(headerRow.querySelectorAll("th, td"))
      .map((c) => (c.innerText || "").toLowerCase().trim());
    const colOf = (re) => headerCells.findIndex((h) => re.test(h));
    const idx = {
      roll: colOf(/roll/),
      name: colOf(/name/),
      degree: colOf(/degree/),
      branch: colOf(/branch/),
      centre: colOf(/centre|center|campus/),
    };

    const dataRows = target.querySelectorAll("tbody tr").length
      ? Array.from(target.querySelectorAll("tbody tr"))
      : Array.from(target.querySelectorAll("tr")).slice(1);

    return dataRows
      .map((tr) => {
        const cells = Array.from(tr.querySelectorAll("td")).map((c) => (c.innerText || "").trim());
        if (cells.length < 3) return null;
        return {
          rollNo: idx.roll >= 0 ? cells[idx.roll] : "",
          name: idx.name >= 0 ? cells[idx.name] : "",
          degree: idx.degree >= 0 ? cells[idx.degree] : "",
          branch: idx.branch >= 0 ? cells[idx.branch] : "",
          centre: idx.centre >= 0 ? cells[idx.centre] : "",
        };
      })
      .filter(Boolean);
  }

  function aggregateSelected(candidates) {
    if (!candidates.length) return { list: "", count: 0, byBranch: "" };
    const list = candidates
      .map((c) => `${c.name} (${[c.degree, c.branch].filter(Boolean).join(" / ")})`)
      .join("; ");
    const tally = {};
    candidates.forEach((c) => {
      const k = c.branch || "Unknown";
      tally[k] = (tally[k] || 0) + 1;
    });
    return {
      list,
      count: candidates.length,
      byBranch: Object.entries(tally).map(([b, n]) => `${b}: ${n}`).join(", "),
    };
  }

  // ---------- Fetch helpers ----------
  async function fetchHTML(url) {
    if (!url) return null;
    try {
      const res = await fetch(url, { credentials: "same-origin" });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
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
  // Priority: parsed CTC > parsed basePay > stipendUG×12.
  // Returns { value: rupees|null, source: "ctc"|"basePay"|"stipendx12"|"unknown" }.
  function computeAnnualCTC(row) {
    const ctc = parseAnnualPay(row.ctc);
    if (ctc != null) return { value: ctc, source: "ctc" };
    const bp = parseAnnualPay(row.basePay);
    if (bp != null) return { value: bp, source: "basePay" };
    const stipend = parseStipendMonthly(row.stipendUG);
    if (stipend != null) {
      const annual = clamp(stipend * 12);
      if (annual != null) return { value: annual, source: "stipendx12" };
    }
    return { value: null, source: "unknown" };
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
    row.designation = useAI(row.designation, ai.designation);
    row.placeOfPosting = useAI(row.placeOfPosting, ai.placeOfPosting);
    row.ctc = useAI(row.ctc, ai.ctc);
    row.basePay = useAI(row.basePay, ai.basePay);
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
  window.__BIT_TNP_SCRAPE__ = async function (options) {
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
      withLimit(detailURLs, 6, fetchHTML, "Detail"),
      options.fetchResults
        ? withLimit(noticeURLs, 6, fetchHTML, "Notice")
        : Promise.resolve(new Array(noticeURLs.length).fill(null)),
    ]);

    const merged = dashboardRows.map((row, i) => {
      const det = detailHTMLs[i] ? parseDetailPage(detailHTMLs[i]) : {};
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
      // We already have noticeHTMLs (parallel-fetched above). Pick the final
      // result link for each branch-filtered row using its original index.
      const finalUrls = branchFiltered.map((row) => {
        const html = noticeHTMLs[row._origIdx];
        if (!html) return null;
        return pickFinalLink(extractResultLinks(html))?.url || null;
      });

      setProgress(`Fetching ${finalUrls.filter(Boolean).length} final-round result pages...`);
      const resultHTMLs = await withLimit(finalUrls, 6, fetchHTML, "Results");

      branchFiltered.forEach((row, i) => {
        if (!resultHTMLs[i]) {
          row.selectedCount = 0; row.selectedByBranch = ""; row.selectedList = "";
          return;
        }
        const cands = parseResultPage(resultHTMLs[i]);
        const agg = aggregateSelected(cands);
        row.selectedCount = agg.count;
        row.selectedByBranch = agg.byBranch;
        row.selectedList = agg.list;
      });
    }
    branchFiltered.forEach((r) => delete r._origIdx);

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

  window.__BIT_TNP_GET_PROGRESS__ = function () {
    return window.__BIT_TNP_PROGRESS__ || "";
  };
})();
