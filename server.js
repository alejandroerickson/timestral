// Serves the explorer UI and proxies forecast requests to a long-lived Python Timestral worker.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { listDatasets, loadDataset } from "./datasets.js";

const ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT ?? 5177);

// --- Python worker -----------------------------------------------------------

class Worker {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.ready = this.start();
  }

  start() {
    const proc = spawn("uv", ["run", "--quiet", "python", "python/forecast_worker.py"], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.proc = proc;
    return new Promise((resolve, reject) => {
      readline.createInterface({ input: proc.stdout }).on("line", (line) => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          console.log("[worker]", line);
          return;
        }
        if (msg.ready) {
          console.log("[worker] ready");
          resolve();
          return;
        }
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.ok ? p.resolve(msg) : p.reject(new Error(msg.error));
      });
      proc.on("exit", (code) => {
        console.error(`[worker] exited with code ${code}`);
        const err = new Error(`forecast worker exited (${code})`);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        reject(err);
        this.ready = null;
      });
    });
  }

  async request(payload) {
    if (!this.ready) this.ready = this.start();
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ ...payload, id }) + "\n");
    });
  }
}

const worker = new Worker();
worker.ready.catch(() => {});

// --- HTTP --------------------------------------------------------------------

const STATIC = {
  "/": ["public/index.html", "text/html"],
  "/app.js": ["public/app.js", "text/javascript"],
  "/style.css": ["public/style.css", "text/css"],
  "/vendor/uPlot.esm.js": ["node_modules/uplot/dist/uPlot.esm.js", "text/javascript"],
  "/vendor/uPlot.min.css": ["node_modules/uplot/dist/uPlot.min.css", "text/css"],
};

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function route(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  if (req.method === "GET" && STATIC[p]) {
    const [file, type] = STATIC[p];
    return send(res, 200, await readFile(path.join(ROOT, file)), type);
  }
  if (req.method === "GET" && p === "/api/info") {
    return send(res, 200, await worker.request({ type: "info" }));
  }
  if (req.method === "GET" && p === "/api/datasets") {
    return send(res, 200, await listDatasets());
  }
  if (req.method === "GET" && p.startsWith("/api/datasets/")) {
    const ds = await loadDataset(decodeURIComponent(p.slice("/api/datasets/".length)));
    return ds ? send(res, 200, ds) : send(res, 404, { error: "unknown dataset" });
  }
  if (req.method === "POST" && p === "/api/forecast") {
    const { model, context, prediction_length, actual, period } = await readJson(req);
    if (!Array.isArray(context) || !Number.isInteger(prediction_length) || prediction_length < 1) {
      return send(res, 400, { error: "context (array) and prediction_length (positive integer) are required" });
    }
    return send(res, 200, await worker.request({ model, context, prediction_length, actual, period }));
  }
  send(res, 404, { error: "not found" });
}

createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error(err);
    send(res, 500, { error: err.message });
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Timestral explorer on http://localhost:${PORT} (loading model…)`);
});
