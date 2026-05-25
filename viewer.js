// State
let allRows = [];
let filteredRows = [];
let viewMode = 'grid'; // 'grid' | 'list'
let selectedBranches = new Set();
let maxCtcPossible = 100;
let currentMinCtc = 0;
let currentMaxCtc = 100;

const branchList = ["CSE", "ECE", "EEE", "MECH", "CIVIL", "PROD", "CHEM", "BIO", "AIML", "MnC", "PHY", "QED"];

// DOM Elements
const $ = id => document.getElementById(id);
const searchInput = $('searchInput');
const clearSearch = $('clearSearch');
const sortBySelect = $('sortBySelect');
const branchToggleBtn = $('branchToggleBtn');
const branchDropdown = $('branchDropdown');
const branchCheckboxContainer = $('branchCheckboxContainer');
const resetBranchesBtn = $('resetBranchesBtn');
const selectedBranchesLabel = $('selectedBranchesLabel');
const viewModeList = $('viewModeList');
const viewModeGrid = $('viewModeGrid');
const exportCsvBtn = $('exportCsvBtn');
const printDossierBtn = $('printDossierBtn');
const minCbcSlider = $('minCbcSlider');
const maxCbcSlider = $('maxCbcSlider');
const sliderTrackActive = $('sliderTrackActive');
const sliderValueLabel = $('sliderValueLabel');
const noticesContainer = $('noticesContainer');
const btnGenerateInsights = $('btnGenerateInsights');
const aiReportWrap = $('aiReportWrap');
const aiReportBox = $('aiReportBox');
const aiBtnText = $('aiBtnText');

// Utilities
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]);
}

function parseLPA(r) {
  if (typeof r.annualCTC === "number" && isFinite(r.annualCTC)) {
    return r.annualCTC / 100000;
  }
  return 0; // default to 0 if unknown
}

function extractBranches(r) {
  const str = (r.courses || r.matchingCourses || r.criteriaUG || "").toUpperCase();
  const rawList = ["CSE", "ECE", "EEE", "IT", "MECH", "CIVIL", "PROD", "CHEM", "BIO", "PIE", "AI", "MATH", "PHY", "QED"];
  const branchAliases = { "IT": "CSE", "PIE": "PROD", "AI": "AIML", "MATH": "MnC" };
  const matches = rawList.filter(b => str.includes(b));
  const mapped = matches.map(b => branchAliases[b] || b);
  return [...new Set(mapped)];
}

function formatLPA(val) {
  if (val == null || isNaN(val) || val === 0) return "N/A";
  return `₹${val.toFixed(2)} LPA`;
}

// Initialization
(async () => {
  try {
    const v = chrome.runtime.getManifest()?.version;
    if (v) $('versionPill').textContent = "v" + v;
  } catch {}

  const data = await chrome.storage.local.get(["lastScrape", "filterMin", "filterMax"]);
  const last = data.lastScrape;

  if (!last || !last.rows || !last.rows.length) {
    noticesContainer.innerHTML = `<div class="col-span-full text-center text-zinc-500 py-10">No scrape data found yet. Run a scrape from the extension popup first.</div>`;
    return;
  }
  
  allRows = last.rows.map(r => ({
    ...r,
    lpa: parseLPA(r),
    branchArr: extractBranches(r)
  }));
  
  initDualSlider(data.filterMin, data.filterMax);
  initBranchDropdown();
  bindEvents();
  
  applyFiltersAndRender();
})();

function initDualSlider(savedMin, savedMax) {
  if (!minCbcSlider || !maxCbcSlider) return;
  const valid = allRows.map(r => r.lpa).filter(v => v > 0);
  maxCtcPossible = valid.length ? Math.ceil(Math.max(...valid)) : 100;
  
  // Parse inputs handles strings/numbers/NaNs nicely
  let parsedMin = parseFloat(savedMin);
  let parsedMax = parseFloat(savedMax);
  
  currentMinCtc = (!isNaN(parsedMin)) ? parsedMin : 0;
  currentMaxCtc = (!isNaN(parsedMax)) ? parsedMax : maxCtcPossible;

  if (currentMaxCtc > maxCtcPossible) currentMaxCtc = maxCtcPossible;
  if (currentMinCtc > currentMaxCtc) currentMinCtc = 0;

  minCbcSlider.max = maxCtcPossible;
  maxCbcSlider.max = maxCtcPossible;
  minCbcSlider.value = currentMinCtc;
  maxCbcSlider.value = currentMaxCtc;

  updateSliderUI();
}

