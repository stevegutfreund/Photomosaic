"use strict";

// All URLs are relative: through the login gateway this page lives under
// /photomosaic/, directly it's at http://localhost:5006/.

const $ = (id) => document.getElementById(id);
const fmtInt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));
const fmtMB = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : b >= 1e6 ? Math.round(b / 1e6) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB");
const fmtDims = (w, h) => (w && h ? `${fmtInt(w)} × ${fmtInt(h)}` : "—");
const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem("pm." + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem("pm." + k, JSON.stringify(v));
    } catch {
      /* private mode */
    }
  },
};

async function api(path, opts = {}) {
  const res = await fetch("api/" + path, {
    cache: "no-store",
    ...opts,
    headers: opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json", ...(opts.headers || {}) } : opts.headers,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const msg = (data && data.error) || (res.status === 413 ? "That file is too large to send." : `Request failed (${res.status})`);
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

function note(el, kind, text) {
  if (!text) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.className = "note " + kind;
  el.querySelector("use").setAttribute("href", kind === "ok" ? "#i-check" : "#i-alert");
  el.querySelector("span").textContent = text;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  target: store.get("target", null), // { id, name, width, height }
  targetUrl: null,
  sources: store.get("sources", ""),
  tile: store.get("tile", 100),
  adjust: store.get("adjust", 0.3),
  repeat: store.get("repeat", 0),
  strategy: store.get("strategy", "thumbnail"),
  rows: "",
  cols: "",
  grid: null,
  view: "empty",
  jobId: null,
};

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function show(view) {
  state.view = view;
  $("view-empty").hidden = view !== "empty";
  $("view-preview").hidden = view !== "preview";
  $("view-progress").hidden = view !== "progress";
  $("view-result").hidden = view !== "result";
  $("foot-preview").hidden = view !== "preview" || !state.grid;
  $("foot-result").hidden = view !== "result";
  if (view !== "result") $("result-warn").hidden = true;
  updateGenerate();
  if (view === "preview") requestAnimationFrame(drawGrid);
}

function idleView() {
  show(state.target ? "preview" : "empty");
}

// ---------------------------------------------------------------------------
// Step 1 — target picture
// ---------------------------------------------------------------------------

function renderTarget() {
  const t = state.target;
  $("drop").hidden = !!t;
  $("target-row").hidden = !t;
  $("step-target").classList.toggle("done", !!t);
  if (!t) return;
  const url = state.targetUrl || "api/target/" + encodeURIComponent(t.id);
  $("target-thumb").src = url;
  $("preview-img").src = url;
  $("target-name").textContent = t.name;
  $("target-meta").textContent = fmtDims(t.width, t.height) + " px";
}

async function uploadTarget(file) {
  if (!file) return;
  note($("target-err"), "bad", "");
  if (!/^image\/(jpeg|png|webp|tiff)$/.test(file.type) && !/\.(jpe?g|png|webp|tiff?)$/i.test(file.name)) {
    note($("target-err"), "bad", "Please choose a JPG, PNG, WebP or TIFF image.");
    return;
  }
  $("drop").querySelector("strong").textContent = "Uploading…";
  const fd = new FormData();
  fd.append("target", file);
  try {
    const r = await api("upload-target", { method: "POST", body: fd });
    if (state.targetUrl) URL.revokeObjectURL(state.targetUrl);
    state.targetUrl = URL.createObjectURL(file);
    state.target = { id: r.targetId, name: r.originalName, width: r.width, height: r.height };
    store.set("target", state.target);
    renderTarget();
    if (state.view !== "progress") show("preview");
    refreshPreview();
  } catch (e) {
    note($("target-err"), "bad", e.message);
  } finally {
    $("drop").querySelector("strong").textContent = "Choose a photo";
    $("file").value = "";
  }
}

$("file").addEventListener("change", (e) => uploadTarget(e.target.files[0]));
$("target-replace").addEventListener("click", () => $("file").click());
$("drop").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    $("file").click();
  }
});
["dragenter", "dragover"].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    if (!$("drop").hidden) $("drop").classList.add("over");
  }),
);
["dragleave", "drop"].forEach((ev) =>
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === "dragleave" && e.relatedTarget) return;
    $("drop").classList.remove("over");
  }),
);
document.addEventListener("drop", (e) => {
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (f) uploadTarget(f);
});

