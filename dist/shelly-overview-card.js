/*
 * Shelly Overview Card für Home Assistant
 * Übersicht aller Shelly-Geräte: Suche, Stockwerke/Räume, Status, Updates (gestaffelt, Testgruppe),
 * Leistung, Temperatur, WLAN, Neustart- und Sicherheitshinweise, Schalter, CSV-Export.
 *
 * Installation: siehe Anleitung. Karte:  type: custom:shelly-overview-card
 */
const SOC_VERSION = "1.1.1";

const SOC_DEFAULTS = {
  title: "Shellys",
  test_label: "shelly_test", // Label-ID für die Testgruppe
  test_days: 3,              // Tage, die die Testgruppe stabil laufen soll
  temp_warn: 70,             // °C ab wann ein Hinweis kommt
  rssi_weak: -75,            // dBm, darunter = schwaches WLAN
  pause_seconds: 20,         // Pause zwischen zwei Updates
  update_timeout: 600,       // Sekunden, die pro Update maximal gewartet wird
  restart_hours: 24,         // Neustarts in diesem Zeitraum werden gemeldet
};

const SOC_COLS = [
  ["model", "Modell"],
  ["fw", "Firmware"],
  ["rssi", "WLAN"],
  ["power", "Leistung"],
  ["temp", "Temp."],
  ["uptime", "Laufzeit"],
];
const SOC_COL_WIDTH = {
  model: "minmax(0,.9fr)", fw: "minmax(0,1fr)", rssi: "44px",
  power: "64px", temp: "52px", uptime: "64px",
};