function updateSliderUI() {
  const minPercent = (currentMinCtc / maxCtcPossible) * 100;
  const maxPercent = (currentMaxCtc / maxCtcPossible) * 100;
  sliderTrackActive.style.left = `${minPercent}%`;
  sliderTrackActive.style.right = `${100 - maxPercent}%`;
  sliderValueLabel.textContent = `₹${currentMinCtc} LPA - ₹${currentMaxCtc}${currentMaxCtc === maxCtcPossible ? '+' : ''} LPA`;
}

function initBranchDropdown() {
  branchCheckboxContainer.innerHTML = '';
  branchList.forEach(br => {
    const lbl = document.createElement('label');
    lbl.className = 'flex items-center justify-between p-1.5 hover:bg-[#1e1e24] rounded cursor-pointer transition-colors';
    lbl.innerHTML = `
      <span class="text-xs text-zinc-300 font-medium">${br}</span>
      <input type="checkbox" value="${br}" class="form-checkbox text-zinc-500 rounded bg-[#0b0b0e] border-[#27272a] focus:ring-0 focus:ring-offset-0 w-3.5 h-3.5">
    `;
    const cb = lbl.querySelector('input');
    cb.addEventListener('change', (e) => {
      if (e.target.checked) selectedBranches.add(br);
      else selectedBranches.delete(br);
      updateBranchLabel();
      applyFiltersAndRender();
    });
    branchCheckboxContainer.appendChild(lbl);
  });
}

function updateBranchLabel() {
  if (selectedBranches.size === 0) {
    selectedBranchesLabel.textContent = 'Branches: All Active';
    selectedBranchesLabel.classList.remove('text-white');
  } else {
    selectedBranchesLabel.textContent = `Branches: ${selectedBranches.size} Selected`;
    selectedBranchesLabel.classList.add('text-white');
  }
}

