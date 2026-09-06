'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ML = require('../lib/passport-ml.js');

test('confidence mapping is a smoothstep from transparent to opaque', () => {
  const out = ML.confidenceToKeep(new Float32Array([0, 0.2, 0.4, 0.5, 0.6, 0.8, 1]));
  assert.equal(out[0], 0);
  assert.equal(out[1], 0);
  assert.equal(out[2], 0);
  assert.ok(out[3] > 100 && out[3] < 155, `midpoint should be ~127, got ${out[3]}`);
  assert.equal(out[4], 255);
  assert.equal(out[5], 255);
  assert.equal(out[6], 255);
});

test('confidence mapping is monotonic (no banding reversals)', () => {
  const conf = new Float32Array(101);
  for (let i = 0; i <= 100; i += 1) conf[i] = i / 100;
  const out = ML.confidenceToKeep(conf);
  for (let i = 1; i < out.length; i += 1) {
    assert.ok(out[i] >= out[i - 1], `dip at ${i}: ${out[i - 1]} -> ${out[i]}`);
  }
});

test('confidence mapping honors a custom window', () => {
  const out = ML.confidenceToKeep(new Float32Array([0.3, 0.45, 0.7]), 0.3, 0.7);
  assert.equal(out[0], 0);
  assert.ok(out[1] > 0 && out[1] < 255);
  assert.equal(out[2], 255);
});

test('engine module exposes the lazy segmentation API', () => {
  for (const fn of ['confidenceToKeep', 'validMaskGeometry', 'framePerson', 'extractPersonConfidence', 'tagError', 'ensureEngine', 'segmentPerson', 'dispose']) {
    assert.equal(typeof ML[fn], 'function', `missing export: ${fn}`);
  }
});

function approx(actual, expected, eps = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} != ${expected}`);
}

test('framePerson leaves a full-frame person alone', () => {
  const f = ML.framePerson({ tW: 413, tH: 531, imgW: 413, imgH: 531, box: { x0: 0, y0: 0, x1: 413, y1: 531 } });
  assert.equal(f.zoom, 1);
  assert.equal(f.panX, 0);
  assert.equal(f.panY, 0);
});

test('framePerson zooms a small centered person to fill height with headroom', () => {
  const fit = (0.92 * 413) / 400;
  const f = ML.framePerson({ tW: 413, tH: 531, imgW: 1000, imgH: 1000, box: { x0: 300, y0: 300, x1: 700, y1: 700 } });
  approx(f.zoom, fit / 0.531, 1e-9);
  approx(f.panX, 0);
  approx(f.panY, 0.04 * 531, 1e-9);
});

test('framePerson pans an off-center person into frame', () => {
  // Height binds here (300x400 box): fit = 0.88*531/400.
  const fit = (0.88 * 531) / 400;
  const f = ML.framePerson({ tW: 413, tH: 531, imgW: 1000, imgH: 1000, box: { x0: 600, y0: 300, x1: 900, y1: 700 } });
  approx(f.zoom, fit / 0.531, 1e-9);
  approx(f.panX, (1000 * fit) / 2 - 750 * fit, 1e-9);
  assert.ok(f.panX < 0, 'person right of center needs negative pan');
});

test('framePerson clamps zoom for tiny subjects and cover-floors wide ones', () => {
  const tiny = ML.framePerson({ tW: 413, tH: 531, imgW: 2000, imgH: 2000, box: { x0: 950, y0: 950, x1: 1050, y1: 1050 } });
  assert.equal(tiny.zoom, 3);
  // An 800px-wide person cannot fit 380px without uncovering: cover scale
  // wins (zoom 1) and the centered person stays centered.
  const wide = ML.framePerson({ tW: 413, tH: 531, imgW: 1000, imgH: 1000, box: { x0: 100, y0: 200, x1: 900, y1: 400 } });
  assert.equal(wide.zoom, 1);
  approx(wide.panX, 0);
});

test('mask geometry guard accepts exact buffers and rejects the rest', () => {
  const ok = new Float32Array(256 * 256);
  assert.equal(ML.validMaskGeometry(ok, 256, 256), true);
  assert.equal(ML.validMaskGeometry(new Float32Array(100), 256, 256), false);
  assert.equal(ML.validMaskGeometry(ok, 0, 256), false);
  assert.equal(ML.validMaskGeometry(ok, 256, -1), false);
  assert.equal(ML.validMaskGeometry(null, 256, 256), false);
  assert.equal(ML.validMaskGeometry(ok, NaN, 256), false);
});

function stubMask(values, w, h, float) {
  return {
    width: w,
    height: h,
    getAsFloat32Array: () => Float32Array.from(values),
    getAsUint8Array: () => Uint8Array.from(values),
    closeCalls: 0,
    close() { this.closeCalls += 1; },
    float,
  };
}

function approxEqual(actual, expected) {
  assert.equal(actual.length, expected.length, 'length mismatch');
  for (let i = 0; i < actual.length; i += 1) {
    assert.ok(Math.abs(actual[i] - expected[i]) < 1e-6, `index ${i}: ${actual[i]} != ${expected[i]}`);
  }
}

test('extraction prefers the last confidence mask (bg + person)', () => {
  const bg = stubMask([0.1, 0.1, 0.1, 0.1], 2, 2);
  const person = stubMask([0, 0.9, 0.8, 0.1], 2, 2);
  const out = ML.extractPersonConfidence({ confidenceMasks: [bg, person], categoryMask: null });
  approxEqual([...out.confidence], [0, 0.9, 0.8, 0.1]);
  assert.equal(out.width, 2);
  assert.equal(out.height, 2);
});

test('extraction accepts a single-channel person mask', () => {
  const person = stubMask([0.2, 0.7, 0.9, 0.3], 2, 2);
  const out = ML.extractPersonConfidence({ confidenceMasks: [person], categoryMask: null });
  approxEqual([...out.confidence], [0.2, 0.7, 0.9, 0.3]);
});

test('extraction falls back to the hard category mask', () => {
  const cat = stubMask([0, 1, 1, 0], 2, 2);
  const out = ML.extractPersonConfidence({ confidenceMasks: [], categoryMask: cat });
  approxEqual([...out.confidence], [0, 1, 1, 0]);
});

test('extraction returns null when no mask exists at all', () => {
  assert.equal(ML.extractPersonConfidence({ confidenceMasks: [], categoryMask: null }), null);
  assert.equal(ML.extractPersonConfidence({}), null);
  assert.equal(ML.extractPersonConfidence(null), null);
});

test('failures carry their stage tag for diagnosis', () => {
  const err = ML.tagError('model-load', new Error('fetch failed'));
  assert.ok(err.message.startsWith('[ml:model-load] '));
  assert.ok(err.message.includes('fetch failed'));
  assert.equal(err.cause.message, 'fetch failed');
});

test('unreachable engine bundle rejects with the download stage tag', async () => {
  await assert.rejects(
    () => ML.segmentPerson({ bundle: './does-not-exist-pp.mjs', wasmDir: '.', model: 'x' }, null),
    (err) => err instanceof Error && err.message.startsWith('[ml:engine-download]'),
  );
});

test('UMD attaches to window when loaded as a plain script', () => {
  const ctx = { self: {} };
  vm.createContext(ctx);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'lib', 'passport-ml.js'), 'utf8'),
    ctx,
    { filename: 'passport-ml.js' },
  );
  assert.ok(ctx.self.PassportML, 'window.PassportML missing');
  assert.equal(typeof ctx.self.PassportML.segmentPerson, 'function');
});
