'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectBackground,
  featherMask,
  compositeOver,
} = require('../lib/passport-bg.js');

const W = 413;
const H = 531;

// Deterministic PRNG so the proxies are stable run to run.
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Builds a portrait proxy: wall bg (+vertical gradient + noise), dark hair
// cap up top (never touching corners), skin-tone face ellipse, striped
// shirt filling the bottom (touching left/right/bottom borders AND the
// bottom corners — exactly the hard part of the reported photo).
// Returns { data, person } where person[i] = 1 for face/hair/shirt pixels.
function genProxy({ wallTop, wallBottom, skin, hair, stripes }) {
  const rand = mulberry32(42);
  const data = new Uint8ClampedArray(W * H * 4);
  const person = new Uint8Array(W * H);
  const noise = () => (rand() - 0.5) * 8;
  for (let y = 0; y < H; y += 1) {
    const t = y / (H - 1);
    const wr = wallTop[0] + (wallBottom[0] - wallTop[0]) * t;
    const wg = wallTop[1] + (wallBottom[1] - wallTop[1]) * t;
    const wb = wallTop[2] + (wallBottom[2] - wallTop[2]) * t;
    for (let x = 0; x < W; x += 1) {
      const i = y * W + x;
      // Shirt: bottom band, full width, horizontal stripes.
      if (y >= 400) {
        const stripe = Math.floor((y - 400) / 18) % 2 === 0 ? stripes[0] : stripes[1];
        data[i * 4] = stripe[0] + noise();
        data[i * 4 + 1] = stripe[1] + noise();
        data[i * 4 + 2] = stripe[2] + noise();
        data[i * 4 + 3] = 255;
        person[i] = 1;
        continue;
      }
      // Hair: rounded cap, top center, clear of the corners.
      const hx = (x - W / 2) / 120;
      const hy = (y - 60) / 110;
      if (hx * hx + hy * hy < 1 && y < 170) {
        data[i * 4] = hair[0] + noise();
        data[i * 4 + 1] = hair[1] + noise();
        data[i * 4 + 2] = hair[2] + noise();
        data[i * 4 + 3] = 255;
        person[i] = 1;
        continue;
      }
      // Face ellipse overlapping the hair.
      const fx = (x - W / 2) / 105;
      const fy = (y - 300) / 140;
      if (fx * fx + fy * fy < 1) {
        data[i * 4] = skin[0] + noise();
        data[i * 4 + 1] = skin[1] + noise();
        data[i * 4 + 2] = skin[2] + noise();
        data[i * 4 + 3] = 255;
        person[i] = 1;
        continue;
      }
      data[i * 4] = wr + noise();
      data[i * 4 + 1] = wg + noise();
      data[i * 4 + 2] = wb + noise();
      data[i * 4 + 3] = 255;
    }
  }
  return { data, person };
}

function metrics(mask, person) {
  let personTotal = 0; let personKept = 0;
  let bgTotal = 0; let bgFound = 0;
  for (let i = 0; i < person.length; i += 1) {
    if (person[i]) {
      personTotal += 1;
      if (!mask[i]) personKept += 1;
    } else {
      bgTotal += 1;
      if (mask[i]) bgFound += 1;
    }
  }
  return { keep: personKept / personTotal, recall: bgFound / bgTotal };
}

const SKIN = [226, 180, 152];
const HAIR = [28, 24, 22];
const STRIPES = [[238, 202, 96], [148, 153, 158]];

for (const tol of [16, 24, 32, 48]) {
  test(`white-wall portrait holds up at tolerance ${tol}`, () => {
    const { data, person } = genProxy({
      wallTop: [248, 248, 248], wallBottom: [240, 240, 240],
      skin: SKIN, hair: HAIR, stripes: STRIPES,
    });
    const res = detectBackground(data, W, H, { tol });
    const m = metrics(res.mask, person);
    console.log(`tol=${tol} aborted=${res.aborted} keep=${m.keep.toFixed(4)} recall=${m.recall.toFixed(4)} bgFrac=${res.bgFraction.toFixed(3)}`);
    assert.equal(res.aborted, false);
    assert.ok(m.keep >= 0.97, `person preservation too low: ${m.keep}`);
    assert.ok(m.recall >= 0.85, `background recall too low: ${m.recall}`);
  });
}

for (const tol of [16, 24, 32, 48]) {
  test(`blue-wall portrait holds up at tolerance ${tol}`, () => {
    const { data, person } = genProxy({
      wallTop: [112, 148, 196], wallBottom: [104, 140, 188],
      skin: SKIN, hair: HAIR, stripes: STRIPES,
    });
    const res = detectBackground(data, W, H, { tol });
    const m = metrics(res.mask, person);
    console.log(`blue tol=${tol} aborted=${res.aborted} keep=${m.keep.toFixed(4)} recall=${m.recall.toFixed(4)}`);
    assert.equal(res.aborted, false);
    if (tol <= 24) {
      assert.ok(m.keep >= 0.97, `person preservation too low: ${m.keep}`);
      assert.ok(m.recall >= 0.85, `background recall too low: ${m.recall}`);
    }
  });
}

test('cluttered corners abort gracefully instead of recoloring the person', () => {
  const { data } = genProxy({
    wallTop: [248, 248, 248], wallBottom: [240, 240, 240],
    skin: SKIN, hair: HAIR, stripes: STRIPES,
  });
  // Splatter the four corners with unrelated colors.
  const paint = (ox, oy, c) => {
    for (let y = oy; y < oy + 30; y += 1) {
      for (let x = ox; x < ox + 30; x += 1) {
        const i = (y * W + x) * 4;
        data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
      }
    }
  };
  paint(0, 0, [200, 30, 30]);
  paint(W - 30, 0, [30, 160, 30]);
  paint(0, H - 30, [30, 30, 200]);
  paint(W - 30, H - 30, [200, 200, 30]);
  const res = detectBackground(data, W, H, { tol: 32 });
  assert.equal(res.aborted, true);
  assert.equal(res.bgFraction, 0);
});

test('feather keeps uniform areas, composite paints only the mask', () => {
  const w = 32; const h = 32;
  const mask = new Uint8Array(w * h).fill(1);
  for (let y = 12; y < 21; y += 1) {
    for (let x = 12; x < 21; x += 1) mask[y * w + x] = 0; // 9x9 person block
  }
  const soft = featherMask(mask, w, h, 2, 2);
  assert.equal(soft[0], 0); // far bg corner stays background
  assert.ok(soft[16 * w + 16] > 200); // deep inside the block stays person
  const data = new Uint8ClampedArray(w * h * 4).fill(100);
  const out = compositeOver(data, w, h, soft, '#FF0000');
  assert.equal(out[0], 255); // bg corner painted red
  assert.equal(out[1], 0);
  assert.ok(Math.abs(out[(16 * w + 16) * 4] - 100) < 30); // person pixel ~untouched
});
