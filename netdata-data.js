/* ============================================================
   NetData 2.0 - Data Abstraction Layer
   Tries live Netdata REST API, falls back to mock data.
   ============================================================ */

const ND_DATA = (function () {
  let _mode = 'unknown'; // 'live' | 'mock'
  let _baseUrl = '';
  let _charts = null;
  let _pollTimer = null;
  let _info = null;

  async function init(host) {
    _baseUrl = host || `${location.protocol}//${location.hostname}:19999`;
    try {
      const r = await fetch(`${_baseUrl}/api/v1/info`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error(r.status);
      _info = await r.json();
      _mode = 'live';
      _charts = await _fetchCharts();
    } catch (e) {
      console.warn('NetData API unreachable, using mock data:', e.message);
      _mode = 'mock';
      _info = MOCK_INFO;
      _charts = MOCK_CHARTS;
      MockEngine.init();
    }
    return _mode;
  }

  async function _fetchCharts() {
    const r = await fetch(`${_baseUrl}/api/v1/charts`);
    return r.json();
  }

  function isLive() { return _mode === 'live'; }
  function getMode() { return _mode; }
  function getInfo() { return _info; }
  function getCharts() { return _charts; }

  function getNetworkInterfaces() {
    if (!_charts) return [];
    const prefix = 'net.';
    const ifaces = [];
    const charts = _charts.charts || _charts;
    for (const key in charts) {
      if (key.startsWith(prefix)) {
        const name = key.slice(prefix.length);
        if (name && !name.includes('.') && name !== 'lo') ifaces.push(name);
      }
    }
    return ifaces.length ? ifaces : ['eth0', 'br-lan', 'wwan0'];
  }

  function getDisks() {
    if (!_charts) return [];
    const disks = [];
    const charts = _charts.charts || _charts;
    for (const key in charts) {
      if (key.startsWith('disk.') && key.indexOf('.') === 4) {
        const name = key.slice(5);
        if (name && !disks.includes(name)) disks.push(name);
      }
    }
    return disks.length ? disks : ['sda'];
  }

  function getDiskMounts() {
    if (!_charts) return [];
    const mounts = [];
    const charts = _charts.charts || _charts;
    for (const key in charts) {
      if (key.startsWith('disk_space.')) {
        mounts.push({ id: key, name: key.slice(11) });
      }
    }
    return mounts.length ? mounts : [{ id: 'disk_space._', name: '/' }];
  }

  async function getData(chart, afterSecs, points, offsetSecs) {
    offsetSecs = offsetSecs || 0;
    if (_mode === 'live') {
      try {
        const before = offsetSecs > 0 ? `&before=-${offsetSecs}` : '';
        const url = `${_baseUrl}/api/v1/data?chart=${encodeURIComponent(chart)}&after=-${afterSecs + offsetSecs}${before}&points=${points}&format=json&options=abs`;
        const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
        return r.json();
      } catch (e) {
        console.warn(`Failed to fetch ${chart}:`, e.message);
        return null;
      }
    }
    return MockEngine.getData(chart, afterSecs, points, offsetSecs);
  }

  function startPolling(callback, intervalMs) {
    stopPolling();
    callback();
    _pollTimer = setInterval(callback, intervalMs || 2000);
  }

  function stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }

  return {
    init, isLive, getMode, getInfo, getCharts,
    getNetworkInterfaces, getDisks, getDiskMounts,
    getData, startPolling, stopPolling
  };
})();


/* ============================================================
   Mock Data Constants
   ============================================================ */

const MOCK_INFO = {
  version: '1.33.1',
  os_name: 'SmartOS',
  os_version: 'OpenWrt 22.03',
  kernel_name: 'Linux',
  hostname: 'smartos-gw',
  cores_total: 4,
  ram_total: 536870912,
  memory_mode: 'dbengine',
  update_every: 2
};

