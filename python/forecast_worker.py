"""Long-lived Timestral worker. Reads one JSON request per line on stdin, writes one JSON response per line on stdout.

Request:  {"id": 1, "model": "mistralai/Timestral-209M", "context": [..], "prediction_length": 96,
           "actual": [..] (optional, for metrics), "period": 12 (optional, for MASE / seasonal naive)}
Response: {"id": 1, "ok": true, "quantile_levels": [..], "quantiles": [[..21..] per step], "median": [..],
           "baseline": [..], "metrics": {..}, "timing_ms": {..}}
JSON null stands for NaN in both directions. Logs go to stderr.
"""

import json
import sys
import time

import numpy as np
import torch
from timestral import TimestralForecaster

from metrics import mase_scale, point_metrics, quantile_metrics, seasonal_naive

# MPS is not usable: timestral's scaler computes in float64, which MPS does not support. CPU is fast enough.
DEVICE = "cpu"
MODELS = ["mistralai/Timestral-5M", "mistralai/Timestral-28M", "mistralai/Timestral-123M", "mistralai/Timestral-209M"]
DEFAULT_MODEL = "mistralai/Timestral-209M"
_loaded: dict[str, TimestralForecaster] = {}


def log(*args) -> None:
    print(*args, file=sys.stderr, flush=True)


def get_model(name: str) -> tuple[TimestralForecaster, float]:
    if name not in MODELS:
        raise ValueError(f"unknown model {name!r}")
    if name in _loaded:
        return _loaded[name], 0.0
    t0 = time.perf_counter()
    log(f"loading {name} on {DEVICE} (first use downloads weights to the Hugging Face cache)")
    _loaded[name] = TimestralForecaster.from_pretrained(name, device=DEVICE)
    return _loaded[name], (time.perf_counter() - t0) * 1000


def to_array(values) -> np.ndarray:
    return np.array([np.nan if v is None else v for v in values], dtype=np.float64)


def to_json(values: np.ndarray) -> list:
    return [None if np.isnan(v) else round(float(v), 6) for v in np.asarray(values).ravel()]


def clean(obj):
    if isinstance(obj, float) and obj != obj:
        return None
    if isinstance(obj, dict):
        return {k: clean(v) for k, v in obj.items()}
    return obj


def handle(req: dict) -> dict:
    if req.get("type") == "info":
        return {"models": MODELS, "default_model": DEFAULT_MODEL, "device": DEVICE, "loaded": list(_loaded),
                "torch": torch.__version__, "threads": torch.get_num_threads()}

    model, load_ms = get_model(req.get("model", DEFAULT_MODEL))
    context = to_array(req["context"])
    horizon = int(req["prediction_length"])
    period = int(req.get("period") or 1)
    if np.isnan(context).all():
        raise ValueError("context has no observed values")

    t0 = time.perf_counter()
    with torch.inference_mode():
        fc = model.forecast(context, prediction_length=horizon)
    infer_ms = (time.perf_counter() - t0) * 1000

    levels = [round(float(x), 4) for x in fc.quantile_levels]
    quantiles = fc.quantiles.cpu().numpy().reshape(horizon, len(levels)).astype(np.float64)
    median = fc.median.cpu().numpy().reshape(horizon).astype(np.float64)
    baseline = seasonal_naive(context, horizon, period)

    metrics = {}
    if req.get("actual") is not None:
        actual = to_array(req["actual"])[:horizon]
        n = len(actual)
        scale = mase_scale(context, period)
        metrics = {
            "evaluated_steps": int((~np.isnan(actual)).sum()),
            "timestral": {**point_metrics(actual, median[:n], scale),
                          **quantile_metrics(actual, quantiles[:n], levels, scale)},
            "seasonal_naive": point_metrics(actual, baseline[:n], scale),
        }

    return {
        "quantile_levels": levels,
        "quantiles": [to_json(row) for row in quantiles],
        "median": to_json(median),
        "baseline": to_json(baseline),
        "metrics": clean(metrics),
        "timing_ms": {"load": round(load_ms, 1), "inference": round(infer_ms, 1)},
        "context_length": int(len(context)),
    }


def main() -> None:
    torch.set_grad_enabled(False)
    get_model(DEFAULT_MODEL)
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        if not line.strip():
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            out = {"id": req_id, "ok": True, **handle(req)}
        except Exception as e:  # report to the caller, keep serving
            log(f"request {req_id} failed: {e!r}")
            out = {"id": req_id, "ok": False, "error": str(e)}
        print(json.dumps(out, allow_nan=False), flush=True)


if __name__ == "__main__":
    main()
