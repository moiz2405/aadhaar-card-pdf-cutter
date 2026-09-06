'use strict';

// Passport photo layout math. Pure functions only (no DOM) so the grid
// packing and unit conversions are unit-testable. The browser bundle
// (passport-photos.js) mirrors these formulas for rendering.

const DPI = 300;
const MM_PER_INCH = 25.4;
const PT_PER_INCH = 72;

const PHOTO_PRESETS = {
  '35x45': { wMm: 35, hMm: 45, label: '35 × 45 mm' },
  '51x51': { wMm: 51, hMm: 51, label: '51 × 51 mm' },
};

// Sheets are stored landscape (width >= height). The default 4×6 in sheet
// fits exactly eight 35×45 mm photos (4 cols × 2 rows).
const SHEETS = {
  '4x6l': { wIn: 6, hIn: 4, label: '4 × 6 in (landscape)' },
};

function mmToPx(mm, dpi = DPI) {
  return Math.max(1, Math.round((mm / MM_PER_INCH) * dpi));
}

function mmToPt(mm) {
  return (mm / MM_PER_INCH) * PT_PER_INCH;
}

function photoPx(presetKey, dpi = DPI) {
  const preset = PHOTO_PRESETS[presetKey];
  if (!preset) throw new Error(`Unknown photo preset: ${presetKey}`);
  return { w: mmToPx(preset.wMm, dpi), h: mmToPx(preset.hMm, dpi) };
}

function sheetPx(sheetKey, dpi = DPI) {
  const sheet = SHEETS[sheetKey];
  if (!sheet) throw new Error(`Unknown sheet: ${sheetKey}`);
  return {
    w: Math.max(1, Math.round(sheet.wIn * dpi)),
    h: Math.max(1, Math.round(sheet.hIn * dpi)),
  };
}

// Pack as many photoW×photoH cells as fit, centered with even margins.
// Always returns at least 1×1 (cells may overflow tiny sheets; callers clip).
function gridLayout({ sheetW, sheetH, photoW, photoH, margin = 30, gap = 10 }) {
  const cols = Math.max(1, Math.floor((sheetW - margin * 2 + gap) / (photoW + gap)));
  const rows = Math.max(1, Math.floor((sheetH - margin * 2 + gap) / (photoH + gap)));
  const gridW = cols * photoW + (cols - 1) * gap;
  const gridH = rows * photoH + (rows - 1) * gap;
  const offsetX = Math.round((sheetW - gridW) / 2);
  const offsetY = Math.round((sheetH - gridH) / 2);
  const cells = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      cells.push({ x: offsetX + c * (photoW + gap), y: offsetY + r * (photoH + gap) });
    }
  }
  return { cols, rows, count: cols * rows, gap, offsetX, offsetY, cells };
}

module.exports = {
  DPI,
  MM_PER_INCH,
  PT_PER_INCH,
  PHOTO_PRESETS,
  SHEETS,
  mmToPx,
  mmToPt,
  photoPx,
  sheetPx,
  gridLayout,
};
