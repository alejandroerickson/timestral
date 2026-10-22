import uPlot from "/vendor/uPlot.esm.js";

const $ = (id) => document.getElementById(id);
const el = {
  status: $("status"),
  dataset: $("dataset"),
  upload: $("upload"),
  model: $("model"),
  horizon: $("horizon"),
  maxContext: $("maxContext"),
  period: $("period"),
  auto: $("auto"),
  showBaseline: $("showBaseline"),
  run: $("run"),
  cutoff: $("cutoff"),
  cutoffLabel: $("cutoffLabel"),
  chart: $("chart"),
  chartCard: document.querySelector(".chart-card"),
  tooltip: $("tooltip"),
  baselineKey: $("baselineKey"),
  zoomForecast: $("zoomForecast"),
  zoomAll: $("zoomAll"),
  metrics: document.querySelector("#metrics tbody"),
  timing: $("timing"),
  download: $("download"),
};

// Series order in the uPlot data array. Bands first so the actual line draws on top.
const S = { x: 0, q99: 1, q01: 2, q90: 3, q10: 4, median: 5, baseline: 6, actual: 7 };

const state = {
  datasets: [],
  series: null, // { id, name, values, timestamps, period, horizon }
  forecast: null, // last worker response, plus { cutoff, horizon, contextStart }
  plot: null,
  seq: 0,
};

// --- helpers -----------------------------------------------------------------

const cssVar = (name) => getComputedStyle(document.querySelector(".viz-root")).getPropertyValue(name).trim();
const intOf = (input, fallback) => (Number.isFinite(parseInt(input.value, 10)) ? parseInt(input.value, 10) : fallback);
const fmt = (v, digits = 3) => {
  if (v == null || !Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e5 || a < 1e-3)) return v.toExponential(2);
  return v.toLocaleString(undefined, { maximumFractionDigits: a >= 100 ? 1 : digits });
};

function timeLabel(i) {
  const s = state.series;
  if (!s) return "";
  i = Math.round(i);
  if (!s.timestamps) return `t=${i}`;
  if (i < s.timestamps.length) return s.timestamps[i].slice(0, 16);
  return `end+${i - s.timestamps.length + 1}`;
}

function setStatus(text, isError = false) {
  el.status.textContent = text;
  el.status.classList.toggle("error", isError);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// --- data assembly -------------------------------------------------------------

function params() {
  const s = state.series;
  const n = s.values.length;
  const cutoff = Math.min(Math.max(intOf(el.cutoff, n), 1), n);
  const horizon = Math.min(Math.max(intOf(el.horizon, s.horizon), 1), 4096);
  const maxContext = Math.min(Math.max(intOf(el.maxContext, 32768), 1), 32768);
  const period = Math.max(intOf(el.period, 1), 1);
  return { cutoff, horizon, contextStart: Math.max(0, cutoff - maxContext), period };
}

function buildData() {
  const s = state.series;
  const f = state.forecast;
  const n = s.values.length;
  const end = f ? Math.max(n, f.cutoff + f.horizon) : n;
  const x = Array.from({ length: end }, (_, i) => i);
  const empty = () => new Array(end).fill(null);
  const data = [x, empty(), empty(), empty(), empty(), empty(), empty(), empty()];
  for (let i = 0; i < n; i++) data[S.actual][i] = s.values[i];
  if (f) {
    const li = f.quantile_levels;
    const col = { q01: li.indexOf(0.01), q99: li.indexOf(0.99), q10: li.indexOf(0.1), q90: li.indexOf(0.9) };
    // Anchor the forecast to the last observed point so it reads as a continuation.
    const anchor = s.values[f.cutoff - 1];
    if (anchor != null) for (const k of ["q01", "q99", "q10", "q90", "median", "baseline"]) data[S[k]][f.cutoff - 1] = anchor;
    for (let h = 0; h < f.horizon; h++) {
      const i = f.cutoff + h;
      const q = f.quantiles[h];
      for (const k of ["q01", "q99", "q10", "q90"]) data[S[k]][i] = q[col[k]];
      data[S.median][i] = f.median[h];
      data[S.baseline][i] = f.baseline[h];
    }
  }
  return data;
}

// --- chart ---------------------------------------------------------------------

function drawRegions(u) {
  const { cutoff, contextStart, horizon } = params();
  const { ctx } = u;
  const { left, top, width, height } = u.bbox;
  const px = (v) => Math.min(Math.max(u.valToPos(v, "x", true), left), left + width);
  ctx.save();
  if (contextStart > 0) {
    ctx.fillStyle = cssVar("--context-shade");
    ctx.fillRect(left, top, px(contextStart) - left, height);
  }
  const holdoutEnd = Math.min(cutoff + horizon, state.series.values.length);
  if (holdoutEnd > cutoff) {
    ctx.fillStyle = cssVar("--holdout-shade");
    ctx.fillRect(px(cutoff - 1), top, px(holdoutEnd - 1) - px(cutoff - 1), height);
  }
  ctx.restore();
}

function drawCutoff(u) {
  const { cutoff } = params();
  const x = Math.round(u.valToPos(cutoff - 1, "x", true)) + 0.5;
  const { left, top, width, height } = u.bbox;
  if (x < left || x > left + width) return;
  const { ctx } = u;
  ctx.save();
  ctx.strokeStyle = cssVar("--text-secondary");
  ctx.lineWidth = uPlot.pxRatio;
  ctx.setLineDash([3 * uPlot.pxRatio, 3 * uPlot.pxRatio]);
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x, top + height);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = cssVar("--text-secondary");
  ctx.font = `${11 * uPlot.pxRatio}px -apple-system, system-ui, sans-serif`;
  ctx.fillText("origin", x + 4 * uPlot.pxRatio, top + 12 * uPlot.pxRatio);
  ctx.restore();
}

