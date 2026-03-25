/* ============================================================
   NetData 2.0 - Main UI Logic
   ============================================================ */

// --- Globals ---
let currentView = localStorage.getItem('nd_view') || 'basic';
let currentRange = parseInt(localStorage.getItem('nd_range')) || 900;
const charts = {};
const POLL_INTERVAL = 2000;
let panOffset = 0;
let _panRafId = 0;

// --- Theme ---
function initTheme() {
  const saved = localStorage.getItem('nd_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('nd_theme', next);
  Object.values(charts).forEach(c => { if (c.recolor) c.recolor(); });
}

// --- View Toggle ---
function setView(mode) {
  currentView = mode;
  document.body.dataset.view = mode;
  localStorage.setItem('nd_view', mode);
  document.querySelectorAll('.view-group .pill-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.view === mode));
  requestAnimationFrame(() => {
    Object.values(charts).forEach(c => { if (c.resize) c.resize(); });
  });
}

// --- Time Range ---
function setTimeRange(secs) {
  currentRange = secs;
  localStorage.setItem('nd_range', secs);
  document.querySelectorAll('.time-group .pill-btn').forEach(btn =>
    btn.classList.toggle('active', parseInt(btn.dataset.range) === secs));
  panOffset = 0; // reset pan when changing range
}

// --- Formatting Helpers ---
function fmtBits(kbits) {
  if (kbits == null) return '0';
  const bits = Math.abs(kbits) * 1000;
  if (bits >= 1e9) return (bits / 1e9).toFixed(2) + ' Gbps';
  if (bits >= 1e6) return (bits / 1e6).toFixed(1) + ' Mbps';
  if (bits >= 1e3) return (bits / 1e3).toFixed(0) + ' Kbps';
  return bits.toFixed(0) + ' bps';
}

function fmtMiB(mib) {
  if (mib >= 1024) return (mib / 1024).toFixed(1) + ' GiB';
  return mib.toFixed(0) + ' MiB';
}

function fmtGiB(gib) {
  if (gib >= 1024) return (gib / 1024).toFixed(1) + ' TiB';
  return gib.toFixed(2) + ' GiB';
}

function fmtNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return Math.round(n).toString();
}

function fmtPct(n) { return n.toFixed(1) + '%'; }

function fmtTime(epoch) {
  const d = new Date(epoch * 1000);
  if (currentRange <= 900) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// --- CSS Variable Reader ---
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function getChartColors() {
  return {
    cyan: cssVar('--accent-cyan'),
    green: cssVar('--accent-green'),
    amber: cssVar('--accent-amber'),
    red: cssVar('--accent-red'),
    purple: cssVar('--accent-purple'),
    blue: cssVar('--accent-blue'),
    grey: cssVar('--accent-grey'),
    text: cssVar('--text-muted'),
    border: cssVar('--border'),
    bg: cssVar('--bg-card'),
  };
}

// --- Tooltip ---
const tooltip = document.getElementById('chart-tooltip');

function showTooltip(html, x, y) {
  tooltip.innerHTML = html;
  tooltip.classList.add('visible');
  const rect = tooltip.getBoundingClientRect();
  const px = Math.min(x + 12, window.innerWidth - rect.width - 8);
  const py = Math.min(y - 8, window.innerHeight - rect.height - 8);
  tooltip.style.left = px + 'px';
  tooltip.style.top = py + 'px';
}

function hideTooltip() {
  tooltip.classList.remove('visible');
}

// --- Pan Offset Control ---
function setPanOffset(newOffset) {
  panOffset = newOffset;
  if (!_panRafId) {
    _panRafId = requestAnimationFrame(() => {
      _panRafId = 0;
      pollUpdate(true);
    });
  }
}

// --- Y-axis Formatter Helper ---
function yFmt(v, fmt) {
  if (fmt === 'percent') return fmtPct(v);
  if (fmt === 'bits') return fmtBits(v);
  if (fmt === 'mib') return fmtMiB(v);
  if (fmt === 'gib') return fmtGiB(v);
  return fmtNum(v);
}

// --- Legend Helper ---
function createLegendEl(series) {
  const div = document.createElement('div');
  div.className = 'chart-legend';
  series.forEach(s => {
    const item = document.createElement('span');
    item.className = 'chart-legend-item';
    item.innerHTML = `<span class="chart-legend-swatch" style="background:${s.color}"></span>${s.label}`;
    div.appendChild(item);
  });
  return div;
}


/* ============================================================
   D3 Chart Factory
   Supports: stacked-area, multi-line, dual y-axis, drag-to-pan
   ============================================================ */

function createTimeSeriesChart(container, config) {
  const {
    type = 'multi-line',
    series = [],
    yFormat = 'number',
    rightYFormat = null,
    height = 80,
  } = config;

  const el = typeof container === 'string' ? document.querySelector(container) : container;
  if (!el) return null;

  const hasRightAxis = series.some(s => s.axis === 'right');
  const margin = { top: 2, right: hasRightAxis ? 50 : 8, bottom: 18, left: 48 };

  const chartDiv = document.createElement('div');
  chartDiv.className = 'chart-container';
  el.appendChild(chartDiv);

  const svg = d3.select(chartDiv).append('svg').attr('height', height);

  const clipId = 'clip-' + Math.random().toString(36).slice(2);
  const gClip = svg.append('defs').append('clipPath').attr('id', clipId).append('rect');

  const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
  const gGrid = g.append('g').attr('class', 'grid');
  const gArea = g.append('g').attr('clip-path', `url(#${clipId})`);
  const gXAxis = g.append('g').attr('class', 'axis x-axis');
  const gYAxis = g.append('g').attr('class', 'axis y-axis');
  const gYAxisR = hasRightAxis ? g.append('g').attr('class', 'axis y-axis-right') : null;
  const gCrosshair = g.append('line').attr('class', 'crosshair-line').style('display', 'none');
  const gOverlay = g.append('rect').attr('fill', 'none').attr('pointer-events', 'all');

  const xScale = d3.scaleTime();
  const yScaleL = d3.scaleLinear();
  const yScaleR = d3.scaleLinear();

  let lastData = null;

  function getWidth() { return chartDiv.clientWidth || 400; }

  function render(data) {
    if (!data || !data.data || data.data.length === 0) return;
    lastData = data;

    const W = getWidth();
    const w = W - margin.left - margin.right;
    const h = height - margin.top - margin.bottom;

    svg.attr('width', W);
    gClip.attr('width', w).attr('height', h);
    gOverlay.attr('width', w).attr('height', h);

    const labels = data.labels;
    const rows = data.data;

    const leftSeries = series.filter(s => s.axis !== 'right');
    const rightSeries = series.filter(s => s.axis === 'right');

    // Time extent
    xScale.domain([new Date(rows[0][0] * 1000), new Date(rows[rows.length - 1][0] * 1000)]).range([0, w]);

    // Left Y extent
    let yMaxL = 0;
    if (type === 'stacked-area') {
      rows.forEach(row => {
        let sum = 0;
        leftSeries.forEach(s => {
          const idx = labels.indexOf(s.key);
          if (idx >= 0) sum += Math.abs(row[idx] || 0);
        });
        yMaxL = Math.max(yMaxL, sum);
      });
    } else {
      rows.forEach(row => {
        leftSeries.forEach(s => {
          const idx = labels.indexOf(s.key);
          if (idx >= 0) yMaxL = Math.max(yMaxL, Math.abs(row[idx] || 0));
        });
      });
    }
    if (yFormat === 'percent') yMaxL = Math.max(yMaxL, 100);
    yMaxL = yMaxL * 1.1 || 1;
    yScaleL.domain([0, yMaxL]).range([h, 0]);

    // Right Y extent
    if (hasRightAxis) {
      let yMaxR = 0;
      rows.forEach(row => {
        rightSeries.forEach(s => {
          const idx = labels.indexOf(s.key);
          if (idx >= 0) yMaxR = Math.max(yMaxR, Math.abs(row[idx] || 0));
        });
      });
      yMaxR = Math.max(yMaxR * 1.5, 1); // extra headroom for errors
      yScaleR.domain([0, yMaxR]).range([h, 0]);
    }

    // Axes
    const xTickCount = Math.max(2, Math.floor(w / 100));
    const xTickFmt = currentRange <= 900 ? d3.timeFormat('%H:%M:%S') : d3.timeFormat('%H:%M');
    gXAxis.attr('transform', `translate(0,${h})`).call(d3.axisBottom(xScale).ticks(xTickCount).tickFormat(xTickFmt));
    gYAxis.call(d3.axisLeft(yScaleL).ticks(4).tickFormat(v => yFmt(v, yFormat)));

    if (gYAxisR) {
      gYAxisR.attr('transform', `translate(${w},0)`)
        .call(d3.axisRight(yScaleR).ticks(3).tickFormat(v => yFmt(v, rightYFormat || 'number')));
    }

    // Grid
    gGrid.selectAll('line').remove();
    yScaleL.ticks(4).forEach(tick => {
      gGrid.append('line').attr('x1', 0).attr('x2', w)
        .attr('y1', yScaleL(tick)).attr('y2', yScaleL(tick));
    });

    // Draw series
    gArea.selectAll('*').remove();

    if (type === 'stacked-area') {
      const stackKeys = leftSeries.map(s => s.key);
      const stackData = rows.map(row => {
        const obj = { time: new Date(row[0] * 1000) };
        stackKeys.forEach(k => {
          const idx = labels.indexOf(k);
          obj[k] = Math.abs(idx >= 0 ? (row[idx] || 0) : 0);
        });
        return obj;
      });

      const stacked = d3.stack().keys(stackKeys)(stackData);
      const area = d3.area()
        .x(d => xScale(d.data.time))
        .y0(d => yScaleL(d[0]))
        .y1(d => yScaleL(d[1]))
        .curve(d3.curveMonotoneX);

      stacked.forEach((layer, i) => {
        gArea.append('path').datum(layer)
          .attr('fill', leftSeries[i].color)
          .attr('fill-opacity', 0.3)
          .attr('stroke', leftSeries[i].color)
          .attr('stroke-width', 1.5)
          .attr('d', area);
      });
    } else {
      // Multi-line (left axis)
      leftSeries.forEach(s => {
        const idx = labels.indexOf(s.key);
        if (idx < 0) return;

        const line = d3.line()
          .x(d => xScale(new Date(d[0] * 1000)))
          .y(d => yScaleL(Math.abs(d[idx] || 0)))
          .curve(d3.curveMonotoneX);

        const area = d3.area()
          .x(d => xScale(new Date(d[0] * 1000)))
          .y0(h)
          .y1(d => yScaleL(Math.abs(d[idx] || 0)))
          .curve(d3.curveMonotoneX);

        gArea.append('path').datum(rows)
          .attr('fill', s.color).attr('fill-opacity', 0.08).attr('d', area);
        gArea.append('path').datum(rows)
          .attr('fill', 'none').attr('stroke', s.color).attr('stroke-width', 1.5).attr('d', line);
      });
    }

    // Right axis lines (dashed, no fill)
    rightSeries.forEach(s => {
      const idx = labels.indexOf(s.key);
      if (idx < 0) return;

      const line = d3.line()
        .x(d => xScale(new Date(d[0] * 1000)))
        .y(d => yScaleR(Math.abs(d[idx] || 0)))
        .curve(d3.curveMonotoneX);

      gArea.append('path').datum(rows)
        .attr('fill', 'none')
        .attr('stroke', s.color)
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '4,2')
        .attr('d', line);
    });
  }

  // --- Drag-to-Pan ---
  let _chartDragging = false;

  gOverlay.on('mousedown', function (event) {
    if (event.button !== 0) return;
    event.preventDefault();
    _chartDragging = true;

    const startX = event.clientX;
    const startOffset = panOffset;
    const w = getWidth() - margin.left - margin.right;
    const secPerPx = currentRange / w;

    document.body.style.userSelect = 'none';
    hideTooltip();
    gCrosshair.style('display', 'none');

    function onMove(e) {
      const dx = e.clientX - startX;
      const maxOff = Math.max(0, 86400 - currentRange);
      setPanOffset(Math.max(0, Math.min(maxOff, startOffset + (-dx * secPerPx))));
    }

    function onUp() {
      _chartDragging = false;
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // --- Crosshair (only when not dragging) ---
  gOverlay.on('mousemove', function (event) {
    if (_chartDragging) return;
    if (!lastData) return;
    const [mx] = d3.pointer(event);
    const rows = lastData.data;
    const labels = lastData.labels;
    const time = xScale.invert(mx);
    const bisect = d3.bisector(d => new Date(d[0] * 1000)).left;
    const idx = Math.min(bisect(rows, time), rows.length - 1);
    const row = rows[idx];
    if (!row) return;

    const x = xScale(new Date(row[0] * 1000));
    const h = height - margin.top - margin.bottom;
    gCrosshair.style('display', null).attr('x1', x).attr('x2', x).attr('y1', 0).attr('y2', h);

    let html = `<div class="tt-time">${fmtTime(row[0])}</div>`;
    series.forEach(s => {
      const di = labels.indexOf(s.key);
      if (di < 0) return;
      const val = row[di] || 0;
      const formatter = s.axis === 'right' ? (rightYFormat || 'number') : yFormat;
      html += `<div class="tt-row"><span class="tt-swatch" style="background:${s.color}"></span><span class="tt-label">${s.label}</span><span class="tt-value">${yFmt(Math.abs(val), formatter)}</span></div>`;
    });
    const rect = chartDiv.getBoundingClientRect();
    showTooltip(html, rect.left + margin.left + mx, event.clientY);
  });

  gOverlay.on('mouseleave', function () {
    if (_chartDragging) return;
    gCrosshair.style('display', 'none');
    hideTooltip();
  });

  // --- Lifecycle ---
  function resize() { if (lastData) render(lastData); }
  function recolor() { if (lastData) render(lastData); }
  function destroy() { chartDiv.remove(); }

  const ro = new ResizeObserver(() => { if (lastData) render(lastData); });
  ro.observe(el);

  return { update: render, resize, recolor, destroy };
}


/* ============================================================
   Interface Metadata
   ============================================================ */

const IFACE_META = {
  'eth0': { speed: '10GbE' },
  'br-lan': { speed: '1GbE' },
  'wwan0': { speed: 'LTE' },
};

const BAND_INFO = {
  '2g': { label: '2.4 GHZ', chartKey: 'airtime.2g' },
  '5g': { label: '5 GHZ', chartKey: 'airtime.5g' },
  '6g': { label: '6 GHZ', chartKey: 'airtime.6g' },
};


/* ============================================================
   Card Initializers
   ============================================================ */

// --- Per-Interface Throughput (with dual y-axis for errors) ---
function initThroughputCharts(interfaces) {
  const grid = document.getElementById('dashboard-grid');
  const airtimeHeader = document.getElementById('section-airtime');
  const colors = getChartColors();

  interfaces.forEach(iface => {
    const meta = IFACE_META[iface] || {};
    const card = document.createElement('div');
    card.className = 'card card-iface';
    card.id = `card-net-${iface}`;

    const labelMeta = meta.speed ? ` <span class="card-label-meta">${meta.speed}</span>` : '';
    card.innerHTML = `
      <div class="card-header">
        <div class="card-label">${iface.toUpperCase()}${labelMeta}</div>
        <div class="card-meta" id="net-meta-${iface}"></div>
      </div>
      <div class="card-body" id="net-body-${iface}"></div>
    `;
    grid.insertBefore(card, airtimeHeader);

    // Add legend to header
    const seriesDef = [
      { key: 'received', color: colors.cyan, label: 'RX' },
      { key: 'sent', color: colors.green, label: 'TX' },
      { key: 'errors', color: colors.red, label: 'Errors', axis: 'right' },
      { key: 'drops', color: colors.amber, label: 'Drops', axis: 'right' },
    ];
    card.querySelector('.card-header').appendChild(createLegendEl(seriesDef));

    charts[`net_combined.${iface}`] = createTimeSeriesChart(`#net-body-${iface}`, {
      type: 'multi-line',
      series: seriesDef,
      yFormat: 'bits',
      rightYFormat: 'number',
      height: 70,
    });
  });
}

// --- Per-Band Airtime (line charts) ---
function initAirtimeCharts() {
  const grid = document.getElementById('dashboard-grid');
  const systemHeader = document.getElementById('section-system');
  const colors = getChartColors();

  ['2g', '5g', '6g'].forEach(band => {
    const info = BAND_INFO[band];
    const card = document.createElement('div');
    card.className = 'card card-airtime';
    card.id = `card-airtime-${band}`;
    card.innerHTML = `
      <div class="card-header">
        <div class="card-label">${info.label}</div>
        <div class="card-meta" id="airtime-meta-${band}"></div>
      </div>
      <div class="card-body" id="airtime-body-${band}"></div>
    `;
    grid.insertBefore(card, systemHeader);

    const seriesDef = [
      { key: 'tx', color: colors.cyan, label: 'TX' },
      { key: 'rx', color: colors.green, label: 'RX' },
      { key: 'wifi_int', color: colors.amber, label: 'WiFi Int' },
      { key: 'non_wifi', color: colors.red, label: 'Non-WiFi' },
    ];
    card.querySelector('.card-header').appendChild(createLegendEl(seriesDef));

    charts[`airtime.${band}`] = createTimeSeriesChart(`#airtime-body-${band}`, {
      type: 'stacked-area',
      series: seriesDef,
      yFormat: 'percent',
      height: 70,
    });
  });
}

// --- CPU (stacked area) ---
function initCPUChart() {
  const colors = getChartColors();
  const seriesDef = [
    { key: 'user', color: colors.cyan, label: 'User' },
    { key: 'system', color: colors.amber, label: 'System' },
    { key: 'iowait', color: colors.red, label: 'IOW' },
    { key: 'irq', color: colors.purple, label: 'IRQ' },
    { key: 'softirq', color: colors.blue, label: 'SIRQ' },
    { key: 'steal', color: colors.grey, label: 'Stl' },
  ];
  document.querySelector('#card-cpu .card-header').appendChild(createLegendEl(seriesDef));

  charts['system.cpu'] = createTimeSeriesChart('#cpu-body', {
    type: 'stacked-area',
    series: seriesDef,
    yFormat: 'percent',
    height: 80,
  });
}

// --- Memory (stacked area) ---
function initMemoryChart() {
  const colors = getChartColors();
  const seriesDef = [
    { key: 'used', color: colors.cyan, label: 'Used' },
    { key: 'buffers', color: colors.green, label: 'Buf' },
    { key: 'cached', color: colors.amber, label: 'Cache' },
    { key: 'free', color: colors.grey, label: 'Free' },
  ];
  document.querySelector('#card-memory .card-header').appendChild(createLegendEl(seriesDef));

  charts['system.ram'] = createTimeSeriesChart('#memory-body', {
    type: 'stacked-area',
    series: seriesDef,
    yFormat: 'mib',
    height: 80,
  });
}

// --- System Load ---
function initLoadChart() {
  const colors = getChartColors();
  const seriesDef = [
    { key: 'load1', color: colors.cyan, label: '1m' },
    { key: 'load5', color: colors.amber, label: '5m' },
    { key: 'load15', color: colors.red, label: '15m' },
  ];
  document.querySelector('#card-load .card-header').appendChild(createLegendEl(seriesDef));

  charts['system.load'] = createTimeSeriesChart('#load-body', {
    type: 'multi-line',
    series: seriesDef,
    yFormat: 'number',
    height: 80,
  });
}

// --- Disk I/O ---
function initDiskIOChart() {
  const colors = getChartColors();
  const seriesDef = [
    { key: 'reads', color: colors.cyan, label: 'Read' },
    { key: 'writes', color: colors.green, label: 'Write' },
  ];
  document.querySelector('#card-diskio .card-header').appendChild(createLegendEl(seriesDef));

  charts['disk.sda'] = createTimeSeriesChart('#diskio-body', {
    type: 'multi-line',
    series: seriesDef,
    yFormat: 'number',
    height: 80,
  });
}

// --- Disk Space (line chart, merged mounts) ---
function initDiskSpaceChart() {
  const colors = getChartColors();
  const seriesDef = [
    { key: 'root_used', color: colors.cyan, label: '/' },
    { key: 'tmp_used', color: colors.green, label: '/tmp' },
  ];
  document.querySelector('#card-diskspace .card-header').appendChild(createLegendEl(seriesDef));

  charts['diskspace'] = createTimeSeriesChart('#diskspace-body', {
    type: 'multi-line',
    series: seriesDef,
    yFormat: 'gib',
    height: 80,
  });
}

// --- Processes (line chart) ---
function initProcessesChart() {
  const colors = getChartColors();
  const seriesDef = [
    { key: 'running', color: colors.green, label: 'Running' },
    { key: 'blocked', color: colors.red, label: 'Blocked' },
  ];
  document.querySelector('#card-processes .card-header').appendChild(createLegendEl(seriesDef));

  charts['system.processes'] = createTimeSeriesChart('#processes-body', {
    type: 'multi-line',
    series: seriesDef,
    yFormat: 'number',
    height: 80,
  });
}

// --- Context Switches / Interrupts (merged, line chart) ---
function initCtxIntChart() {
  const colors = getChartColors();
  const seriesDef = [
    { key: 'switches', color: colors.cyan, label: 'Ctx Switches' },
    { key: 'interrupts', color: colors.amber, label: 'Interrupts' },
  ];
  document.querySelector('#card-ctxint .card-header').appendChild(createLegendEl(seriesDef));

  charts['system.ctxint'] = createTimeSeriesChart('#ctxint-body', {
    type: 'multi-line',
    series: seriesDef,
    yFormat: 'number',
    height: 80,
  });
}

// --- File Descriptors (line chart) ---
function initFDChart() {
  const colors = getChartColors();
  const seriesDef = [
    { key: 'allocated', color: colors.cyan, label: 'Allocated' },
  ];
  document.querySelector('#card-fds .card-header').appendChild(createLegendEl(seriesDef));

  charts['system.fds'] = createTimeSeriesChart('#fds-body', {
    type: 'multi-line',
    series: seriesDef,
    yFormat: 'number',
    height: 80,
  });
}


/* ============================================================
   Main Init & Poll Loop
   ============================================================ */

let _interfaces = [];
let _disks = [];
let _mounts = [];

async function initApp() {
  initTheme();
  setView(currentView);
  setTimeRange(currentRange);

  const mode = await ND_DATA.init();

  // Status badge
  const badge = document.getElementById('nd-status');
  badge.className = 'status-badge ' + mode;
  badge.querySelector('.status-label').textContent = mode === 'live' ? 'LIVE' : 'MOCK DATA';

  // Version
  const info = ND_DATA.getInfo();
  if (info) {
    document.getElementById('nd-version').textContent = `v${info.version || '?'}`;
  }

  // Discover
  _interfaces = ND_DATA.getNetworkInterfaces();
  _disks = ND_DATA.getDisks();
  _mounts = ND_DATA.getDiskMounts();

  // Init all charts
  initThroughputCharts(_interfaces);
  initAirtimeCharts();
  initCPUChart();
  initMemoryChart();
  initLoadChart();
  initDiskIOChart();
  initDiskSpaceChart();
  initProcessesChart();
  initCtxIntChart();
  initFDChart();

  // Start polling
  ND_DATA.startPolling(pollUpdate, POLL_INTERVAL);
}

async function pollUpdate(skipTick) {
  // Tick mock engine (skip during drag-pan to avoid jitter)
  if (!ND_DATA.isLive() && !skipTick) {
    MockEngine.tick();
  }

  const range = currentRange;
  const points = Math.min(Math.floor(range / 2), 600);
  const offset = panOffset;

  // Build list of all chart keys to fetch
  const fetchKeys = [
    'system.cpu', 'system.ram', 'system.load',
    'system.ctxt', 'system.intr',
    'system.fds', 'system.processes',
    ..._interfaces.map(i => `net_combined.${i}`),
    ..._disks.map(d => `disk.${d}`),
    ..._mounts.map(m => m.id),
    'airtime.2g', 'airtime.5g', 'airtime.6g',
  ];

  const results = await Promise.all(fetchKeys.map(k => ND_DATA.getData(k, range, points, offset)));
  const data = {};
  fetchKeys.forEach((k, i) => { data[k] = results[i]; });

  // --- Update Basic Mode Charts ---

  // Interface throughput (always visible)
  _interfaces.forEach(iface => {
    const k = `net_combined.${iface}`;
    if (charts[k] && data[k]) {
      charts[k].update(data[k]);
      // Update meta with current rates
      const rows = data[k].data;
      if (rows.length > 0) {
        const last = rows[rows.length - 1];
        const rx = Math.abs(last[1] || 0);
        const tx = Math.abs(last[2] || 0);
        const metaEl = document.getElementById(`net-meta-${iface}`);
        if (metaEl) metaEl.textContent = `\u2193 ${fmtBits(rx)} / \u2191 ${fmtBits(tx)}`;
      }
    }
  });

  // Airtime (always visible)
  ['2g', '5g', '6g'].forEach(band => {
    const k = `airtime.${band}`;
    if (charts[k] && data[k]) {
      charts[k].update(data[k]);
      // Update meta with current utilization
      const rows = data[k].data;
      if (rows.length > 0) {
        const last = rows[rows.length - 1];
        const total = (last[1] || 0) + (last[2] || 0) + (last[3] || 0) + (last[4] || 0);
        const metaEl = document.getElementById(`airtime-meta-${band}`);
        if (metaEl) {
          const airtimeSnap = ND_DATA.isLive() ? null : MockEngine.getAirtime();
          const snap = airtimeSnap ? airtimeSnap[['2g', '5g', '6g'].indexOf(band)] : null;
          const clients = snap ? snap.clients : '';
          const ch = snap ? `CH ${snap.channel}` : '';
          metaEl.textContent = `${ch} ${clients ? '\u00b7 ' + clients + ' clients \u00b7 ' : ''}${total.toFixed(0)}%`;
        }
      }
    }
  });

  // --- Update Advanced Mode Charts (only if visible) ---
  if (currentView === 'advanced') {
    // CPU
    if (charts['system.cpu'] && data['system.cpu']) {
      charts['system.cpu'].update(data['system.cpu']);
      const rows = data['system.cpu'].data;
      if (rows.length > 0) {
        const last = rows[rows.length - 1];
        const busy = (last[1] || 0) + (last[2] || 0) + (last[3] || 0) + (last[4] || 0) + (last[5] || 0) + (last[6] || 0);
        document.getElementById('cpu-meta').textContent = `${busy.toFixed(1)}% busy`;
      }
    }

    // Memory
    if (charts['system.ram'] && data['system.ram']) {
      charts['system.ram'].update(data['system.ram']);
      const rows = data['system.ram'].data;
      if (rows.length > 0) {
        const last = rows[rows.length - 1];
        const used = last[1] || 0;
        const total = (last[1] || 0) + (last[2] || 0) + (last[3] || 0) + (last[4] || 0);
        document.getElementById('memory-meta').textContent = `${fmtMiB(used)} / ${fmtMiB(total)}`;
      }
    }

    // Load
    if (charts['system.load'] && data['system.load']) {
      charts['system.load'].update(data['system.load']);
      const rows = data['system.load'].data;
      if (rows.length > 0) {
        const last = rows[rows.length - 1];
        document.getElementById('load-meta').textContent = `${(last[1] || 0).toFixed(2)} / ${(last[2] || 0).toFixed(2)} / ${(last[3] || 0).toFixed(2)}`;
      }
    }

    // Disk I/O
    _disks.forEach(disk => {
      const k = `disk.${disk}`;
      if (charts[k] && data[k]) charts[k].update(data[k]);
    });

    // Disk Space (merge mounts)
    if (data['disk_space._']) {
      const rootData = data['disk_space._'].data;
      const tmpData = data['disk_space._tmp'] ? data['disk_space._tmp'].data : [];
      const merged = {
        labels: ['time', 'root_used', 'tmp_used'],
        data: rootData.map((row, i) => {
          const tmpRow = tmpData[i] || [0, 0, 0, 0];
          return [row[0], row[2] || 0, tmpRow[2] || 0]; // index 2 = 'used'
        })
      };
      if (charts['diskspace']) charts['diskspace'].update(merged);
    }

    // Processes
    if (charts['system.processes'] && data['system.processes']) {
      charts['system.processes'].update(data['system.processes']);
    }

    // Context Switches + Interrupts (merge)
    if (data['system.ctxt'] && data['system.intr'] && charts['system.ctxint']) {
      const ctxtRows = data['system.ctxt'].data;
      const intrRows = data['system.intr'].data;
      const merged = {
        labels: ['time', 'switches', 'interrupts'],
        data: ctxtRows.map((row, i) => {
          const ir = intrRows[i];
          return [row[0], row[1] || 0, ir ? (ir[1] || 0) : 0];
        })
      };
      charts['system.ctxint'].update(merged);
    }

    // File Descriptors
    if (charts['system.fds'] && data['system.fds']) {
      charts['system.fds'].update(data['system.fds']);
      const rows = data['system.fds'].data;
      if (rows.length > 0) {
        const last = rows[rows.length - 1];
        const alloc = Math.round(last[1] || 0);
        const max = Math.round(last[2] || 32768);
        document.getElementById('fds-meta').textContent = `${fmtNum(alloc)} / ${fmtNum(max)}`;
      }
    }
  }
}

// Boot
initApp();
