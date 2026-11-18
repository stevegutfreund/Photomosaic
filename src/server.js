"use strict";

/**
 * server.js — Web UI server for the photomosaic generator
 * Listens on http://127.0.0.1:5006 only (see dashboard/start-all.ps1).
 * Behind the login gateway it lives under /photomosaic/, so the page uses
 * relative URLs throughout.
 *
 * Endpoints:
 *   GET    /                        → the UI
 *   GET    /api/status              → { busy, jobId } (the running / last job)
 *   GET    /api/browse?path=        → folders for the sources picker
 *   POST   /api/upload-target       → upload target image, returns { targetId, width, height }
 *   GET    /api/target/:id          → an uploaded target image
 *   POST   /api/preview             → grid/output size for the current settings, no rendering
 *   POST   /api/generate            → starts a job, returns { jobId }
 *   GET    /api/job/:jobId          → job progress (polled; the gateway can't stream)
 *   GET    /api/mosaics             → finished mosaics, newest first
 *   GET    /api/mosaics/:file/image?w=480|1600 → cached downscaled preview
 *   DELETE /api/mosaics/:file       → delete a mosaic
 *   GET    /output/:file            → full-size mosaic (download)
 */

const express = require("express");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const fs = require("fs");
const os = require("os");
const sharp = require("sharp");

const { loadImagesFromDirectory, discoverImages } = require("./modules/imageLoader");
const { analyzeImages, analyzeTargetGrid } = require("./modules/analyzer");
const { matchCells } = require("./modules/matcher");
const { render } = require("./modules/renderer");

const PORT = 5006;
const UPLOADS_DIR = path.resolve(__dirname, "../tmp/uploads");
const OUTPUT_DIR = path.resolve(__dirname, "../output");
const CACHE_DIR = path.join(OUTPUT_DIR, ".previews");
const DEFAULT_TILE_PX = 100;
const PREVIEW_WIDTHS = new Set([480, 1600]);
const MOSAIC_RE = /^mosaic_[0-9a-f]{8}\.jpg$/;
const UPLOAD_RE = /^[0-9a-f-]{36}\.(jpe?g|png|webp|tiff?)$/i;
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|tiff?)$/i;

// Mosaics can be well past sharp's default pixel limit.
sharp.cache(false);

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });

// Requests must address the app by one of these names (blocks DNS rebinding).
// EXTRA_HOSTS (comma-separated, set by start-all.ps1) adds the Wi-Fi IP.
const HOSTNAMES = ["127.0.0.1", "localhost"].concat(
  (process.env.EXTRA_HOSTS || "").split(",").map((h) => h.trim()).filter(Boolean),
);
const ALLOWED_HOSTS = new Set(HOSTNAMES.map((h) => `${h}:${PORT}`));
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));

// ---------------------------------------------------------------------------
// Jobs — one mosaic renders at a time; it's CPU and disk heavy.
// ---------------------------------------------------------------------------

const jobs = new Map();
let currentJobId = null;