const socEsc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const socSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const socLS = {
  get(k, d) { try { const v = localStorage.getItem("shelly-ov-" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("shelly-ov-" + k, JSON.stringify(v)); } catch (e) { /* egal */ } },
};
const socNum = (s) => { const n = parseFloat(s); return Number.isFinite(n) ? n : null; };
const socAgo = (ms) => {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} Min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} Std`;
  return `${Math.round(h / 24)} T`;
};

class ShellyOverviewCard extends HTMLElement {
  setConfig(config) {
    this._cfg = { ...SOC_DEFAULTS, ...(config || {}) };
    this._view = socLS.get("view", "floor");
    this._filter = "all";
    this._q = "";
    this._cols = new Set(socLS.get("cols", ["fw", "rssi", "power", "temp", "uptime"]));
    this._closed = new Set(socLS.get("closed", []));
    this._openCl = new Set();
    this._notes = {};
    this._prog = {};
    this._busy = false;
    this._msg = "";
    this._panel = null;
    this._narrow = false;
  }

  static getStubConfig() { return {}; }
  getCardSize() { return 12; }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    if (!hass.floors && !this._floorReq) this._loadFloors();
    this._schedule();
  }

  connectedCallback() {
    if (!this._ro && window.ResizeObserver) {
      this._ro = new ResizeObserver(() => {
        const n = this.clientWidth > 0 && this.clientWidth < 620;
        if (n !== this._narrow) { this._narrow = n; this._force(); }
      });
      this._ro.observe(this);
    }
  }
  disconnectedCallback() { if (this._ro) { this._ro.disconnect(); this._ro = null; } }

  async _loadFloors() {
    this._floorReq = true;
    try {
      const list = await this._hass.callWS({ type: "config/floor_registry/list" });
      this._floors = {};
      list.forEach((f) => (this._floors[f.floor_id] = f));
    } catch (e) { this._floors = {}; }
    this._force();
  }

  /* ---------- Daten ---------- */

  _collect() {
    const h = this._hass, cfg = this._cfg;
    const devs = h.devices || {}, ents = h.entities || {}, areas = h.areas || {};
    const floors = h.floors || this._floors || {};
    const now = Date.now();
    const updatedByCard = socLS.get("updated", {});

    const shellyDevIds = new Set();
    for (const e of Object.values(ents)) if (e.platform === "shelly" && e.device_id) shellyDevIds.add(e.device_id);

    const rootOf = (id) => {
      let d = devs[id], guard = 0;
      while (d && d.via_device_id && shellyDevIds.has(d.via_device_id) && guard++ < 4) d = devs[d.via_device_id];
      return d;
    };

    const map = new Map();
    const rec = (dev) => {
      if (!map.has(dev.id)) {
        map.set(dev.id, {
          dev, children: [], upd: null, rssi: null, uptime: null, temps: [], powers: [],
          ctrls: [], states: [], cloud: null, rr: null, hot: null,
        });
      }
      return map.get(dev.id);
    };

    for (const e of Object.values(ents)) {
      if (e.platform !== "shelly" || !e.device_id) continue;
      const dev = devs[e.device_id]; if (!dev) continue;
      const root = rootOf(e.device_id) || dev;
      const r = rec(root);
      if (dev.id !== root.id && !r.children.includes(dev)) r.children.push(dev);
      const st = h.states[e.entity_id]; if (!st) continue; // deaktiviert
      const domain = e.entity_id.split(".")[0];
      const dc = st.attributes.device_class;
      const tk = e.translation_key || "";
      const cat = e.entity_category || null;
      const id = e.entity_id;

      r.states.push(st.state); // alle Entitäten zählen für „offline“
      if (domain === "update") {
        if (!/beta/.test(id) && !/beta/.test(tk)) r.upd = id;
        continue;
      }
      if (domain === "sensor") {
        if (dc === "signal_strength") r.rssi = id;
        else if (dc === "timestamp" && (tk === "uptime" || /uptime|last_restart|letzter_neustart/.test(id))) r.uptime = id;
        else if (dc === "temperature" && cat === "diagnostic") r.temps.push(id);
        else if (dc === "power" && !cat) r.powers.push(id);
      } else if (domain === "binary_sensor") {
        if (tk === "cloud" || /_cloud$/.test(id)) r.cloud = id;
        else if (tk === "restart_required" || /restart_required/.test(id)) r.rr = id;
        else if (tk === "overheating" || tk === "overtemp" || /overheat|overtemp/.test(id)) r.hot = id;
      } else if ((domain === "switch" || domain === "light") && !cat && !e.hidden) {
        r.ctrls.push(id);
      }
    }

    const out = [];
    for (const r of map.values()) {
      const d = r.dev;
      const name = d.name_by_user || d.name || "Shelly";
      let areaId = d.area_id || (r.children.find((c) => c.area_id) || {}).area_id || null;
      const area = areaId ? areas[areaId] : null;
      const floor = area && area.floor_id ? floors[area.floor_id] : null;
      let ip = "", url = d.configuration_url || "";
      try { if (url) ip = new URL(url).hostname; } catch (e) { /* egal */ }
      const modelId = d.model_id || "";
      const gen1 = /^SH/i.test(modelId);

      const us = r.upd ? h.states[r.upd] : null;
      const ua = us ? us.attributes : {};
      const fw = ua.installed_version || d.sw_version || "";
      const nf = us && us.state === "on" ? ua.latest_version : null;

      const rssi = r.rssi ? socNum(h.states[r.rssi].state) : null;
      const bars = rssi == null ? null : rssi > -55 ? 4 : rssi > -65 ? 3 : rssi > -75 ? 2 : rssi > -85 ? 1 : 0;

      let pw = r.powers;
      const totals = pw.filter((x) => /total/.test(x));
      if (totals.length) pw = totals;
      const pvals = pw.map((x) => socNum(h.states[x].state)).filter((x) => x != null);
      const power = pvals.length ? pvals.reduce((a, b) => a + b, 0) : null;

      const tvals = r.temps.map((x) => socNum(h.states[x].state)).filter((x) => x != null);
      const temp = tvals.length ? Math.max(...tvals) : null;

      let restart = null;
      if (r.uptime) { const t = Date.parse(h.states[r.uptime].state); if (Number.isFinite(t)) restart = t; }

      // Offline nur, wenn HA ALLE Entitäten als „unavailable“ meldet. „unknown“ ist normal
      // (Ereignis noch nicht ausgelöst, Taste nie gedrückt) und heißt nicht offline.
      const offline = r.states.length > 0 && r.states.every((s) => s === "unavailable");

      const hints = [];
      if (!offline) {
        if (temp != null && temp >= cfg.temp_warn) hints.push(`Gerätetemperatur ${Math.round(temp)} °C`);
        if (restart && now - restart < cfg.restart_hours * 3600e3) {
          const byCard = updatedByCard[d.id] && Math.abs(updatedByCard[d.id] - restart) < 30 * 60e3;
          if (!byCard) hints.push(`Neustart vor ${socAgo(now - restart)} ohne Update durch diese Karte`);
        }
        if (r.cloud && h.states[r.cloud].state === "on") hints.push("Shelly-Cloud verbunden");
        if (r.rr && h.states[r.rr].state === "on") hints.push("Neustart erforderlich");
        if (r.hot && h.states[r.hot].state === "on") hints.push("Überhitzung gemeldet");
      }

      const labels = new Set([...(d.labels || []), ...r.children.flatMap((c) => c.labels || [])]);
      const status = offline ? "off" : nf ? "upd" : rssi != null && rssi < cfg.rssi_weak ? "weak" : "ok";

      out.push({
        id: d.id, name, model: d.model || modelId || "", modelId, gen1, ip, url,
        areaId, areaName: area ? area.name : "",
        floorId: floor ? floor.floor_id : area ? "_nofloor" : "_noarea",
        floorName: floor ? floor.name : area ? "Ohne Stockwerk" : "Ohne Raum",
        floorLevel: floor ? (floor.level ?? 0) : area ? 900 : 999,
        fw, nf, updEnt: r.upd, inProg: !!ua.in_progress, pct: ua.update_percentage,
        releaseUrl: ua.release_url || "", releaseSummary: ua.release_summary || "",
        rssi, bars, power, temp, restart, ctrls: r.ctrls, offline, hints, status,
        test: labels.has(cfg.test_label),
      });
    }
    out.sort((a, b) => a.floorLevel - b.floorLevel || a.floorName.localeCompare(b.floorName, "de") ||
      a.areaName.localeCompare(b.areaName, "de") || a.name.localeCompare(b.name, "de"));
    return out;
  }

  /* ---------- Gerüst ---------- */

  _build() {
    this._built = true;
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
<style>
:host{display:block}
ha-card{padding:16px}
.hdr{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.hdr h1{font-size:20px;font-weight:500;margin:0;flex:1;color:var(--primary-text-color)}
.ver{font-size:11px;color:var(--secondary-text-color)}
.search{position:relative;margin-bottom:10px}
.search ha-icon{position:absolute;left:10px;top:9px;--mdc-icon-size:20px;color:var(--secondary-text-color)}
.search input{width:100%;box-sizing:border-box;height:38px;padding:0 12px 0 38px;font-size:14px;border-radius:8px;
  border:1px solid var(--divider-color);background:var(--card-background-color);color:var(--primary-text-color);outline:none}
.search input:focus{border-color:var(--primary-color)}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
.seg{display:inline-flex;border:1px solid var(--divider-color);border-radius:8px;overflow:hidden}
.seg button{border:0;background:transparent;color:var(--primary-text-color);font-size:13px;padding:6px 10px;display:flex;gap:5px;align-items:center;cursor:pointer;font-family:inherit}
.seg button+button{border-left:1px solid var(--divider-color)}
.seg button.on{background:var(--secondary-background-color);font-weight:500}
.seg ha-icon,.btn ha-icon{--mdc-icon-size:16px}
.btn{border:1px solid var(--divider-color);background:transparent;color:var(--primary-text-color);border-radius:8px;font-size:13px;padding:6px 10px;cursor:pointer;display:inline-flex;gap:5px;align-items:center;font-family:inherit}
.btn:hover{background:var(--secondary-background-color)}
.btn.pri{border-color:var(--primary-color);color:var(--primary-color)}
.sp{flex:1}
.cnt{font-size:12px;color:var(--secondary-text-color)}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}
.c-off{background:var(--error-color,#db4437)}.c-upd{background:var(--info-color,#039be5)}.c-weak{background:var(--warning-color,#ffa600)}.c-ok{background:var(--success-color,#43a047)}
.panel{font-size:13px;color:var(--secondary-text-color);background:var(--secondary-background-color);border-radius:8px;padding:10px 12px;margin-bottom:8px}
.panel b{color:var(--primary-text-color);font-weight:500}
.panel .acts{margin-top:8px;display:flex;gap:8px;flex-wrap:wrap}
.cols{display:flex;gap:14px;flex-wrap:wrap}
.cols label{display:flex;gap:5px;align-items:center;cursor:pointer}
.row{display:grid;gap:10px;align-items:center;padding:7px 4px 7px 20px;border-top:1px solid var(--divider-color);font-size:13px;color:var(--secondary-text-color)}
.row.flat{padding-left:4px}
.row:hover{background:var(--secondary-background-color)}
.nm{color:var(--primary-text-color);font-size:14px;font-weight:500;display:flex;gap:4px;align-items:center;min-width:0}
.nm a{color:inherit;text-decoration:none;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nm a:hover{text-decoration:underline}
.nm ha-icon{--mdc-icon-size:16px;flex:none}
.sub{font-size:12px;color:var(--secondary-text-color);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.85}
.lk{color:var(--primary-color);text-decoration:none;cursor:pointer}
.lk ha-icon{--mdc-icon-size:13px;vertical-align:-1px}
.ell{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.warn{color:var(--warning-color,#ffa600);font-weight:500}
.err{color:var(--error-color,#db4437)}
.fl{display:flex;align-items:center;gap:8px;padding:14px 4px 8px;cursor:pointer;border-top:2px solid var(--divider-color);user-select:none;flex-wrap:wrap}
.fl h3{margin:0;font-size:16px;font-weight:500;color:var(--primary-text-color)}
.fl ha-icon{--mdc-icon-size:18px;color:var(--secondary-text-color)}
.rm{font-size:13px;color:var(--secondary-text-color);padding:8px 4px 6px 12px;border-top:1px solid var(--divider-color);display:flex;gap:6px;align-items:center;cursor:pointer;user-select:none;flex-wrap:wrap}
.rm:hover{background:var(--secondary-background-color)}
.rm .rn{color:var(--primary-text-color);font-weight:500}
.rm ha-icon{--mdc-icon-size:14px}
.pill{font-size:12px;padding:1px 8px;border-radius:8px}
.p-upd{background:rgba(3,155,229,.15);color:var(--info-color,#039be5)}
.p-off{background:rgba(219,68,55,.15);color:var(--error-color,#db4437)}
.p-warn{background:rgba(255,166,0,.18);color:var(--warning-color,#c77c00)}
.sig{display:inline-flex;gap:2px;align-items:flex-end;height:12px}
.sig i{width:3px;background:var(--divider-color);display:block}
.sig i.f{background:var(--primary-text-color)}
.sws{display:flex;justify-content:flex-end;gap:4px;align-items:center}
.sw{width:30px;height:18px;border-radius:9px;background:var(--disabled-color,#bdbdbd);border:0;padding:0;position:relative;cursor:pointer;flex:none}
.sw::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .15s}
.sw.on{background:var(--success-color,#43a047)}.sw.on::after{left:14px}
.sw.na{opacity:.35;cursor:default}
.ub{border:1px solid var(--primary-color);color:var(--primary-color);background:transparent;border-radius:6px;font-size:12px;padding:2px 8px;cursor:pointer;font-family:inherit}
.cl{padding:8px 12px 10px 44px;font-size:12px;color:var(--secondary-text-color);background:var(--secondary-background-color);border-top:1px solid var(--divider-color);white-space:pre-line}
.cl b{color:var(--primary-text-color);font-weight:500}
.rooms{display:flex;gap:8px;flex-wrap:wrap;padding:0 4px 8px}
.room{border:1px solid var(--divider-color);border-radius:8px;padding:8px 10px;min-height:60px;flex:1 1 140px;font-size:12px;color:var(--secondary-text-color)}
.room .t{margin-bottom:6px;color:var(--primary-text-color);font-weight:500}
.room .ds{display:flex;gap:6px 10px;flex-wrap:wrap}
.room .d{display:inline-flex;align-items:center;gap:4px;cursor:pointer}
.room .d .dot{width:10px;height:10px}
mark{background:rgba(255,200,0,.35);color:inherit;border-radius:2px}
.empty{font-size:13px;color:var(--secondary-text-color);padding:12px 4px;border-top:1px solid var(--divider-color)}
.msg{font-size:13px;color:var(--secondary-text-color);margin:10px 0 0;min-height:1em}
.leg{font-size:12px;color:var(--secondary-text-color);margin-top:4px;display:flex;gap:12px;flex-wrap:wrap;opacity:.8}
.leg ha-icon{--mdc-icon-size:14px;vertical-align:-2px}
</style>
<ha-card>
  <div class="hdr"><h1 id="title"></h1><span class="ver">v${SOC_VERSION}</span></div>
  <div class="search"><ha-icon icon="mdi:magnify"></ha-icon>
    <input id="q" type="text" placeholder="Name, Raum, Stockwerk, Modell, IP oder Firmware" aria-label="Shellys durchsuchen"></div>
  <div class="bar">
    <div class="seg" id="view">
      <button data-v="floor"><ha-icon icon="mdi:stairs"></ha-icon>Stockwerk</button>
      <button data-v="list"><ha-icon icon="mdi:format-list-bulleted"></ha-icon>Liste</button>
      <button data-v="plan"><ha-icon icon="mdi:floor-plan"></ha-icon>Grundriss</button>
    </div>
    <div class="seg" id="filt">
      <button data-f="all">Alle <span class="cnt" id="c-all"></span></button>
      <button data-f="upd" title="Updates verfügbar"><span class="dot c-upd"></span><span class="cnt" id="c-upd"></span></button>
      <button data-f="off" title="Offline"><span class="dot c-off"></span><span class="cnt" id="c-off"></span></button>
      <button data-f="weak" title="Schwaches WLAN"><span class="dot c-weak"></span><span class="cnt" id="c-weak"></span></button>
      <button data-f="hint" title="Hinweise"><ha-icon icon="mdi:alert-outline" style="color:var(--warning-color,#ffa600)"></ha-icon><span class="cnt" id="c-hint"></span></button>
    </div>
    <span class="sp"></span>
    <button class="btn" id="b-fold" title="Alles auf- oder zuklappen"><ha-icon icon="mdi:unfold-less-horizontal"></ha-icon></button>
    <button class="btn" id="b-cols" title="Spalten wählen"><ha-icon icon="mdi:view-column-outline"></ha-icon></button>
    <button class="btn" id="b-csv" title="Als CSV exportieren"><ha-icon icon="mdi:file-export-outline"></ha-icon></button>
    <button class="btn" id="b-upd"><ha-icon icon="mdi:download"></ha-icon>Updates</button>
  </div>
  <div id="panel"></div>
  <div id="banner"></div>
  <div id="list"></div>
  <p class="msg" id="msg"></p>
  <div class="leg">
    <span><ha-icon icon="mdi:flask-outline"></ha-icon> Testgruppe</span>
    <span><ha-icon icon="mdi:restart-alert"></ha-icon> Neustart</span>
    <span><ha-icon icon="mdi:shield-alert-outline"></ha-icon> Hinweis</span>
    <span>Name → HA-Gerät · IP → Shelly-Oberfläche</span>
  </div>
</ha-card>`;
    const $ = (s) => root.querySelector(s);
    this._$ = $;
    $("#title").textContent = this._cfg.title;
    $("#q").addEventListener("input", (e) => { this._q = e.target.value; this._force(); });
    $("#view").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      this._view = b.dataset.v; socLS.set("view", this._view); this._force();
    });
    $("#filt").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      this._filter = b.dataset.f; this._force();
    });
    $("#b-cols").addEventListener("click", () => { this._panel = this._panel === "cols" ? null : "cols"; this._force(); });
    $("#b-upd").addEventListener("click", () => { this._panel = this._panel === "upd" ? null : "upd"; this._force(); });
    $("#b-csv").addEventListener("click", () => this._csv());
    $("#b-fold").addEventListener("click", () => this._foldAll());
    $("#panel").addEventListener("click", (e) => this._onPanel(e));
    $("#panel").addEventListener("change", (e) => {
      const i = e.target.closest("input[data-c]"); if (!i) return;
      i.checked ? this._cols.add(i.dataset.c) : this._cols.delete(i.dataset.c);
      socLS.set("cols", [...this._cols]); this._force();
    });
    $("#banner").addEventListener("click", (e) => {
      if (e.target.closest("[data-act=rest]")) this._startRest();
      if (e.target.closest("[data-act=dismiss]")) { socLS.set("testRun", null); this._force(); }
    });
    $("#list").addEventListener("click", (e) => this._onList(e));
  }

  _schedule() {
    if (this._timer) return;
    const wait = Math.max(0, 1000 - (Date.now() - (this._last || 0)));
    this._timer = setTimeout(() => { this._timer = null; this._render(false); }, wait);
  }
  _force() { this._render(true); }
  _setMsg(m) { this._msg = m; if (this._$) this._$("#msg").textContent = m; }

  /* ---------- Darstellung ---------- */

  _render(force) {
    if (!this._hass || !this._built) return;
    this._last = Date.now();
    const data = this._collect();
    const sig = JSON.stringify(data) + "|" + JSON.stringify(this._prog);
    if (!force && sig === this._sig) return;
    this._sig = sig;
    this._data = data;
    const $ = this._$;

    $("#view").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === this._view));
    $("#filt").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.f === this._filter));

    const s = this._q.trim().toLowerCase();
    const match = data.filter((d) => !s || [d.name, d.areaName, d.floorName, d.model, d.modelId, d.ip, d.fw].join(" ").toLowerCase().includes(s));
    $("#c-all").textContent = match.length;
    ["upd", "off", "weak"].forEach((k) => ($("#c-" + k).textContent = match.filter((d) => d.status === k).length));
    $("#c-hint").textContent = match.filter((d) => d.hints.length).length;
    const shown = match.filter((d) => this._filter === "all" || (this._filter === "hint" ? d.hints.length : d.status === this._filter));

    $("#panel").innerHTML = this._panelHtml(data);
    $("#banner").innerHTML = this._bannerHtml(data);
    $("#msg").textContent = this._msg;

    const L = $("#list");
    if (!data.length) { L.innerHTML = `<div class="empty">Keine Shelly-Geräte gefunden. Ist die Shelly-Integration eingerichtet?</div>`; return; }
    if (!shown.length) { L.innerHTML = `<div class="empty">Kein Shelly passt zu dieser Suche.</div>`; return; }

    if (this._view === "list") { L.innerHTML = shown.map((d) => this._row(d, s, false)).join(""); return; }

    const groups = [];
    for (const d of shown) {
      let g = groups.find((x) => x.id === d.floorId);
      if (!g) { g = { id: d.floorId, name: d.floorName, items: [] }; groups.push(g); }
      g.items.push(d);
    }
    let h = "";
    for (const g of groups) {
      const all = data.filter((d) => d.floorId === g.id);
      const open = this._view === "plan" || !this._closed.has(g.id) || s;
      h += `<div class="fl" data-act="fl" data-id="${socEsc(g.id)}">
        ${this._view === "plan" ? "" : `<ha-icon icon="mdi:chevron-${open ? "down" : "right"}"></ha-icon>`}
        <h3>${this._hl(g.name, s)}</h3><span class="cnt">${all.length} Shellys</span>${this._pills(all)}
        ${g.id === "_noarea" ? `<span class="cnt">· in HA einem Raum zuordnen</span>` : ""}</div>`;
      if (!open) continue;
      const rooms = [...new Set(g.items.map((d) => d.areaName))];
      if (this._view === "plan") {
        h += `<div class="rooms">` + rooms.map((r) => `<div class="room"><div class="t">${socEsc(r || "Ohne Raum")}</div><div class="ds">` +
          g.items.filter((d) => d.areaName === r).map((d) =>
            `<span class="d" data-act="dev" data-id="${d.id}" title="${socEsc(d.name + (d.hints.length ? " – " + d.hints.join(", ") : ""))}"><span class="dot c-${d.status}"></span>${socEsc(d.name)}</span>`).join("") +
          `</div></div>`).join("") + `</div>`;
        continue;
      }
      for (const r of rooms) {
        const key = "r:" + g.id + "|" + r;
        const items = g.items.filter((d) => d.areaName === r);
        const ropen = !r || !this._closed.has(key) || s;
        if (r) {
          const allR = data.filter((d) => d.floorId === g.id && d.areaName === r);
          h += `<div class="rm" data-act="rm" data-id="${socEsc(key)}"><ha-icon icon="mdi:chevron-${ropen ? "down" : "right"}"></ha-icon>
            <ha-icon icon="mdi:door"></ha-icon><span class="rn">${this._hl(r, s)}</span><span class="cnt">${allR.length}</span>${ropen ? "" : this._pills(allR)}</div>`;
        }
        if (ropen) h += items.map((d) => this._row(d, s, true)).join("");
      }
    }
    L.innerHTML = h;
  }

  _hl(t, s) {
    t = String(t ?? "");
    if (!s) return socEsc(t);
    const i = t.toLowerCase().indexOf(s);
    if (i < 0) return socEsc(t);
    return socEsc(t.slice(0, i)) + "<mark>" + socEsc(t.slice(i, i + s.length)) + "</mark>" + socEsc(t.slice(i + s.length));
  }

  _visCols() {
    const narrow = this._narrow ? new Set(["fw", "rssi"]) : null;
    return SOC_COLS.map((c) => c[0]).filter((k) => this._cols.has(k) && (!narrow || narrow.has(k)));
  }

  _pills(all) {
    const u = all.filter((d) => d.status === "upd").length, o = all.filter((d) => d.offline).length;
    const w = all.filter((d) => d.status === "weak").length, hn = all.filter((d) => d.hints.length).length;
    const W = all.reduce((x, d) => x + (d.power || 0), 0);
    return (W ? `<span class="cnt">⚡ ${Math.round(W)} W</span>` : "") +
      (u ? `<span class="pill p-upd">${u} Update${u > 1 ? "s" : ""}</span>` : "") +
      (o ? `<span class="pill p-off">${o} offline</span>` : "") +
      (w ? `<span class="pill p-warn">${w} WLAN</span>` : "") +
      (hn ? `<span class="pill p-warn">${hn} Hinweis${hn > 1 ? "e" : ""}</span>` : "");
  }

  _bars(n) {
    let h = "";
    for (let i = 1; i <= 4; i++) h += `<i class="${i <= n ? "f" : ""}" style="height:${i * 3}px"></i>`;
    return `<span class="sig">${h}</span>`;
  }

  _cell(k, d, s) {
    switch (k) {
      case "model": return `<span class="ell" title="${socEsc(d.modelId)}">${this._hl(d.model, s)}</span>`;
      case "fw": {
        if (this._prog[d.id]) return `<span class="lk">${socEsc(this._prog[d.id])}</span>`;
        if (d.inProg) return `<span class="lk">${d.pct != null ? Math.round(d.pct) + " %" : "installiert …"}</span>`;
        return `<span class="ell">${this._hl(d.fw, s)}${d.nf ? ` <span class="lk" data-act="cl" data-id="${d.id}" title="Änderungen anzeigen">→ ${socEsc(d.nf)}</span>` : ""}</span>`;
      }
      case "rssi":
        if (d.offline) return `<span class="err">aus</span>`;
        return d.bars == null ? `<span>–</span>` : `<span title="${d.rssi} dBm">${this._bars(d.bars)}</span>`;
      case "power": return `<span>${d.power == null ? "–" : Math.round(d.power) + " W"}</span>`;
      case "temp": return `<span class="${d.temp != null && d.temp >= this._cfg.temp_warn ? "warn" : ""}">${d.temp == null ? "–" : Math.round(d.temp) + " °C"}</span>`;
      case "uptime": return `<span>${d.restart ? socAgo(Date.now() - d.restart) : "–"}</span>`;
    }
    return "";
  }

  _row(d, s, indent) {
    const cols = this._visCols();
    const tpl = "16px minmax(0,1.6fr) " + cols.map((k) => SOC_COL_WIDTH[k]).join(" ") + " 80px";
    let ic = "";
    if (d.test) ic += `<ha-icon icon="mdi:flask-outline" title="Testgruppe: bekommt Updates zuerst"></ha-icon>`;
    const rs = d.hints.filter((x) => x.startsWith("Neustart vor"));
    const ot = d.hints.filter((x) => !x.startsWith("Neustart vor"));
    if (rs.length) ic += `<ha-icon icon="mdi:restart-alert" style="color:var(--warning-color,#ffa600)" title="${socEsc(rs.join(", "))}"></ha-icon>`;
    if (ot.length) ic += `<ha-icon icon="mdi:shield-alert-outline" style="color:var(--warning-color,#ffa600)" title="${socEsc(ot.join(", "))}"></ha-icon>`;

    const h = this._hass;
    let act = "";
    if (d.nf && !d.offline && !this._prog[d.id] && !d.inProg && this._narrow) act = `<button class="ub" data-act="one" data-id="${d.id}">Update</button>`;
    else if (!d.offline) {
      act = d.ctrls.slice(0, 4).map((c) => {
        const st = h.states[c]; const on = st && st.state === "on"; const na = !st || st.state === "unavailable";
        const nm = (st && st.attributes.friendly_name) || c;
        return `<button class="sw ${on ? "on" : ""} ${na ? "na" : ""}" data-act="sw" data-ent="${socEsc(c)}" title="${socEsc(nm)}" aria-label="${socEsc(nm)} schalten"></button>`;
      }).join("");
    }

    const sub = (d.ip ? `<a class="lk" href="${socEsc(d.url)}" target="_blank" rel="noopener" title="Shelly-Weboberfläche öffnen"><ha-icon icon="mdi:open-in-new"></ha-icon> ${this._hl(d.ip, s)}</a>` : "") +
      (indent ? "" : ` · ${this._hl(d.areaName || "Ohne Raum", s)} · ${this._hl(d.floorName, s)}`);

    let r = `<div class="row ${indent ? "" : "flat"}" style="grid-template-columns:${tpl}">
      <span class="dot c-${d.status}" title="${{ off: "Offline", upd: "Update verfügbar", weak: "Schwaches WLAN", ok: "OK" }[d.status]}"></span>
      <div style="min-width:0"><div class="nm"><a data-act="dev" data-id="${d.id}" title="HA-Geräteseite öffnen">${this._hl(d.name, s)}</a>${ic}</div>
      <div class="sub">${sub}</div></div>
      ${cols.map((k) => this._cell(k, d, s)).join("")}
      <span class="sws">${act}</span></div>`;

    if (this._openCl.has(d.id) && d.nf) {
      const n = this._notes[d.id];
      const body = n === undefined ? "Lade Änderungen …" : n ? socEsc(n.length > 1500 ? n.slice(0, 1500) + " …" : n) : "Keine Beschreibung verfügbar.";
      r += `<div class="cl"><b>Neu in ${socEsc(d.nf)}</b> (installiert: ${socEsc(d.fw)})
${body}
${d.releaseUrl ? `<a class="lk" href="${socEsc(d.releaseUrl)}" target="_blank" rel="noopener">Vollständige Release Notes</a> · ` : ""}<span class="lk" data-act="one" data-id="${d.id}">Nur dieses Gerät jetzt aktualisieren</span></div>`;
    }
    return r;
  }

  _panelHtml(data) {
    if (this._panel === "cols") {
      return `<div class="panel"><div class="cols">${SOC_COLS.map(([k, l]) =>
        `<label><input type="checkbox" data-c="${k}" ${this._cols.has(k) ? "checked" : ""}>${l}</label>`).join("")}</div>
        ${this._narrow ? `<div style="margin-top:6px">Auf schmalen Bildschirmen werden nur Firmware und WLAN gezeigt.</div>` : ""}</div>`;
    }
    if (this._panel === "upd") {
      if (this._busy) return `<div class="panel"><b>Updates laufen …</b> Bitte diese Seite offen lassen.</div>`;
      const p = data.filter((d) => d.nf && !d.offline && d.updEnt);
      if (!p.length) return `<div class="panel">Alle erreichbaren Shellys sind aktuell.</div>`;
      const t = p.filter((d) => d.test), r = p.filter((d) => !d.test);
      const names = (l) => l.map((d) => socEsc(d.name)).join(", ");
      return `<div class="panel"><b>${p.length} Update${p.length > 1 ? "s" : ""} verfügbar</b><br>
        ${t.length ? `1. Testgruppe jetzt: ${names(t)}<br>2. Übrige ${r.length} nach ${this._cfg.test_days} Tagen, wenn alles stabil läuft`
          : `Nacheinander, mit ${this._cfg.pause_seconds} s Pause: ${names(p)}${!data.some((d) => d.test) ? `<br><span style="opacity:.8">Tipp: Vergib in HA das Label „${socEsc(this._cfg.test_label)}“ an 2–3 unkritische Shellys, dann werden sie zuerst aktualisiert.</span>` : ""}`}
        <div class="acts">
          ${t.length ? `<button class="btn pri" data-act="test">Testgruppe starten</button>` : `<button class="btn pri" data-act="all">Starten</button>`}
          ${t.length ? `<button class="btn" data-act="all">Alle sofort, nacheinander</button>` : ""}
          <button class="btn" data-act="close">Abbrechen</button></div></div>`;
    }
    return "";
  }

  _bannerHtml(data) {
    const run = socLS.get("testRun", null);
    if (!run || this._busy) return "";
    const rest = data.filter((d) => d.nf && !d.test && !d.offline && d.updEnt);
    if (!rest.length) { socLS.set("testRun", null); return ""; }
    const days = (Date.now() - run.ts) / 864e5;
    const tests = data.filter((d) => d.test);
    const trouble = tests.filter((d) => d.offline || d.hints.length);
    const due = new Date(run.ts + this._cfg.test_days * 864e5).toLocaleDateString("de-DE");
    let txt;
    if (trouble.length) txt = `<b>Testgruppe auffällig:</b> ${trouble.map((d) => socEsc(d.name) + " (" + socEsc(d.offline ? "offline" : d.hints.join(", ")) + ")").join("; ")}. Übrige ${rest.length} Updates lieber noch zurückhalten.`;
    else if (days >= this._cfg.test_days) txt = `<b>Testgruppe läuft seit ${Math.floor(days)} Tagen stabil.</b> Die übrigen ${rest.length} Shellys können jetzt aktualisiert werden.`;
    else txt = `<b>Testgruppe aktualisiert</b> am ${new Date(run.ts).toLocaleDateString("de-DE")}. Übrige ${rest.length} Shellys ab ${due} empfohlen.`;
    return `<div class="panel">${txt}<div class="acts">
      <button class="btn ${days >= this._cfg.test_days && !trouble.length ? "pri" : ""}" data-act="rest">Übrige jetzt aktualisieren</button>
      <button class="btn" data-act="dismiss">Ausblenden</button></div></div>`;
  }

  /* ---------- Aktionen ---------- */

  _onPanel(e) {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const a = b.dataset.act;
    const p = (this._data || []).filter((d) => d.nf && !d.offline && d.updEnt);
    if (a === "close") { this._panel = null; this._force(); return; }
    if (a === "test") {
      const t = p.filter((d) => d.test);
      socLS.set("testRun", { ts: Date.now() });
      this._panel = null;
      this._runUpdates(t, `Testgruppe aktualisiert. Die übrigen Shellys werden in ${this._cfg.test_days} Tagen hier oben vorgeschlagen.`);
    }
    if (a === "all") { this._panel = null; socLS.set("testRun", null); this._runUpdates(p); }
  }

  _foldAll() {
    const data = this._data || [];
    const keys = new Set();
    data.forEach((d) => { keys.add(d.floorId); if (d.areaName) keys.add("r:" + d.floorId + "|" + d.areaName); });
    const anyOpen = [...keys].some((k) => !this._closed.has(k));
    this._closed = anyOpen ? keys : new Set();
    socLS.set("closed", [...this._closed]);
    if (this._view !== "floor") { this._view = "floor"; socLS.set("view", "floor"); }
    this._force();
  }

  _startRest() {
    const r = (this._data || []).filter((d) => d.nf && !d.test && !d.offline && d.updEnt);
    socLS.set("testRun", null);
    this._runUpdates(r);
  }

  _onList(e) {
    const el = e.target.closest("[data-act]"); if (!el) return;
    const a = el.dataset.act, id = el.dataset.id;
    if (a === "fl" || a === "rm") {
      if (this._view === "plan") return;
      this._closed.has(id) ? this._closed.delete(id) : this._closed.add(id);
      socLS.set("closed", [...this._closed]); this._force();
    } else if (a === "dev") {
      history.pushState(null, "", `/config/devices/device/${id}`);
      window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
    } else if (a === "sw") {
      if (el.classList.contains("na")) return;
      this._hass.callService("homeassistant", "toggle", { entity_id: el.dataset.ent });
    } else if (a === "cl") {
      if (this._openCl.has(id)) this._openCl.delete(id); else { this._openCl.add(id); this._loadNotes(id); }
      this._force();
    } else if (a === "one") {
      const d = (this._data || []).find((x) => x.id === id);
      if (d) this._runUpdates([d]);
    }
  }

  async _loadNotes(id) {
    if (this._notes[id] !== undefined) return;
    const d = (this._data || []).find((x) => x.id === id); if (!d || !d.updEnt) return;
    let n = d.releaseSummary || "";
    try {
      const r = await this._hass.callWS({ type: "update/release_notes", entity_id: d.updEnt });
      if (r) n = String(r).replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();
    } catch (e) { /* nicht unterstützt */ }
    this._notes[id] = n;
    this._force();
  }

  async _runUpdates(list, after) {
    if (this._busy || !list.length) return;
    this._busy = true;
    const cfg = this._cfg;
    const updated = socLS.get("updated", {});
    let ok = 0, fail = 0;
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      this._setMsg(`Update ${i + 1} von ${list.length}: ${d.name}`);
      this._prog[d.id] = "startet …"; this._force();
      updated[d.id] = Date.now(); socLS.set("updated", updated);
      try {
        await this._hass.callService("update", "install", { entity_id: d.updEnt });
      } catch (e) {
        this._prog[d.id] = "Fehler beim Start"; this._force(); fail++; await socSleep(2000); delete this._prog[d.id]; continue;
      }
      const t0 = Date.now(); let done = false;
      while (Date.now() - t0 < cfg.update_timeout * 1000) {
        await socSleep(2000);
        const st = this._hass.states[d.updEnt]; if (!st) continue;
        const a = st.attributes;
        if (a.in_progress) this._prog[d.id] = a.update_percentage != null ? `lädt ${Math.round(a.update_percentage)} %` : "installiert …";
        else if (st.state === "unavailable") this._prog[d.id] = "startet neu …";
        else if (st.state === "off") { done = true; break; }
        this._force();
      }
      updated[d.id] = Date.now(); socLS.set("updated", updated);
      delete this._prog[d.id];
      done ? ok++ : fail++;
      if (!done) { this._prog[d.id] = "Zeitüberschreitung"; this._force(); await socSleep(3000); delete this._prog[d.id]; }
      this._force();
      if (i < list.length - 1) {
        for (let s = cfg.pause_seconds; s > 0; s--) { this._setMsg(`Pause vor dem nächsten Update: ${s} s`); await socSleep(1000); }
      }
    }
    this._busy = false;
    this._setMsg((after ? after + " " : "") + `${ok} erfolgreich${fail ? `, ${fail} mit Problemen` : ""}.`);
    this._force();
  }

  _csv() {
    const data = this._data || [];
    const head = ["Name", "Stockwerk", "Raum", "Modell", "Modell-ID", "IP", "Firmware", "Update verfügbar", "WLAN dBm", "Leistung W", "Temperatur °C", "Status", "Hinweise", "Testgruppe"];
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = data.map((d) => [d.name, d.floorName, d.areaName, d.model, d.modelId, d.ip, d.fw, d.nf || "", d.rssi ?? "",
      d.power != null ? Math.round(d.power) : "", d.temp != null ? Math.round(d.temp) : "",
      { off: "offline", upd: "Update", weak: "WLAN schwach", ok: "OK" }[d.status], d.hints.join(", "), d.test ? "ja" : ""].map(q).join(";"));
    const blob = new Blob(["﻿" + [head.map(q).join(";"), ...rows].join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `shellys-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    this._setMsg(`CSV mit ${data.length} Shellys exportiert.`);
  }
}

if (!customElements.get("shelly-overview-card")) customElements.define("shelly-overview-card", ShellyOverviewCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "shelly-overview-card",
  name: "Shelly-Übersicht",
  description: "Alle Shellys mit Suche, Stockwerken, Status und gestaffelten Updates.",
});
console.info(`%c SHELLY-OVERVIEW-CARD %c v${SOC_VERSION} `, "background:#4a90d9;color:#fff", "background:#ddd;color:#333");
