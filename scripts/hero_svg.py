"""Draw the blog post's opening picture: one precomputed forecast, all four sizes, as inline SVG.

Run with: uv run python scripts/hero_svg.py DATASET.json [--origin INDEX] [--before N] [--width W --height H]
Prints SVG whose strokes are the blog's CSS tokens (var(--data-1) ...), so it follows the page's theme.
"""

import argparse
import json

ORDER = [("5M", 5), ("28M", 4), ("123M", 3), ("209M", 2)]  # drawn smallest first; 209M ends up on top


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("dataset")
    ap.add_argument("--origin", type=int, default=-1, help="index into the dataset's origins")
    ap.add_argument("--before", type=int, default=36, help="steps of history to show before the origin")
    ap.add_argument("--width", type=int, default=672)
    ap.add_argument("--height", type=int, default=300)
    args = ap.parse_args()

    doc = json.load(open(args.dataset))
    oi = args.origin % len(doc["origins"])
    o, h = doc["origins"][oi], doc["horizon"]
    lo_i, hi_i = max(0, o - args.before), o + h - 1
    values = doc["values"]
    fc = {m: doc["forecasts"][m][oi] for m, _ in ORDER}

    ys = [v for v in values[lo_i : hi_i + 1] if v is not None]
    for m, _ in ORDER:
        ys += fc[m]["median"]
    ys += fc["209M"]["lo"] + fc["209M"]["hi"]
    y0, y1 = min(ys), max(ys)
    pad_y = (y1 - y0) * 0.06
    y0, y1 = y0 - pad_y, y1 + pad_y
    W, H, top, bottom = args.width, args.height, 12, 28

    def X(i: float) -> float:
        return round((i - lo_i) / (hi_i - lo_i) * W, 1)

    def Y(v: float) -> float:
        return round(top + (1 - (v - y0) / (y1 - y0)) * (H - top - bottom), 1)

    def path(points) -> str:
        return "M" + " L".join(f"{x},{y}" for x, y in points)

    anchor = values[o - 1]
    actual = path((X(i), Y(values[i])) for i in range(lo_i, hi_i + 1) if values[i] is not None)
    band_top = [(X(o - 1), Y(anchor))] + [(X(o + k), Y(fc["209M"]["hi"][k])) for k in range(h)]
    band_bot = [(X(o + k), Y(fc["209M"]["lo"][k])) for k in reversed(range(h))]
    band = path(band_top + band_bot) + " Z"

    out = [
        f'<svg viewBox="0 0 {W} {H}" fill="none" stroke-linejoin="round" stroke-linecap="round">',
        f'  <rect x="{X(o - 1)}" y="0" width="{round(W - X(o - 1), 1)}" height="{H - bottom}" fill="var(--surface)" stroke="none"/>',
    ]
    # Faint horizontal guides at four levels.
    for k in range(1, 5):
        y = round(top + k * (H - top - bottom) / 5, 1)
        out.append(f'  <line x1="0" x2="{W}" y1="{y}" y2="{y}" stroke="var(--rule)" stroke-width="1"/>')
    out.append(f'  <path d="{band}" fill="var(--data-2)" fill-opacity="0.2" stroke="none"/>')
    for m, slot in ORDER:
        pts = [(X(o - 1), Y(anchor))] + [(X(o + k), Y(v)) for k, v in enumerate(fc[m]["median"])]
        out.append(f'  <path d="{path(pts)}" stroke="var(--data-{slot})" stroke-width="2.5"/>')
    out.append(f'  <path d="{actual}" stroke="var(--data-1)" stroke-width="2.5"/>')
    out.append(f'  <line x1="{X(o - 1)}" x2="{X(o - 1)}" y1="0" y2="{H - bottom}" stroke="var(--muted)" stroke-width="1.25" stroke-dasharray="4 4"/>')
    # Year ticks along the bottom, for the monthly series.
    if doc.get("timestamps"):
        for i in range(lo_i, hi_i + 1):
            t = doc["timestamps"][i]
            if t.endswith("-01") and len(t) == 7 and 18 <= X(i) <= W - 18:  # no label cut off at an edge
                out.append(f'  <text x="{X(i)}" y="{H - 8}" fill="var(--muted)" stroke="none" font-size="12" text-anchor="middle">{t[:4]}</text>')
    out.append("</svg>")
    print("\n".join(out))


if __name__ == "__main__":
    main()