function createJob(meta) {
  const job = {
    id: uuidv4(),
    status: "pending",
    currentStage: "",
    stages: {},
    warnings: [],
    result: null,
    error: null,
    meta,
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(job.id, job);
  currentJobId = job.id;
  // Forget finished jobs after an hour.
  for (const [id, j] of jobs) {
    if (j.finishedAt && Date.now() - j.finishedAt > 3600e3) jobs.delete(id);
  }
  return job;
}

function publicJob(job) {
  const { id, status, currentStage, stages, warnings, result, error, startedAt, finishedAt } = job;
  return { id, status, currentStage, stages, warnings, result, error, startedAt, finishedAt };
}

function setStage(job, stageName, current, total) {
  job.currentStage = stageName;
  job.stages[stageName] = {
    current,
    total,
    pct: total > 0 ? Math.floor((current / total) * 100) : 0,
  };
}

// ---------------------------------------------------------------------------
// Grid sizing — shared by preview and generate so the numbers always agree.
// ---------------------------------------------------------------------------

function computeGrid(imageCount, targetW, targetH, opts) {
  const aspect = targetW / targetH;
  let rows = opts.rows || null;
  let cols = opts.cols || null;
  if (!rows || !cols) {
    const autoRows = Math.max(1, Math.floor(Math.sqrt(imageCount / aspect)));
    const autoCols = Math.max(1, Math.floor(autoRows * aspect));
    rows = rows || autoRows;
    cols = cols || autoCols;
  }

  let clamped = false;
  if (opts.repeatFreedom === 0 && imageCount < rows * cols) {
    const gridAspect = cols / rows;
    rows = Math.max(1, Math.floor(Math.sqrt(imageCount / gridAspect)));
    cols = Math.max(1, Math.floor(rows * gridAspect));
    while (rows * cols > imageCount && rows > 1) rows--;
    clamped = true;
  }

  // Keep tiles the shape of the target's cells so the mosaic isn't stretched.
  const tileWidth = opts.tileWidth || DEFAULT_TILE_PX;
  const cellAspect = targetW / cols / (targetH / rows);
  const tileHeight = opts.tileHeight || Math.max(1, Math.round(tileWidth / cellAspect));

  return {
    rows,
    cols,
    cells: rows * cols,
    tileWidth,
    tileHeight,
    outputWidth: cols * tileWidth,
    outputHeight: rows * tileHeight,
    clamped,
  };
}

function readOpts(body) {
  const num = (v) => (v === undefined || v === null || v === "" ? null : Math.max(1, Math.round(+v)) || null);
  const clamp01 = (v, d) => (v === undefined || v === "" || isNaN(+v) ? d : Math.max(0, Math.min(1, +v)));
  const strategy = body.strategy === "avgColor" ? "avgColor" : "thumbnail";
  return {
    rows: num(body.rows),
    cols: num(body.cols),
    tileWidth: num(body.tileWidth),
    tileHeight: num(body.tileHeight),
    adjustmentStrength: clamp01(body.adjustmentStrength, 0.3),
    repeatFreedom: clamp01(body.repeatFreedom, 0),
    strategy,
    useThumbnail: strategy === "thumbnail",
  };
}

function resolveTarget(targetId) {
  if (typeof targetId !== "string" || !UPLOAD_RE.test(targetId)) return null;
  const p = path.join(UPLOADS_DIR, targetId);
  return fs.existsSync(p) ? p : null;
}

function resolveSources(dir) {
  if (typeof dir !== "string" || !dir.trim()) return null;
  const p = path.resolve(dir.trim());
  try {
    return fs.statSync(p).isDirectory() ? p : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

async function runPipeline(job, { sourcesDir, targetPath, outputPath, opts }) {
  job.status = "running";

  setStage(job, "Loading images", 0, 1);
  const loaded = await loadImagesFromDirectory(sourcesDir, {
    onProgress: (n, t) => setStage(job, "Loading images", n, t),
  });
  const imagesFound = loaded.length;
  const targetMeta = await sharp(targetPath, { failOn: "none" }).metadata();

  setStage(job, "Analyzing sources", 0, imagesFound);
  const analyzed = await analyzeImages(loaded, {
    useThumbnail: opts.useThumbnail,
    onProgress: (n, t) => setStage(job, "Analyzing sources", n, t),
  });
  const imagesLoaded = analyzed.length;
  const imagesSkipped = imagesFound - imagesLoaded;
  if (imagesLoaded === 0) {
    throw new Error("None of the source images could be read. Check that the folder contains valid photos.");
  }
  if (imagesSkipped > 0) job.warnings.push(`${imagesSkipped} source image${imagesSkipped > 1 ? "s" : ""} couldn't be read and were skipped.`);

  const grid = computeGrid(imagesLoaded, targetMeta.width, targetMeta.height, opts);
  if (grid.clamped) {
    job.warnings.push(`Grid reduced to ${grid.rows} × ${grid.cols} so each of the ${imagesLoaded} photos is used once.`);
  }
  const { rows, cols, tileWidth, tileHeight } = grid;

  setStage(job, "Preparing grid", 0, 1);
  const targetCells = await analyzeTargetGrid(targetPath, rows, cols, { useThumbnail: opts.useThumbnail });
  setStage(job, "Preparing grid", 1, 1);

  setStage(job, "Matching tiles", 0, targetCells.length);
  const assignments = matchCells(analyzed, targetCells, {
    repeatFreedom: opts.repeatFreedom,
    strategy: opts.strategy,
    onProgress: (n, t) => setStage(job, "Matching tiles", n, t),
  });
  const totalTiles = assignments.length;
  const uniqueImagesUsed = new Set(assignments.map((a) => a.source.filePath)).size;

  setStage(job, "Rendering", 0, totalTiles);
  await render(assignments, targetCells, rows, cols, tileWidth, tileHeight, opts.adjustmentStrength, outputPath, {
    onProgress: (n, t) => setStage(job, "Rendering", n, t),
  });

  setStage(job, "Finishing", 0, 1);
  const outMeta = await sharp(outputPath, { limitInputPixels: false }).metadata();
  const fileSize = fs.statSync(outputPath).size;
  const filename = path.basename(outputPath);

  job.result = {
    filename,
    width: outMeta.width,
    height: outMeta.height,
    fileSize,
    rows,
    cols,
    tileWidth,
    tileHeight,
    imagesFound,
    imagesLoaded,
    imagesSkipped,
    uniqueImagesUsed,
    totalTiles,
    tilesRepeated: totalTiles - uniqueImagesUsed,
  };

  // Sidecar for the gallery, plus a warm preview cache.
  const sidecar = {
    ...job.result,
    createdAt: new Date().toISOString(),
    targetName: job.meta.targetName,
    sourcesDir,
    settings: opts,
  };
  fs.writeFileSync(outputPath.replace(/\.jpg$/, ".json"), JSON.stringify(sidecar, null, 2));
  await previewFor(filename, 480).catch(() => {});
  await previewFor(filename, 1600).catch(() => {});
  setStage(job, "Finishing", 1, 1);

  console.log(`[mosaic] ${filename}: ${rows}×${cols}, ${outMeta.width}×${outMeta.height}px, ${(fileSize / 1e6).toFixed(1)} MB`);
  job.status = "done";
}

// ---------------------------------------------------------------------------
// Downscaled previews (full mosaics can be >100 MB — far too big for a phone)
// ---------------------------------------------------------------------------

let previewQueue = Promise.resolve();
const previewInFlight = new Map();

function previewFor(filename, width) {
  const out = path.join(CACHE_DIR, `${path.basename(filename, ".jpg")}_${width}.jpg`);
  const src = path.join(OUTPUT_DIR, filename);
  try {
    if (fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) return Promise.resolve(out);
  } catch {
    /* not cached yet */
  }
  if (previewInFlight.has(out)) return previewInFlight.get(out);
  // One at a time: decoding several huge JPEGs at once eats memory.
  const p = (previewQueue = previewQueue
    .catch(() => {})
    .then(() =>
      sharp(src, { limitInputPixels: false, failOn: "none" })
        .resize({ width, height: width, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: width > 1000 ? 85 : 78, mozjpeg: true })
        .toFile(out),
    )
    .then(() => out)
    .finally(() => previewInFlight.delete(out)));
  previewInFlight.set(out, p);
  return p;
}

function listMosaics() {
  return fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => MOSAIC_RE.test(f))
    .map((f) => {
      const full = path.join(OUTPUT_DIR, f);
      const st = fs.statSync(full);
      let meta = {};
      try {
        meta = JSON.parse(fs.readFileSync(full.replace(/\.jpg$/, ".json"), "utf8"));
      } catch {
        /* older mosaics have no sidecar */
      }
      return {
        filename: f,
        createdAt: meta.createdAt || st.mtime.toISOString(),
        fileSize: st.size,
        width: meta.width || null,
        height: meta.height || null,
        rows: meta.rows || null,
        cols: meta.cols || null,
        totalTiles: meta.totalTiles || null,
        uniqueImagesUsed: meta.uniqueImagesUsed || null,
        targetName: meta.targetName || null,
      };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// ---------------------------------------------------------------------------
// Folder browser
// ---------------------------------------------------------------------------

function places() {
  const home = os.homedir();
  const out = [{ name: "Home", path: home }];
  for (const [name, rel] of [
    ["Pictures", "Pictures"],
    ["Desktop", "Desktop"],
    ["OneDrive Pictures", "OneDrive/Pictures"],
    ["Downloads", "Downloads"],
  ]) {
    const p = path.join(home, rel);
    if (fs.existsSync(p)) out.push({ name, path: p });
  }
  if (process.platform === "win32") {
    for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
      const root = `${letter}:\\`;
      try {
        fs.accessSync(root);
        out.push({ name: `${letter}: drive`, path: root });
      } catch {
        /* no such drive */
      }
    }
  } else {
    out.push({ name: "/", path: "/" });
  }
  return out;
}

function browse(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const dirs = [];
  let images = 0;
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name.startsWith(".") || e.name.startsWith("$") || e.name === "node_modules") continue;
      dirs.push({ name: e.name, path: path.join(dir, e.name) });
    } else if (IMAGE_EXT_RE.test(e.name)) {
      images++;
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent !== dir ? parent : null, dirs, images };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.disable("x-powered-by");

app.use((req, res, next) => {
  if (!ALLOWED_HOSTS.has(req.headers.host || "")) return res.status(400).send("Bad host");
  // Any website can make the browser POST to localhost; refuse writes that
  // don't come from this app's own page.
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined) {
      if (site !== "same-origin" && site !== "none") return res.status(403).send("Cross-site request refused");
    } else if (req.headers.origin && !ALLOWED_ORIGINS.has(req.headers.origin)) {
      return res.status(403).send("Cross-site request refused");
    }
  }
  res.set({
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; " +
      "frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
  });
  next();
});

app.use(express.json());
app.use(express.static(path.resolve(__dirname, "../public"), { index: "index.html", maxAge: 0 }));
app.get("/output/:file", (req, res) => {
  const f = req.params.file;
  if (!MOSAIC_RE.test(f)) return res.status(404).end();
  const full = path.join(OUTPUT_DIR, f);
  if (!fs.existsSync(full)) return res.status(404).end();
  if (req.query.download) res.attachment(f);
  res.sendFile(full);
});

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = IMAGE_EXT_RE.test(file.originalname);
    cb(ok ? null : new Error("Please choose a JPG, PNG, WebP or TIFF image."), ok);
  },
});

