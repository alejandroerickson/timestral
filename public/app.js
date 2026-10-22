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
  compare: $("compare"),
  showBaseline: $("showBaseline"),
  run: $("run"),
  cutoff: $("cutoff"),
  cutoffLabel: $("cutoffLabel"),
  chart: $("chart"),
  chartCard: document.querySelector(".chart-card"),
  tooltip: $("tooltip"),
  legend: $("legendItems"),
  zoomForecast: $("zoomForecast"),
  zoomAll: $("zoomAll"),
  metricsHead: document.querySelector("#metrics thead tr"),
  metrics: document.querySelector("#metrics tbody"),
  timing: $("timing"),
  download: $("download"),
};

// Series order in the uPlot data array. Bands first so the actual line draws on top. The selected model is drawn
// as `median` with its bands; in compare mode the other models' medians follow at cmp + their index in state.models.
const S = { x: 0, q99: 1, q01: 2, q90: 3, q10: 4, median: 5, baseline: 6, cmp: 7, actual: null };

const state = {
  datasets: [],
  models: [], // Hub ids, smallest first
  series: null, // { id, name, values, timestamps, period, horizon }
  forecast: null, // selected model's last worker response, plus { model, cutoff, horizon, contextStart }
  results: null, // compare mode: { [model]: response } from the same request as forecast
  plot: null,
  seq: 0,
};

// --- helpers -----------------------------------------------------------------

