# Photomosaic

A Node.js photomosaic generator that assembles a target image from a library of source photos, where each source image acts as a single tile.

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Start the web UI  (recommended)
npm run serve
# → open http://localhost:5006 in your browser

# 3. Or use the CLI directly (see below)
```

## Installation

```bash
npm install
```

## Web UI

```bash
npm run serve
```

Opens a browser UI at **http://localhost:5006** where you can:

- Type the path to your **sources folder** on this machine (no upload needed — the server reads it directly)
- **Upload or drag & drop** your target image
- Tweak all parameters with sliders and dropdowns
- Click **Preview grid** to see tile/output dimensions before committing
- Click **Generate mosaic** and watch live per-stage progress
- Download the finished image directly from the browser

## CLI usage

### Command line

```bash
# Basic usage
node src/index.js --sources ./sources --target ./target.jpg --output ./output/mosaic.jpg

# Preview grid resolution without rendering
node src/index.js --sources ./sources --target ./target.jpg --preview

# Allow some image reuse with adjustment
node src/index.js --sources ./sources --target ./target.jpg \
  --repeat-freedom 0.3 \
  --adjustment-strength 0.5 \
  --strategy thumbnail

# Explicit grid
node src/index.js --sources ./sources --target ./target.jpg \
  --rows 40 --cols 60

# Use config file (defaults to config/default.json)
node src/index.js --config ./config/default.json
```

### Config file (`config/default.json`)

```json
{
  "sources": "./sources",
  "target": "./target.jpg",
  "output": "./output/mosaic.jpg",
  "adjustment_strength": 0.3,
  "repeat_freedom": 0.0,
  "strategy": "thumbnail"
}
```

CLI flags always override config file values.

## Options

| Flag                    | Description                                 | Default                 |
| ----------------------- | ------------------------------------------- | ----------------------- |
| `--sources`             | Directory of source images (jpg/png/webp)   | required                |
| `--target`              | Target image file                           | required                |
| `--output`              | Output file path                            | `./output/mosaic.jpg`   |
| `--rows`                | Grid rows                                   | auto                    |
| `--cols`                | Grid columns                                | auto                    |
| `--tile-width`          | Tile width in pixels                        | auto                    |
| `--tile-height`         | Tile height in pixels                       | auto                    |
| `--adjustment-strength` | Colour/brightness tweak strength [0..1]     | `0.3`                   |
| `--repeat-freedom`      | Allow image reuse [0=none, 1=free]          | `0`                     |
| `--strategy`            | `thumbnail` (better) or `avgColor` (faster) | `thumbnail`             |
| `--no-thumbnail`        | Skip thumbnail analysis                     | off                     |
| `--preview`             | Print resolution info, no render            | off                     |
| `--config`              | JSON config file                            | `./config/default.json` |

## Parameters explained

### `adjustment_strength` (0.0 → 1.0)

Controls how much each tile is visually adjusted to better match the target cell:

- **0.0** — tiles are placed as-is, no colour changes
- **0.5** — moderate brightness/contrast/tint applied
- **1.0** — maximum adjustment (still visually natural)

Adjustments applied: brightness scaling, saturation tweak, colour tint overlay.  
Originals are **never modified**.

### `repeat_freedom` (0.0 → 1.0)

Controls image reuse across the grid:

- **0.0** — strict: each source image used at most once. Requires `sources >= grid cells`.
- **0.0–1.0** — penalty mode: reused images get a distance penalty that grows with reuse count.
- **1.0** — no penalty, images reused freely.

### `strategy`

- **`thumbnail`** (default): compares 8×8 pixel grids for spatial colour matching — better quality.
- **`avgColor`**: compares single average RGB values — faster, lower quality.

## Project structure

```
src/
  index.js              # CLI entry point + pipeline orchestration
  server.js             # Express web server (127.0.0.1:5006)
  modules/
    imageLoader.js      # Discovers and loads source images
    analyzer.js         # Computes image signatures (avgColor, thumbnail)
    matcher.js          # Assigns source images to target grid cells
    renderer.js         # Assembles and saves the final mosaic
public/
  index.html            # Web UI (single page)
config/
  default.json          # Default configuration
output/                 # Generated mosaics saved here
tmp/uploads/            # Temporary target image uploads (auto-created)
```

## Tips

- For best quality, use **as many source images as possible** with `repeat_freedom = 0`.
- Lower `--tile-width`/`--tile-height` = more tiles, finer detail in the mosaic.
- Use `--preview` first to check grid size before committing to a full render.
- Large grids with many high-res sources can take several minutes.
