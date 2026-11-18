"use strict";

/**
 * analyzer.js
 * Computes image "signatures" used for matching.
 *
 * Memory design: signatures are computed directly from files using Sharp's
 * streaming API — no full-resolution pixel buffers are ever held in JS heap.
 *
 * Signatures:
 *   - avgColor : computed via sharp.stats() (no full decode)
 *   - thumbnail: 8×8 resize → 192 bytes per image
 */

const path = require("path");
const sharp = require("sharp");

// Limit libvips tile cache so it doesn't silently consume RAM
sharp.cache({ memory: 50, items: 200, files: 20 });

// Size of the thumbnail used for thumbnail-based matching
const THUMBNAIL_SIZE = 8;

/**
 * Computes the average RGB colour of an image using sharp.stats().
 * This never materialises a full pixel buffer in the JS heap.
 *
 * @param {string} filePath
 * @returns {Promise<{r: number, g: number, b: number}>}
 */
async function computeAvgColor(filePath) {
  const stats = await sharp(filePath, { failOn: "none" })
    .toColorspace("srgb")
    .removeAlpha()
    .stats();
  const ch = stats.channels;
  if (!ch || ch.length < 3 || !ch[0]) {
    throw new Error(
      `Unexpected channel count (${ch ? ch.length : 0}) in ${filePath}`,
    );
  }
  return {
    r: ch[0].mean,
    g: ch[1].mean,
    b: ch[2].mean,
  };
}

/**
 * Computes an NxN thumbnail signature (array of {r,g,b} per cell).
 * Each cell is the average colour of that region.
 *
 * @param {string} filePath  path to original image (re-reads for accuracy)
 * @param {number} [size=THUMBNAIL_SIZE]
 * @returns {Promise<Array<{r,g,b}>>}  flattened row-major array, length = size*size
 */
async function computeThumbnail(filePath, size = THUMBNAIL_SIZE) {
  const { data, info } = await sharp(filePath, { failOn: "none" })
    .rotate() // apply EXIF orientation, then strip tag
    .resize(size, size, { fit: "fill" })
    .toColorspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const cells = [];
  for (let i = 0; i < size * size; i++) {
    const offset = i * 3; // always 3 after toColorspace('srgb') + removeAlpha
    cells.push({
      r: data[offset],
      g: data[offset + 1],
      b: data[offset + 2],
    });
  }
  return cells;
}

/**
 * Builds a full signature for an image entry.
 * Reads the file twice at most (stats + 8×8 resize) — never stores large buffers.
 *
 * @param {{filePath: string}} imageEntry
 * @param {object} [options]
 * @param {boolean} [options.useThumbnail=true]
 * @returns {Promise<{filePath: string, signature: object}>}
 */
async function analyzeImage(imageEntry, { useThumbnail = true } = {}) {
  const { filePath } = imageEntry;

  const avgColor = await computeAvgColor(filePath);
  const signature = { avgColor };

  if (useThumbnail) {
    signature.thumbnail = await computeThumbnail(filePath);
  }

  return { filePath, signature };
}

/**
 * Analyzes a batch of path-only image entries.
 * Concurrency is intentionally low (4) to prevent libvips from opening too
 * many files simultaneously and exhausting disk I/O / memory bandwidth.
 * Failed images are skipped with a warning rather than aborting the job.
 *
 * @param {Array<{filePath: string}>} imageEntries
 * @param {object} [options]
 * @param {function} [options.onProgress]
 * @param {boolean}  [options.useThumbnail]
 * @returns {Promise<Array<{filePath: string, signature: object}>>}
 */
async function analyzeImages(
  imageEntries,
  { onProgress, useThumbnail = true } = {},
) {
  const results = [];
  const CONCURRENCY = 4; // keep memory/I/O pressure low for large sets
  let processed = 0;

  for (let i = 0; i < imageEntries.length; i += CONCURRENCY) {
    const batch = imageEntries.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map((entry) => analyzeImage(entry, { useThumbnail })),
    );

    for (let j = 0; j < settled.length; j++) {
      if (settled[j].status === "fulfilled") {
        results.push(settled[j].value);
      } else {
        console.warn(
          `[analyzer] Skipping ${path.basename(batch[j].filePath)}: ${settled[j].reason.message}`,
        );
      }
      processed++;
      if (onProgress) onProgress(processed, imageEntries.length);
    }
  }

  return results;
}

/**
 * Prepares the target grid cells for matching.
 * Resizes the target image to (cols x rows) and extracts per-cell signatures.
 *
 * @param {string} targetPath
 * @param {number} rows
 * @param {number} cols
 * @param {object} [options]
 * @param {boolean} [options.useThumbnail=true]
 * @returns {Promise<Array<{row, col, avgColor, thumbnail?}>>}
 */
async function analyzeTargetGrid(
  targetPath,
  rows,
  cols,
  { useThumbnail = true } = {},
) {
  // Resize the entire target to cols x rows — each pixel = one grid cell
  const { data: avgData, info: avgInfo } = await sharp(targetPath, {
    failOn: "none",
  })
    .resize(cols, rows, { fit: "fill" })
    .toColorspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Optionally resize to thumbnail-grid size = cols*THUMBNAIL_SIZE x rows*THUMBNAIL_SIZE
  let thumbData = null;
  if (useThumbnail) {
    const result = await sharp(targetPath, { failOn: "none" })
      .resize(cols * THUMBNAIL_SIZE, rows * THUMBNAIL_SIZE, { fit: "fill" })
      .toColorspace("srgb")
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    thumbData = result.data;
  }

  const cells = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const pixelIdx = row * cols + col;
      const offset = pixelIdx * 3; // always 3 channels after toColorspace('srgb') + removeAlpha

      const cell = {
        row,
        col,
        avgColor: {
          r: avgData[offset],
          g: avgData[offset + 1],
          b: avgData[offset + 2],
        },
      };

      if (useThumbnail && thumbData) {
        // Extract the THUMBNAIL_SIZE x THUMBNAIL_SIZE block for this cell
        const thumb = [];
        const thumbCols = cols * THUMBNAIL_SIZE;
        const startRow = row * THUMBNAIL_SIZE;
        const startCol = col * THUMBNAIL_SIZE;

        for (let tr = 0; tr < THUMBNAIL_SIZE; tr++) {
          for (let tc = 0; tc < THUMBNAIL_SIZE; tc++) {
            const thumbIdx = (startRow + tr) * thumbCols + (startCol + tc);
            const tOffset = thumbIdx * 3; // channels always 3 after removeAlpha
            thumb.push({
              r: thumbData[tOffset],
              g: thumbData[tOffset + 1],
              b: thumbData[tOffset + 2],
            });
          }
        }
        cell.thumbnail = thumb;
      }

      cells.push(cell);
    }
  }

  return cells;
}

module.exports = {
  computeAvgColor,
  computeThumbnail,
  analyzeImage,
  analyzeImages,
  analyzeTargetGrid,
  THUMBNAIL_SIZE,
};
