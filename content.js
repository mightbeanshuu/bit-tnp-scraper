// BIT TNP Scraper — content script (v3)
// Three-stage crawl:
//   1. Dashboard table → company list + detail/notice URLs
//   2. /job/info/<hash>  → JD, designation, stipend, eligibility (Courses + Criteria), CTC
//   3. /job/notice/<hash> → /resultlist/<id>/<hash> link → selected candidates table

(function () {
  if (window.__BIT_TNP_LOADED__) return;
  window.__BIT_TNP_LOADED__ = true;
  window.__BIT_TNP_PROGRESS__ = "";

  function setProgress(msg) {
    window.__BIT_TNP_PROGRESS__ = msg;
  }

  // ---------- Dashboard ----------
  function extractDashboardRows() {
    const tables = Array.from(document.querySelectorAll("table"));
    let chosen = null;
    for (const t of tables) {
      const headers = Array.from(t.querySelectorAll("th, thead td"))
        .map((c) => (c.innerText || "").toLowerCase().trim());
      if (headers.some((h) => /company|organi/.test(h)) && headers.some((h) => /action/.test(h))) {
        chosen = t;
        break;
      }
    }
    if (!chosen) chosen = tables[0];
    if (!chosen) return [];

    const bodyRows = chosen.querySelectorAll("tbody tr").length
      ? Array.from(chosen.querySelectorAll("tbody tr"))
      : Array.from(chosen.querySelectorAll("tr")).slice(1);

    return bodyRows
      .map((tr) => {
        const cells = Array.from(tr.querySelectorAll("td"));
        if (cells.length < 2) return null;
        const company = (cells[0].innerText || "").trim();
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

  // ---------- Section text mining ----------
  const SECTIONS_AFTER = [
    "REGISTRATION", "JOB PROFILE DETAILS", "STIPEND DETAILS",
    "SALARY DETAILS", "CTC DETAILS", "REMUNERATION", "SELECTION PROCESS",
    "ELIGIBILITY", "CAMPUSES CONSIDERED", "COMPANY DETAILS", "Note:",
  ];

  function getSection(text, start) {
    const upper = text.toUpperCase();
    const startUpper = start.toUpperCase();
    const i = upper.indexOf(startUpper);
    if (i === -1) return "";
    const after = i + startUpper.length;
    let end = text.length;
    for (const next of SECTIONS_AFTER) {
      if (next.toUpperCase() === startUpper) continue;
      const j = upper.indexOf(next.toUpperCase(), after);
      if (j !== -1 && j < end) end = j;
    }
    return text.slice(after, end).trim();
  }

  // ---------- Detail page parsing ----------
  function parseDetailPage(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const data = {
      type: "",
      designation: "",
      jobDescription: "",
      placeOfPosting: "",
      stipendUG: "",
      stipendPG: "",
      basePay: "",
      ctc: "",
      courses: "",
      criteriaUG: "",
      criteriaPG: "",
      companyURL: "",
      yearOfEstablishment: "",
    };

    // Strategy 1: tabular label/value rows
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

    // Strategy 2: section-based text mining
    const bodyText = (doc.body?.innerText || "").replace(/\r/g, "");

    // Type — first non-empty line of JOB PROFILE DETAILS
    const jpd = getSection(bodyText, "JOB PROFILE DETAILS");
    if (jpd) {
      const firstLine = jpd.split("\n").map((s) => s.trim()).find(Boolean);
      if (firstLine && firstLine.length < 60) data.type = firstLine;
    }

    // Stipend
    const stipend = getSection(bodyText, "STIPEND DETAILS");
    if (stipend) {
      const ug = stipend.match(/For\s+UG\s*₹?\s*([\d,]+)/i);
      const pg = stipend.match(/For\s+PG\s*₹?\s*([\d,]+)/i);
      if (ug) data.stipendUG = ug[1].replace(/,/g, "");
      if (pg) data.stipendPG = pg[1].replace(/,/g, "");
    }

    // Salary / CTC
    const salary = getSection(bodyText, "SALARY DETAILS") ||
      getSection(bodyText, "CTC DETAILS") ||
      getSection(bodyText, "REMUNERATION");
    const salaryText = salary || bodyText;
    if (!data.ctc) {
      const ctcM = salaryText.match(/(?:CTC|Total\s*Pay|Package)[:\s]*([₹]?\s*[\d.,]+\s*(?:LPA|Lakh|Lac|Cr|Crore)?)/i);
      if (ctcM) data.ctc = ctcM[1].trim().replace(/\s+/g, " ");
    }
    if (!data.basePay) {
      const bpM = salaryText.match(/(?:Base\s*Pay|Base\s*Salary|Fixed\s*Pay)[:\s]*([₹]?\s*[\d.,]+\s*(?:LPA|Lakh|Lac|Cr|Crore)?)/i);
      if (bpM) data.basePay = bpM[1].trim().replace(/\s+/g, " ");
    }

    // Eligibility — Courses + Criteria
    const elig = getSection(bodyText, "ELIGIBILITY");
    if (elig) {
      const coursesM = elig.match(/Courses\s*:?\s*([\s\S]*?)(?=Criteria|$)/i);
      if (coursesM) {
        const parts = coursesM[1]
          .split(/[\n,]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        data.courses = Array.from(new Set(parts)).join(", ");
      }
      const ugM = elig.match(/(?:^|\n)\s*UG\s*[-:]\s*([^\n]*)/i);
      const pgM = elig.match(/(?:^|\n)\s*PG\s*[-:]\s*([^\n]*)/i);
      if (ugM) data.criteriaUG = ugM[1].trim();
      if (pgM) data.criteriaPG = pgM[1].trim();
    }

    return data;
  }

  // ---------- Notice page → result links ----------
  function extractResultLinks(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const links = [];
    doc.querySelectorAll('a[href*="/resultlist/"]').forEach((a) => {
      const href = a.getAttribute("href");
      if (!href) return;
      // Use parent context to get a richer label.
      const ownText = (a.innerText || "").trim();
      const parentText = ((a.parentElement?.innerText) || "").trim();
      links.push({
        url: new URL(href, location.origin).href,
        label: ownText || parentText,
      });
    });
    return links;
  }

  function pickFinalLink(links) {
    if (!links.length) return null;
    const finalOne = links.find((l) => /final/i.test(l.label));
    if (finalOne) return finalOne;
    const hrOne = links.find((l) => /\bhr\b/i.test(l.label));
    if (hrOne) return hrOne;
    return links[links.length - 1];
  }

  // ---------- Result page parsing ----------
  function parseResultPage(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const tables = Array.from(doc.querySelectorAll("table"));
    let target = null;
    for (const t of tables) {
      const header = (t.innerText || "").toLowerCase().slice(0, 300);
      if (/roll\s*no/.test(header) && /branch/.test(header)) {
        target = t;
        break;
      }
    }
    if (!target) return [];

    // Map header positions to columns.
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
      const key = c.branch || "Unknown";
      tally[key] = (tally[key] || 0) + 1;
    });
    const byBranch = Object.entries(tally).map(([b, n]) => `${b}: ${n}`).join(", ");
    return { list, count: candidates.length, byBranch };
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
    let idx = 0;
    let done = 0;
    const total = items.length;
    async function loop() {
      while (idx < total) {
        const i = idx++;
        try {
          results[i] = await worker(items[i], i);
        } catch {
          results[i] = null;
        }
        done++;
        if (label) setProgress(`${label}: ${done}/${total}`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, total || 1) }, loop));
    return results;
  }

  // ---------- Branch filter ----------
  const BRANCH_PATTERNS = {
    CSE: [/computer\s*science/i, /\bcse\b/i, /information\s*technology/i, /\bit\b(?!\w)/i],
    AIML: [
      /ai\s*&?\s*ml/i, /ai\s*and\s*ml/i, /aiml/i,
      /artificial\s*intelligence/i, /machine\s*learning/i,
      /\bmath(?:ematics)?\s*(?:&|and)\s*computing\b/i, /\bm&c\b/i,
    ],
    ECE: [
      /electronics(?:\s*(?:&|and)\s*communication)?/i, /\bece\b/i,
      /electronics\s*engineering/i, /\bvlsi\b/i,
    ],
  };

  function isBranchEligible(row, enabled) {
    const list = Object.entries(enabled).filter(([, v]) => v).map(([k]) => k);
    if (list.length === 0) return true;
    if (!row.courses || !row.courses.trim()) return true; // unknown — keep
    return list.some((b) => BRANCH_PATTERNS[b].some((re) => re.test(row.courses)));
  }

  // ---------- Compensation ----------
  function parseRupees(s) {
    if (!s) return Infinity;
    const t = String(s).toLowerCase().replace(/,/g, "").replace(/₹/g, "").trim();
    let m = t.match(/(\d+(?:\.\d+)?)\s*(lpa|lakh|lac|\bl\b)/);
    if (m) return parseFloat(m[1]) * 100000;
    m = t.match(/(\d+(?:\.\d+)?)\s*(cr|crore)/);
    if (m) return parseFloat(m[1]) * 10000000;
    m = t.match(/(\d+(?:\.\d+)?)/);
    if (m) {
      const n = parseFloat(m[1]);
      return n >= 100000 ? n : n * 100000;
    }
    return Infinity;
  }

  function compensationValue(row) {
    if (row.ctc) return parseRupees(row.ctc);
    if (row.basePay) return parseRupees(row.basePay);
    if (row.stipendUG) {
      const n = parseFloat(row.stipendUG);
      if (!isNaN(n)) return n * 12; // annualise
    }
    return Infinity;
  }

  // ---------- CSV ----------
  const COLUMNS = [
    ["Company", "company"],
    ["Type", "type"],
    ["Designation", "designation"],
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

  // ---------- Main entry ----------
  window.__BIT_TNP_SCRAPE__ = async function (options) {
    setProgress("Reading dashboard table...");
    const rows = extractDashboardRows();
    if (!rows.length) {
      return { error: "No dashboard table found. Make sure you are on the Recent Jobs page.", rawCount: 0 };
    }

    setProgress(`Found ${rows.length} companies. Fetching detail pages...`);
    const detailHTMLs = await withLimit(
      rows.map((r) => r.viewApplyUrl),
      5,
      fetchHTML,
      "Detail pages"
    );

    const merged = rows.map((row, i) => {
      const det = detailHTMLs[i] ? parseDetailPage(detailHTMLs[i]) : {};
      return { ...row, ...det };
    });

    const branchFiltered = merged.filter((r) => isBranchEligible(r, options.branches));

    if (options.fetchResults) {
      setProgress(`Fetching notice pages for ${branchFiltered.length} companies...`);
      const noticeHTMLs = await withLimit(
        branchFiltered.map((r) => r.updatesUrl),
        4,
        fetchHTML,
        "Notice pages"
      );

      // Pick the final result link per company (one per company keeps it tractable).
      const finalResultURLs = noticeHTMLs.map((html) => {
        if (!html) return null;
        const links = extractResultLinks(html);
        return pickFinalLink(links)?.url || null;
      });

      setProgress(`Fetching final-round result pages...`);
      const resultHTMLs = await withLimit(finalResultURLs, 4, fetchHTML, "Result pages");

      branchFiltered.forEach((row, i) => {
        const html = resultHTMLs[i];
        if (!html) {
          row.selectedCount = 0;
          row.selectedByBranch = "";
          row.selectedList = "";
          return;
        }
        const cands = parseResultPage(html);
        const agg = aggregateSelected(cands);
        row.selectedCount = agg.count;
        row.selectedByBranch = agg.byBranch;
        row.selectedList = agg.list;
      });
    }

    const sorted = branchFiltered
      .map((r) => ({ ...r, _comp: compensationValue(r) }))
      .sort((a, b) => a._comp - b._comp);

    setProgress(`Done. ${sorted.length} rows in CSV.`);
    return {
      rawCount: rows.length,
      detailFetched: detailHTMLs.filter(Boolean).length,
      afterBranch: branchFiltered.length,
      csv: toCSV(sorted),
    };
  };

  window.__BIT_TNP_INSPECT__ = function () {
    const rows = extractDashboardRows();
    const lines = [`Dashboard rows: ${rows.length}`];
    if (rows.length > 0) {
      lines.push("", "First row:", JSON.stringify(rows[0], null, 2));
    }
    return lines.join("\n");
  };

  window.__BIT_TNP_GET_PROGRESS__ = function () {
    return window.__BIT_TNP_PROGRESS__ || "";
  };
})();