// ---------------------------------------------------------------------------
// Step 2 — sources folder
// ---------------------------------------------------------------------------

function renderRecent() {
  const recent = store.get("recent", []).filter((p) => p !== state.sources);
  const box = $("recent");
  box.replaceChildren();
  box.hidden = recent.length === 0;
  recent.slice(0, 4).forEach((p) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.title = p;
    b.textContent = p.split(/[\\/]/).filter(Boolean).pop() || p;
    b.addEventListener("click", () => setSources(p));
    box.appendChild(b);
  });
}

function rememberFolder(p) {
  const recent = [p, ...store.get("recent", []).filter((x) => x !== p)].slice(0, 6);
  store.set("recent", recent);
}

function setSources(p) {
  state.sources = p.trim();
  $("sources").value = state.sources;
  store.set("sources", state.sources);
  renderRecent();
  refreshPreview();
}

$("sources").value = state.sources;
$("sources").addEventListener("change", (e) => setSources(e.target.value));
$("sources").addEventListener("keydown", (e) => {
  if (e.key === "Enter") setSources(e.target.value);
});

// Folder picker -------------------------------------------------------------

let pickerPath = null;

async function openFolder(p) {
  const list = $("dirs");
  try {
    const r = await api("browse" + (p ? "?path=" + encodeURIComponent(p) : ""));
    pickerPath = r.path;
    // Places
    const places = $("places");
    if (!places.childElementCount) {
      r.places.forEach((pl) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "chip";
        b.textContent = pl.name;
        b.title = pl.path;
        b.addEventListener("click", () => openFolder(pl.path));
        places.appendChild(b);
      });
    }
    $("crumb").textContent = r.path || "Pick a place to start";
    $("up").disabled = !r.parent;
    $("up").onclick = () => r.parent && openFolder(r.parent);
    $("picker-use").disabled = !r.path;
    $("picker-count").textContent = r.path ? (r.images ? `${fmtInt(r.images)} photo${r.images === 1 ? "" : "s"} in this folder` : "No photos directly in this folder") : "";

    list.replaceChildren();
    if (r.path && !r.dirs.length) {
      const li = document.createElement("li");
      li.className = "empty-row";
      li.textContent = "No sub-folders.";
      list.appendChild(li);
    }
    r.dirs.forEach((d) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.innerHTML = '<svg aria-hidden="true"><use href="#i-folder"/></svg><span class="nm"></span><svg aria-hidden="true" style="width:14px;height:14px"><use href="#i-chev"/></svg>';
      b.querySelector(".nm").textContent = d.name;
      b.addEventListener("click", () => openFolder(d.path));
      li.appendChild(b);
      list.appendChild(li);
    });
    $("picker").querySelector(".dlg-body").scrollTop = 0;
  } catch (e) {
    toast(e.message);
  }
}

$("browse").addEventListener("click", () => {
  $("picker").showModal();
  openFolder(state.sources || store.get("lastBrowse", "") || null);
});
$("picker-use").addEventListener("click", () => {
  if (!pickerPath) return;
  store.set("lastBrowse", pickerPath);
  $("picker").close();
  setSources(pickerPath);
});

// ---------------------------------------------------------------------------
// Step 3 — style
// ---------------------------------------------------------------------------

function bindSeg(id, key, onChange) {
  const seg = $(id);
  const paint = () =>
    seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === String(state[key]))));
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state[key] = key === "tile" ? +b.dataset.v : b.dataset.v;
    store.set(key, state[key]);
    paint();
    onChange && onChange();
  });
  paint();
}

function paintRange(el) {
  el.style.setProperty("--p", ((el.value - el.min) / (el.max - el.min)) * 100 + "%");
}

function reuseLabel(v) {
  if (v === 0) return "Never";
  if (v < 0.35) return "A little";
  if (v < 0.7) return "Some";
  if (v < 1) return "Often";
  return "Freely";
}

function renderStyle() {
  $("tile-val").textContent = state.tile + " px";
  $("adjust").value = state.adjust;
  $("adjust-val").textContent = Math.round(state.adjust * 100) + "%";
  $("repeat").value = state.repeat;
  $("repeat-val").textContent = reuseLabel(state.repeat);
  paintRange($("adjust"));
  paintRange($("repeat"));
}

bindSeg("tile-seg", "tile", () => {
  renderStyle();
  refreshPreview();
});
bindSeg("strategy-seg", "strategy");