const MOCK_CHARTS = {
  'system.cpu': { name: 'system.cpu', units: 'percentage', dimensions: { user: {}, system: {}, iowait: {}, irq: {}, softirq: {}, steal: {}, idle: {} } },
  'system.ram': { name: 'system.ram', units: 'MiB', dimensions: { used: {}, buffers: {}, cached: {}, free: {} } },
  'system.load': { name: 'system.load', units: 'load', dimensions: { load1: {}, load5: {}, load15: {} } },
  'system.ctxt': { name: 'system.ctxt', units: 'switches/s', dimensions: { switches: {} } },
  'system.intr': { name: 'system.intr', units: 'interrupts/s', dimensions: { interrupts: {} } },
  'system.fds': { name: 'system.fds', units: 'fds', dimensions: { allocated: {}, max: {} } },
  'system.processes': { name: 'system.processes', units: 'processes', dimensions: { running: {}, blocked: {} } },
  'net.eth0': { name: 'net.eth0', units: 'kilobits/s', dimensions: { received: {}, sent: {} } },
  'net.br-lan': { name: 'net.br-lan', units: 'kilobits/s', dimensions: { received: {}, sent: {} } },
  'net.wwan0': { name: 'net.wwan0', units: 'kilobits/s', dimensions: { received: {}, sent: {} } },
  'net_combined.eth0': { name: 'net_combined.eth0', units: 'mixed', dimensions: { received: {}, sent: {}, errors: {}, drops: {} } },
  'net_combined.br-lan': { name: 'net_combined.br-lan', units: 'mixed', dimensions: { received: {}, sent: {}, errors: {}, drops: {} } },
  'net_combined.wwan0': { name: 'net_combined.wwan0', units: 'mixed', dimensions: { received: {}, sent: {}, errors: {}, drops: {} } },
  'disk.sda': { name: 'disk.sda', units: 'KiB/s', dimensions: { reads: {}, writes: {} } },
  'disk_space._': { name: 'disk_space._', units: 'GiB', dimensions: { avail: {}, used: {}, reserved: {} } },
  'disk_space._tmp': { name: 'disk_space._tmp', units: 'GiB', dimensions: { avail: {}, used: {}, reserved: {} } },
  'airtime.2g': { name: 'airtime.2g', units: '%', dimensions: { tx: {}, rx: {}, wifi_int: {}, non_wifi: {} } },
  'airtime.5g': { name: 'airtime.5g', units: '%', dimensions: { tx: {}, rx: {}, wifi_int: {}, non_wifi: {} } },
  'airtime.6g': { name: 'airtime.6g', units: '%', dimensions: { tx: {}, rx: {}, wifi_int: {}, non_wifi: {} } },
};


/* ============================================================
   Mock Data Engine
   ============================================================ */

