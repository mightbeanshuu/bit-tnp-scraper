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
    if (!row.courses || !row.courses.trim()) return true;
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
      if (!isNaN(n)) return n * 12;
    }
    return Infinity;
  }

  // ---------- Main ----------
  window.__BIT_TNP_SCRAPE__ = async function (options) {
    setProgress("Walking dashboard pagination...");
    const dashboardRows = await walkAllPages();
    if (!dashboardRows.length) {
      return { error: "No dashboard rows found.", rawCount: 0 };
    }

    setProgress(`Total companies: ${dashboardRows.length}. Fetching detail pages...`);
    const detailHTMLs = await withLimit(
      dashboardRows.map((r) => r.viewApplyUrl),
      4, fetchHTML, "Detail pages"
    );
    const merged = dashboardRows.map((row, i) => {
      const det = detailHTMLs[i] ? parseDetailPage(detailHTMLs[i]) : {};
      return { ...row, ...det };
    });

    const branchFiltered = merged.filter((r) => isBranchEligible(r, options.branches));

    if (options.fetchResults) {
      setProgress(`Branch-filtered: ${branchFiltered.length}. Fetching notice pages...`);
      const noticeHTMLs = await withLimit(
        branchFiltered.map((r) => r.updatesUrl),
        4, fetchHTML, "Notice pages"
      );

      const finalUrls = noticeHTMLs.map((html) => {
        if (!html) return null;
        const links = extractResultLinks(html);
        return pickFinalLink(links)?.url || null;
      });

      setProgress(`Fetching final result pages...`);
      const resultHTMLs = await withLimit(finalUrls, 4, fetchHTML, "Result pages");

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

    const sorted = branchFiltered
      .map((r) => ({ ...r, _comp: compensationValue(r) }))
      .sort((a, b) => a._comp - b._comp);

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