function bindEvents() {
  searchInput.addEventListener('input', () => {
    clearSearch.classList.toggle('hidden', searchInput.value.trim() === '');
    applyFiltersAndRender();
  });
  
  clearSearch.addEventListener('click', () => {
    searchInput.value = '';
    clearSearch.classList.add('hidden');
    applyFiltersAndRender();
  });

  sortBySelect.addEventListener('change', applyFiltersAndRender);

  branchToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    branchDropdown.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!branchToggleBtn.contains(e.target) && !branchDropdown.contains(e.target)) {
      branchDropdown.classList.add('hidden');
    }
  });

  resetBranchesBtn.addEventListener('click', () => {
    selectedBranches.clear();
    branchCheckboxContainer.querySelectorAll('input').forEach(cb => cb.checked = false);
    updateBranchLabel();
    applyFiltersAndRender();
  });

  if (minCbcSlider) {
    minCbcSlider.addEventListener('input', (e) => {
      let val = parseFloat(e.target.value);
      if (val > currentMaxCtc) { val = currentMaxCtc; minCbcSlider.value = val; }
      currentMinCtc = val;
      updateSliderUI();
      applyFiltersAndRender();
    });
  }

  if (maxCbcSlider) {
    maxCbcSlider.addEventListener('input', (e) => {
      let val = parseFloat(e.target.value);
      if (val < currentMinCtc) { val = currentMinCtc; maxCbcSlider.value = val; }
      currentMaxCtc = val;
      updateSliderUI();
      applyFiltersAndRender();
    });
  }

  viewModeGrid.addEventListener('click', () => {
    viewMode = 'grid';
    viewModeGrid.className = 'px-3 py-1 rounded-sm text-xs font-semibold flex items-center gap-1.5 transition-all bg-[#27272a] text-white';
    viewModeList.className = 'px-3 py-1 rounded-sm text-xs font-semibold flex items-center gap-1.5 transition-all text-zinc-500 hover:text-white';
    renderCards();
  });

  viewModeList.addEventListener('click', () => {
    viewMode = 'list';
    viewModeList.className = 'px-3 py-1 rounded-sm text-xs font-semibold flex items-center gap-1.5 transition-all bg-[#27272a] text-white';
    viewModeGrid.className = 'px-3 py-1 rounded-sm text-xs font-semibold flex items-center gap-1.5 transition-all text-zinc-500 hover:text-white';
    renderCards();
  });

  if ($('themeToggleBtn')) {
    const htmlEl = document.documentElement;
    const themeIconDark = $('themeIconDark');
    const themeIconLight = $('themeIconLight');
    
    // Initialize icons based on current theme
    if (htmlEl.classList.contains('dark')) {
      themeIconLight.classList.remove('hidden');
    } else {
      themeIconDark.classList.remove('hidden');
    }

    $('themeToggleBtn').addEventListener('click', () => {
      htmlEl.classList.toggle('dark');
      const isDark = htmlEl.classList.contains('dark');
      if (isDark) {
        themeIconLight.classList.remove('hidden');
        themeIconDark.classList.add('hidden');
      } else {
        themeIconDark.classList.remove('hidden');
        themeIconLight.classList.add('hidden');
      }
      // Re-render chart to update colors based on theme if necessary
      // For now the SVG colors are static or handled via CSS
    });
  }

  $('modalCloseBtn').addEventListener('click', closeDetailsModal);
  $('modalOverlay').addEventListener('click', closeDetailsModal);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetailsModal(); });
  
  exportCsvBtn.addEventListener('click', triggerCSVDownload);
  printDossierBtn.addEventListener('click', triggerDossierPrint);
  btnGenerateInsights.addEventListener('click', generateStructuredReport);
}

function applyFiltersAndRender() {
  const term = searchInput.value.toLowerCase().trim();
  
  filteredRows = allRows.filter(r => {
    const matchesSearch = !term || 
      (r.company && r.company.toLowerCase().includes(term)) || 
      (r.designation && r.designation.toLowerCase().includes(term)) ||
      (r.skillSet && r.skillSet.toLowerCase().includes(term)) ||
      (r.jobDescription && r.jobDescription.toLowerCase().includes(term));
    
    // Include 0/unknown CTCs if slider min is 0
    let matchesCtc = false;
    if (r.lpa === 0 && currentMinCtc === 0) matchesCtc = true;
    else if (r.lpa >= currentMinCtc && r.lpa <= currentMaxCtc) matchesCtc = true;
    if (currentMaxCtc === maxCtcPossible && r.lpa > currentMaxCtc) matchesCtc = true;

    let matchesBranch = true;
    if (selectedBranches.size > 0) {
      matchesBranch = r.branchArr.some(b => selectedBranches.has(b));
    }

    return matchesSearch && matchesCtc && matchesBranch;
  });

  const sortVal = sortBySelect.value;
  if (sortVal === 'ctc-desc') filteredRows.sort((a,b) => b.lpa - a.lpa);
  else if (sortVal === 'ctc-asc') filteredRows.sort((a,b) => a.lpa - b.lpa);
  else if (sortVal === 'selected-desc') filteredRows.sort((a,b) => (b.selectedCount || 0) - (a.selectedCount || 0));
  else if (sortVal === 'applicants-desc') filteredRows.sort((a,b) => (b.applicantCount || 0) - (a.applicantCount || 0));
  else if (sortVal === 'company-asc') filteredRows.sort((a,b) => (a.company || '').localeCompare(b.company || ''));

  updateStats();
  drawHistogram();
  drawDonutChart();
  renderCards();
}

