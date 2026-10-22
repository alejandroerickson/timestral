"""Time every Timestral size on CPU at a few thread counts and context lengths, and report peak memory.

Run with: uv run python scripts/benchmark.py
Each model runs in its own subprocess so peak RSS is per model.
"""

import json
import subprocess
import sys

MODELS = ["mistralai/Timestral-5M", "mistralai/Timestral-28M", "mistralai/Timestral-123M", "mistralai/Timestral-209M"]

CHILD = r"""
import json, resource, sys, time
import numpy as np, torch
from timestral import TimestralForecaster
name, threads = sys.argv[1], int(sys.argv[2])
torch.set_num_threads(threads)
m = TimestralForecaster.from_pretrained(name, local_files_only=True)
rng = np.random.default_rng(0)
t = np.arange(4096)
series = 10 * np.sin(2 * np.pi * t / 24) + 0.01 * t + rng.standard_normal(len(t))
out = {}
for ctx in (512, 4096):
    m.forecast(series[-ctx:], prediction_length=96)  # warm-up
    times = []
    for _ in range(5):
        t0 = time.perf_counter()
        m.forecast(series[-ctx:], prediction_length=96)
        times.append((time.perf_counter() - t0) * 1000)
    out[f"ctx{ctx}_ms"] = round(sorted(times)[2], 1)
out["peak_rss_mb"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2**20)  # bytes on macOS
print(json.dumps(out))
"""

rows = []
for name in MODELS:
    for threads in (2, 8):
        res = subprocess.run([sys.executable, "-c", CHILD, name, str(threads)], capture_output=True, text=True, check=True)
        r = json.loads(res.stdout.strip().splitlines()[-1])
        rows.append({"model": name.split("/")[1], "threads": threads, **r})
        print(json.dumps(rows[-1]), flush=True)
