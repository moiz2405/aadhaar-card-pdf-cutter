// Lazy MediaPipe portrait-segmentation engine (UMD: Node require + browser).
// Loaded on demand by passport-photos.js only when a non-Original background
// is picked, so the page stays light until then. Photos never leave the
// device; inference runs locally via WASM. Throws on any failure so callers
// can keep the original photo.
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

  // Geometry guard: the confidence buffer must exactly fill width×height.
  // Anything else means an unexpected model/format — callers must fall back
  // rather than render a scrambled mask. Pure, unit-tested.
  function validMaskGeometry(confidence, width, height) {
    return Boolean(confidence)
      && Number.isFinite(width) && Number.isFinite(height)
      && width > 0 && height > 0
      && confidence.length === width * height;
  }

  // Every failure is tagged with the stage that broke so the UI can say
  // WHAT failed (engine download / runtime download / model load / segment)
  // instead of a generic "unavailable".
  function tagError(stage, err) {
    const detail = err && err.message ? err.message : String(err);
    const tagged = new Error(`[ml:${stage}] ${detail}`);
    tagged.cause = err;
    return tagged;
  }

  async function ensureEngine(paths) {
    if (!enginePromise) {
      enginePromise = (async () => {
        let vision;
        try {
          vision = await import(paths.bundle);
        } catch (err) {
          throw tagError('engine-download', err);
        }
        let fileset;
        try {
          fileset = await vision.FilesetResolver.forVisionTasks(paths.wasmDir);
        } catch (err) {
          throw tagError('runtime-download', err);
        }
        try {
          const segmenter = await vision.ImageSegmenter.createFromOptions(fileset, {
            baseOptions: {
              modelAssetPath: paths.model,
              delegate: 'CPU',
            },
            runningMode: 'IMAGE',
            outputCategoryMask: true,
            outputConfidenceMasks: true,
          });
          return { vision, segmenter };
        } catch (err) {
          throw tagError('model-load', err);
        }
      })().catch((err) => {
        enginePromise = null; // allow a later retry
        throw err;
      });
    }
    return enginePromise;
  }

  // Pulls the person mask out of a segment() result, tolerating every shape
  // the task can return: 2-entry confidence (bg + person), single-channel
  // person confidence, or — last resort — the hard category mask (0/1).
  // Pure (stub-friendly) so it is unit-testable without WASM.
  function extractPersonConfidence(result) {
    const masks = result ? result.confidenceMasks : null;
    if (masks && masks.length > 0) {
      // Binary model: index 0 = background, index 1 = person. Single-channel
      // builds carry the person map in the only entry — either way it is last.
      const person = masks[masks.length - 1];
      return {
        confidence: Float32Array.from(person.getAsFloat32Array()),
        width: person.width,
        height: person.height,
      };
    }
    const cat = result ? result.categoryMask : null;
    if (cat) {
      const u8 = cat.getAsUint8Array();
      const confidence = new Float32Array(u8.length);
      for (let i = 0; i < u8.length; i += 1) confidence[i] = u8[i] ? 1 : 0;
      return { confidence, width: cat.width, height: cat.height };
    }
    return null;
  }

  // Segment a canvas/ImageBitmap/image and return person confidence
  // (Float32Array 0..1) plus mask dimensions. Caller upscales + composites.
  // Result buffers are copied before return (owned by the task otherwise).
  async function segmentPerson(paths, image) {
    let segmenter;
    try {
      ({ segmenter } = await ensureEngine(paths));
    } catch (err) {
      throw err; // already stage-tagged by ensureEngine
    }
    let result;
    try {
      result = segmenter.segment(image);
    } catch (err) {
      throw tagError('segment', err);
    }
    try {
      const extracted = extractPersonConfidence(result);
      if (!extracted) {
        const confCount = result && result.confidenceMasks ? result.confidenceMasks.length : -1;
        const hasCat = Boolean(result && result.categoryMask);
        throw new Error(
          `Segmentation returned no person mask (confidence entries: ${confCount}, category: ${hasCat}).`,
        );
      }
      return extracted;
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
    validMaskGeometry,
    extractPersonConfidence,
    tagError,
    ensureEngine,
    segmentPerson,
    dispose,
  };
}));