function updateStats() {
  $('statCompanyCount').textContent = filteredRows.length;
  $('statCompanyTotalLabel').textContent = `of ${allRows.length} registered notices`;

  const validCtcs = filteredRows.filter(r => r.lpa > 0).map(r => r.lpa).sort((a,b) => a - b);
  if (validCtcs.length > 0) {
    const avg = validCtcs.reduce((a,b) => a + b, 0) / validCtcs.length;
    const median = validCtcs[Math.floor(validCtcs.length / 2)];
    const highest = filteredRows.slice().sort((a,b) => b.lpa - a.lpa)[0];
    
    $('statAvgPackage').textContent = `₹${avg.toFixed(2)} LPA`;
    $('statMedianPackage').textContent = `Median: ₹${median.toFixed(2)} LPA`;
    $('statHighestCompany').textContent = highest.company;
    $('statHighestValue').textContent = `₹${highest.lpa.toFixed(2)} LPA`;
  } else {
    $('statAvgPackage').textContent = 'N/A';
    $('statMedianPackage').textContent = 'Median: N/A';
    $('statHighestCompany').textContent = 'N/A';
    $('statHighestValue').textContent = 'N/A';
  }

  const totalApp = filteredRows.reduce((sum, r) => sum + (r.applicantCount || 0), 0);
  const totalSel = filteredRows.reduce((sum, r) => sum + (r.selectedCount || 0), 0);
  $('statTotalApplicants').textContent = totalApp;
  $('statTotalSelects').textContent = totalSel;
  $('statConversionRate').textContent = totalApp > 0 ? `${((totalSel / totalApp) * 100).toFixed(1)}% conversion rate` : '0% conversion rate';
}

function barChartSVG(items, w = 320, h = 160) {
  if (items.length === 0 || items.every((i) => i.value === 0)) return null;
  const max = Math.max(...items.map((i) => i.value)) || 1;
  const padL = 24, padR = 8, padT = 18, padB = 32;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;
  const gap = 16;
  const barW = Math.max(8, (chartW - gap * (items.length - 1)) / items.length);
  const bars = items.map((it, idx) => {
    const x = padL + idx * (barW + gap);
    
    let rectHtml = '';
    if (it.value > 0) {
      // Use a subtle 4px radius on all corners and a 3px gap from the axis
      const barH = Math.max(8, (it.value / max) * (chartH - 3)); 
      const y = padT + chartH - barH - 3; // 3px gap from the bottom axis line
      rectHtml = `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="#506385" rx="4" />`;
    }
    
    return `
      ${rectHtml}
      <text x="${(x + barW / 2).toFixed(1)}" y="${(padT + chartH + 20).toFixed(1)}" text-anchor="middle" font-size="8" fill="#a1a1aa" font-weight="400">${escapeHtml(it.label)}</text>
    `;
  }).join("");
  return `<svg width="100%" height="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
    <line x1="${padL - 10}" y1="${padT + chartH}" x2="${padL + chartW + 10}" y2="${padT + chartH}" stroke="#27272a" stroke-width="0" stroke-linecap="round"/>
    ${bars}
  </svg>`;
}

function drawHistogram() {
  const container = $('histogramContainer');
  container.innerHTML = '';
  if (filteredRows.length === 0) return;

  const validCtcs = filteredRows.map(r => r.lpa).filter(v => v > 0);
  if (validCtcs.length === 0) {
    container.innerHTML = `<div class="chart-empty text-zinc-500 text-xs my-auto w-full text-center py-8">No CTC data in the current filter</div>`;
    return;
  }

  const buckets = [
    { label: '<3L', min: 0, max: 3, value: 0 },
    { label: '3-6L', min: 3, max: 6, value: 0 },
    { label: '6-10L', min: 6, max: 10, value: 0 },
    { label: '10-20L', min: 10, max: 20, value: 0 },
    { label: '20-40L', min: 20, max: 40, value: 0 },
    { label: '40L+', min: 40, max: Infinity, value: 0 }
  ];

  validCtcs.forEach(val => {
    const b = buckets.find(b => val >= b.min && val < b.max);
    if (b) b.value++;
  });

  const svg = barChartSVG(buckets);
  container.innerHTML = svg || `<div class="chart-empty text-zinc-500 text-xs my-auto w-full text-center py-8">No CTC data in the current filter</div>`;
}