function updateTooltip(u) {
  const idx = u.cursor.idx;
  const tip = el.tooltip;
  if (idx == null || u.cursor.left < 0) {
    tip.hidden = true;
    return;
  }
  const d = u.data;
  const rows = [
    ["--actual", "Actual", d[S.actual][idx]],
    ["--forecast", "Median", d[S.median][idx]],
  ];
  const lo = d[S.q10][idx];
  const hi = d[S.q90][idx];
  const hasForecast = state.forecast && idx >= state.forecast.cutoff;
  tip.replaceChildren();
  const when = document.createElement("div");
  when.className = "when";
  when.textContent = timeLabel(idx);
  tip.append(when);
  const addRow = (color, label, value, dashed = false) => {
    const row = document.createElement("div");
    row.className = "row";
    const key = document.createElement("i");
    key.className = "key line";
    key.style.borderColor = cssVar(color);
    if (dashed) key.style.borderTopStyle = "dashed";
    const strong = document.createElement("strong");
    strong.textContent = value;
    const name = document.createElement("span");
    name.textContent = label;
    row.append(key, strong, name);
    tip.append(row);
  };
  for (const [color, label, v] of rows) if (v != null && (label === "Actual" || hasForecast)) addRow(color, label, fmt(v));
  if (hasForecast && lo != null) addRow("--band80", "10–90%", `${fmt(lo)} – ${fmt(hi)}`);
  if (hasForecast && el.showBaseline.checked && d[S.baseline][idx] != null) {
    addRow("--baseline", "Seasonal naive", fmt(d[S.baseline][idx]), true);
  }
  tip.hidden = false;
  const over = u.over;
  const card = el.chartCard.getBoundingClientRect();
  const o = over.getBoundingClientRect();
  let left = o.left - card.left + u.cursor.left + 14;
  if (left + tip.offsetWidth > card.width - 8) left -= tip.offsetWidth + 28;
  tip.style.left = `${left}px`;
  tip.style.top = `${o.top - card.top + Math.max(8, u.cursor.top - tip.offsetHeight / 2)}px`;
}