$("adjust").addEventListener("input", (e) => {
  state.adjust = +e.target.value;
  store.set("adjust", state.adjust);
  renderStyle();
});
$("repeat").addEventListener("input", (e) => {
  state.repeat = +e.target.value;
  store.set("repeat", state.repeat);
  renderStyle();
  refreshPreview();
});
["rows", "cols"].forEach((k) =>
  $(k).addEventListener("input", (e) => {
    state[k] = e.target.value;
    refreshPreview();
  }),
);

// ---------------------------------------------------------------------------
// Preview (grid numbers + overlay)
// ---------------------------------------------------------------------------

let previewTimer;
let previewSeq = 0;

function settingsBody() {
  return {
    sourcesDir: state.sources,
    targetId: state.target && state.target.id,
    targetName: state.target && state.target.name,
    rows: state.rows || null,
    cols: state.cols || null,
    tileWidth: state.tile,
    adjustmentStrength: state.adjust,
    repeatFreedom: state.repeat,
    strategy: state.strategy,
  };
}

function refreshPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, 250);
}

async function runPreview() {
  const seq = ++previewSeq;
  const srcNote = $("sources-note");
  $("step-sources").classList.remove("done");
  if (!state.sources) {
    state.grid = null;
    note(srcNote, "ok", "");
    renderSummary();
    return;
  }
  if (!state.target) {
    state.grid = null;
    note(srcNote, "ok", "");
    renderSummary();
    return;
  }
  note(srcNote, "ok", "Counting photos…");
  srcNote.className = "note";
  try {
    const g = await api("preview", { method: "POST", body: JSON.stringify(settingsBody()) });
    if (seq !== previewSeq) return;
    state.grid = g;
    note(srcNote, "ok", `${fmtInt(g.imageCount)} photos found (including sub-folders)`);
    $("step-sources").classList.add("done");
    rememberFolder(state.sources);
    renderRecent();
  } catch (e) {
    if (seq !== previewSeq) return;
    state.grid = null;
    note(srcNote, "bad", e.message);
  }
  renderSummary();
}

function renderSummary() {
  const g = state.grid;
  $("sum-grid").textContent = g ? `${g.cols} × ${g.rows}` : "—";
  $("sum-tiles").textContent = g ? fmtInt(g.cells) : "—";
  $("sum-out").textContent = g ? `${(g.outputWidth * g.outputHeight / 1e6).toFixed(g.outputWidth * g.outputHeight > 1e8 ? 0 : 1)} MP` : "—";
  $("sum-out").title = g ? fmtDims(g.outputWidth, g.outputHeight) + " px" : "";

  let warn = "";
  if (g && g.clamped) warn = `Only ${fmtInt(g.imageCount)} photos, so the grid is limited to ${fmtInt(g.cells)} tiles. Allow photo reuse for more detail.`;
  else if (g && g.cells < 400) warn = "Few tiles — the picture will be hard to recognise. Add photos or allow reuse.";
  else if (g && g.outputWidth * g.outputHeight > 3e8) warn = "Very large output. It may take a while and the file could be over 100 MB.";
  note($("go-note"), "warn", warn);

  $("foot-preview-text").textContent = g
    ? `Each square is one photo · ${g.cols} × ${g.rows} grid · output ${fmtDims(g.outputWidth, g.outputHeight)} px`
    : "";
  $("foot-preview").hidden = state.view !== "preview" || !g;
  updateGenerate();
  drawGrid();
}

function updateGenerate() {
  $("generate").disabled = !state.grid || state.running;
}

function drawGrid() {
  const img = $("preview-img");
  const cv = $("grid");
  const g = state.grid;
  if (state.view !== "preview" || !img.complete || !img.naturalWidth) return;
  const w = img.clientWidth;
  const h = img.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cv.style.width = w + "px";
  cv.style.height = h + "px";
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!g) return;
  ctx.scale(dpr, dpr);
  const cw = w / g.cols;
  const ch = h / g.rows;
  const dense = Math.min(cw, ch) < 5;
  ctx.strokeStyle = dense ? "rgba(255,255,255,.28)" : "rgba(255,255,255,.55)";
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  if (!dense || g.cols <= w) {
    for (let c = 1; c < g.cols; c++) {
      const x = Math.round(c * cw) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let r = 1; r < g.rows; r++) {
      const y = Math.round(r * ch) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
  }
  ctx.stroke();
}

