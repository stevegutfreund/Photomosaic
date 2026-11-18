"use strict";

/**
 * renderer.js
 * Assembles the final mosaic image from matched cell assignments.
 *
 * Adjustment pipeline (in-memory only, originals never modified):
 *   - Brightness  : scales luminosity
 *   - Contrast    : adjusts contrast around mid-grey
 *   - Color tint  : blends tile towards target cell's average colour
 *
 * All adjustments are gated by adjustmentStrength ∈ [0, 1].
 * At 0.0: no change. At 1.0: maximum useful adjustment (not destructive).
 */

const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

// Maximum absolute adjustments applied at strength = 1.0
const MAX_BRIGHTNESS_DELTA = 35; // pixel value shift ±35 (out of 255)
const MAX_CONTRAST_FACTOR = 0.4; // contrast multiplier delta ±0.4 (sharp uses 1.0 = neutral)
const MAX_TINT_ALPHA = 0.35; // opacity of colour tint overlay

// ---------------------------------------------------------------------------
// Per-tile adjustment helpers
// ---------------------------------------------------------------------------

/**
 * Computes target brightness from the target cell's average colour vs the
 * source tile's average colour, scaled by strength.
 *
 * Sharp's modulate({ brightness }) uses a multiplier (1.0 = no change).
 *
 * @param {{r,g,b}} sourceAvg
 * @param {{r,g,b}} targetAvg
 * @param {number} strength
 * @returns {number}  brightness multiplier
 */
function computeBrightnessMultiplier(sourceAvg, targetAvg, strength) {
  const sourceLuma =
    0.299 * sourceAvg.r + 0.587 * sourceAvg.g + 0.114 * sourceAvg.b;
  const targetLuma =
    0.299 * targetAvg.r + 0.587 * targetAvg.g + 0.114 * targetAvg.b;

  if (sourceLuma < 1) return 1; // avoid division by near-zero

  // Fractional ratio, blend towards target by `strength`
  const rawRatio = targetLuma / sourceLuma;
  const blended = 1 + (rawRatio - 1) * strength;

  // Clamp to a reasonable range to avoid destroying the image
  return Math.max(0.3, Math.min(3.0, blended));
}

/**
 * Derives a saturation multiplier to boost/reduce saturation toward the target.
 * We approximate: if the target cell is very grey, reduce saturation.
 *
 * @param {{r,g,b}} targetAvg
 * @param {number} strength
 * @returns {number}  saturation multiplier
 */
function computeSaturationMultiplier(targetAvg, strength) {
  const max = Math.max(targetAvg.r, targetAvg.g, targetAvg.b);
  const min = Math.min(targetAvg.r, targetAvg.g, targetAvg.b);
  const targetSaturation = max > 0 ? (max - min) / max : 0; // naive HSV saturation

  // Blend current saturation (1.0 = unchanged) toward a scaled version
  const target = 0.5 + targetSaturation * 0.5; // range [0.5, 1.0]
  return 1 + (target - 1) * strength;
}

// ---------------------------------------------------------------------------
// Composite tint overlay
// ---------------------------------------------------------------------------

/**
 * Generates a solid-colour PNG buffer to composite as a tint over the tile.
 *
 * @param {number} width
 * @param {number} height
 * @param {{r,g,b}} color
 * @param {number} alpha  0→1
 * @returns {Promise<Buffer>}
 */
