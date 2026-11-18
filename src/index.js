#!/usr/bin/env node
"use strict";

/**
 * index.js — Photomosaic generator
 *
 * Usage:
 *   node src/index.js --sources ./images --target ./photo.jpg --output ./output/mosaic.jpg
 *   node src/index.js --config ./config/mosaic.json
 *   node src/index.js --sources ./images --target ./photo.jpg --preview
 *
 * All options can also be set via config/default.json.
 */

const { program } = require("commander");
const chalk = require("chalk");
const path = require("path");
const fs = require("fs");

const { loadImagesFromDirectory } = require("./modules/imageLoader");
const { analyzeImages, analyzeTargetGrid } = require("./modules/analyzer");
const { matchCells } = require("./modules/matcher");
const { render } = require("./modules/renderer");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  process.stdout.write(chalk.cyan("[mosaic] ") + msg + "\n");
}
function ok(msg) {
  process.stdout.write(chalk.green("[done]   ") + msg + "\n");
}
function warn(msg) {
  process.stdout.write(chalk.yellow("[warn]   ") + msg + "\n");
}
function fail(msg) {
  process.stderr.write(chalk.red("[error]  ") + msg + "\n");
}

function progressBar(label, current, total) {
  const pct = Math.floor((current / total) * 100);
  process.stdout.write(
    `\r${chalk.cyan("[mosaic]")} ${label}: ${pct}% (${current}/${total})   `,
  );
  if (current === total) process.stdout.write("\n");
}

/**
 * Loads a JSON config file, returning an empty object if not found.
 */
function loadConfigFile(configPath) {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) return {};
  try {
    return JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (e) {
    warn(`Could not parse config file ${resolved}: ${e.message}`);
    return {};
  }
}

/**
 * Determines a sensible grid size based on the number of source images and a
 * desired aspect ratio from the target image dimensions.
 *
 * @param {number} imageCount
 * @param {number} targetWidth
 * @param {number} targetHeight
 * @returns {{ rows: number, cols: number }}
 */
