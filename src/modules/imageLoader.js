"use strict";

/**
 * imageLoader.js
 * Discovers image paths from a directory.
 * Signatures are computed by analyzer.js directly from each file — no raw
 * pixel buffers are ever held in memory here.
 */

const fs = require("fs");
const path = require("path");

const SUPPORTED_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".tiff",
]);

/**
 * Recursively collects all supported image file paths under a directory.
 * @param {string} dir
 * @returns {string[]}
 */
function discoverImages(dir) {
  if (!fs.existsSync(dir)) {
    throw new Error(`Source directory not found: ${dir}`);
  }

  const images = [];

  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.resolve(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        images.push(full);
      }
    }
  }

  walk(dir);
  return images;
}

/**
 * Loads an image file and returns its metadata and raw pixel buffer.
 * The source file is never modified.
 *
 * @param {string} filePath
 * @returns {Promise<{filePath: string, width: number, height: number, buffer: Buffer, channels: number}>}
 */

/**
 * Returns lightweight path-only entries for every supported image found under
 * `dir`. No files are opened — pixel data is never loaded here.
 * Signature computation happens in analyzer.js using streaming sharp operations
 * so full decoded buffers are never accumulated in the JS heap.
 *
 * @param {string} dir
 * @param {object} [options]
 * @param {function} [options.onProgress]
 * @returns {Promise<Array<{filePath: string}>>}
 */
async function loadImagesFromDirectory(dir, { onProgress } = {}) {
  const paths = discoverImages(dir);

  if (paths.length === 0) {
    throw new Error(`No supported images found in: ${dir}`);
  }

  const results = paths.map((filePath) => ({ filePath }));

  // Discovery is instant — report completion immediately
  if (onProgress) onProgress(results.length, results.length);

  return results;
}

module.exports = { discoverImages, loadImagesFromDirectory };
