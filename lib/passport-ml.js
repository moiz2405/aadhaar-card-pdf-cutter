// Lazy MediaPipe portrait-segmentation engine (UMD: Node require + browser).
// Loaded on demand by passport-photos.js only when a non-Original background
// is picked, so the page stays light until then. Photos never leave the
// device; inference runs locally via WASM. Throws on any failure so callers
// can cascade to the flood-fill fallback, then to the original photo.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PassportML = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  let enginePromise = null;

  // Map person-class confidence [0,1] to a keep-map 0..255 with a smoothstep
  // window. Pure (no DOM) so it is unit-testable.
  function confidenceToKeep(conf, lo, hi) {
    const low = lo === undefined ? 0.4 : lo;
    const high = hi === undefined ? 0.6 : hi;
    const span = Math.max(1e-6, high - low);
    const out = new Uint8Array(conf.length);
    for (let i = 0; i < conf.length; i += 1) {
      const t = Math.max(0, Math.min(1, (conf[i] - low) / span));
      out[i] = Math.round((t * t * (3 - 2 * t)) * 255);
    }
    return out;
  }

  async function ensureEngine(paths) {
    if (!enginePromise) {
      enginePromise = (async () => {
        const vision = await import(paths.bundle);
        const fileset = await vision.FilesetResolver.forVisionTasks(paths.wasmDir);
        const segmenter = await vision.ImageSegmenter.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: paths.model,
            delegate: 'CPU',
          },
          runningMode: 'IMAGE',
          outputCategoryMask: false,
          outputConfidenceMasks: true,
        });
        return { vision, segmenter };
      })().catch((err) => {
        enginePromise = null; // allow a later retry
        throw err;
      });
    }
    return enginePromise;
  }

  // Segment a canvas/ImageBitmap/image and return person confidence
  // (Float32Array 0..1) plus mask dimensions. Caller upscales + composites.
  // Result buffers are copied before return (owned by the task otherwise).
  async function segmentPerson(paths, image) {
    const { segmenter } = await ensureEngine(paths);
    const result = segmenter.segment(image);
    try {
      const masks = result.confidenceMasks;
      if (!masks || masks.length < 2) {
        throw new Error('Segmentation returned no person mask.');
      }
      const person = masks[1];
      const width = person.width;
      const height = person.height;
      const confidence = Float32Array.from(person.getAsFloat32Array());
      return { confidence, width, height };
    } finally {
      if (result.confidenceMasks) {
        for (const m of result.confidenceMasks) {
          try { m.close(); } catch { /* ignore */ }
        }
      }
      if (result.categoryMask) {
        try { result.categoryMask.close(); } catch { /* ignore */ }
      }
    }
  }

  function dispose() {
    if (!enginePromise) return Promise.resolve();
    const p = enginePromise;
    enginePromise = null;
    return p.then(({ segmenter }) => {
      try { segmenter.close(); } catch { /* ignore */ }
    }).catch(() => {});
  }

  return {
    confidenceToKeep,
    ensureEngine,
    segmentPerson,
    dispose,
  };
}));