function makePlot() {
  state.plot?.destroy();
  const transparent = "rgba(0,0,0,0)";
  const quiet = { stroke: transparent, points: { show: false } };
  const axis = {
    stroke: cssVar("--text-muted"),
    grid: { stroke: cssVar("--grid"), width: 1 },
    ticks: { stroke: cssVar("--grid"), width: 1 },
    font: "11px -apple-system, system-ui, sans-serif",
  };
  const opts = {
    width: el.chart.clientWidth,
    height: 440,
    scales: { x: { time: false } },
    legend: { show: false },
    cursor: { drag: { x: true, y: false }, points: { show: false } },
    series: [
      {},
      { label: "q99", ...quiet },
      { label: "q01", ...quiet },
      { label: "q90", ...quiet },
      { label: "q10", ...quiet },
      { label: "Median", stroke: cssVar("--forecast"), width: 2, points: { show: false } },
      {
        label: "Seasonal naive",
        stroke: cssVar("--baseline"),
        width: 1.5,
        dash: [5, 4],
        points: { show: false },
        show: el.showBaseline.checked,
      },
      { label: "Actual", stroke: cssVar("--actual"), width: 1.5, points: { show: false } },
    ],
    bands: [
      { series: [S.q99, S.q01], fill: cssVar("--band98") },
      { series: [S.q90, S.q10], fill: cssVar("--band80") },
    ],
    axes: [
      { ...axis, space: 100, values: (u, splits) => splits.map(timeLabel) },
      { ...axis, size: 60 },
    ],
    hooks: {
      drawClear: [drawRegions],
      draw: [drawCutoff],
      setCursor: [updateTooltip],
    },
  };
  state.plot = new uPlot(opts, buildData(), el.chart);
  attachClickToSetCutoff(state.plot);
}

// A plain click (no drag) on the plot moves the forecast origin. Double-click still resets zoom.
function attachClickToSetCutoff(u) {
  let down = null;
  let timer = null;
  u.over.addEventListener("mousedown", (e) => (down = { x: e.clientX, y: e.clientY }));
  u.over.addEventListener("mouseup", (e) => {
    const start = down;
    down = null;
    if (!start || Math.abs(e.clientX - start.x) > 3 || Math.abs(e.clientY - start.y) > 3) return;
    const idx = u.posToIdx(u.cursor.left);
    clearTimeout(timer);
    timer = setTimeout(() => setCutoff(idx + 1), 220);
  });
  u.over.addEventListener("dblclick", () => clearTimeout(timer));
  u.over.addEventListener("mouseleave", () => (el.tooltip.hidden = true));
}

function refreshPlot({ resetZoom = false } = {}) {
  const u = state.plot;
  if (!u) return makePlot();
  const { min, max } = u.scales.x;
  const data = buildData();
  u.setData(data, resetZoom);
  // Keep the zoom, but widen it if the forecast runs past the right edge.
  if (resetZoom || min == null) return;
  const f = state.forecast;
  const end = f ? f.cutoff + f.horizon - 1 : max;
  u.setScale("x", { min, max: f && f.cutoff - 1 <= max && end > max ? end : max });
}

function zoomToForecast() {
  const { cutoff, horizon } = state.forecast ?? params();
  const u = state.plot;
  const end = cutoff + horizon;
  u.setScale("x", { min: Math.max(0, cutoff - 3 * horizon), max: Math.min(u.data[0].length - 1, end) });
}

// --- forecasting ---------------------------------------------------------------

async function runForecast() {
  if (!state.series) return;
  const s = state.series;
  const p = params();
  const context = s.values.slice(p.contextStart, p.cutoff);
  const actual = s.values.slice(p.cutoff, p.cutoff + p.horizon);
  const seq = ++state.seq;
  el.chartCard.classList.add("loading");
  el.run.disabled = true;
  setStatus(`Forecasting ${p.horizon} steps from ${context.length} points…`);
  try {
    const res = await fetch("/api/forecast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: el.model.value,
        context,
        prediction_length: p.horizon,
        actual: actual.length ? actual : null,
        period: p.period,
      }),
    });
    const body = await res.json();
    if (seq !== state.seq) return; // a newer request superseded this one
    if (!res.ok || body.ok === false) throw new Error(body.error ?? res.statusText);
    state.forecast = { ...body, ...p };
    refreshPlot();
    renderMetrics();
    setStatus(`${el.model.selectedOptions[0].textContent} · CPU · ${body.timing_ms.inference.toFixed(0)} ms`);
  } catch (err) {
    if (seq === state.seq) setStatus(`Forecast failed: ${err.message}`, true);
  } finally {
    if (seq === state.seq) {
      el.chartCard.classList.remove("loading");
      el.run.disabled = false;
    }
  }
}

