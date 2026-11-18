"use strict";

/**
 * matcher.js
 * Matches each target grid cell to the best available source image.
 *
 * Pluggable strategy system:
 *   - 'avgColor'   : compare average RGB (fast)
 *   - 'thumbnail'  : compare NxN thumbnail grids (better quality)
 *
 * Repeat control:
 *   - repeatFreedom = 0.0  → each image may only be used once
 *   - repeatFreedom > 0.0  → repeats allowed but penalised
 *     The penalty escalates with each reuse proportionally to repeatFreedom.
 *     repeatFreedom = 1.0 means images effectively get no penalty (fully free).
 */

// ---------------------------------------------------------------------------
// Distance functions
// ---------------------------------------------------------------------------

/**
 * Squared Euclidean RGB distance between two {r,g,b} objects.
 * Squared avoids sqrt for comparative purposes (preserves ordering).
 */
function rgbDistSq(a, b) {
  return (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2;
}

/**
 * Average squared distance across parallel thumbnail arrays.
 * Both arrays must have the same length.
 */
function thumbnailDistSq(thumbA, thumbB) {
  let total = 0;
  for (let i = 0; i < thumbA.length; i++) {
    total += rgbDistSq(thumbA[i], thumbB[i]);
  }
  return total / thumbA.length;
}

// ---------------------------------------------------------------------------
// Strategy registry
// ---------------------------------------------------------------------------

/**
 * Computes raw distance between a source signature and a target cell.
 * Returns a non-negative number — lower = better match.
 *
 * @param {'avgColor'|'thumbnail'} strategy
 * @param {object} sourceSignature
 * @param {object} targetCell
 * @returns {number}
 */
function computeDistance(strategy, sourceSignature, targetCell) {
  if (
    strategy === "thumbnail" &&
    sourceSignature.thumbnail &&
    targetCell.thumbnail
  ) {
    return thumbnailDistSq(sourceSignature.thumbnail, targetCell.thumbnail);
  }
  // Fallback / 'avgColor' strategy
  return rgbDistSq(sourceSignature.avgColor, targetCell.avgColor);
}

// ---------------------------------------------------------------------------
// Penalty system
// ---------------------------------------------------------------------------

/**
 * Computes the usage penalty multiplier for an image that has been used `useCount` times.
 *
 * At repeatFreedom = 0, the function is not called (images are excluded after first use).
 * At repeatFreedom = 1, penalty is always 1.0 (no penalty).
 * In between, each reuse multiplies the effective distance.
 *
 * Formula: penalty = 1 + useCount * (1 - repeatFreedom) * PENALTY_SCALE
 *
 * @param {number} useCount
 * @param {number} repeatFreedom  [0, 1]
 * @returns {number}  multiplier ≥ 1
 */
const PENALTY_SCALE = 5; // tune: how aggressively penalties stack

function usagePenalty(useCount, repeatFreedom) {
  if (useCount === 0) return 1;
  return 1 + useCount * (1 - repeatFreedom) * PENALTY_SCALE;
}

// ---------------------------------------------------------------------------
// Core matching
// ---------------------------------------------------------------------------

/**
 * Assigns a source image to every target cell.
 *
 * @param {Array} analyzedSources   output of analyzer.analyzeImages()
 * @param {Array} targetCells       output of analyzer.analyzeTargetGrid()
 * @param {object} options
 * @param {number} options.repeatFreedom   [0, 1]
 * @param {'avgColor'|'thumbnail'} [options.strategy='thumbnail']
 * @param {function} [options.onProgress]
 * @returns {Array<{row, col, source: object}>}
 */
function matchCells(
  analyzedSources,
  targetCells,
  { repeatFreedom = 0, strategy = "thumbnail", onProgress } = {},
) {
  if (analyzedSources.length === 0) {
    throw new Error("No source images available for matching.");
  }

  const strictNoRepeat = repeatFreedom === 0;

  if (strictNoRepeat && analyzedSources.length < targetCells.length) {
    throw new Error(
      `Not enough source images (${analyzedSources.length}) for grid cells ` +
        `(${targetCells.length}). Increase repeat_freedom or reduce grid size.`,
    );
  }

  // Track use counts per source index
  const useCounts = new Array(analyzedSources.length).fill(0);
  const assignments = [];

  for (let cellIdx = 0; cellIdx < targetCells.length; cellIdx++) {
    const cell = targetCells[cellIdx];

    let bestIndex = -1;
    let bestScore = Infinity;

    for (let srcIdx = 0; srcIdx < analyzedSources.length; srcIdx++) {
      // Skip already-used images in strict mode
      if (strictNoRepeat && useCounts[srcIdx] > 0) continue;

      const rawDist = computeDistance(
        strategy,
        analyzedSources[srcIdx].signature,
        cell,
      );
      const penalised =
        rawDist * usagePenalty(useCounts[srcIdx], repeatFreedom);

      if (penalised < bestScore) {
        bestScore = penalised;
        bestIndex = srcIdx;
      }
    }

    if (bestIndex === -1) {
      // Exhausted all unique images in strict mode — should not reach here due to
      // earlier check, but guard defensively
      throw new Error(`Ran out of unique source images at cell ${cellIdx}.`);
    }

    useCounts[bestIndex]++;
    assignments.push({
      row: cell.row,
      col: cell.col,
      source: analyzedSources[bestIndex],
    });

    if (onProgress) onProgress(cellIdx + 1, targetCells.length);
  }

  return assignments;
}

module.exports = { matchCells, computeDistance, usagePenalty };
