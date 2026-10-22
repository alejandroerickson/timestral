// Dataset catalog: real series from data/ (see scripts/fetch_datasets.py) plus seeded synthetic ones.
import { readFile } from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.join(import.meta.dirname, "data");

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}

const SYNTHETIC = [
  {
    id: "synthetic-sine-trend",
    name: "Synthetic: daily sine + trend + noise (hourly)",
    freq: "hourly",
    period: 24,
    horizon: 168,
    generate(rand) {
      return Array.from({ length: 2000 }, (_, t) => 20 + 0.01 * t + 8 * Math.sin((2 * Math.PI * t) / 24) + gaussian(rand));
    },
  },
  {
    id: "synthetic-multi-seasonal",
    name: "Synthetic: daily + weekly seasonality (hourly)",
    freq: "hourly",
    period: 168,
    horizon: 336,
    generate(rand) {
      return Array.from({ length: 24 * 7 * 16 }, (_, t) => {
        const daily = 6 * Math.sin((2 * Math.PI * t) / 24) + 2 * Math.sin((4 * Math.PI * t) / 24);
        const weekend = Math.floor(t / 24) % 7 >= 5 ? -7 : 0;
        return 50 + daily + weekend + 1.5 * gaussian(rand);
      });
    },
  },
  {
    id: "synthetic-random-walk",
    name: "Synthetic: random walk (no signal to find)",
    freq: "step",
    period: 1,
    horizon: 100,
    generate(rand) {
      let x = 0;
      return Array.from({ length: 1500 }, () => (x += gaussian(rand)));
    },
  },
  {
    id: "synthetic-level-shift",
    name: "Synthetic: seasonal with a level shift at t=1200",
    freq: "hourly",
    period: 24,
    horizon: 168,
    generate(rand) {
      return Array.from({ length: 1600 }, (_, t) => (t < 1200 ? 10 : 25) + 5 * Math.sin((2 * Math.PI * t) / 24) + gaussian(rand));
    },
  },
  {
    id: "synthetic-intermittent",
    name: "Synthetic: intermittent demand (mostly zeros)",
    freq: "daily",
    period: 7,
    horizon: 56,
    generate(rand) {
      return Array.from({ length: 730 }, (_, t) => {
        const p = t % 7 === 5 ? 0.6 : 0.15;
        return rand() < p ? Math.round(1 + 6 * rand()) : 0;
      });
    },
  },
];

function stripGenerator({ generate, ...meta }) {
  return meta;
}

export async function listDatasets() {
  const real = JSON.parse(await readFile(path.join(DATA_DIR, "index.json"), "utf8"));
  return [...real, ...SYNTHETIC.map((s) => ({ ...stripGenerator(s), length: s.generate(mulberry32(1)).length }))];
}

export async function loadDataset(id) {
  const synthetic = SYNTHETIC.find((s) => s.id === id);
  if (synthetic) {
    const values = synthetic.generate(mulberry32(42)).map((v) => Math.round(v * 1e4) / 1e4);
    return { ...stripGenerator(synthetic), length: values.length, timestamps: null, values };
  }
  const meta = (await listDatasets()).find((d) => d.id === id);
  if (!meta) return null;
  const lines = (await readFile(path.join(DATA_DIR, `${id}.csv`), "utf8")).trim().split("\n").slice(1);
  const timestamps = [];
  const values = [];
  for (const line of lines) {
    const [ts, v] = line.split(",");
    timestamps.push(ts);
    values.push(v === "" ? null : Number(v));
  }
  return { ...meta, timestamps, values };
}
