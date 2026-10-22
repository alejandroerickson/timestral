"""Precompute forecasts for the static blog demo: every dataset, every model size, a fixed set of forecast origins.

Run with: uv run python scripts/precompute.py OUT_DIR
Writes OUT_DIR/index.json (datasets, models, machine) and OUT_DIR/<dataset>.json (series + forecasts).
Series come from datasets.js through Node, so the synthetic ones match the explorer exactly.
"""

import json
import math
import platform
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import torch
from timestral import TimestralForecaster

ROOT = Path(__file__).resolve().parent.parent
MODELS = [  # largest first, the order the demo lists them
    ("209M", "mistralai/Timestral-209M", 837),  # weights in MB (float32), as in Mistral's README
    ("123M", "mistralai/Timestral-123M", 490),
    ("28M", "mistralai/Timestral-28M", 111),
    ("5M", "mistralai/Timestral-5M", 21),
]
N_ORIGINS = 40

# Labels for the demo's buttons, in display order. Horizons override the explorer's where a shorter one reads better.
DATASETS = [
    ("air-passengers", "Airline passengers", "Monthly airline passengers, 1949 to 1960, in thousands.", "thousand", None),
    ("co2-mauna-loa", "CO₂ at Mauna Loa", "Monthly mean CO₂ at Mauna Loa, Hawaii, since 1958.", "ppm", None),
    ("sunspots", "Sunspots", "Monthly sunspot count, 1749 to 1983: an 11-year cycle that never quite repeats.", "", 132),
    ("melbourne-min-temp", "Melbourne lows", "Daily minimum temperature in Melbourne, 1981 to 1990.", "°C", None),
    ("etth1-ot", "Transformer oil", "Hourly oil temperature of an electricity transformer, 2016 to 2018.", "°C", None),
    ("synthetic-sine-trend", "Sine and trend", "Made up: a daily cycle on a slow rise, with noise.", "", None),
    ("synthetic-multi-seasonal", "Daily and weekly", "Made up: a daily cycle with quieter weekends.", "", None),
    ("synthetic-random-walk", "Random walk", "Made up: a random walk. There is nothing to predict.", "", None),
    ("synthetic-level-shift", "Level shift", "Made up: a daily cycle that jumps up at hour 1,200.", "", None),
    ("synthetic-intermittent", "Intermittent", "Made up: mostly zeros, with demand most often on one day of the week.", "", None),
]


def load_series(dataset_id: str) -> dict:
    script = (
        "import { loadDataset } from './datasets.js';"
        f"process.stdout.write(JSON.stringify(await loadDataset({json.dumps(dataset_id)})));"
    )
    out = subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT, capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def decimals_for(values: np.ndarray) -> int:
    finite = values[np.isfinite(values)]
    span = float(finite.max() - finite.min()) if finite.size else 1.0
    return max(0, 2 - math.floor(math.log10(span or 1.0)))  # about 3 significant figures of the series' range


def rounded(values, digits: int) -> list:
    return [None if not np.isfinite(v) else round(float(v), digits) for v in np.asarray(values, dtype=np.float64)]


def main(out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    forecasters = {short: TimestralForecaster.from_pretrained(repo, local_files_only=True) for short, repo, _ in MODELS}
    index = []
    for dataset_id, label, blurb, unit, horizon_override in DATASETS:
        series = load_series(dataset_id)
        values = np.array([np.nan if v is None else v for v in series["values"]], dtype=np.float64)
        n = len(values)
        horizon = int(horizon_override or series["horizon"])
        first = max(2 * horizon, int(0.3 * n), 32)
        origins = sorted({int(round(x)) for x in np.linspace(first, n - horizon, N_ORIGINS)})
        digits = decimals_for(values)

        forecasts = {short: [] for short, _, _ in MODELS}
        for origin in origins:
            context = values[:origin]
            actual = values[origin : origin + horizon]
            for short, _, _ in MODELS:
                model = forecasters[short]
                model.forecast(context[-64:], prediction_length=8)  # keeps timing free of first-call overhead
                t0 = time.perf_counter()
                fc = model.forecast(context, prediction_length=horizon)
                ms = (time.perf_counter() - t0) * 1000
                levels = [round(float(q), 2) for q in fc.quantile_levels]
                q = fc.quantiles.cpu().numpy().reshape(horizon, len(levels))
                median = fc.median.cpu().numpy().reshape(horizon)
                ok = np.isfinite(actual)
                forecasts[short].append({
                    "median": rounded(median, digits),
                    "lo": rounded(q[:, levels.index(0.1)], digits),
                    "hi": rounded(q[:, levels.index(0.9)], digits),
                    "ms": round(ms, 1),
                    "mae": round(float(np.mean(np.abs(median[ok] - actual[ok]))), digits + 1) if ok.any() else None,
                })
            print(f"{dataset_id} origin {origin}/{n}", flush=True)

        doc = {
            "id": dataset_id,
            "label": label,
            "blurb": blurb,
            "unit": unit,
            "freq": series.get("freq"),
            "horizon": horizon,
            "timestamps": series["timestamps"],
            "values": rounded(values, digits),
            "origins": origins,
            "forecasts": forecasts,
        }
        (out_dir / f"{dataset_id}.json").write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False))
        index.append({"id": dataset_id, "label": label, "synthetic": dataset_id.startswith("synthetic-")})

    meta = {
        "datasets": index,
        "models": [{"id": short, "repo": repo, "weights_mb": mb} for short, repo, mb in MODELS],
        "machine": {
            "chip": subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True).stdout.strip(),
            "memory_gb": round(int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True).stdout) / 2**30),
            "device": "cpu",
            "threads": torch.get_num_threads(),
            "torch": torch.__version__,
            "python": platform.python_version(),
        },
        "interval": [0.1, 0.9],
        "generated": time.strftime("%Y-%m-%d"),
    }
    (out_dir / "index.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
