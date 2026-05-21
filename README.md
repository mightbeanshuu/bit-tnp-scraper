# JUST TNP Scraper v2.0.0

A Chrome extension that scrapes the BIT Mesra Training & Placement portal, filters companies by branch (CSE / AIML / ECE), filters by academic year, sorts by CTC ascending, and exports the result as a CSV that opens directly in Excel.

## What it captures

For every company listed on the active TNP page:

- Company name
- JD / role / profile
- CGPA cutoff
- Branches allowed
- Stipend (UG)
- Base pay
- CTC
- Students selected in final HR (names + branches, when visible)
- Academic year
- Drive date

## Filters and ordering

- **Year**: configurable from the popup (default `25-26`, also matches `2025-26` and `2025-2026`).
- **Branches**: OR filter across CSE, AIML, ECE — toggleable in the popup. A company is kept if it allows any of the selected branches.
- **Sort**: ascending by CTC. CTC strings like `12 LPA`, `12,00,000`, `₹12 Lakhs`, `1.2 Cr` are all parsed to a numeric value before sorting.

## Install

1. Clone this repo or download as a folder.
2. Open Chrome and go to `chrome://extensions/`.
3. Toggle **Developer mode** (top right).
4. Click **Load unpacked** and select the project folder.
5. Pin the extension to the toolbar.

## Use

1. Log in to `tnp.bitmesra.ac.in` and open the page that lists companies.
2. Click the extension icon.
3. Adjust the academic year and branch filters if needed.
4. Click **Scrape current page** — a CSV download starts.

Open the CSV in Excel, Numbers, or Google Sheets.

## Debugging the scraper

The portal's DOM may use slightly different column labels than the defaults. If the CSV comes out with empty columns:

1. Click **Inspect DOM (debug)** in the popup.
2. Read the headers it detected and how they mapped.
3. Adjust the `FIELD_PATTERNS` regex map in `content.js` to match the actual column names.

## How it works

Three-stage crawl, all client-side, all using your existing logged-in session cookies.

1. **Dashboard scrape** — reads the Recent Jobs table on `tp.bitmesra.co.in` and extracts each company row, its `/job/info/<hash>` (View & Apply) URL, and its `/job/notice/<hash>` (Updates) URL.
2. **Detail page crawl** — fetches each `/job/info/<hash>` (5 in parallel) and parses the labelled sections: JOB PROFILE DETAILS (Designation, Description, Place of Posting), STIPEND DETAILS (UG/PG), SALARY/CTC DETAILS (CTC, Base Pay), ELIGIBILITY (Courses, UG/PG Criteria), COMPANY DETAILS (URL, Year of Establishment).
3. **Result crawl** — for each company that passes the branch filter, fetches the notice page, finds the `/resultlist/<id>/<hash>` link labelled "Final" (or HR-round equivalent), fetches it, and parses the Selected Candidates table into a name/branch list plus a per-branch tally.

Rows are then filtered by the selected branches (CSE / AIML / ECE — OR logic against the `Eligible Courses` pills) and sorted ascending by compensation (CTC if present, else base pay, else annualised UG stipend).

No data leaves the browser. Nothing is sent to any external server.

## Limitations and caveats

- The year filter is handled by the portal's own "Placement Year" dropdown — set it to `2025-26` before scraping.
- The dashboard's "Show N entries" pagination is honoured as-is. Set it to a high number (e.g. 100) before scraping if there are more than 25 listings.
- "Final-round selected candidates" picks the result link whose label contains `Final` (preferred) or `HR`, falling back to the most recent result link. If a company has multiple final rounds (e.g. separate Mechanical / MBA tracks), only one is captured per company by design — uncheck "Include final-round selected candidates" to skip results entirely and run faster.
- Compensation parsing handles `LPA`, `Lakh`, `Cr`, plain rupees, and per-month stipends (annualised by ×12). Unusual formats may fall back to `Infinity` and sort to the bottom.

## Project layout

```
bit-tnp-scraper/
  manifest.json      MV3 manifest
  popup.html         extension popup UI
  popup.js           popup logic + download trigger
  content.js         scraper, filters, sort, CSV generation
  background.js      service worker (reserved)
  icons/             extension icons
```

## License

MIT