function drawDonutChart() {
  const svg = $('donutSvg');
  const legend = $('donutLegend');
  const centerCount = $('donutCenterCount');
  
  svg.innerHTML = '<circle cx="18" cy="18" r="15.915" fill="transparent" stroke="#232328" stroke-width="3"></circle>';
  legend.innerHTML = '';
  centerCount.textContent = '0';

  if (filteredRows.length === 0) return;

  const branchCounts = {};
  let totalHires = 0;

  const shortBranchName = (name) => {
    const map = {
      'COMPUTER SCIENCE & ENGINEERING': 'CSE',
      'INFORMATION TECHNOLOGY': 'CSE',
      'ELECTRONICS & COMMUNICATION ENGINEERING': 'ECE',
      'ELECTRICAL & ELECTRONICS ENGINEERING': 'EEE',
      'MECHANICAL ENGINEERING': 'MECH',
      'CIVIL ENGINEERING': 'CIVIL',
      'ARTIFICIAL INTELLIGENCE AND MACHINE LEARNING': 'AIML',
      'ARTIFICIAL INTELLIGENCE': 'AIML',
      'AI': 'AIML',
      'CHEMICAL ENGINEERING': 'CHEM',
      'PRODUCTION ENGINEERING': 'PROD',
      'PRODUCTION AND INDUSTRIAL ENGINEERING': 'PROD',
      'PIE': 'PROD',
      'BIOTECHNOLOGY': 'BIO',
      'MATHEMATICS AND COMPUTING': 'MnC',
      'MATHEMATICS': 'MnC',
      'MATH': 'MnC',
      'PHYSICS': 'PHY',
      'QED': 'QED'
    };
    const upper = name.toUpperCase().trim();
    if (map[upper]) return map[upper];
    if (upper.split(' ').length > 1) return upper.split(' ').map(w => w[0]).join('');
    return upper;
  };

  filteredRows.forEach(r => {
    if (r.selectedByBranch) {
      r.selectedByBranch.split(',').forEach(s => {
        const m = s.trim().match(/^(.+):\s*(\d+)$/);
        if (m) {
          const rawBr = m[1].trim();
          const br = shortBranchName(rawBr);
          const cnt = parseInt(m[2]);
          branchCounts[br] = (branchCounts[br] || 0) + cnt;
          totalHires += cnt;
        }
      });
    }
  });

  centerCount.textContent = totalHires;
  if (totalHires === 0) {
    legend.innerHTML = '<div class="text-xs text-zinc-600 italic">No hiring data</div>';
    return;
  }

  const sorted = Object.entries(branchCounts).sort((a,b) => b[1] - a[1]);
  const colors = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#14b8a6', '#6366f1', '#eab308', '#f43f5e'];

  let cumulativePercent = 0;
  sorted.slice(0, 8).forEach(([br, cnt], idx) => {
    const color = colors[idx % colors.length];
    const percent = (cnt / totalHires) * 100;
    const offset = 100 - cumulativePercent + 25;
    const shortBr = shortBranchName(br);

    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", "18");
    circle.setAttribute("cy", "18");
    circle.setAttribute("r", "15.915");
    circle.setAttribute("fill", "transparent");
    circle.setAttribute("stroke", color);
    circle.setAttribute("stroke-width", "3");
    circle.setAttribute("stroke-dasharray", `${percent} ${100 - percent}`);
    circle.setAttribute("stroke-dashoffset", offset);
    svg.appendChild(circle);

    cumulativePercent += percent;

    legend.innerHTML += `
      <div class="flex items-center justify-between text-[10px]">
        <div class="flex items-center gap-1.5">
          <span class="w-2 h-2 rounded-full" style="background-color: ${color}"></span>
          <span class="text-zinc-400 font-semibold uppercase tracking-wider">${shortBr}</span>
        </div>
        <span class="text-white font-mono font-bold">${cnt}</span>
      </div>
    `;
  });
}