$("preview-img").addEventListener("load", drawGrid);
window.addEventListener("resize", drawGrid);

// ---------------------------------------------------------------------------
// Generate + progress
// ---------------------------------------------------------------------------

const STAGES = [
  ["Loading images", "Finding photos", 2],
  ["Analyzing sources", "Reading tile photos", 45],
  ["Preparing grid", "Mapping the picture", 3],
  ["Matching tiles", "Matching tiles", 10],
  ["Rendering", "Rendering mosaic", 37],
  ["Finishing", "Saving", 3],
];

$("generate").addEventListener("click", async () => {
  if (!state.grid) return;
  $("generate").disabled = true;
  try {
    const r = await api("generate", { method: "POST", body: JSON.stringify(settingsBody()) });
    startTracking(r.jobId);
  } catch (e) {
    if (e.status === 409 && e.data && e.data.jobId) {
      toast("A mosaic is already being made — showing its progress.");
      startTracking(e.data.jobId);
    } else {
      toast(e.message);
      updateGenerate();
    }
  }
});

let pollTimer;
function startTracking(jobId) {
  state.jobId = jobId;
  state.running = true;
  $("prog-err").hidden = true;
  $("prog-bar").style.width = "0%";
  $("prog-sub").textContent = "Starting…";
  renderStages({ stages: {}, currentStage: "" });
  show("progress");
  const stage = document.querySelector(".stage");
  const r = stage.getBoundingClientRect();
  if (r.top < 0 || r.top > window.innerHeight * 0.5) stage.scrollIntoView({ behavior: "smooth", block: "start" });
  poll();
}

async function poll() {
  clearTimeout(pollTimer);
  let job;
  try {
    job = await api("job/" + state.jobId);
  } catch (e) {
    if (e.status === 404) {
      state.running = false;
      toast("That job is no longer available.");
      idleView();
      return;
    }
    pollTimer = setTimeout(poll, 2000); // PC busy or briefly unreachable
    return;
  }
  renderStages(job);
  if (job.status === "done") {
    state.running = false;
    return showResult(job);
  }
  if (job.status === "error") {
    const box = $("prog-err");
    box.hidden = false;
    box.querySelector("span").textContent = job.error || "Something went wrong.";
    $("prog-sub").textContent = "Stopped — adjust the settings and try again.";
    state.running = false;
    updateGenerate();
    return;
  }
  pollTimer = setTimeout(poll, 800);
}

function renderStages(job) {
  const list = $("stages");
  list.replaceChildren();
  const curIdx = STAGES.findIndex(([k]) => k === job.currentStage);
  let pct = 0;
  STAGES.forEach(([key, label, weight], i) => {
    const s = job.stages[key];
    const done = job.status === "done" || i < curIdx || (s && s.total && s.current >= s.total && i !== curIdx);
    const active = i === curIdx && job.status !== "done";
    const frac = done ? 1 : active && s && s.total ? s.current / s.total : 0;
    pct += weight * frac;

    const li = document.createElement("li");
    li.className = done ? "done" : active ? "active" : "";
    li.innerHTML = `<span class="ico">${
      done ? '<svg><use href="#i-check"/></svg>' : active ? '<span class="ring"></span>' : '<span class="pending-dot"></span>'
    }</span><span class="lbl"></span><span class="count num"></span>`;
    li.querySelector(".lbl").textContent = label;
    if (active && s && s.total > 1) li.querySelector(".count").textContent = `${fmtInt(s.current)} / ${fmtInt(s.total)}`;
    list.appendChild(li);
  });
  $("prog-bar").style.width = Math.min(100, Math.round(pct)) + "%";
  if (job.startedAt) {
    const secs = Math.round(((job.finishedAt || Date.now()) - job.startedAt) / 1000);
    const m = Math.floor(secs / 60);
    $("prog-sub").textContent = `${Math.min(100, Math.round(pct))}% · ${m}:${String(secs % 60).padStart(2, "0")} elapsed — you can leave this page, it keeps going.`;
  }
}

function setDownload(a, open, file, size) {
  a.href = "output/" + encodeURIComponent(file) + "?download=1";
  a.setAttribute("download", file);
  a.lastChild.textContent = "Download" + (size ? " · " + fmtMB(size) : "");
  open.href = "output/" + encodeURIComponent(file);
}

