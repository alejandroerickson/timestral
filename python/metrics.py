"""Forecast accuracy metrics. `actual` may contain NaN; those steps are skipped."""

import numpy as np


def seasonal_naive(context: np.ndarray, horizon: int, period: int) -> np.ndarray:
    """Repeat the last observed season. Falls back to the last value when the context is shorter than a season."""
    ctx = context[~np.isnan(context)]
    if len(ctx) == 0:
        return np.full(horizon, np.nan)
    if period < 1 or len(ctx) < period:
        return np.full(horizon, ctx[-1])
    last = ctx[-period:]
    return np.resize(last, horizon)


def mase_scale(context: np.ndarray, period: int) -> float:
    """Mean absolute in-sample seasonal-naive error, the MASE denominator."""
    ctx = context[~np.isnan(context)]
    m = period if 1 <= period < len(ctx) else 1
    if len(ctx) <= m:
        return float("nan")
    return float(np.mean(np.abs(ctx[m:] - ctx[:-m])))


def point_metrics(actual: np.ndarray, pred: np.ndarray, scale: float) -> dict:
    ok = ~np.isnan(actual) & ~np.isnan(pred)
    if not ok.any():
        return {}
    err = pred[ok] - actual[ok]
    mae = float(np.mean(np.abs(err)))
    denom = np.abs(actual[ok]) + np.abs(pred[ok])
    smape = float(np.mean(np.where(denom > 0, 2 * np.abs(err) / np.where(denom > 0, denom, 1), 0)))
    return {
        "mae": mae,
        "rmse": float(np.sqrt(np.mean(err**2))),
        "mase": mae / scale if scale and scale == scale else None,
        "smape": smape,
    }


def quantile_metrics(actual: np.ndarray, quantiles: np.ndarray, levels: list[float], scale: float) -> dict:
    """quantiles is (horizon, n_levels). Weighted quantile loss approximates CRPS; coverage uses the 10-90 and 1-99 bands."""
    ok = ~np.isnan(actual)
    if not ok.any():
        return {}
    y = actual[ok][:, None]
    q = quantiles[ok]
    lv = np.asarray(levels)[None, :]
    pinball = np.maximum(lv * (y - q), (lv - 1) * (y - q))
    crps = 2 * float(np.mean(pinball))
    lv_list = list(levels)

    def coverage(lo: float, hi: float) -> float | None:
        if lo not in lv_list or hi not in lv_list:
            return None
        a, b = q[:, lv_list.index(lo)], q[:, lv_list.index(hi)]
        return float(np.mean((y[:, 0] >= a) & (y[:, 0] <= b)))

    return {
        "crps": crps,
        "scaled_crps": crps / scale if scale and scale == scale else None,
        "coverage_80": coverage(0.1, 0.9),
        "coverage_98": coverage(0.01, 0.99),
    }
