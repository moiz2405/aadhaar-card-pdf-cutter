// Background-swap pixel core: consensus-corner seeding + edge flood-fill.
// Single source of truth, no DOM: required by Node tests AND loaded in the
// browser via <script> (UMD wrapper). passport-photos.js calls this.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PassportBG = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function dist2(ar, ag, ab, br, bg, bb) {
    const dr = ar - br;
    const dg = ag - bg;
    const db = ab - bb;
    return dr * dr + dg * dg + db * db;
  }

  function cornerMeans(data, w, h, frac) {
    const s = Math.max(4, Math.floor(Math.min(w, h) * frac));
    const origins = [[0, 0], [w - s, 0], [0, h - s], [w - s, h - s]];
    return origins.map(([ox, oy]) => {
      let r = 0; let g = 0; let b = 0;
      for (let y = oy; y < oy + s; y += 1) {
        for (let x = ox; x < ox + s; x += 1) {
          const i = (y * w + x) * 4;
          r += data[i]; g += data[i + 1]; b += data[i + 2];
        }
      }
      const n = s * s;
      return [r / n, g / n, b / n];
    });
  }

  // Reference = the agreeing corner pair with the most support along the
  // frame border (the wall touches far more edge than clothing does).
  // Returns null when no pair agrees (cluttered scene) or the winner owns
  // too little border (no trustworthy background) — callers keep original.
  function pickReference(data, w, h, means, tol) {
    const tol2 = 3 * tol * tol;
    const near = (idx, ref) => dist2(
      data[idx * 4], data[idx * 4 + 1], data[idx * 4 + 2],
      ref[0], ref[1], ref[2],
    ) <= tol2;
    const borderCount = 2 * w + 2 * h - 4;
    let best = null;
    for (let a = 0; a < means.length; a += 1) {
      for (let b = a + 1; b < means.length; b += 1) {
        const m1 = means[a];
        const m2 = means[b];
        if (dist2(m1[0], m1[1], m1[2], m2[0], m2[1], m2[2]) > 6.25 * tol * tol) continue;
        const ref = [(m1[0] + m2[0]) / 2, (m1[1] + m2[1]) / 2, (m1[2] + m2[2]) / 2];
        let support = 0;
        for (let x = 0; x < w; x += 1) {
          if (near(x, ref)) support += 1;
          if (near((h - 1) * w + x, ref)) support += 1;
        }
        for (let y = 1; y < h - 1; y += 1) {
          if (near(y * w, ref)) support += 1;
          if (near(y * w + (w - 1), ref)) support += 1;
        }
        if (!best || support > best.support) best = { ref, support };
      }
    }
    if (!best || best.support < 0.1 * borderCount) return null;
    return best.ref;
  }

  // Flood-fill the background: seeds are border pixels near the reference
  // color only (never the whole border — clothing often touches the frame),
  // then local-similarity BFS handles wall shading gradients.
  // Returns { mask (1=bg), ref, aborted, bgFraction }.
  function detectBackground(data, w, h, opts) {
    const { tol = 24, patchFrac = 0.06 } = opts || {};
    const tol2 = 3 * tol * tol;
    const n = w * h;
    const ref = pickReference(data, w, h, cornerMeans(data, w, h, patchFrac), tol);
    const empty = { mask: new Uint8Array(n), ref: null, aborted: true, bgFraction: 0 };
    if (!ref) return empty;

    const isBg = new Uint8Array(n);
    const queue = new Int32Array(n);
    let head = 0; let tail = 0;
    const nearRef = (idx) => dist2(
      data[idx * 4], data[idx * 4 + 1], data[idx * 4 + 2],
      ref[0], ref[1], ref[2],
    ) <= tol2;
    const push = (idx) => {
      if (!isBg[idx]) { isBg[idx] = 1; queue[tail++] = idx; }
    };
    for (let x = 0; x < w; x += 1) {
      if (nearRef(x)) push(x);
      if (nearRef((h - 1) * w + x)) push((h - 1) * w + x);
    }
    for (let y = 0; y < h; y += 1) {
      if (nearRef(y * w)) push(y * w);
      if (nearRef(y * w + (w - 1))) push(y * w + (w - 1));
    }

    const tryGrow = (next, cr, cg, cb) => {
      if (isBg[next]) return;
      const dr = data[next * 4] - cr;
      const dg = data[next * 4 + 1] - cg;
      const db = data[next * 4 + 2] - cb;
      if (dr * dr + dg * dg + db * db <= tol2) push(next);
    };
    while (head < tail) {
      const cur = queue[head++];
      const cx = cur % w;
      const cy = (cur / w) | 0;
      const cr = data[cur * 4]; const cg = data[cur * 4 + 1]; const cb = data[cur * 4 + 2];
      if (cx > 0) tryGrow(cur - 1, cr, cg, cb);
      if (cx < w - 1) tryGrow(cur + 1, cr, cg, cb);
      if (cy > 0) tryGrow(cur - w, cr, cg, cb);
      if (cy < h - 1) tryGrow(cur + w, cr, cg, cb);
    }

    let bgCount = 0;
    for (let i = 0; i < n; i += 1) bgCount += isBg[i];
    return { mask: isBg, ref, aborted: false, bgFraction: bgCount / n };
  }

  // Separable sliding-window box blur over a bg mask.
  // Returns soft keep-map 0..255 (255 = definitely person).
  function featherMask(mask, w, h, radius, passes) {
    const r = radius === undefined ? 2 : radius;
    const p = passes === undefined ? 2 : passes;
    let src = new Float64Array(mask.length);
    for (let i = 0; i < mask.length; i += 1) src[i] = mask[i] ? 0 : 255;
    let dst = new Float64Array(mask.length);
    const win = 2 * r + 1;
    for (let pass = 0; pass < p; pass += 1) {
      for (let y = 0; y < h; y += 1) {
        let acc = 0;
        for (let x = -r; x <= r; x += 1) acc += src[y * w + Math.max(0, Math.min(w - 1, x))];
        for (let x = 0; x < w; x += 1) {
          dst[y * w + x] = acc / win;
          acc += src[y * w + Math.max(0, Math.min(w - 1, x + r + 1))]
            - src[y * w + Math.max(0, Math.min(w - 1, x - r))];
        }
      }
      for (let x = 0; x < w; x += 1) {
        let acc = 0;
        for (let y = -r; y <= r; y += 1) acc += dst[Math.max(0, Math.min(h - 1, y)) * w + x];
        for (let y = 0; y < h; y += 1) {
          src[y * w + x] = acc / win;
          acc += dst[Math.max(0, Math.min(h - 1, y + r + 1)) * w + x]
            - dst[Math.max(0, Math.min(h - 1, y - r)) * w + x];
        }
      }
    }
    const out = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i += 1) out[i] = Math.max(0, Math.min(255, Math.round(src[i])));
    return out;
  }

  function hexToRgb(hex) {
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
  }

  // Composite data over hexColor wherever soft keep-map < 255.
  // Returns a new Uint8ClampedArray (input untouched).
  function compositeOver(data, w, h, soft, hex) {
    const [bgR, bgG, bgB] = hexToRgb(hex);
    const out = new Uint8ClampedArray(data.length);
    for (let i = 0, n = w * h; i < n; i += 1) {
      const keep = soft[i] / 255;
      out[i * 4] = data[i * 4] * keep + bgR * (1 - keep);
      out[i * 4 + 1] = data[i * 4 + 1] * keep + bgG * (1 - keep);
      out[i * 4 + 2] = data[i * 4 + 2] * keep + bgB * (1 - keep);
      out[i * 4 + 3] = 255;
    }
    return out;
  }

  return {
    cornerMeans,
    pickReference,
    detectBackground,
    featherMask,
    compositeOver,
    hexToRgb,
  };
}));