const autoRun = debounce(() => el.auto.checked && runForecast(), 250);

function renderMetrics() {
  const f = state.forecast;
  el.metrics.replaceChildren();
  el.download.disabled = !f;
  if (!f) return;
  const m = f.metrics ?? {};
  const t = m.timestral ?? {};
  const b = m.seasonal_naive ?? {};
  const pct = (v) => (v == null ? "–" : `${(v * 100).toFixed(1)}%`);
  const rows = [
    ["MAE", t.mae, b.mae, fmt, "lower"],
    ["RMSE", t.rmse, b.rmse, fmt, "lower"],
    ["MASE", t.mase, b.mase, fmt, "lower"],
    ["sMAPE", t.smape, b.smape, pct, "lower"],
    ["CRPS (quantile loss)", t.crps, null, fmt],
    ["Scaled CRPS", t.scaled_crps, null, fmt],
    ["10–90% interval coverage (target 80%)", t.coverage_80, null, pct],
    ["1–99% interval coverage (target 98%)", t.coverage_98, null, pct],
  ];
  if (!m.evaluated_steps) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 3;
    td.textContent = "No held-out data after the origin: this is a pure forecast of the future.";
    tr.append(td);
    el.metrics.append(tr);
  } else {
    for (const [label, tv, bv, f2, better] of rows) {
      const tr = document.createElement("tr");
      const cells = [label, f2(tv), bv === null && !better ? "" : f2(bv)].map((text) => {
        const td = document.createElement("td");
        td.textContent = text;
        return td;
      });
      if (better && tv != null && bv != null) cells[tv <= bv ? 1 : 2].classList.add("better");
      tr.append(...cells);
      el.metrics.append(tr);
    }
  }
  el.timing.textContent =
    `Context ${f.context_length} points · horizon ${f.horizon} · evaluated on ${m.evaluated_steps ?? 0} held-out points · ` +
    `inference ${f.timing_ms.inference.toFixed(0)} ms` +
    (f.timing_ms.load ? ` · model load ${(f.timing_ms.load / 1000).toFixed(1)} s` : "");
}