function showResult(job) {
  const r = job.result;
  $("result-img").src = `api/mosaics/${encodeURIComponent(r.filename)}/image?w=1600`;
  $("result-img").onclick = () => openViewer({ filename: r.filename, ...r, createdAt: new Date().toISOString(), targetName: state.target && state.target.name });
  $("result-stats").innerHTML = "";
  [
    ["Grid", `${r.cols} × ${r.rows}`],
    ["Tiles", fmtInt(r.totalTiles)],
    ["Photos used", fmtInt(r.uniqueImagesUsed)],
    ["Size", fmtDims(r.width, r.height) + " px"],
  ].forEach(([k, v]) => {
    const s = document.createElement("span");
    s.innerHTML = "<span></span> <b></b>";
    s.firstChild.textContent = k;
    s.lastChild.textContent = v;
    $("result-stats").appendChild(s);
  });
  setDownload($("result-dl"), $("result-open"), r.filename, r.fileSize);
  show("result");
  const w = $("result-warn");
  w.hidden = !job.warnings.length;
  w.querySelector("span").textContent = job.warnings.join(" ");
  loadGallery();
}

$("again").addEventListener("click", () => idleView());

// ---------------------------------------------------------------------------
// Gallery + viewer
// ---------------------------------------------------------------------------

let viewing = null;

function mosaicTitle(m) {
  return m.targetName ? m.targetName.replace(/\.[^.]+$/, "") : "Mosaic";
}

async function loadGallery() {
  let items = [];
  try {
    items = await api("mosaics");
  } catch {
    return;
  }
  const g = $("gallery");
  g.replaceChildren();
  $("gal-count").textContent = items.length ? `· ${items.length}` : "";
  $("gallery-empty").hidden = items.length > 0;
  items.forEach((m) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tile";
    b.innerHTML = '<span class="thumb"><img loading="lazy" alt=""></span><span class="cap"><span class="t1"></span><span class="t2 num"></span></span>';
    b.querySelector("img").src = `api/mosaics/${encodeURIComponent(m.filename)}/image?w=480`;
    b.querySelector(".t1").textContent = mosaicTitle(m);
    b.querySelector(".t2").textContent = [fmtDate(m.createdAt), m.totalTiles ? fmtInt(m.totalTiles) + " tiles" : null, fmtMB(m.fileSize)]
      .filter(Boolean)
      .join(" · ");
    b.addEventListener("click", () => openViewer(m));
    g.appendChild(b);
  });
}

function openViewer(m) {
  viewing = m;
  $("viewer-title").textContent = mosaicTitle(m);
  $("viewer-img").src = `api/mosaics/${encodeURIComponent(m.filename)}/image?w=1600`;
  $("viewer-meta").textContent = [fmtDate(m.createdAt), m.width ? fmtDims(m.width, m.height) + " px" : null, m.cols ? `${m.cols} × ${m.rows} grid` : null]
    .filter(Boolean)
    .join(" · ");
  setDownload($("viewer-dl"), $("viewer-open"), m.filename, m.fileSize);
  $("viewer").showModal();
}

$("viewer-del").addEventListener("click", async () => {
  if (!viewing) return;
  if (!confirm(`Delete “${mosaicTitle(viewing)}”? This can't be undone.`)) return;
  try {
    await api("mosaics/" + encodeURIComponent(viewing.filename), { method: "DELETE" });
    $("viewer").close();
    if (state.view === "result" && $("result-img").src.includes(viewing.filename)) idleView();
    toast("Mosaic deleted");
    loadGallery();
  } catch (e) {
    toast(e.message);
  }
});

// Dialog close buttons + click on backdrop
document.querySelectorAll("dialog").forEach((d) => {
  d.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => d.close()));
  d.addEventListener("click", (e) => {
    if (e.target === d) d.close();
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function boot() {
  renderStyle();
  renderRecent();
  renderTarget();
  idleView();
  loadGallery();

  // A restored target may have been cleaned up on the PC.
  if (state.target) {
    const probe = new Image();
    probe.onerror = () => {
      state.target = null;
      store.set("target", null);
      renderTarget();
      idleView();
      refreshPreview();
    };
    probe.src = "api/target/" + encodeURIComponent(state.target.id);
  }
  runPreview();

  // Pick up a mosaic that's still being made (e.g. after the phone slept).
  try {
    const s = await api("status");
    if (s.busy && s.jobId) startTracking(s.jobId);
  } catch {
    /* offline */
  }
})();
