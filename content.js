// BIT TNP Scraper — content script (v2)
// Crawls the dashboard table, fetches each /job/info/<hash> page, parses
// labelled fields, filters by branch, sorts by compensation, exports CSV.

(function () {
  if (window.__BIT_TNP_LOADED__) return;
  window.__BIT_TNP_LOADED__ = true;

  window.__BIT_TNP_PROGRESS__ = "";

  // ---------- Dashboard table extraction ----------
  function extractDashboardRows() {
    const tables = Array.from(document.querySelectorAll("table"));
    // Pick the table whose headers include "Company" and "Action" (or similar).
    let chosen = null;
    for (const t of tables) {
      const headers = Array.from(t.querySelectorAll("th, thead td"))
        .map((c) => (c.innerText || "").toLowerCase().trim());
      const hasCompany = headers.some((h) => /company|organi/.test(h));
      const hasAction = headers.some((h) => /action/.test(h));
      if (hasCompany && hasAction) {
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

        // Collect all links from any cell, classify by href.
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

  // ---------- Detail page parsing ----------
  const FIELD_MAP = [
    ["designation", /designation|position|role/],
    ["jobDescription", /job ?description|description/],
    ["placeOfPosting", /place ?of ?posting|location|posting/],
    ["cgpa", /cgpa|gpa|cut.?off|minimum ?cgpa/],
    ["branches", /branch|department|stream|course|eligibility/],
    ["ctc", /ctc|package|compensation|total ?pay/],
    ["basePay", /base ?pay|base ?salary|fixed|in ?hand/],
    ["selected", /selected|final ?result|placed|offer/],
    ["dated", /^dated$|posted ?by/],
    ["registrationEnds", /ends ?on|registration|last ?date/],
  ];

  function classifyLabel(text) {
    const t = (text || "").toLowerCase().trim();
    for (const [field, re] of FIELD_MAP) {
      if (re.test(t)) return field;
    }
    return null;
  }

  function parseDetailPage(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const data = {
      type: "",
      designation: "",
      jobDescription: "",
      placeOfPosting: "",
      cgpa: "",
      branches: "",
      ctc: "",
      basePay: "",
      stipendUG: "",
      stipendPG: "",
      otherBenefits: "",
    };

    // Strategy 1: <tr> with label/value cells.
    doc.querySelectorAll("tr").forEach((tr) => {
      const cells = Array.from(tr.querySelectorAll("td, th"));
      if (cells.length < 2) return;
      const labelText = (cells[0].innerText || "").trim();
      const valueText = cells
        .slice(1)
        .map((c) => (c.innerText || "").trim())
        .join(" | ");
      const field = classifyLabel(labelText);
      if (field && !data[field]) data[field] = valueText;
    });

    // Strategy 2: body-text patterns for stipend.
    const bodyText = doc.body ? doc.body.innerText : "";

    const ugMatch = bodyText.match(/For\s+UG\s*₹?\s*([\d,]+)/i);
    if (ugMatch) data.stipendUG = ugMatch[1].replace(/,/g, "");
    const pgMatch = bodyText.match(/For\s+PG\s*₹?\s*([\d,]+)/i);
    if (pgMatch) data.stipendPG = pgMatch[1].replace(/,/g, "");

    // CTC fallback patterns: "CTC: 12 LPA" anywhere
    if (!data.ctc) {
      const ctcMatch = bodyText.match(/CTC[:\s]+([₹\d.,\s]+(?:LPA|Lakh|Lac|Cr|Crore)?)/i);
      if (ctcMatch) data.ctc = ctcMatch[1].trim();
    }
    if (!data.basePay) {
      const bpMatch = bodyText.match(/(?:Base ?Pay|Base ?Salary|Fixed)[:\s]+([₹\d.,\s]+(?:LPA|Lakh|Lac|Cr|Crore)?)/i);
      if (bpMatch) data.basePay = bpMatch[1].trim();
    }

    // CGPA pattern: "CGPA: 7.0" or "Minimum CGPA 6.5"
    if (!data.cgpa) {
      const cgMatch = bodyText.match(/(?:minimum\s+)?CGPA[:\s]+([\d.]+)/i);
      if (cgMatch) data.cgpa = cgMatch[1];
    }

    // Type detection
    if (/six\s*months?\s*internship|internship/i.test(bodyText)) data.type = "Internship";
    if (/full[\s-]?time/i.test(bodyText)) {
      data.type = data.type ? data.type + " / Full-Time" : "Full-Time";
    }

    return data;
  }

  // ---------- Crawler with concurrency limit ----------
  async function fetchWithLimit(urls, concurrency) {
    const results = new Array(urls.length);
    let nextIndex = 0;
    let completed = 0;

    async function worker() {
      while (nextIndex < urls.length) {
        const i = nextIndex++;
        if (!urls[i]) {
          results[i] = null;
        } else {
          try {
            const res = await fetch(urls[i], { credentials: "same-origin" });
            results[i] = res.ok ? await res.text() : null;
          } catch {
            results[i] = null;
          }
        }
        completed++;
        window.__BIT_TNP_PROGRESS__ = `Fetched ${completed}/${urls.length} detail pages`;
      }
    }

    const workers = Array.from(
      { length: Math.min(concurrency, urls.length) },
      worker
    );
    await Promise.all(workers);
    return results;
  }

  // ---------- Branch filter ----------
  const BRANCH_PATTERNS = {
    CSE: [/\bcse\b/i, /computer ?science(?: ?& ?engineering)?/i, /\bcs\b/i],
    AIML: [/aiml/i, /ai ?[&/-] ?ml/i, /ai ?and ?ml/i, /artificial ?intelligence/i, /machine ?learning/i],
    ECE: [/\bece\b/i, /electronics ?(?:& ?communication|and ?communication)?/i, /e ?[&/-] ?c/i],
  };

  function isBranchEligible(detail, enabled) {
    const list = Object.entries(enabled).filter(([, v]) => v).map(([k]) => k);
    if (list.length === 0) return true;
    const haystack = [
      detail.branches || "",
      detail.designation || "",
      detail.jobDescription || "",
    ].join(" ");
    // If the detail page didn't expose a branches field at all, keep the row
    // (false negatives are worse than false positives — user can filter the CSV).
    if (!detail.branches || !detail.branches.trim()) return true;
    return list.some((b) => BRANCH_PATTERNS[b].some((re) => re.test(haystack)));
  }

  // ---------- Compensation parsing ----------
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
    if (row.stipendUG) return parseFloat(row.stipendUG) * 12; // annualize stipend
    return Infinity;
  }

  // ---------- CSV ----------
  const COLUMNS = [
    ["Company", "company"],
    ["Type", "type"],
    ["Designation", "designation"],
    ["Job Description", "jobDescription"],
    ["Place of Posting", "placeOfPosting"],
    ["CGPA Cutoff", "cgpa"],
    ["Branches Allowed", "branches"],
    ["Stipend UG (₹/month)", "stipendUG"],
    ["Stipend PG (₹/month)", "stipendPG"],
    ["Base Pay", "basePay"],
    ["CTC", "ctc"],
    ["Selected (final HR)", "selected"],
    ["Deadline", "deadline"],
    ["Posted On", "postedOn"],
    ["Detail URL", "viewApplyUrl"],
    ["Updates URL", "updatesUrl"],
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
      lines.push(COLUMNS.map(([, k]) => csvEscape(r[k] || "")).join(","));
    }
    return lines.join("\n");
  }

  // ---------- Public API ----------
  window.__BIT_TNP_SCRAPE__ = async function (options) {
    window.__BIT_TNP_PROGRESS__ = "Reading dashboard table...";
    const dashboardRows = extractDashboardRows();
    if (dashboardRows.length === 0) {
      return {
        error: "No dashboard table found. Make sure you are on the Recent Jobs page.",
        rawCount: 0,
      };
    }

    window.__BIT_TNP_PROGRESS__ = `Found ${dashboardRows.length} companies. Fetching detail pages...`;
    const urls = dashboardRows.map((r) => r.viewApplyUrl);
    const htmls = await fetchWithLimit(urls, 5);

    const merged = dashboardRows.map((row, i) => {
      const detail = htmls[i] ? parseDetailPage(htmls[i]) : {};
      return { ...row, ...detail };
    });

    const filtered = merged.filter((r) => isBranchEligible(r, options.branches));

    const sorted = filtered
      .map((r) => ({ ...r, _comp: compensationValue(r) }))
      .sort((a, b) => a._comp - b._comp);

    window.__BIT_TNP_PROGRESS__ = `Done. ${sorted.length} rows in output.`;

    return {
      rawCount: dashboardRows.length,
      detailFetched: htmls.filter(Boolean).length,
      afterBranch: filtered.length,
      csv: toCSV(sorted),
    };
  };

  window.__BIT_TNP_INSPECT__ = function () {
    const rows = extractDashboardRows();
    const lines = [];
    lines.push(`Dashboard rows found: ${rows.length}`);
    if (rows.length > 0) {
      lines.push("");
      lines.push("First row sample:");
      lines.push(JSON.stringify(rows[0], null, 2));
      if (rows.length > 1) {
        lines.push("");
        lines.push(`(+ ${rows.length - 1} more rows)`);
      }
    }
    return lines.join("\n");
  };

  window.__BIT_TNP_GET_PROGRESS__ = function () {
    return window.__BIT_TNP_PROGRESS__ || "";
  };
})();
