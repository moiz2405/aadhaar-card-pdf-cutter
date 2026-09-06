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
  for (const fn of ['confidenceToKeep', 'validMaskGeometry', 'extractPersonConfidence', 'tagError', 'ensureEngine', 'segmentPerson', 'dispose']) {
    assert.equal(typeof ML[fn], 'function', `missing export: ${fn}`);
  }
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