function downloadCsv() {
  const f = state.forecast;
  const s = state.series;
  const header = ["step", "timestamp", "actual", "median", ...f.quantile_levels.map((q) => `q${q}`), "seasonal_naive"];
  const lines = [header.join(",")];
  for (let h = 0; h < f.horizon; h++) {
    const i = f.cutoff + h;
    const cell = (v) => (v == null ? "" : v);
    lines.push([i, timeLabel(i), cell(s.values[i]), f.median[h], ...f.quantiles[h], cell(f.baseline[h])].join(","));
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  a.download = `${s.id}-origin${f.cutoff}-h${f.horizon}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// --- series selection ----------------------------------------------------------

function updateCutoffLabel() {
  const s = state.series;
  const p = params();
  const held = Math.max(0, Math.min(p.horizon, s.values.length - p.cutoff));
  el.cutoffLabel.textContent = `${timeLabel(p.cutoff - 1)} · context ${p.cutoff - p.contextStart} · held out ${held}`;
}

function setCutoff(value) {
  el.cutoff.value = Math.min(Math.max(value, Number(el.cutoff.min)), Number(el.cutoff.max));
  updateCutoffLabel();
  if (el.auto.checked) {
    el.chartCard.classList.add("loading"); // keep the previous forecast, dimmed, until the new one lands
    state.plot.redraw();
    autoRun();
  } else {
    state.forecast = null;
    refreshPlot();
    renderMetrics();
  }
}

function useSeries(series) {
  state.series = series;
  state.forecast = null;
  const n = series.values.length;
  const horizon = Math.max(1, Math.min(series.horizon ?? 96, Math.floor(n / 4)));
  el.horizon.value = horizon;
  el.period.value = series.period ?? 1;
  el.cutoff.min = Math.min(16, n);
  el.cutoff.max = n;
  el.cutoff.value = n - horizon;
  updateCutoffLabel();
  if (state.plot) refreshPlot({ resetZoom: true });
  else makePlot();
  renderMetrics();
  runForecast().then(() => state.series === series && zoomToForecast());
}

async function selectDataset(id) {
  setStatus("Loading dataset…");
  const res = await fetch(`/api/datasets/${encodeURIComponent(id)}`);
  if (!res.ok) return setStatus(`Could not load dataset ${id}`, true);
  useSeries(await res.json());
}

function parseCsv(text, name) {
  const rows = text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => l.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, "")));
  const isNum = (c) => c !== "" && Number.isFinite(Number(c));
  const header = rows[0].some((c) => !isNum(c) && c !== "") && rows.length > 1 && rows[1].some(isNum);
  const body = header ? rows.slice(1) : rows;
  const width = Math.max(...body.map((r) => r.length));
  let valueCol = -1;
  for (let c = width - 1; c >= 0; c--) {
    if (body.filter((r) => isNum(r[c] ?? "")).length >= 0.8 * body.length) {
      valueCol = c;
      break;
    }
  }
  if (valueCol < 0) throw new Error("no numeric column found");
  const timeCol = valueCol > 0 && body.some((r) => !isNum(r[0] ?? "")) ? 0 : -1;
  return {
    id: `upload-${name.replace(/\W+/g, "-")}`,
    name: `Uploaded: ${name}${header ? ` (${rows[0][valueCol]})` : ""}`,
    values: body.map((r) => (isNum(r[valueCol] ?? "") ? Number(r[valueCol]) : null)),
    timestamps: timeCol >= 0 ? body.map((r) => r[timeCol]) : null,
    period: 1,
    horizon: 96,
  };
}

// --- boot ----------------------------------------------------------------------

async function boot() {
  state.datasets = await (await fetch("/api/datasets")).json();
  const groups = { Real: [], Synthetic: [] };
  for (const d of state.datasets) (d.id.startsWith("synthetic-") ? groups.Synthetic : groups.Real).push(d);
  for (const [label, items] of Object.entries(groups)) {
    const og = document.createElement("optgroup");
    og.label = label;
    for (const d of items) og.append(new Option(`${d.name} · ${d.length.toLocaleString()} pts`, d.id));
    el.dataset.append(og);
  }

  const info = await (await fetch("/api/info")).json();
  for (const m of info.models) el.model.append(new Option(m.replace("mistralai/", ""), m));
  el.model.value = info.default_model;
  setStatus(`Worker ready · device ${info.device} · torch ${info.torch} · ${info.threads} threads`);

  el.dataset.addEventListener("change", () => selectDataset(el.dataset.value));
  el.upload.addEventListener("change", async () => {
    const file = el.upload.files[0];
    if (!file) return;
    try {
      useSeries(parseCsv(await file.text(), file.name));
    } catch (err) {
      setStatus(`Could not parse ${file.name}: ${err.message}`, true);
    }
  });
  el.cutoff.addEventListener("input", () => setCutoff(intOf(el.cutoff, 0)));
  for (const input of [el.horizon, el.maxContext, el.period]) {
    input.addEventListener("change", () => {
      updateCutoffLabel();
      autoRun();
    });
  }
  el.model.addEventListener("change", () => {
    setStatus(`Switching to ${el.model.value} (first use downloads the weights)…`);
    runForecast();
  });
  el.run.addEventListener("click", runForecast);
  el.showBaseline.addEventListener("change", () => {
    state.plot.setSeries(S.baseline, { show: el.showBaseline.checked });
    el.baselineKey.hidden = !el.showBaseline.checked;
  });
  el.zoomForecast.addEventListener("click", zoomToForecast);
  el.zoomAll.addEventListener("click", () => state.plot.setScale("x", { min: 0, max: state.plot.data[0].length - 1 }));
  el.download.addEventListener("click", downloadCsv);
  new ResizeObserver(() => state.plot?.setSize({ width: el.chart.clientWidth, height: 440 })).observe(el.chart);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => state.series && makePlot());

  el.dataset.value = "air-passengers";
  await selectDataset(el.dataset.value);
}

boot().catch((err) => setStatus(`Startup failed: ${err.message}`, true));