const cssVar = (name) => getComputedStyle(document.querySelector(".viz-root")).getPropertyValue(name).trim();
const shortName = (model) => model.replace("mistralai/Timestral-", "");
const modelColor = (model) => cssVar(`--model-${shortName(model).toLowerCase()}`);
const withAlpha = (hex, alpha) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16} ${(n >> 8) & 255} ${n & 255} / ${alpha})`;
};
const comparing = () => el.compare.checked && state.results != null;
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
  const data = Array.from({ length: S.actual + 1 }, empty);
  data[S.x] = x;
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
    if (comparing()) {
      state.models.forEach((m, k) => {
        const r = state.results[m];
        if (m === f.model || !r) return;
        if (anchor != null) data[S.cmp + k][f.cutoff - 1] = anchor;
        for (let h = 0; h < f.horizon; h++) data[S.cmp + k][f.cutoff + h] = r.median[h];
      });
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
  const lo = d[S.q10][idx];
  const hi = d[S.q90][idx];
  const hasForecast = state.forecast && idx >= state.forecast.cutoff;
  tip.replaceChildren();
  const when = document.createElement("div");
  when.className = "when";
  when.textContent = timeLabel(idx);
  tip.append(when);
  const addRow = (color, label, value, dashed = false) => {
    if (color.startsWith("--")) color = cssVar(color);
    const row = document.createElement("div");
    row.className = "row";
    const key = document.createElement("i");
    key.className = "key line";
    key.style.borderColor = color;
    if (dashed) key.style.borderTopStyle = "dashed";
    const strong = document.createElement("strong");
    strong.textContent = value;
    const name = document.createElement("span");
    name.textContent = label;
    row.append(key, strong, name);
    tip.append(row);
  };
  if (d[S.actual][idx] != null) addRow("--actual", "Actual", fmt(d[S.actual][idx]));
  if (hasForecast) {
    const f = state.forecast;
    addRow(modelColor(f.model), `${shortName(f.model)} median`, fmt(d[S.median][idx]));
    if (lo != null) addRow(withAlpha(modelColor(f.model), 0.5), `${shortName(f.model)} 10–90%`, `${fmt(lo)} – ${fmt(hi)}`);
    state.models.forEach((m, k) => {
      const v = d[S.cmp + k][idx];
      if (v != null) addRow(modelColor(m), `${shortName(m)} median`, fmt(v));
    });
  }
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
  const zoom = state.plot && state.plot.data[0].length === buildData()[0].length ? { ...state.plot.scales.x } : null;
  state.plot?.destroy();
  const selected = state.forecast?.model ?? el.model.value;
  const color = modelColor(selected);
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
      { label: "Median", stroke: color, width: 2, points: { show: false } },
      {
        label: "Seasonal naive",
        stroke: cssVar("--baseline"),
        width: 1.5,
        dash: [5, 4],
        points: { show: false },
        show: el.showBaseline.checked,
      },
      ...state.models.map((m) => ({ label: shortName(m), stroke: modelColor(m), width: 1.5, points: { show: false } })),
      { label: "Actual", stroke: cssVar("--actual"), width: 1.5, points: { show: false } },
    ],
    bands: [
      { series: [S.q99, S.q01], fill: withAlpha(color, cssVar("--band98-alpha")) },
      { series: [S.q90, S.q10], fill: withAlpha(color, cssVar("--band80-alpha")) },
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
  if (zoom?.min != null) state.plot.setScale("x", { min: zoom.min, max: zoom.max });
  attachClickToSetCutoff(state.plot);
  renderLegend();
}

function renderLegend() {
  const selected = state.forecast?.model ?? el.model.value;
  const color = modelColor(selected);
  const items = [
    ["line", cssVar("--actual"), "Actual"],
    ["line", color, `${shortName(selected)} median`],
    ["rect", withAlpha(color, cssVar("--band80-alpha")), "10–90% interval"],
    ["rect", withAlpha(color, cssVar("--band98-alpha")), "1–99% interval"],
  ];
  if (comparing()) for (const m of [...state.models].reverse()) if (m !== selected) items.push(["line", modelColor(m), `${shortName(m)} median`]);
  if (el.showBaseline.checked) items.push(["dashed", cssVar("--baseline"), "Seasonal naive"]);
  el.legend.replaceChildren(
    ...items.map(([kind, c, label]) => {
      const span = document.createElement("span");
      const key = document.createElement("i");
      key.className = kind === "rect" ? "key rect" : `key line${kind === "dashed" ? " dashed" : ""}`;
      if (kind === "rect") key.style.background = c;
      else key.style.borderColor = c;
      span.append(key, label);
      return span;
    }),
  );
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
  const selected = el.model.value;
  const models = el.compare.checked ? state.models : [selected];
  setStatus(`Forecasting ${p.horizon} steps from ${context.length} points with ${models.map(shortName).join(", ")}…`);
  const request = async (model) => {
    const res = await fetch("/api/forecast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        context,
        prediction_length: p.horizon,
        actual: actual.length ? actual : null,
        period: p.period,
      }),
    });
    const body = await res.json();
    if (!res.ok || body.ok === false) throw new Error(body.error ?? res.statusText);
    return { ...body, ...p, model };
  };
  try {
    const responses = await Promise.all(models.map(request));
    if (seq !== state.seq) return; // a newer request superseded this one
    const byModel = Object.fromEntries(responses.map((r) => [r.model, r]));
    const recolor = state.forecast?.model !== selected || (state.results != null) !== el.compare.checked;
    state.results = el.compare.checked ? byModel : null;
    state.forecast = byModel[selected];
    recolor ? makePlot() : refreshPlot();
    renderMetrics();
    const ms = responses.map((r) => `${shortName(r.model)} ${r.timing_ms.inference.toFixed(0)} ms`).join(" · ");
    setStatus(`CPU · ${ms}`);
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
  el.metricsHead.replaceChildren();
  el.download.disabled = !f;
  if (!f) return;
  // Largest model first; the seasonal-naive baseline last.
  const models = comparing() ? [...state.models].reverse() : [f.model];
  const results = models.map((m) => (comparing() ? state.results[m] : f));
  const head = ["Metric", ...models.map((m) => `Timestral-${shortName(m)}`), "Seasonal naive"];
  for (const text of head) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = text;
    el.metricsHead.append(th);
  }
  const m = f.metrics ?? {};
  const naive = m.seasonal_naive ?? {};
  const pct = (v) => (v == null ? "–" : `${(v * 100).toFixed(1)}%`);
  const ms = (v) => (v == null ? "–" : `${v.toFixed(0)} ms`);
  // [label, key, formatter, how to pick the best: "lower" | target value | null, include baseline?]
  const rows = [
    ["MAE", "mae", fmt, "lower", true],
    ["RMSE", "rmse", fmt, "lower", true],
    ["MASE", "mase", fmt, "lower", true],
    ["sMAPE", "smape", pct, "lower", true],
    ["CRPS (quantile loss)", "crps", fmt, "lower", false],
    ["Scaled CRPS", "scaled_crps", fmt, "lower", false],
    ["10–90% interval coverage (target 80%)", "coverage_80", pct, 0.8, false],
    ["1–99% interval coverage (target 98%)", "coverage_98", pct, 0.98, false],
  ];
  const addRow = (label, values, format, best) => {
    const tr = document.createElement("tr");
    const cells = [label, ...values.map((v) => (v === undefined ? "" : format(v)))].map((text) => {
      const td = document.createElement("td");
      td.textContent = text;
      return td;
    });
    const scored = values.map((v, i) => [v, i]).filter(([v]) => v != null && Number.isFinite(v));
    if (best != null && scored.length > 1) {
      const score = (v) => (best === "lower" ? v : Math.abs(v - best));
      const top = Math.min(...scored.map(([v]) => score(v)));
      for (const [v, i] of scored) if (score(v) - top < 1e-9) cells[i + 1].classList.add("better");
    }
    tr.append(...cells);
    el.metrics.append(tr);
  };
  if (!m.evaluated_steps) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = head.length;
    td.textContent = "No held-out data after the origin: this is a pure forecast of the future.";
    tr.append(td);
    el.metrics.append(tr);
  } else {
    for (const [label, key, format, best, withBaseline] of rows) {
      const values = results.map((r) => r.metrics?.timestral?.[key] ?? null);
      addRow(label, [...values, withBaseline ? (naive[key] ?? null) : undefined], format, best);
    }
  }
  addRow("Inference time", [...results.map((r) => r.timing_ms.inference), undefined], ms, null);
  el.timing.textContent =
    `Context ${f.context_length} points · horizon ${f.horizon} · evaluated on ${m.evaluated_steps ?? 0} held-out points` +
    (results.some((r) => r.timing_ms.load) ? " · includes first-use model load" : "");
}

function downloadCsv() {
  const f = state.forecast;
  const s = state.series;
  const others = comparing() ? state.models.filter((m) => m !== f.model) : [];
  const header = [
    "step",
    "timestamp",
    "actual",
    `median_${shortName(f.model)}`,
    ...f.quantile_levels.map((q) => `q${q}_${shortName(f.model)}`),
    ...others.map((m) => `median_${shortName(m)}`),
    "seasonal_naive",
  ];
  const lines = [header.join(",")];
  for (let h = 0; h < f.horizon; h++) {
    const i = f.cutoff + h;
    const cell = (v) => (v == null ? "" : v);
    const otherMedians = others.map((m) => state.results[m].median[h]);
    lines.push(
      [i, timeLabel(i), cell(s.values[i]), f.median[h], ...f.quantiles[h], ...otherMedians, cell(f.baseline[h])].join(","),
    );
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  a.download = `${s.id}-origin${f.cutoff}-h${f.horizon}-${others.length ? "all-sizes" : shortName(f.model)}.csv`;
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
    state.results = null;
    refreshPlot();
    renderMetrics();
  }
}

function useSeries(series) {
  state.series = series;
  state.forecast = null;
  state.results = null;
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
  state.models = info.models;
  S.actual = S.cmp + state.models.length;
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
    // In compare mode every size is already forecast: just change which one gets the bands.
    const cached = state.results?.[el.model.value];
    if (cached && el.compare.checked) {
      state.forecast = cached;
      makePlot();
      renderMetrics();
      return;
    }
    setStatus(`Switching to ${el.model.value} (first use downloads the weights)…`);
    runForecast();
  });
  el.compare.addEventListener("change", () => {
    if (el.compare.checked) return runForecast();
    state.results = null;
    makePlot();
    renderMetrics();
  });
  el.run.addEventListener("click", runForecast);
  el.showBaseline.addEventListener("change", () => {
    state.plot.setSeries(S.baseline, { show: el.showBaseline.checked });
    renderLegend();
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