const api = express.Router();

api.get("/status", (req, res) => {
  const job = currentJobId && jobs.get(currentJobId);
  res.set("Cache-Control", "no-store").json({
    busy: !!job && (job.status === "running" || job.status === "pending"),
    jobId: job ? job.id : null,
  });
});

api.get("/browse", (req, res) => {
  try {
    const p = req.query.path ? resolveSources(String(req.query.path)) : null;
    if (req.query.path && !p) return res.status(404).json({ error: "Folder not found" });
    res.json({ places: places(), ...(p ? browse(p) : { path: null, parent: null, dirs: [], images: 0 }) });
  } catch (err) {
    res.status(500).json({ error: `Can't open this folder (${err.code || err.message})` });
  }
});

api.post("/upload-target", (req, res) => {
  upload.single("target")(req, res, async (err) => {
    if (err) {
      const msg = err.code === "LIMIT_FILE_SIZE" ? "That image is larger than 50 MB." : err.message;
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    try {
      const meta = await sharp(req.file.path, { failOn: "none" }).metadata();
      // EXIF orientations 5–8 are rotated 90°.
      const swap = meta.orientation >= 5;
      res.json({
        targetId: req.file.filename,
        originalName: req.file.originalname,
        width: swap ? meta.height : meta.width,
        height: swap ? meta.width : meta.height,
      });
    } catch {
      fs.unlink(req.file.path, () => {});
      res.status(400).json({ error: "That file isn't a readable image." });
    }
  });
});

api.get("/target/:id", (req, res) => {
  const p = resolveTarget(req.params.id);
  if (!p) return res.status(404).end();
  res.sendFile(p);
});

api.post("/preview", async (req, res) => {
  try {
    const sources = resolveSources(req.body.sourcesDir);
    const target = resolveTarget(req.body.targetId);
    if (!sources) return res.status(400).json({ error: "Sources folder not found." });
    if (!target) return res.status(400).json({ error: "Upload a target image first." });
    const imageCount = discoverImages(sources).length;
    if (imageCount === 0) return res.status(400).json({ error: "No photos (JPG, PNG, WebP, TIFF) in that folder." });
    const meta = await sharp(target, { failOn: "none" }).metadata();
    const swap = meta.orientation >= 5;
    const tw = swap ? meta.height : meta.width;
    const th = swap ? meta.width : meta.height;
    const opts = readOpts(req.body);
    res.json({ imageCount, targetWidth: tw, targetHeight: th, ...computeGrid(imageCount, tw, th, opts) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

api.post("/generate", (req, res) => {
  const running = currentJobId && jobs.get(currentJobId);
  if (running && (running.status === "running" || running.status === "pending")) {
    return res.status(409).json({ error: "A mosaic is already being made.", jobId: running.id });
  }
  const sources = resolveSources(req.body.sourcesDir);
  const target = resolveTarget(req.body.targetId);
  if (!sources) return res.status(400).json({ error: "Sources folder not found." });
  if (!target) return res.status(400).json({ error: "Upload a target image first." });

  const job = createJob({ targetName: String(req.body.targetName || "").slice(0, 200) || null });
  const outputPath = path.join(OUTPUT_DIR, `mosaic_${job.id.slice(0, 8)}.jpg`);

  runPipeline(job, { sourcesDir: sources, targetPath: target, outputPath, opts: readOpts(req.body) })
    .catch((err) => {
      console.error("[mosaic] failed:", err);
      job.status = "error";
      job.error = err.message;
    })
    .finally(() => {
      job.finishedAt = Date.now();
    });

  res.json({ jobId: job.id });
});

api.get("/job/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.set("Cache-Control", "no-store").json(publicJob(job));
});

api.get("/mosaics", (req, res) => {
  res.set("Cache-Control", "no-store").json(listMosaics());
});

api.get("/mosaics/:file/image", async (req, res) => {
  const f = req.params.file;
  const w = +req.query.w || 480;
  if (!MOSAIC_RE.test(f) || !PREVIEW_WIDTHS.has(w) || !fs.existsSync(path.join(OUTPUT_DIR, f))) {
    return res.status(404).end();
  }
  try {
    const out = await previewFor(f, w);
    res.set("Cache-Control", "private, max-age=86400").sendFile(out);
  } catch (err) {
    res.status(500).end();
  }
});

api.delete("/mosaics/:file", (req, res) => {
  const f = req.params.file;
  if (!MOSAIC_RE.test(f)) return res.status(404).end();
  const base = path.basename(f, ".jpg");
  const job = currentJobId && jobs.get(currentJobId);
  if (job && job.status === "running" && job.id.startsWith(base.slice(7))) {
    return res.status(409).json({ error: "That mosaic is still being made." });
  }
  for (const p of [
    path.join(OUTPUT_DIR, f),
    path.join(OUTPUT_DIR, `${base}.json`),
    ...[...PREVIEW_WIDTHS].map((w) => path.join(CACHE_DIR, `${base}_${w}.jpg`)),
  ]) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* already gone */
    }
  }
  res.json({ ok: true });
});

app.use("/api", api);

app.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  Photomosaic UI → http://localhost:${PORT}\n`);
});
