# StatsView: SmartOS Firmware Integration Guide

This document maps every StatsView data field to its real SmartOS/Netdata API source and covers the integration path into production SmartOS/JUCI firmware.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Netdata on SmartOS](#2-netdata-on-smartos)
3. [Data Layer Architecture](#3-data-layer-architecture)
4. [Chart-to-API Mapping](#4-chart-to-api-mapping)
   - 4.1 [Interface Throughput](#41-interface-throughput)
   - 4.2 [Wi-Fi Airtime](#42-wi-fi-airtime)
   - 4.3 [System Metrics](#43-system-metrics)
   - 4.4 [Client Monitoring](#44-client-monitoring)
5. [JUCI Plugin Structure](#5-juci-plugin-structure)
6. [Integration Steps](#6-integration-steps)
7. [Wi-Fi Client Data Sources](#7-wi-fi-client-data-sources)
8. [Wired Client Data Sources](#8-wired-client-data-sources)
9. [Performance Considerations](#9-performance-considerations)
10. [Open Engineering Questions](#10-open-engineering-questions)
11. [Testing Checklist](#11-testing-checklist)

---

## 1. Prerequisites

- SmartOS firmware with Netdata package installed (`admin/netdata` feed package)
- Netdata listening on `127.0.0.1:19999` (default)
- JUCI WebUI framework with sidebar navigation
- `hostapd`, `iw`, and `netifd` available for Wi-Fi and interface stats

## 2. Netdata on SmartOS

The SmartOS Netdata package is built from the `admin/netdata` feed at:
`https://github.com/Adtran-SOS/internal-feed-packages/tree/master/admin/netdata`

### Key Configuration

| File | Purpose |
|------|---------|
| `/etc/netdata/netdata.conf` | Main config: bind address, update frequency, memory mode |
| `/etc/netdata/stream.conf` | Streaming config (parent/child) |
| `/usr/lib/netdata/plugins.d/` | Collector plugins |

### Default Settings for SmartOS

```ini
[global]
    update every = 2
    memory mode = dbengine
    page cache size = 32
    dbengine multihost disk space = 256

[web]
    bind to = 127.0.0.1:19999
    allow connections from = localhost
```

The WebUI accesses Netdata via a JUCI reverse proxy or direct localhost fetch from the browser (since the WebUI is served from the same device).

## 3. Data Layer Architecture

`statsview-data.js` implements a two-mode data layer:

```
Browser
  |
  v
statsview-data.js
  |
  |-- try fetch(/api/v1/info) --> Netdata REST API (port 19999)
  |                                  |
  |                                  v
  |                            Live time-series data
  |
  |-- on failure --> MockEngine (synthetic 24h data)
```

### Live Mode API Pattern

```javascript
// Probe
GET /api/v1/info
// Returns: { version, os_name, hostname, cores_total, ram_total, ... }

// Chart catalog
GET /api/v1/charts
// Returns: { charts: { "system.cpu": {...}, "net.wan": {...}, ... } }

// Time-series data
GET /api/v1/data?chart=system.cpu&after=-900&points=450&format=json&options=abs
// Returns: { labels: ["time","user","system",...], data: [[ts, v1, v2, ...], ...] }
```

### Polling Interval

StatsView polls every 2 seconds (`SV_POLL_MS = 2000`), matching Netdata's default `update every = 2` setting.

## 4. Chart-to-API Mapping

### 4.1 Interface Throughput

| UI Field | Netdata Chart | Dimensions | Unit |
|----------|---------------|------------|------|
| RX rate | `net.<iface>` | `received` | Kbps |
| TX rate | `net.<iface>` | `sent` | Kbps |
| RX errors | `net.<iface>` | `rx_errors` | count/s |
| TX errors | `net.<iface>` | `tx_errors` | count/s |
| Packet drops | `net_drops.<iface>` | `inbound`, `outbound` | packets/s |

**Interface discovery:** Enumerate `net.*` charts from `/api/v1/charts`, excluding `lo` and dotted sub-charts.

**Interface name mapping (SmartOS):**

| Netdata ID | SmartOS Name | Display | Media |
|------------|-------------|---------|-------|
| `net.eth0` | eth0 | WAN | 10GbE |
| `net.br-lan` | br-lan | LAN Bridge | GbE |
| `net.wwan0` | wwan0 | WWAN | LTE |
| `net.wlan0` | wlan0 | WiFi 2.4G | 802.11ax |
| `net.wlan1` | wlan1 | WiFi 5G | 802.11ax |
| `net.wlan2` | wlan2 | WiFi 6G | 802.11be |

### 4.2 Wi-Fi Airtime

Netdata does not collect Wi-Fi airtime natively. This data must come from hostapd/iw via a custom collector or ubus calls.

**Data source options:**

1. **Custom Netdata plugin** at `/usr/lib/netdata/plugins.d/wifi_airtime.sh`:
   ```bash
   #!/bin/bash
   # Collect from iw survey dump
   for phy in /sys/class/ieee80211/phy*; do
     iface=$(ls $phy/net/ | head -1)
     iw dev $iface survey dump | awk '/frequency|busy|receive|transmit/ {...}'
   done
   ```

2. **JUCI ubus RPC** (preferred for WebUI integration):
   ```lua
   -- /usr/lib/ubus/juci/wifi.airtime.lua
   function status()
     local result = {}
     for _, radio in ipairs({"radio0","radio1","radio2"}) do
       local survey = util.exec("iw dev %s survey dump" % iface_for(radio))
       result[radio] = parse_survey(survey)
     end
     return result
   end
   ```

**Fields needed per radio:**

| Field | Source | Unit |
|-------|--------|------|
| TX airtime | `iw survey dump` "channel transmit time" | % of active time |
| RX airtime | `iw survey dump` "channel receive time" | % |
| WiFi interference | `iw survey dump` "channel busy time" minus TX+RX | % |
| Non-WiFi interference | Inferred from `channel busy time` vs WiFi-attributed time | % |
| Channel | `iw dev <iface> info` | integer |
| Client count | `hostapd_cli all_sta` or `iw dev <iface> station dump` line count | integer |

### 4.3 System Metrics

All system metrics are available from Netdata out of the box:

| UI Card | Chart ID | Dimensions |
|---------|----------|------------|
| CPU | `system.cpu` | user, system, iowait, irq, softirq, steal |
| Memory | `system.ram` | used, buffers, cached, free |
| Load | `system.load` | load1, load5, load15 |
| Disk I/O | `disk.sda` | reads, writes |
| Disk Space | `disk_space._` | avail, used, reserved |
| Processes | `system.processes` | running, blocked |
| Ctx Switches | `system.ctxt` | switches |
| Interrupts | `system.intr` | interrupts |
| File Descriptors | `system.fds` | allocated |

### 4.4 Client Monitoring

Client data requires multiple SmartOS sources combined:

**WiFi clients:**

| Field | Source | Command/API |
|-------|--------|-------------|
| MAC address | hostapd | `hostapd_cli -i <iface> all_sta` |
| IP address | ARP/DHCP | `/proc/net/arp` or `odhcpd` lease file |
| Hostname | DHCP lease | `/tmp/dhcp.leases` |
| RSSI | hostapd | `signal` field from `all_sta` |
| TX/RX bytes | hostapd | `tx bytes` / `rx bytes` from `all_sta` |
| PHY rate | hostapd | `tx bitrate` / `rx bitrate` |
| MCS | hostapd | Parsed from bitrate string |
| Band | Interface mapping | radio0=2.4G, radio1=5G, radio2=6G |
| Channel | `iw dev info` | Per-interface |
| Airtime % | hostapd | `connected_time` vs measurement window |

**Wired clients:**

| Field | Source | Command/API |
|-------|--------|-------------|
| MAC address | Bridge FDB | `bridge fdb show br br-lan` |
| IP address | ARP table | `/proc/net/arp` |
| Hostname | DHCP lease | `/tmp/dhcp.leases` |
| TX/RX bytes | `/sys/class/net/` or flow stats | Per-MAC counters from bridge or flowstatd |
| Port | Bridge FDB | `dev` field maps to physical port |

**Device classification:**

The prototype uses mock classification. In production, use:
- DHCP vendor class (option 60) for basic OS detection
- OUI lookup (first 3 octets of MAC) for manufacturer
- Optional: fingerbank or custom classifier for IoT/streaming/gaming categories

## 5. JUCI Plugin Structure

```
juci-plugin-statsview/
  Makefile                           # OpenWrt package Makefile
  files/
    www/
      juci/js/
        statsview.js                 # Main page logic
        statsview-data.js            # Data layer
      juci/css/
        statsview.css                # Page-specific styles
    usr/lib/ubus/juci/
      statsview.lua                  # Lua RPC backend
    usr/share/rpcd/acl.d/
      statsview.json                 # ACL permissions
    usr/lib/netdata/plugins.d/
      wifi_airtime.sh                # Custom Netdata collector (optional)
```

### Makefile Template

```makefile
include $(TOPDIR)/rules.mk

PKG_NAME:=juci-plugin-statsview
PKG_VERSION:=1.0.0
PKG_RELEASE:=1

include $(INCLUDE_DIR)/package.mk

define Package/juci-plugin-statsview
  SECTION:=juci
  CATEGORY:=JUCI
  TITLE:=System Statistics Dashboard
  DEPENDS:=+netdata +juci
endef

define Package/juci-plugin-statsview/install
	$(INSTALL_DIR) $(1)/www/juci/js
	$(INSTALL_DATA) ./files/www/juci/js/statsview.js $(1)/www/juci/js/
	$(INSTALL_DATA) ./files/www/juci/js/statsview-data.js $(1)/www/juci/js/
	$(INSTALL_DIR) $(1)/www/juci/css
	$(INSTALL_DATA) ./files/www/juci/css/statsview.css $(1)/www/juci/css/
	$(INSTALL_DIR) $(1)/usr/lib/ubus/juci
	$(INSTALL_DATA) ./files/usr/lib/ubus/juci/statsview.lua $(1)/usr/lib/ubus/juci/
	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./files/usr/share/rpcd/acl.d/statsview.json $(1)/usr/share/rpcd/acl.d/
endef

$(eval $(call BuildPackage,juci-plugin-statsview))
```

### ACL File

```json
{
  "statsview": {
    "description": "StatsView system statistics",
    "read": {
      "ubus": {
        "juci.statsview": ["status", "clients", "airtime"]
      }
    }
  }
}
```

## 6. Integration Steps

### Step 1: Add Sidebar Entry

In the JUCI menu configuration, add StatsView to the sidebar:

```javascript
// In JUCI menu/navigation config
{
  path: "/statsview",
  title: "StatsView",
  icon: "fa-chart-line",
  page: "statsview"
}
```

### Step 2: Proxy Netdata API

Add a uhttpd reverse proxy rule so the browser can reach Netdata:

```
# /etc/uhttpd/conf.d/netdata.conf
location /netdata/ {
    proxy_pass http://127.0.0.1:19999/;
}
```

Or use JUCI's RPC layer to fetch and relay Netdata data server-side.

### Step 3: Create Lua Backend for Client Data

```lua
-- /usr/lib/ubus/juci/statsview.lua
local util = require("juci.util")

function clients()
  local result = { wifi = {}, wired = {} }

  -- WiFi clients from hostapd
  for _, iface in ipairs({"wlan0", "wlan1", "wlan2"}) do
    local sta = util.exec("hostapd_cli -i %s all_sta" % iface)
    -- parse MAC, signal, tx/rx bytes, bitrate, connected_time
    for mac, data in parse_hostapd(sta) do
      table.insert(result.wifi, {
        mac = mac, iface = iface,
        rssi = data.signal, tx_bytes = data.tx_bytes,
        rx_bytes = data.rx_bytes, tx_rate = data.tx_bitrate
      })
    end
  end

  -- Wired clients from bridge FDB + ARP
  local fdb = util.exec("bridge fdb show br br-lan")
  local arp = read_arp()
  local leases = read_leases()
  -- merge FDB entries with ARP IPs and DHCP hostnames

  return result
end

function airtime()
  local result = {}
  for _, radio in ipairs({"radio0", "radio1", "radio2"}) do
    local iface = get_iface_for_radio(radio)
    local survey = util.exec("iw dev %s survey dump" % iface)
    result[radio] = parse_survey(survey)
  end
  return result
end
```

### Step 4: Wire Up Data Layer

Modify `statsview-data.js` to use JUCI RPC for client and airtime data:

```javascript
// In production, replace mock client/airtime data with:
async function getClients() {
  if (_mode === 'live') {
    return await $rpc.juci.statsview.clients();
  }
  return MockEngine.getClients();
}

async function getAirtime() {
  if (_mode === 'live') {
    return await $rpc.juci.statsview.airtime();
  }
  return MockEngine.getAirtime();
}
```

### Step 5: Package and Build

```bash
# Add to feeds.conf
src-link statsview /path/to/juci-plugin-statsview

# Update and install
./scripts/feeds update statsview
./scripts/feeds install juci-plugin-statsview

# Select in menuconfig
make menuconfig  # JUCI -> juci-plugin-statsview

# Build
make package/juci-plugin-statsview/compile V=s
```

## 7. Wi-Fi Client Data Sources

### hostapd_cli all_sta Output Format

```
b0:be:76:xx:xx:xx
flags=[AUTH][ASSOC][AUTHORIZED][SHORT_PREAMBLE][WMM][HT][VHT][HE]
aid=1
capability=0x1431
listen_interval=10
supported_rates=0c 12 18 24 30 48 60 6c
timeout_next=NULLFUNC POLL
dot11RSNAStatsSTAAddress=b0:be:76:xx:xx:xx
rx_packets=12345
tx_packets=67890
rx_bytes=1234567
tx_bytes=7654321
inactive_msec=120
signal=-52
tx_bitrate=1201.0 MBit/s VHT-MCS 9 80MHz VHT-NSS 2
rx_bitrate=866.7 MBit/s VHT-MCS 9 80MHz VHT-NSS 2
connected_time=3600
```

### Extracting Per-Client Airtime

Per-client airtime is approximated from `connected_time` and TX/RX byte counters relative to PHY rate:

```
client_airtime_pct = (tx_bytes * 8 / tx_bitrate + rx_bytes * 8 / rx_bitrate) / measurement_window * 100
```

## 8. Wired Client Data Sources

### Bridge FDB

```bash
bridge fdb show br br-lan | grep -v permanent
# aa:bb:cc:dd:ee:ff dev lan1 master br-lan
```

### ARP Table

```bash
cat /proc/net/arp
# IP           HW type  Flags  HW address         Mask  Device
# 192.168.1.50 0x1      0x2    aa:bb:cc:dd:ee:ff  *     br-lan
```

### DHCP Leases

```bash
cat /tmp/dhcp.leases
# 1711234567 aa:bb:cc:dd:ee:ff 192.168.1.50 MyPhone 01:aa:bb:cc:dd:ee:ff
```

## 9. Performance Considerations

- **Memory:** Each chart stores up to 43,200 data points (24h at 2s intervals). With ~20 charts, this is approximately 7 MB of JavaScript heap. On resource-constrained devices, consider reducing `SV_MAX_HISTORY` to 3600 (1h)
- **CPU:** SVG rendering of 20+ charts with area fills is lightweight but avoid re-rendering all charts on every poll. Only update visible charts
- **Network:** Each poll cycle fetches ~20 chart endpoints. Batch into a single RPC call in production rather than individual HTTP requests
- **Client polling:** `hostapd_cli all_sta` and `bridge fdb show` are cheap syscalls. Safe to poll every 5-10 seconds
- **Netdata dbengine:** Uses ~32 MB page cache + 256 MB disk by default. Reduce `dbengine multihost disk space` to 64 MB on flash-constrained devices

## 10. Open Engineering Questions

1. **Netdata access method:** Direct browser fetch to port 19999 (requires uhttpd proxy) vs. JUCI RPC relay (adds latency but avoids CORS)?
2. **Wi-Fi airtime collector:** Custom Netdata plugin (chart-native) vs. JUCI Lua RPC (avoids adding to Netdata)?
3. **Client device classification:** Ship a static OUI database, or use fingerbank-style active fingerprinting?
4. **Per-client throughput history:** Store in Netdata (one chart per client, dynamic) or maintain in-browser only (lost on refresh)?
5. **Wired client byte counters:** Use bridge per-port counters, flowstatd per-MAC aggregation, or iptables/nftables per-MAC rules?
6. **Flash storage:** Netdata dbengine writes to `/var/cache/netdata/`. On devices with limited flash, should we use `memory mode = ram` instead?

## 11. Testing Checklist

- [ ] Netdata running and accessible on port 19999
- [ ] StatsView loads and detects live mode
- [ ] All 6 interfaces discovered from chart catalog
- [ ] Throughput charts show real traffic with correct units
- [ ] Error/drop dual Y-axis scales independently from throughput
- [ ] Wi-Fi airtime collector produces valid survey data
- [ ] Client list populates from hostapd + bridge + ARP + DHCP
- [ ] Client drilldown shows correct band/channel/RSSI/PHY rate
- [ ] Grab-to-pan works on all chart timelines
- [ ] Time range selector (5m/15m/1h/6h/24h) re-renders correctly
- [ ] Card drag-and-drop reorders and persists to localStorage
- [ ] Responsive layout works at 1920px, 1280px, 768px, and mobile
- [ ] Mock mode activates cleanly when Netdata is unreachable
- [ ] Memory usage stays under 50 MB after 24h of continuous use
