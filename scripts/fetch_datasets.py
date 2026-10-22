"""Download a few public time series and normalize them to data/<id>.csv (timestamp,value).

Run with: uv run python scripts/fetch_datasets.py
"""

import csv
import io
import json
import urllib.request
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"

JB = "https://raw.githubusercontent.com/jbrownlee/Datasets/master"
DATASETS = [
    {
        "id": "air-passengers",
        "name": "Airline passengers (monthly, 1949-1960)",
        "freq": "monthly",
        "period": 12,
        "horizon": 24,
        "source": f"{JB}/airline-passengers.csv",
        "time_col": "Month",
        "value_col": "Passengers",
    },
    {
        "id": "co2-mauna-loa",
        "name": "Mauna Loa CO2 ppm (monthly, 1958-)",
        "freq": "monthly",
        "period": 12,
        "horizon": 60,
        "source": "https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_mm_mlo.csv",
        "time_col": ("year", "month"),
        "value_col": "average",
    },
    {
        "id": "sunspots",
        "name": "Sunspot number (monthly, 1749-1983)",
        "freq": "monthly",
        "period": 132,
        "horizon": 264,
        "source": f"{JB}/monthly-sunspots.csv",
        "time_col": "Month",
        "value_col": "Sunspots",
    },
    {
        "id": "melbourne-min-temp",
        "name": "Melbourne daily min temperature (1981-1990)",
        "freq": "daily",
        "period": 365,
        "horizon": 365,
        "source": f"{JB}/daily-min-temperatures.csv",
        "time_col": "Date",
        "value_col": "Temp",
    },
    {
        # CC BY-ND 4.0 (github.com/zhouhaoyi/ETDataset): fine to use locally, so this extract is gitignored.
        "id": "etth1-ot",
        "name": "ETTh1 transformer oil temperature (hourly, 2016-2018)",
        "freq": "hourly",
        "period": 24,
        "horizon": 168,
        "source": "https://raw.githubusercontent.com/zhouhaoyi/ETDataset/main/ETT-small/ETTh1.csv",
        "time_col": "date",
        "value_col": "OT",
    },
]


def fetch(url: str) -> str:
    with urllib.request.urlopen(url, timeout=60) as r:
        return r.read().decode("utf-8")


def parse(spec: dict, text: str) -> list[tuple[str, float]]:
    lines = [ln for ln in text.splitlines() if ln.strip() and not ln.startswith("#")]
    rows = []
    for row in csv.DictReader(io.StringIO("\n".join(lines))):
        tc = spec["time_col"]
        ts = f"{row[tc[0]]}-{int(row[tc[1]]):02d}" if isinstance(tc, tuple) else row[tc]
        value = float(row[spec["value_col"]])
        rows.append((ts, value if value > -99 else float("nan")))  # NOAA marks missing as -99.99
    return rows


def main() -> None:
    DATA.mkdir(exist_ok=True)
    index = []
    for spec in DATASETS:
        rows = parse(spec, fetch(spec["source"]))
        with open(DATA / f"{spec['id']}.csv", "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["timestamp", "value"])
            w.writerows((ts, "" if v != v else v) for ts, v in rows)
        meta = {k: spec[k] for k in ("id", "name", "freq", "period", "horizon", "source")}
        index.append({**meta, "length": len(rows)})
        print(f"{spec['id']}: {len(rows)} points")
    (DATA / "index.json").write_text(json.dumps(index, indent=2) + "\n")


if __name__ == "__main__":
    main()