const MockEngine = (function () {
  const _buffers = {};
  const MAX_PTS = 43200; // 24h at 2s

  const _state = {
    cpu_user: 12, cpu_system: 5, cpu_iowait: 1, cpu_irq: 0.5, cpu_softirq: 0.3, cpu_steal: 0,
    ram_used: 280, ram_buffers: 40, ram_cached: 120, ram_free: 72,
    load1: 0.45, load5: 0.38, load15: 0.32,
    eth0_rx: 4500, eth0_tx: 1200,
    brlan_rx: 3800, brlan_tx: 900,
    wwan0_rx: 120, wwan0_tx: 30,
    sda_read: 450, sda_write: 200,
    disk_root_used: 1.8, disk_root_avail: 5.6, disk_root_reserved: 0.6,
    disk_tmp_used: 0.12, disk_tmp_avail: 0.85, disk_tmp_reserved: 0.03,
    ctxt: 2400, intr: 1800,
    fds_alloc: 1840, fds_max: 32768,
    proc_running: 2, proc_blocked: 0,
    // Airtime
    radio_2g_tx: 8, radio_2g_rx: 12, radio_2g_wifi_int: 5, radio_2g_non_wifi: 3, radio_2g_clients: 7,
    radio_5g_tx: 15, radio_5g_rx: 22, radio_5g_wifi_int: 4, radio_5g_non_wifi: 2, radio_5g_clients: 12,
    radio_6g_tx: 10, radio_6g_rx: 18, radio_6g_wifi_int: 3, radio_6g_non_wifi: 1, radio_6g_clients: 5,
    // Net errors/drops
    eth0_rx_err: 0, eth0_tx_err: 0, eth0_drops: 0,
    brlan_rx_err: 0, brlan_tx_err: 0, brlan_drops: 0,
    wwan0_rx_err: 0, wwan0_tx_err: 0, wwan0_drops: 0,
  };

  function drift(val, min, max, step) {
    return Math.max(min, Math.min(max, val + (Math.random() - 0.5) * 2 * step));
  }

  function driftInt(val, min, max, step) {
    return Math.round(drift(val, min, max, step));
  }

  function tick(overrideTime) {
    const s = _state;
    s.cpu_user = drift(s.cpu_user, 2, 60, 3);
    s.cpu_system = drift(s.cpu_system, 1, 25, 1.5);
    s.cpu_iowait = drift(s.cpu_iowait, 0, 15, 1);
    s.cpu_irq = drift(s.cpu_irq, 0, 5, 0.3);
    s.cpu_softirq = drift(s.cpu_softirq, 0, 4, 0.2);
    s.cpu_steal = drift(s.cpu_steal, 0, 2, 0.1);
    const cpuBusy = s.cpu_user + s.cpu_system + s.cpu_iowait + s.cpu_irq + s.cpu_softirq + s.cpu_steal;

    s.ram_used = drift(s.ram_used, 200, 420, 5);
    s.ram_buffers = drift(s.ram_buffers, 20, 80, 2);
    s.ram_cached = drift(s.ram_cached, 60, 180, 3);
    s.ram_free = Math.max(10, 512 - s.ram_used - s.ram_buffers - s.ram_cached);

    s.load1 = drift(s.load1, 0.05, 4, 0.08);
    s.load5 = drift(s.load5, 0.05, 3.5, 0.03);
    s.load15 = drift(s.load15, 0.05, 3, 0.01);

    s.eth0_rx = drift(s.eth0_rx, 100, 50000, 800);
    s.eth0_tx = drift(s.eth0_tx, 50, 20000, 400);
    s.brlan_rx = drift(s.brlan_rx, 50, 40000, 600);
    s.brlan_tx = drift(s.brlan_tx, 20, 15000, 300);
    s.wwan0_rx = drift(s.wwan0_rx, 0, 5000, 100);
    s.wwan0_tx = drift(s.wwan0_tx, 0, 2000, 50);

    s.sda_read = drift(s.sda_read, 0, 8000, 300);
    s.sda_write = drift(s.sda_write, 0, 4000, 150);

    s.disk_root_used = drift(s.disk_root_used, 1.2, 6.5, 0.01);
    s.disk_root_avail = Math.max(0.1, 8.0 - s.disk_root_used - s.disk_root_reserved);
    s.disk_tmp_used = drift(s.disk_tmp_used, 0.01, 0.8, 0.005);
    s.disk_tmp_avail = Math.max(0.01, 1.0 - s.disk_tmp_used - s.disk_tmp_reserved);

    s.ctxt = drift(s.ctxt, 500, 8000, 200);
    s.intr = drift(s.intr, 400, 6000, 150);
    s.fds_alloc = driftInt(s.fds_alloc, 800, 4000, 30);
    s.proc_running = driftInt(s.proc_running, 1, 8, 1);
    s.proc_blocked = Math.random() < 0.1 ? driftInt(s.proc_blocked, 0, 3, 1) : 0;

    // Airtime drift
    s.radio_2g_tx = drift(s.radio_2g_tx, 2, 25, 1.5);
    s.radio_2g_rx = drift(s.radio_2g_rx, 3, 30, 2);
    s.radio_2g_wifi_int = drift(s.radio_2g_wifi_int, 0, 15, 1);
    s.radio_2g_non_wifi = drift(s.radio_2g_non_wifi, 0, 10, 0.5);
    s.radio_2g_clients = driftInt(s.radio_2g_clients, 2, 15, 1);

    s.radio_5g_tx = drift(s.radio_5g_tx, 5, 35, 2);
    s.radio_5g_rx = drift(s.radio_5g_rx, 8, 40, 2.5);
    s.radio_5g_wifi_int = drift(s.radio_5g_wifi_int, 0, 12, 1);
    s.radio_5g_non_wifi = drift(s.radio_5g_non_wifi, 0, 8, 0.5);
    s.radio_5g_clients = driftInt(s.radio_5g_clients, 4, 25, 1);

    s.radio_6g_tx = drift(s.radio_6g_tx, 3, 30, 2);
    s.radio_6g_rx = drift(s.radio_6g_rx, 5, 35, 2);
    s.radio_6g_wifi_int = drift(s.radio_6g_wifi_int, 0, 10, 0.8);
    s.radio_6g_non_wifi = drift(s.radio_6g_non_wifi, 0, 5, 0.3);
    s.radio_6g_clients = driftInt(s.radio_6g_clients, 1, 15, 1);

    // Occasional error spikes
    if (Math.random() < 0.02) s.eth0_rx_err = driftInt(s.eth0_rx_err, 0, 5, 2);
    else s.eth0_rx_err = Math.max(0, s.eth0_rx_err - 1);
    if (Math.random() < 0.015) s.eth0_tx_err = driftInt(s.eth0_tx_err, 0, 3, 1);
    else s.eth0_tx_err = Math.max(0, s.eth0_tx_err - 1);
    if (Math.random() < 0.01) s.wwan0_drops = driftInt(s.wwan0_drops, 0, 3, 1);
    else s.wwan0_drops = Math.max(0, s.wwan0_drops - 1);
    if (Math.random() < 0.005) s.brlan_drops = driftInt(s.brlan_drops, 0, 2, 1);
    else s.brlan_drops = Math.max(0, s.brlan_drops - 1);

    const now = overrideTime || Math.floor(Date.now() / 1000);

    pushBuf('system.cpu', [now, s.cpu_user, s.cpu_system, s.cpu_iowait, s.cpu_irq, s.cpu_softirq, s.cpu_steal, Math.max(0, 100 - cpuBusy)]);
    pushBuf('system.ram', [now, s.ram_used, s.ram_buffers, s.ram_cached, s.ram_free]);
    pushBuf('system.load', [now, s.load1, s.load5, s.load15]);
    pushBuf('net.eth0', [now, s.eth0_rx, s.eth0_tx]);
    pushBuf('net.br-lan', [now, s.brlan_rx, s.brlan_tx]);
    pushBuf('net.wwan0', [now, s.wwan0_rx, s.wwan0_tx]);
    pushBuf('system.net', [now, s.eth0_rx + s.brlan_rx + s.wwan0_rx, s.eth0_tx + s.brlan_tx + s.wwan0_tx]);
    pushBuf('disk.sda', [now, s.sda_read, s.sda_write]);
    pushBuf('disk_space._', [now, s.disk_root_avail, s.disk_root_used, s.disk_root_reserved]);
    pushBuf('disk_space._tmp', [now, s.disk_tmp_avail, s.disk_tmp_used, s.disk_tmp_reserved]);
    pushBuf('system.ctxt', [now, s.ctxt]);
    pushBuf('system.intr', [now, s.intr]);
    pushBuf('system.fds', [now, s.fds_alloc, s.fds_max]);
    pushBuf('system.processes', [now, s.proc_running, s.proc_blocked]);

    // Net combined (throughput + errors for dual-axis charts)
    pushBuf('net_combined.eth0', [now, s.eth0_rx, s.eth0_tx, s.eth0_rx_err + s.eth0_tx_err, s.eth0_drops]);
    pushBuf('net_combined.br-lan', [now, s.brlan_rx, s.brlan_tx, s.brlan_rx_err + s.brlan_tx_err, s.brlan_drops]);
    pushBuf('net_combined.wwan0', [now, s.wwan0_rx, s.wwan0_tx, s.wwan0_rx_err + s.wwan0_tx_err, s.wwan0_drops]);

    // Airtime as time series
    pushBuf('airtime.2g', [now, s.radio_2g_tx, s.radio_2g_rx, s.radio_2g_wifi_int, s.radio_2g_non_wifi]);
    pushBuf('airtime.5g', [now, s.radio_5g_tx, s.radio_5g_rx, s.radio_5g_wifi_int, s.radio_5g_non_wifi]);
    pushBuf('airtime.6g', [now, s.radio_6g_tx, s.radio_6g_rx, s.radio_6g_wifi_int, s.radio_6g_non_wifi]);
  }

  function pushBuf(chart, row) {
    if (!_buffers[chart]) _buffers[chart] = [];
    _buffers[chart].push(row);
    if (_buffers[chart].length > MAX_PTS) _buffers[chart].shift();
  }

  function init() {
    const now = Math.floor(Date.now() / 1000);
    const totalPts = 43200; // 24h at 2s intervals
    for (let t = totalPts; t > 0; t--) {
      tick(now - (t * 2));
    }
  }

  function getData(chart, afterSecs, points, offsetSecs) {
    offsetSecs = offsetSecs || 0;
    const buf = _buffers[chart];
    if (!buf || buf.length === 0) return null;

    const now = Math.floor(Date.now() / 1000);
    const endTime = now - offsetSecs;
    const startTime = endTime - afterSecs;
    let filtered = buf.filter(r => r[0] >= startTime && r[0] <= endTime);
    if (filtered.length === 0) filtered = buf.slice(-1);

    // Downsample if more points than requested
    if (filtered.length > points && points > 0) {
      const step = filtered.length / points;
      const sampled = [];
      for (let i = 0; i < points; i++) {
        sampled.push(filtered[Math.floor(i * step)]);
      }
      filtered = sampled;
    }

    const chartMeta = MOCK_CHARTS[chart];
    if (!chartMeta) return null;
    const dims = Object.keys(chartMeta.dimensions);

    return {
      labels: ['time', ...dims],
      data: filtered.map(r => r.slice())
    };
  }

  function getAirtime() {
    const s = _state;
    return [
      { band: '2.4 GHz', channel: 6, tx: s.radio_2g_tx, rx: s.radio_2g_rx, wifi_int: s.radio_2g_wifi_int, non_wifi_int: s.radio_2g_non_wifi, clients: s.radio_2g_clients },
      { band: '5 GHz', channel: 36, tx: s.radio_5g_tx, rx: s.radio_5g_rx, wifi_int: s.radio_5g_wifi_int, non_wifi_int: s.radio_5g_non_wifi, clients: s.radio_5g_clients },
      { band: '6 GHz', channel: 1, tx: s.radio_6g_tx, rx: s.radio_6g_rx, wifi_int: s.radio_6g_wifi_int, non_wifi_int: s.radio_6g_non_wifi, clients: s.radio_6g_clients }
    ];
  }

  return { init, tick, getData, getAirtime };
})();
