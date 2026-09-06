'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mmToPx,
  mmToPt,
  photoPx,
  sheetPx,
  gridLayout,
} = require('../lib/passport-layout.cjs');

test('converts mm to print pixels at 300 DPI', () => {
  assert.equal(mmToPx(25.4), 300);
  assert.equal(mmToPx(35), 413);
  assert.equal(mmToPx(45), 531);
  assert.equal(mmToPx(51), 602);
});

test('converts mm to PDF points', () => {
  assert.equal(mmToPt(25.4), 72);
  assert.ok(Math.abs(mmToPt(35) - 99.21) < 0.01);
});

test('resolves preset and sheet pixel sizes', () => {
  assert.deepEqual(photoPx('35x45'), { w: 413, h: 531 });
  assert.deepEqual(photoPx('51x51'), { w: 602, h: 602 });
  assert.deepEqual(sheetPx('4x6l'), { w: 1800, h: 1200 });
  assert.throws(() => photoPx('nope'), /Unknown photo preset/);
});

test('packs exactly eight 35x45 photos on a 4x6 landscape sheet', () => {
  const sheet = sheetPx('4x6l');
  const photo = photoPx('35x45');
  const grid = gridLayout({ sheetW: sheet.w, sheetH: sheet.h, photoW: photo.w, photoH: photo.h });
  assert.equal(grid.cols, 4);
  assert.equal(grid.rows, 2);
  assert.equal(grid.count, 8);
  assert.equal(grid.cells.length, 8);
  for (const cell of grid.cells) {
    assert.ok(cell.x >= 0 && cell.y >= 0);
    assert.ok(cell.x + photo.w <= sheet.w && cell.y + photo.h <= sheet.h);
  }
});

test('auto-fits two 51x51 photos on a 4x6 landscape sheet', () => {
  const sheet = sheetPx('4x6l');
  const photo = photoPx('51x51');
  const grid = gridLayout({ sheetW: sheet.w, sheetH: sheet.h, photoW: photo.w, photoH: photo.h });
  assert.equal(grid.cols, 2);
  assert.equal(grid.rows, 1);
  assert.equal(grid.count, 2);
});

test('falls back to a single centered cell when nothing fits', () => {
  const grid = gridLayout({ sheetW: 100, sheetH: 100, photoW: 500, photoH: 500 });
  assert.equal(grid.cols, 1);
  assert.equal(grid.rows, 1);
  assert.equal(grid.count, 1);
  assert.equal(grid.cells.length, 1);
});
