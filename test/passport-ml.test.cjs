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
  for (const fn of ['confidenceToKeep', 'ensureEngine', 'segmentPerson', 'dispose']) {
    assert.equal(typeof ML[fn], 'function', `missing export: ${fn}`);
  }
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