async function createTintBuffer(width, height, color, alpha) {
  const alphaInt = Math.round(alpha * 255);
  const pixels = Buffer.alloc(width * height * 4);

  for (let i = 0; i < width * height; i++) {
    const off = i * 4;
    pixels[off] = color.r;
    pixels[off + 1] = color.g;
    pixels[off + 2] = color.b;
    pixels[off + 3] = alphaInt;
  }

  return sharp(pixels, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------------
// Single tile rendering
// ---------------------------------------------------------------------------

/**
 * Renders one tile: resize source image to tileW × tileH and apply adjustments.
 * Returns a Sharp instance ready for compositing.
 *
 * @param {string} sourceFilePath
 * @param {object} sourceSignature
 * @param {object} targetCellAvgColor
 * @param {number} tileW
 * @param {number} tileH
 * @param {number} adjustmentStrength  [0, 1]
 * @returns {Promise<Buffer>}  raw RGBA buffer of the finished tile
 */
async function renderTile(
  sourceFilePath,
  sourceSignature,
  targetCellAvgColor,
  tileW,
  tileH,
  adjustmentStrength,
) {
  const strength = Math.max(0, Math.min(1, adjustmentStrength));

  let pipeline = sharp(sourceFilePath, { failOn: "none" })
    .rotate() // apply EXIF orientation, then strip tag
    .resize(tileW, tileH, { fit: "cover", position: "entropy" })
    .removeAlpha();

  if (strength > 0) {
    const brightness = computeBrightnessMultiplier(
      sourceSignature.avgColor,
      targetCellAvgColor,
      strength,
    );
    const saturation = computeSaturationMultiplier(
      targetCellAvgColor,
      strength,
    );

    pipeline = pipeline.modulate({ brightness, saturation });
  }

  let tileBuffer = await pipeline.png().toBuffer();

  // Apply colour tint overlay
  if (strength > 0) {
    const tintAlpha = MAX_TINT_ALPHA * strength;
    const tintBuf = await createTintBuffer(
      tileW,
      tileH,
      targetCellAvgColor,
      tintAlpha,
    );

    tileBuffer = await sharp(tileBuffer)
      .composite([{ input: tintBuf, blend: "over" }])
      .png()
      .toBuffer();
  }

  return tileBuffer;
}

// ---------------------------------------------------------------------------
// Full mosaic assembly
// ---------------------------------------------------------------------------

/**
 * Renders the complete mosaic and saves it to outputPath.
 *
 * @param {Array} assignments   output of matcher.matchCells()
 * @param {number} rows
 * @param {number} cols
 * @param {number} tileWidth    pixels per tile
 * @param {number} tileHeight   pixels per tile
 * @param {number} adjustmentStrength
 * @param {string} outputPath
 * @param {object} [options]
 * @param {function} [options.onProgress]
 * @returns {Promise<void>}
 */
async function renderMosaic(
  assignments,
  rows,
  cols,
  tileWidth,
  tileHeight,
  adjustmentStrength,
  outputPath,
  { onProgress } = {},
) {
  const outDir = path.dirname(outputPath);
  fs.mkdirSync(outDir, { recursive: true });

  const canvasWidth = cols * tileWidth;
  const canvasHeight = rows * tileHeight;

  // Temp directory for row strips — avoids holding all tile buffers in memory at once
  const tmpDir = path.join(
    outDir,
    `_strips_${path.basename(outputPath, path.extname(outputPath))}`,
  );
  fs.mkdirSync(tmpDir, { recursive: true });

  // Index assignments by row for O(1) lookup
  const byRow = new Map();
  for (const a of assignments) {
    if (!byRow.has(a.row)) byRow.set(a.row, []);
    byRow.get(a.row).push(a);
  }
  for (const arr of byRow.values()) arr.sort((a, b) => a.col - b.col);

  const TILE_CONCURRENCY = 4; // low to keep I/O and memory pressure manageable
  const stripPaths = [];
  let tilesRendered = 0;

  console.log(
    `[renderer] canvas ${canvasWidth}×${canvasHeight} px  (${cols}×${rows} tiles @ ${tileWidth}×${tileHeight})`,
  );
  console.log(`[renderer] tmp strips → ${tmpDir}`);

  // ---- Pass 1: render each row into a temp strip PNG on disk ----------------
  for (let rowIdx = 0; rowIdx < rows; rowIdx++) {
    const rowAssignments = byRow.get(rowIdx) || [];
    const tileBuffers = new Map(); // col → buffer

    // Render tiles in this row with bounded concurrency
    for (let i = 0; i < rowAssignments.length; i += TILE_CONCURRENCY) {
      const batch = rowAssignments.slice(i, i + TILE_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map((a) =>
          renderTile(
            a.source.filePath,
            a.source.signature,
            a.targetAvgColor || a.source.signature.avgColor,
            tileWidth,
            tileHeight,
            adjustmentStrength,
          ).then((buf) => ({ col: a.col, buf })),
        ),
      );
      for (const r of settled) {
        if (r.status === "fulfilled") {
          tileBuffers.set(r.value.col, r.value.buf);
        } else {
          console.warn(
            `[renderer] tile render failed (row=${rowIdx}):`,
            r.reason?.message || r.reason,
          );
        }
      }
      tilesRendered += batch.length;
      if (onProgress) onProgress(tilesRendered, assignments.length);
    }

    // Composite this row's tiles into a single strip
    const compositeInputs = [];
    for (const [col, buf] of tileBuffers) {
      if (!Buffer.isBuffer(buf)) {
        console.warn(
          `[renderer] skipping non-buffer tile at row=${rowIdx} col=${col}, type=${typeof buf}`,
        );
        continue;
      }
      compositeInputs.push({ input: buf, left: col * tileWidth, top: 0 });
    }

    const stripPath = path.join(
      tmpDir,
      `row_${String(rowIdx).padStart(6, "0")}.png`,
    );

    try {
      await sharp({
        create: {
          width: canvasWidth,
          height: tileHeight,
          channels: 3,
          background: { r: 0, g: 0, b: 0 },
        },
        limitInputPixels: false,
      })
        .composite(compositeInputs)
        .png({ compressionLevel: 1 }) // fast temp write; size doesn't matter
        .toFile(stripPath);
    } catch (err) {
      console.error(
        `[renderer] strip composite failed at row ${rowIdx}:`,
        err.message,
      );
      throw err;
    }

    stripPaths.push(stripPath);
    // tile buffers go out of scope here → GC can reclaim them
  }

  console.log(`[renderer] all ${rows} strips written — stitching final image…`);

  // ---- Pass 2: stitch strips into final image using file paths ---------------
  // Sharp/libvips reads strips sequentially from disk — no giant in-memory canvas
  const stitchInputs = stripPaths.map((p, i) => ({
    input: p,
    left: 0,
    top: i * tileHeight,
  }));

  try {
    await sharp({
      create: {
        width: canvasWidth,
        height: canvasHeight,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
      limitInputPixels: false,
    })
      .composite(stitchInputs)
      .jpeg({ quality: 95 })
      .toFile(outputPath);
  } catch (err) {
    console.error(
      `[renderer] final stitch failed (canvas ${canvasWidth}×${canvasHeight}):`,
      err.message,
    );
    throw err;
  }

  console.log(`[renderer] saved → ${outputPath}`);

  // ---- Clean up temp strips --------------------------------------------------
  for (const p of stripPaths) {
    try {
      fs.unlinkSync(p);
    } catch {}
  }
  try {
    fs.rmdirSync(tmpDir);
  } catch {}
}

/**
 * High-level render entry point that wires target cell colours into assignments.
 * Call this instead of renderMosaic directly when you have targetCells available.
 *
 * @param {Array} assignments   from matcher.matchCells()
 * @param {Array} targetCells   from analyzer.analyzeTargetGrid()
 * @param {number} rows
 * @param {number} cols
 * @param {number} tileWidth
 * @param {number} tileHeight
 * @param {number} adjustmentStrength
 * @param {string} outputPath
 * @param {object} [options]
 * @returns {Promise<void>}
 */
async function render(
  assignments,
  targetCells,
  rows,
  cols,
  tileWidth,
  tileHeight,
  adjustmentStrength,
  outputPath,
  options = {},
) {
  // Merge target cell avg colors into assignments
  const cellMap = new Map();
  for (const cell of targetCells) {
    cellMap.set(`${cell.row},${cell.col}`, cell.avgColor);
  }

  const enrichedAssignments = assignments.map((a) => ({
    ...a,
    targetAvgColor:
      cellMap.get(`${a.row},${a.col}`) || a.source.signature.avgColor,
  }));

  await renderMosaic(
    enrichedAssignments,
    rows,
    cols,
    tileWidth,
    tileHeight,
    adjustmentStrength,
    outputPath,
    options,
  );
}

module.exports = { render, renderTile, createTintBuffer };
