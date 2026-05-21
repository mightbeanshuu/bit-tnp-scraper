// BIT TNP Scraper — content script
// Exposes two globals: __BIT_TNP_SCRAPE__(options) and __BIT_TNP_INSPECT__()

(function () {
  if (window.__BIT_TNP_LOADED__) return;
  window.__BIT_TNP_LOADED__ = true;

  // ---------- Header mapping ----------
  // Each canonical field maps to a list of regex patterns matched against header text (lowercased).
  const FIELD_PATTERNS = {
    company: [/company/, /organi[sz]ation/, /recruiter/, /^name$/],
    jd: [/job ?description/, /^jd$/, /role/, /profile/, /designation/],
    cgpa: [/cgpa/, /gpa/, /cut.?off/, /eligibility/],
    branches: [/branch/, /eligible/, /department/, /stream/],
    stipend: [/stipend/, /internship/],
    basePay: [/base ?pay/, /base ?salary/, /fixed/, /in ?hand/],
    ctc: [/ctc/, /package/, /salary/, /compensation/],
    selected: [/selected/, /placed/, /offer/, /final/, /shortlist/],
    year: [/year/, /session/, /batch/, /academic/],
    date: [/date/, /drive/, /scheduled/],
  };

  function classifyHeader(text) {
    const t = (text || "").toLowerCase().trim();
    for (const [field, patterns] of Object.entries(FIELD_PATTERNS)) {
      if (patterns.some((p) => p.test(t))) return field;
    }
    return null;
  }

  // ---------- Table discovery ----------
  function getHeaderTexts(table) {
    // Look for thead first, then first tr.
    let headerCells = table.querySelectorAll("thead th, thead td");
    if (headerCells.length === 0) {
      const firstRow = table.querySelector("tr");
      if (firstRow) headerCells = firstRow.querySelectorAll("th, td");
    }
    return Array.from(headerCells).map((c) => c.innerText || c.textContent || "");
  }

  function scoreTable(table) {
    const headers = getHeaderTexts(table);
    let score = 0;
    const map = {};
    headers.forEach((h, i) => {
      const field = classifyHeader(h);
      if (field && !(field in map)) {
        map[field] = i;
        score++;
      }
    });
    return { score, map, headers };
  }

  function findBestTable() {
    const tables = Array.from(document.querySelectorAll("table"));
    let best = null;
    for (const t of tables) {
      const { score, map, headers } = scoreTable(t);
      if (!best || score > best.score) {
        best = { table: t, score, map, headers };
      }
    }
    return best;
  }

  // ---------- Row extraction ----------
  function extractRows(table, headerMap) {
    const allRows = Array.from(table.querySelectorAll("tr"));
    // Skip header row(s): any tr inside thead, plus the first tr if no thead.
    const hasThead = !!table.querySelector("thead");
    const dataRows = hasThead
      ? allRows.filter((r) => !r.closest("thead"))
      : allRows.slice(1);

    return dataRows
      .map((tr) => {
        const cells = Array.from(tr.querySelectorAll("td, th")).map((c) =>
          (c.innerText || c.textContent || "").trim()
        );
        if (cells.length === 0) return null;
        const row = { _raw: cells };
        for (const [field, idx] of Object.entries(headerMap)) {
          row[field] = cells[idx] || "";
        }
        return row;
      })
      .filter(Boolean);
  }

  // ---------- Filtering ----------
  function rowMatchesYear(row, year) {
    if (!year) return true;
    const norm = (s) => s.toLowerCase().replace(/\s+/g, "");
    const target = norm(year);
    const variants = new Set([target]);
    // 25-26 -> 2025-26, 2025-2026
    const m = target.match(/^(\d{2})-(\d{2})$/);
    if (m) {
      variants.add(`20${m[1]}-${m[2]}`);
      variants.add(`20${m[1]}-20${m[2]}`);
    }
    const allText = norm(row._raw.join(" "));
    for (const v of variants) if (allText.includes(v)) return true;
    return false;
  }

  const BRANCH_PATTERNS = {
    CSE: [/\bcse\b/i, /\bcs\b/i, /computer ?science/i, /\bit\b/i, /information ?tech/i],
    AIML: [/aiml/i, /ai ?& ?ml/i, /ai ?and ?ml/i, /artificial ?intelligence/i, /machine ?learning/i],
    ECE: [/\bece\b/i, /\bec\b/i, /electronics/i, /e ?& ?c/i, /e ?and ?c/i],
  };

  function rowMatchesBranch(row, enabledBranches) {
    const enabled = Object.entries(enabledBranches)
      .filter(([, v]) => v)
      .map(([k]) => k);
    if (enabled.length === 0) return true;
    const branchText = (row.branches || row._raw.join(" ")) + "";
    return enabled.some((b) => BRANCH_PATTERNS[b].some((re) => re.test(branchText)));
  }

  // ---------- CTC parsing & sort ----------
  function parseCTC(s) {
    if (!s) return Infinity;
    const t = s.toString().toLowerCase().replace(/,/g, "").replace(/₹/g, "").trim();
    // Try LPA / Lakh patterns: "12 lpa", "12 lakh", "12 l"
    let m = t.match(/(\d+(?:\.\d+)?)\s*(lpa|lakh|lac|l\b)/);
    if (m) return parseFloat(m[1]) * 100000;
    // Crore
    m = t.match(/(\d+(?:\.\d+)?)\s*(cr|crore)/);
    if (m) return parseFloat(m[1]) * 10000000;
    // Plain number — assume rupees if >= 100000, else assume lakhs.
    m = t.match(/(\d+(?:\.\d+)?)/);
    if (m) {
      const n = parseFloat(m[1]);
      return n >= 100000 ? n : n * 100000;
    }
    return Infinity;
  }

  function sortByCTCAsc(rows) {
    return rows
      .map((r) => ({ ...r, _ctcNum: parseCTC(r.ctc) }))
      .sort((a, b) => a._ctcNum - b._ctcNum);
  }

  // ---------- CSV ----------
  const CSV_FIELDS = [
    "company",
    "jd",
    "cgpa",
    "branches",
    "stipend",
    "basePay",
    "ctc",
    "selected",
    "year",
    "date",
  ];
  const CSV_HEADERS = [
    "Company",
    "JD / Role",
    "CGPA Cutoff",
    "Branches Allowed",
    "Stipend (UG)",
    "Base Pay",
    "CTC",
    "Selected (names + branch)",
    "Academic Year",
    "Drive Date",
  ];

  function csvEscape(s) {
    if (s == null) return "";
    const str = String(s).replace(/\r?\n/g, " ");
    if (/[",]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
  }

  function toCSV(rows) {
    const lines = [CSV_HEADERS.map(csvEscape).join(",")];
    for (const r of rows) {
      lines.push(CSV_FIELDS.map((f) => csvEscape(r[f] || "")).join(","));
    }
    return lines.join("\n");
  }

  // ---------- Public API ----------
  window.__BIT_TNP_SCRAPE__ = function (options) {
    const best = findBestTable();
    if (!best || best.score < 2) {
      return {
        rawCount: 0,
        afterYear: 0,
        afterBranch: 0,
        csv: toCSV([]),
        warning: "No suitable table found. Use Inspect to see what's on the page.",
      };
    }

    const rows = extractRows(best.table, best.map);
    const rawCount = rows.length;

    const yearFiltered = options.yearFilter
      ? rows.filter((r) => rowMatchesYear(r, options.yearFilter))
      : rows;

    const branchFiltered = yearFiltered.filter((r) => rowMatchesBranch(r, options.branches));

    const sorted = sortByCTCAsc(branchFiltered);

    return {
      rawCount,
      afterYear: yearFiltered.length,
      afterBranch: branchFiltered.length,
      csv: toCSV(sorted),
      detectedFields: Object.keys(best.map),
    };
  };

  window.__BIT_TNP_INSPECT__ = function () {
    const tables = Array.from(document.querySelectorAll("table"));
    const lines = [];
    lines.push(`Tables found: ${tables.length}`);
    tables.forEach((t, i) => {
      const { score, map, headers } = scoreTable(t);
      lines.push(`\nTable #${i + 1}: score=${score}, rows=${t.querySelectorAll("tr").length}`);
      lines.push(`  headers: ${headers.map((h) => h.trim()).filter(Boolean).slice(0, 12).join(" | ")}`);
      lines.push(`  mapped: ${JSON.stringify(map)}`);
    });
    if (tables.length === 0) {
      // Try to suggest card-based scrape targets.
      const cards = document.querySelectorAll('[class*="company" i], [class*="card" i]');
      lines.push(`\nNo tables. Possible card-like elements: ${cards.length}`);
    }
    return lines.join("\n");
  };
})();