function renderCards() {
  noticesContainer.innerHTML = '';
  
  if (filteredRows.length === 0) {
    noticesContainer.innerHTML = `<div class="col-span-full py-16 text-center text-zinc-500 text-sm">No notices matched your criteria.</div>`;
    return;
  }

  noticesContainer.className = viewMode === 'grid' 
    ? 'md:col-span-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 transition-all duration-300'
    : 'md:col-span-4 grid grid-cols-1 gap-3 transition-all duration-300';

  filteredRows.forEach((r, idx) => {
    const card = document.createElement('div');
    card.className = viewMode === 'grid'
      ? 'bg-[#141418] border border-[#1e1e24] hover:border-zinc-700 transition-colors rounded-lg overflow-hidden flex flex-col group cursor-pointer'
      : 'bg-[#141418] border border-[#1e1e24] hover:border-zinc-700 transition-colors rounded-lg overflow-hidden flex flex-col sm:flex-row sm:items-center group cursor-pointer p-4 gap-4';

    const pay = r.annualCTCDisplay || (r.lpa ? formatLPA(r.lpa) : (r.stipendUG ? `₹${r.stipendUG}/mo` : 'N/A'));
    const initial = (r.company || 'C').charAt(0).toUpperCase();
    const typeLabel = r.type ? `<span class="bg-zinc-800 text-zinc-300 px-2 py-0.5 rounded text-[9px] font-semibold tracking-wide uppercase border border-zinc-700">${escapeHtml(r.type)}</span>` : '';
    const branches = r.branchArr.length > 0 ? `<span class="text-[10px] text-zinc-400 font-medium truncate max-w-[120px]">${r.branchArr.join(', ')}</span>` : '';
    
    let statsHtml = '';
    if (r.applicantCount || r.selectedCount) {
      statsHtml = `
        <div class="flex items-center gap-2 mt-3 pt-3 border-t border-zinc-800/60">
          ${r.applicantCount ? `<div class="text-[10px] text-zinc-500 font-medium"><strong class="text-zinc-300">${r.applicantCount}</strong> applied</div>` : ''}
          ${r.applicantCount && r.selectedCount ? `<svg class="w-3 h-3 text-zinc-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"/></svg>` : ''}
          ${r.selectedCount ? `<div class="text-[10px] text-emerald-500 font-bold bg-emerald-500/10 px-1.5 py-0.5 rounded"><strong class="text-emerald-400">${r.selectedCount}</strong> offers</div>` : ''}
        </div>
      `;
    }

    if (viewMode === 'grid') {
      card.innerHTML = `
        <div class="p-4 flex-grow flex flex-col">
          <div class="flex items-start justify-between mb-3 gap-2">
            <div class="w-10 h-10 rounded bg-[#1c1c24] border border-[#2d2d39] flex items-center justify-center flex-shrink-0 text-white font-bold font-space">${initial}</div>
            <div class="flex flex-col items-end gap-1 text-right">
              ${typeLabel}
              ${branches}
            </div>
          </div>
          <div>
            <h3 class="text-base font-bold text-white leading-tight font-space">${escapeHtml(r.company)}</h3>
            <p class="text-xs text-zinc-400 mt-1 line-clamp-1 font-mono">${escapeHtml(r.designation || 'Open Role')}</p>
          </div>
          <div class="mt-4 mb-2">
            <span class="text-xl font-extrabold text-white font-mono tracking-tight">${escapeHtml(pay)}</span>
          </div>
          ${statsHtml}
        </div>
      `;
    } else {
      card.innerHTML = `
        <div class="w-10 h-10 rounded bg-[#1c1c24] border border-[#2d2d39] flex items-center justify-center flex-shrink-0 text-white font-bold font-space sm:self-start">${initial}</div>
        <div class="flex-grow min-w-0">
          <div class="flex items-center gap-2 mb-1">
            <h3 class="text-base font-bold text-white leading-tight font-space truncate">${escapeHtml(r.company)}</h3>
            ${typeLabel}
          </div>
          <p class="text-xs text-zinc-400 truncate font-mono">${escapeHtml(r.designation || 'Open Role')} <span class="mx-1 opacity-50">•</span> ${branches}</p>
        </div>
        <div class="flex-shrink-0 text-right min-w-[120px]">
          <span class="text-lg font-extrabold text-white font-mono block">${escapeHtml(pay)}</span>
        </div>
        <div class="flex-shrink-0 min-w-[140px] flex justify-end">
          ${r.selectedCount ? `<div class="text-[10px] text-emerald-500 font-bold bg-emerald-500/10 px-2 py-1 rounded border border-emerald-500/20">${r.selectedCount} offers extended</div>` : (r.applicantCount ? `<div class="text-[10px] text-zinc-400 bg-zinc-800 px-2 py-1 rounded">${r.applicantCount} applicants</div>` : '')}
        </div>
      `;
    }

    card.addEventListener('click', () => openDetailsModal(r));
    noticesContainer.appendChild(card);
  });
}