function autoGridSize(imageCount, targetWidth, targetHeight) {
  const aspectRatio = targetWidth / targetHeight;
  // cols / rows ≈ aspectRatio, cols * rows ≤ imageCount
  const rows = Math.max(1, Math.floor(Math.sqrt(imageCount / aspectRatio)));
  const cols = Math.max(1, Math.floor(rows * aspectRatio));
  return { rows, cols };
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

function printPreview({
  rows,
  cols,
  tileWidth,
  tileHeight,
  imageCount,
  targetPath,
}) {
  const canvasW = cols * tileWidth;
  const canvasH = rows * tileHeight;

  log(chalk.bold("=== Mosaic Preview ==="));
  log(`Target image  : ${targetPath}`);
  log(`Source images : ${imageCount}`);
  log(`Grid          : ${rows} rows × ${cols} cols = ${rows * cols} cells`);
  log(`Tile size     : ${tileWidth} × ${tileHeight} px`);
  log(`Output size   : ${canvasW} × ${canvasH} px`);

  if (imageCount < rows * cols) {
    warn(
      `Fewer images (${imageCount}) than cells (${rows * cols}). Set repeat_freedom > 0 or reduce grid.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function run(opts) {
  const {
    sources,
    target,
    output,
    rows: rowsOpt,
    cols: colsOpt,
    tileWidth,
    tileHeight,
    adjustmentStrength,
    repeatFreedom,
    strategy,
    useThumbnail,
    preview,
  } = opts;

  // --- Validate inputs ---
  if (!sources) throw new Error("--sources path is required.");
  if (!target) throw new Error("--target path is required.");

  const resolvedTarget = path.resolve(target);
  if (!fs.existsSync(resolvedTarget))
    throw new Error(`Target image not found: ${resolvedTarget}`);

  // --- Load source images ---
  log(`Loading source images from: ${sources}`);
  const loaded = await loadImagesFromDirectory(path.resolve(sources), {
    onProgress: (n, t) => progressBar("Loading", n, t),
  });
  ok(`Loaded ${loaded.length} images.`);

  // --- Determine grid size ---
  const sharp = require("sharp");
  const targetMeta = await sharp(resolvedTarget).metadata();

  let rows, cols;
  if (rowsOpt && colsOpt) {
    rows = rowsOpt;
    cols = colsOpt;
  } else {
    const auto = autoGridSize(
      loaded.length,
      targetMeta.width,
      targetMeta.height,
    );
    rows = rowsOpt || auto.rows;
    cols = colsOpt || auto.cols;
  }

  const resolvedTileWidth = tileWidth || Math.ceil(targetMeta.width / cols);
  const resolvedTileHeight = tileHeight || Math.ceil(targetMeta.height / rows);

  // --- Preview mode ---
  if (preview) {
    printPreview({
      rows,
      cols,
      tileWidth: resolvedTileWidth,
      tileHeight: resolvedTileHeight,
      imageCount: loaded.length,
      targetPath: resolvedTarget,
    });
    return;
  }

  const resolvedOutput = path.resolve(output || "./output/mosaic.jpg");

  // --- Analyze source images ---
  log(`Analyzing ${loaded.length} source images (strategy: ${strategy})...`);
  const analyzed = await analyzeImages(loaded, {
    useThumbnail: useThumbnail && strategy === "thumbnail",
    onProgress: (n, t) => progressBar("Analyzing", n, t),
  });
  ok("Source image analysis complete.");

  // --- Analyze target grid ---
  log(`Analyzing target grid (${rows} × ${cols})...`);
  const targetCells = await analyzeTargetGrid(resolvedTarget, rows, cols, {
    useThumbnail: useThumbnail && strategy === "thumbnail",
  });
  ok(`Target grid prepared: ${targetCells.length} cells.`);

  // --- Match cells ---
  log("Matching tiles...");
  const assignments = matchCells(analyzed, targetCells, {
    repeatFreedom,
    strategy,
    onProgress: (n, t) => progressBar("Matching", n, t),
  });
  ok(`Matching complete. ${assignments.length} tiles assigned.`);

  // --- Render ---
  log(`Rendering mosaic → ${resolvedOutput}`);
  await render(
    assignments,
    targetCells,
    rows,
    cols,
    resolvedTileWidth,
    resolvedTileHeight,
    adjustmentStrength,
    resolvedOutput,
    { onProgress: (n, t) => progressBar("Rendering", n, t) },
  );

  ok(chalk.bold(`Mosaic saved to: ${resolvedOutput}`));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

program
  .name("photomosaic")
  .description(
    "Generate a photomosaic from a folder of images and a target photo.",
  )
  .version("1.0.0")

  .option("-s, --sources <dir>", "Directory of source images")
  .option("-t, --target <file>", "Target image file")
  .option(
    "-o, --output <file>",
    "Output file path (default: ./output/mosaic.jpg)",
  )
  .option(
    "-c, --config <file>",
    "JSON config file (default: ./config/default.json)",
  )
  .option("--rows <n>", "Grid rows (auto if omitted)", (v) => parseInt(v, 10))
  .option("--cols <n>", "Grid cols (auto if omitted)", (v) => parseInt(v, 10))
  .option("--tile-width <px>", "Tile width in pixels (auto if omitted)", (v) =>
    parseInt(v, 10),
  )
  .option(
    "--tile-height <px>",
    "Tile height in pixels (auto if omitted)",
    (v) => parseInt(v, 10),
  )
  .option(
    "--adjustment-strength <0-1>",
    "Colour/brightness adjustment strength [0..1] (default: 0.3)",
    (v) => parseFloat(v),
  )
  .option(
    "--repeat-freedom <0-1>",
    "Allow image reuse [0=none, 1=free] (default: 0)",
    (v) => parseFloat(v),
  )
  .option(
    "--strategy <name>",
    "Matching strategy: avgColor | thumbnail (default: thumbnail)",
  )
  .option(
    "--no-thumbnail",
    "Disable thumbnail analysis (faster, less accurate)",
  )
  .option("--preview", "Print grid resolution info without rendering");

program.parse(process.argv);
const cliOpts = program.opts();

// Merge config file → CLI opts (CLI wins)
const configFile = cliOpts.config || "./config/default.json";
const fileConf = loadConfigFile(configFile);

const opts = {
  sources: cliOpts.sources ?? fileConf.sources,
  target: cliOpts.target ?? fileConf.target,
  output: cliOpts.output ?? fileConf.output,
  rows: cliOpts.rows ?? fileConf.rows,
  cols: cliOpts.cols ?? fileConf.cols,
  tileWidth: cliOpts.tileWidth ?? fileConf.tile_width,
  tileHeight: cliOpts.tileHeight ?? fileConf.tile_height,
  adjustmentStrength:
    cliOpts.adjustmentStrength ?? fileConf.adjustment_strength ?? 0.3,
  repeatFreedom: cliOpts.repeatFreedom ?? fileConf.repeat_freedom ?? 0,
  strategy: cliOpts.strategy ?? fileConf.strategy ?? "thumbnail",
  useThumbnail: cliOpts.thumbnail ?? fileConf.use_thumbnail ?? true,
  preview: cliOpts.preview ?? false,
};

run(opts).catch((err) => {
  fail(err.message);
  process.exit(1);
});
