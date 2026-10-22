# timestral

POC for zero-shot time series forecasting with Mistral's [Timestral](https://huggingface.co/mistralai/Timestral-209M)
on an Apple Silicon Mac, plus a small browser app for exploring forecasts against held-out data.

Pick a series, put the forecast origin anywhere in it, and the app forecasts the next `horizon` steps from
everything before the origin. It overlays the median and the 10–90% / 1–99% intervals on the real values and scores
the forecast against them, next to a seasonal-naive baseline.

## Run it

Needs [uv](https://docs.astral.sh/uv/) and Node 20+.

```bash
uv sync                  # Python 3.12 env with timestral + torch
npm install              # uPlot
npm run download-models  # all four sizes (~1.4 GB) into the Hugging Face cache
npm start                # http://localhost:5177
```

Without `download-models`, the first start downloads Timestral-209M, and the other sizes download the first time
you select them. `PORT=8080 npm start` changes the port.

**Compare all sizes** runs all four models on the same context. The selected model keeps its interval bands and the
others draw their medians in their own colors. The metrics table gets one column per model plus the baseline, with
inference time in the last row. Changing the selected model in this mode re-renders without running inference again.

## Hardware and model choice

This machine is an M1 Pro with 32 GB. That's plenty for the largest model, so **Timestral-209M** is the default.
All four sizes can be selected in the UI. `npm run benchmark` gives these numbers (median of 5 runs,
96-step horizon, M1 Pro CPU):

| model | weights | peak RSS | 512-pt context, 2 threads | 4096-pt context, 2 threads | 4096-pt, 8 threads |
|---|---|---|---|---|---|
| Timestral-5M | 20 MB | 0.25 GB | 10 ms | 20 ms | 20 ms |
| Timestral-28M | 106 MB | 0.42 GB | 28 ms | 65 ms | 77 ms |
| Timestral-123M | 468 MB | 1.1 GB | 81 ms | 152 ms | 194 ms |
| Timestral-209M | 798 MB | 1.8 GB | 133 ms | 233 ms | 264 ms |

Single-series forecasts don't get faster with more threads, so a 2-vCPU machine is enough to serve this.

Inference runs on the **CPU**. Apple's GPU backend (MPS) doesn't work as of timestral 1.0.0: its scaler
(`timestral/scaler.py`) computes running statistics in float64, which MPS doesn't support. CPU is fast enough that
patching it isn't worth it yet.

## Layout

```
server.js                  Node HTTP server: static UI + /api, spawns the Python worker
datasets.js                dataset catalog: data/*.csv plus seeded synthetic series
python/forecast_worker.py  long-lived Timestral process, JSON lines over stdin/stdout
python/metrics.py          MAE, RMSE, MASE, sMAPE, CRPS (quantile loss), interval coverage, seasonal naive
public/                    browser app (vanilla JS + uPlot)
scripts/fetch_datasets.py  re-downloads and normalizes data/ (`npm run fetch-data`)
scripts/download_models.py downloads all four model sizes (`npm run download-models`)
scripts/benchmark.py       per-model latency and memory (`npm run benchmark`)
scripts/precompute.py      forecasts for the static blog demo: 10 series x 40 origins x 4 sizes, as JSON
scripts/hero_svg.py        the blog post's opening chart, as SVG in the blog's colour tokens
data/                      timestamp,value CSVs + index.json
```

### API

- `GET /api/info`: models, device, torch version
- `GET /api/datasets`, `GET /api/datasets/:id`
- `POST /api/forecast` `{ model, context: number[], prediction_length, actual?: number[], period? }` returns
  `{ quantile_levels, quantiles: [horizon][21], median, baseline, metrics, timing_ms }`. Use `null` for missing values.

## Datasets

Real: airline passengers, Mauna Loa CO2, sunspots, Melbourne daily min temperature, ETTh1 oil temperature
(sources in `data/index.json`). Synthetic: sine + trend, daily + weekly seasonality, random walk, level shift,
intermittent demand. You can also upload your own CSV in the UI. It uses the last mostly-numeric column as the value
and the first column as the timestamp when that column isn't numeric.

## Notes so far

- Airline passengers, origin 1958-12, 24 months held out: Timestral MAE 34 vs seasonal naive 71.
- ETTh1, last week held out: Timestral MASE 0.72 vs 1.05. Results vary a lot by origin, and at some origins
  seasonal naive wins. Move the origin around before drawing conclusions.
- The 10–90% interval often covers less than 80% on short horizons. That's worth checking with a rolling backtest.

## License

Timestral code is Apache-2.0. The weights use Mistral's Modified MIT license
(see the [model card](https://huggingface.co/mistralai/Timestral-209M)).