function openDetailsModal(r) {
  $('modalType').textContent = r.type || 'NOTICE';
  $('modalCompany').textContent = r.company;
  $('modalDesignation').textContent = r.designation || 'Open Role';
  
  $('modalCTC').textContent = r.annualCTCDisplay || (r.lpa ? formatLPA(r.lpa) : 'N/A');
  $('modalBasePay').textContent = `Base Pay: ${r.basePay || 'N/A'}`;
  $('modalBonus').textContent = `Bonus / Variable: ${r.bonus || 'N/A'}`;
  $('modalStipend').textContent = `Stipend (UG/PG): ${r.stipendUG ? '₹'+r.stipendUG+'/mo' : 'N/A'}`;
  
  $('modalCourses').textContent = `Courses: ${r.courses || 'N/A'}`;
  $('modalMinCGPA').textContent = `Required CGPA Circuital/Non: ${r.cgpaCirc || 'N/A'} / ${r.cgpaNonCirc || 'N/A'}`;
  $('modalCritUG').textContent = `UG criteria: ${r.criteriaUG || 'N/A'}`;
  
  $('modalApplicantsCount').textContent = r.applicantCount || '0';
  $('modalApplicantsByBranch').textContent = r.applicantByBranch || '—';
  $('modalSelectedCount').textContent = r.selectedCount || '0';
  $('modalSelectedByBranch').textContent = r.selectedByBranch || '—';
  
  $('modalJobDescription').textContent = r.jobDescription || r.jdSummary || 'No detailed description available.';
  
  const winnerList = $('modalWinnerNameList');
  winnerList.innerHTML = '';
  if (r.selectedList) {
    $('modalWinnerBlock').classList.remove('hidden');
    r.selectedList.split(';').forEach(name => {
      if (!name.trim()) return;
      winnerList.innerHTML += `<div class="bg-[#1c1c24] border border-zinc-800 rounded px-2 py-1 text-[10px] text-zinc-300 font-mono truncate">${escapeHtml(name.trim())}</div>`;
    });
  } else {
    $('modalWinnerBlock').classList.add('hidden');
  }

  $('modalPostDate').textContent = `Posted on: ${r.postedOn || 'N/A'}`;
  $('modalDeadline').textContent = `Deadline: ${r.deadline || 'N/A'}`;
  $('modalWebUrl').href = r.companyURL ? (r.companyURL.startsWith('http') ? r.companyURL : 'https://'+r.companyURL) : '#';
  $('modalApplyUrl').href = r.viewApplyUrl || '#';

  $('detailsModal').classList.remove('hidden');
}

function closeDetailsModal() {
  $('detailsModal').classList.add('hidden');
}

// AI Integration
async function generateStructuredReport() {
  btnGenerateInsights.disabled = true;
  aiBtnText.textContent = "Analyzing placement subset data...";
  aiReportWrap.classList.remove('hidden');
  aiReportBox.innerHTML = '<span class="animate-pulse text-zinc-400">Communicating with Groq models...</span>';

  try {
    const { groqApiKey, groqModel } = await chrome.storage.local.get(["groqApiKey", "groqModel"]);
    if (!groqApiKey) {
      aiReportBox.innerHTML = '<span class="text-red-400">Groq API Key is missing. Please configure it in the extension popup settings.</span>';
      return;
    }

    const filteredCount = filteredRows.length;
    const placedCount = filteredRows.reduce((a, b) => a + (b.selectedCount || 0), 0);
    const validCtcs = filteredRows.filter(r => r.lpa > 0).map(r => r.lpa);
    const avgCTC = validCtcs.length > 0 ? (validCtcs.reduce((a, b) => a + b, 0) / validCtcs.length * 100000) : 0;
    const highest = filteredRows.slice().sort((a,b) => b.lpa - a.lpa)[0];

    const promptData = [
      `Total companies: ${filteredCount}`,
      `Total Placed: ${placedCount}`,
      `Avg CTC: ₹${(avgCTC/100000).toFixed(2)} LPA`,
      `Highest: ${highest ? highest.company + ' (₹' + highest.lpa.toFixed(2) + ' LPA)' : 'N/A'}`,
      `Top 5 hiring companies: ${filteredRows.slice().sort((a,b) => (b.selectedCount||0)-(a.selectedCount||0)).slice(0,5).map(r => r.company + ' (' + r.selectedCount + ')').join(', ')}`
    ].join("\\n");

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + groqApiKey },
      body: JSON.stringify({
        model: groqModel || "llama-3.1-8b-instant",
        temperature: 0.3,
        messages: [
          { role: "system", content: "You are a placement analyst. Given the placement data subset, write a tight 4 bullet analysis of standouts, outliers, and hiring trends. Use Indian Rupee notation (LPA). Format as raw HTML lists only (e.g. <ul><li>...</li></ul>)." },
          { role: "user", content: promptData }
        ]
      })
    });

    if (!res.ok) throw new Error("API responded with " + res.status);
    const data = await res.json();
    const insightsHtml = data?.choices?.[0]?.message?.content || "No insights generated.";
    
    aiReportBox.innerHTML = `
      <p class="text-sm text-zinc-300 mb-4">
        Placement notice extraction indicates current competitive trends. The selected subset covers <strong>${filteredCount} active recruiters</strong> with an average annual compensation of <strong>₹${(avgCTC / 100000).toFixed(2)} LPA</strong>, extending <strong>${placedCount} placement selects</strong>.
      </p>
      <div class="text-zinc-300 bg-zinc-900/60 p-4 rounded-lg border border-zinc-800">
        ${insightsHtml}
      </div>
    `;
  } catch (e) {
    aiReportBox.innerHTML = `<span class="text-red-400">Error generating insights: ${e.message}</span>`;
  } finally {
    btnGenerateInsights.disabled = false;
    aiBtnText.textContent = "Refresh Intelligence Report";
  }
}

// Exports
function csvEscape(s) {
  if (s == null) return "";
  const str = String(s).replace(/\\r?\\n/g, " ").replace(/\\s+/g, " ").trim();
  return /[",]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
}

function triggerCSVDownload() {
  const cols = ["Company", "Type", "Designation", "CTC", "Applicants", "Selected", "Deadline"];
  const lines = [cols.join(",")];
  filteredRows.forEach(r => {
    lines.push([
      csvEscape(r.company), csvEscape(r.type), csvEscape(r.designation), 
      csvEscape(r.annualCTCDisplay || r.lpa), csvEscape(r.applicantCount), 
      csvEscape(r.selectedCount), csvEscape(r.deadline)
    ].join(","));
  });
  const blob = new Blob([lines.join("\\n")], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `Placement_Export_${new Date().getTime()}.csv`;
  a.click();
}

function triggerDossierPrint() {
  window.print();
}
