'use strict';

/* ------------------------------------------------------------------ *
 *  Passport Photos — upload, frame, clean, recolor, 8-up print sheet
 *  All client-side. Layout constants mirror lib/passport-layout.cjs,
 *  which is the tested spec for the same math.
 * ------------------------------------------------------------------ */

const PP_DPI = 300;
const PP_MM_PER_INCH = 25.4;
const mmToPx = (mm) => Math.max(1, Math.round((mm / PP_MM_PER_INCH) * PP_DPI));
const mmToPt = (mm) => (mm / PP_MM_PER_INCH) * 72;

const PRESETS = {
  '35x45': { wMm: 35, hMm: 45, label: '35 × 45 mm' },
  '51x51': { wMm: 51, hMm: 51, label: '51 × 51 mm' },
};
const SHEET = { wIn: 6, hIn: 4, label: '4 × 6 in' }; // landscape
const BG_COLORS = { red: '#E53935', white: '#FFFFFF', blue: '#1E5AA8' };
const MAX_WORK_DIM = 2000; // editing resolution cap; still far above print needs

const $ = (id) => document.getElementById(id);

const dropzone = $('pp-dropzone');
const fileInput = $('pp-file');
const stageWrap = $('pp-stage-wrap');
const stage = $('pp-stage');
const canvas = $('pp-canvas');
const gridCanvasEl = $('pp-grid-canvas');
const toast = $('pp-toast');
const statusEl = $('pp-status');
const countEl = $('pp-count');
const zoomInput = $('pp-zoom');
const zoomVal = $('pp-zoom-val');
const autoBtn = $('pp-auto');
const compareBtn = $('pp-compare');
const resetBtn = $('pp-reset');
const brightInput = $('pp-bright');
const contrastInput = $('pp-contrast');
const satInput = $('pp-sat');
const customColor = $('pp-bg-custom');
const sizePills = [...document.querySelectorAll('#pp-size-selector .doc-chip')];
const swatches = [...document.querySelectorAll('.pp-sw[data-bg]')];
const exportBtns = [$('pp-grid-png'), $('pp-grid-pdf'), $('pp-single-png'), $('pp-single-pdf')];

/* ---------------- State ---------------- */
let srcFile = null;      // current File (cache key)
let srcImg = null;       // { bmp, w, h } decoded + downscaled work image
let fileName = 'passport';
let preset = '35x45';
let view = { zoom: 1, panX: 0, panY: 0 }; // pan in target px
let enhance = { auto: true, bright: 100, contrast: 100, sat: 100 };
let bg = { mode: 'red', custom: '#E53935' };
let comparing = false;
let autoCache = { file: null, canvas: null };
let photoCanvas = null;  // final single photo at print px
let sheetCanvas = null;  // final 300 DPI grid
let sheetLayout = null;
let renderQueued = false;
let toastTimer = null;

// Smart cut-out state. The ML mask is computed once per photo at a capped
// resolution, then re-framed per render with the same pan/zoom math as the
// photo itself, so mask and image can never drift apart.
const mlState = { key: null, maskCanvas: null, maskDims: null, failed: false };
let mlPromise = null;
let autoFramedKey = null;

function resetMLState() {
  mlState.key = null; mlState.maskCanvas = null; mlState.maskDims = null; mlState.failed = false;
  autoFramedKey = null;
}

// Fits the segmented person in frame (height-first with headroom) exactly
// once per photo: runs after the first ML mask arrives, never fights the
// user's own pan/zoom afterwards.
function autoFrameFromMask() {
  const mc = mlState.maskCanvas;
  if (!mc || !window.PassportML || !srcImg) return;
  const mw = mc.width;
  const mh = mc.height;
  const d = mc.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, mw, mh).data;
  let x0 = mw; let y0 = mh; let x1 = -1; let y1 = -1;
  for (let y = 0; y < mh; y += 1) {
    for (let x = 0; x < mw; x += 1) {
      if (d[(y * mw + x) * 4] > 127) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return; // empty mask: keep centered cover
  const k = srcImg.w / mw;
  const t = targetDims();
  const f = window.PassportML.framePerson({
    tW: t.w, tH: t.h, imgW: srcImg.w, imgH: srcImg.h,
    box: { x0: x0 * k, y0: y0 * k, x1: x1 * k, y1: y1 * k },
  });
  view.zoom = f.zoom; view.panX = f.panX; view.panY = f.panY;
  zoomInput.value = String(Math.round(f.zoom * 100));
  zoomVal.textContent = Math.round(f.zoom * 100) + '%';
}

function mlPaths() {
  // NOTE: dynamic import() resolves relative to THIS script file's URL
  // (lib/), while fetch() resolves against the document. Root-absolute
  // paths are correct for both, on any domain or page.
  return {
    bundle: '/vendor/mediapipe/vision_bundle.mjs',
    wasmDir: '/vendor/mediapipe/wasm',
    model: '/vendor/mediapipe/selfie_segmenter.tflite',
  };
}

function showToast(message, duration = 3000) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), duration);
}

function baseName() {
  return fileName.replace(/\.[a-z0-9]+$/i, '').replace(/[^\w\-]+/g, '_') || 'passport';
}

function targetDims() {
  const p = PRESETS[preset];
  return { w: mmToPx(p.wMm), h: mmToPx(p.hMm) };
}

/* ---------------- Upload ---------------- */
function setControlsEnabled(on) {
  [autoBtn, compareBtn, resetBtn, brightInput, contrastInput, satInput,
    zoomInput, customColor, ...swatches, ...exportBtns,
  ].forEach((el) => { el.disabled = !on; });
  if (!on) {
    comparing = false;
    compareBtn.setAttribute('aria-pressed', 'false');
    compareBtn.classList.remove('active');
    resetMLState();
  }
}

function updateUI() {
  const ready = Boolean(srcImg);
  setControlsEnabled(ready);
  stageWrap.classList.toggle('hidden', !ready);
  if (!ready) {
    countEl.textContent = 'Upload a photo to build the sheet.';
    statusEl.textContent = '';
  }
}

async function decodeFile(file) {
  try {
    if ('createImageBitmap' in window) {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { bmp, w: bmp.width, h: bmp.height };
    }
  } catch { /* fall through to <img> path */ }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ bmp: img, w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not decode that image.'));
    };
    img.src = url;
  });
}

function downscaleToWork(decoded) {
  const scale = Math.min(1, MAX_WORK_DIM / Math.max(decoded.w, decoded.h));
  const w = Math.max(1, Math.round(decoded.w * scale));
  const h = Math.max(1, Math.round(decoded.h * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(decoded.bmp, 0, 0, w, h);
  if (decoded.bmp.close) { try { decoded.bmp.close(); } catch { /* ignore */ } }
  return { bmp: c, w, h };
}

async function onFileSelected(file) {
  if (!file) return;
  const okType = file.type.startsWith('image/') || /\.(jpe?g|png|webp)$/i.test(file.name);
  if (!okType) {
    showToast('Please choose an image file (JPG, PNG, WebP).');
    fileInput.value = '';
    return;
  }
  try {
    showToast('Loading photo…', 1500);
    const decoded = await decodeFile(file);
    if (!decoded.w || !decoded.h) throw new Error('Could not decode that image.');
    srcFile = file;
    srcImg = downscaleToWork(decoded);
    autoCache = { file: null, canvas: null };
    resetMLState();
    fileName = file.name || 'passport';
    view = { zoom: 1, panX: 0, panY: 0 };
    enhance = { auto: true, bright: 100, contrast: 100, sat: 100 };
    comparing = false;
    autoBtn.classList.add('active');
    autoBtn.setAttribute('aria-pressed', 'true');
    zoomInput.value = '100';
    zoomVal.textContent = '100%';
    for (const [input, def] of [[brightInput, 100], [contrastInput, 100], [satInput, 100]]) {
      input.value = String(def);
      input.closest('.pp-slider').querySelector('.pp-val').textContent = def + '%';
    }
    const t = targetDims();
    if (Math.min(srcImg.w, srcImg.h) < Math.min(t.w, t.h)) {
      showToast('Low-resolution photo — prints may look soft. A larger original is better.', 4500);
    }
    updateUI();
    renderAll();
  } catch (err) {
    fileInput.value = '';
    showToast(err && err.message ? err.message : 'Could not load that image.', 4000);
  }
}

fileInput.addEventListener('change', () => onFileSelected(fileInput.files[0]));
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
['dragover', 'dragenter'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) onFileSelected(file);
});

$('pp-start-over').addEventListener('click', () => {
  srcFile = null; srcImg = null;
  resetMLState();
  photoCanvas = null; sheetCanvas = null; sheetLayout = null;
  autoCache = { file: null, canvas: null };
  fileInput.value = '';
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const gtx = gridCanvasEl.getContext('2d');
  gtx.clearRect(0, 0, gridCanvasEl.width, gridCanvasEl.height);
  updateUI();
  showToast('Cleared. Choose another photo to begin again.');
});

sizePills.forEach((pill) => {
  pill.addEventListener('click', () => {
    sizePills.forEach((p) => { p.classList.remove('active'); p.setAttribute('aria-checked', 'false'); });
    pill.classList.add('active');
    pill.setAttribute('aria-checked', 'true');
    preset = pill.dataset.size;
    view.panX = 0; view.panY = 0; view.zoom = 1;
    autoFramedKey = null;
    zoomInput.value = '100';
    zoomVal.textContent = '100%';
    renderAll();
  });
});

/* ---------------- Cover-fit framing ---------------- */
function coverDrawRaw(targetCtx, source, tW, tH) {
  const iw = source.w || source.width;
  const ih = source.h || source.height;
  const s0 = Math.max(tW / iw, tH / ih);
  const s = s0 * view.zoom;
  const dw = iw * s;
  const dh = ih * s;
  const mx = Math.max(0, (dw - tW) / 2);
  const my = Math.max(0, (dh - tH) / 2);
  view.panX = Math.max(-mx, Math.min(mx, view.panX));
  view.panY = Math.max(-my, Math.min(my, view.panY));
  targetCtx.drawImage(source.bmp || source, (tW - dw) / 2 + view.panX, (tH - dh) / 2 + view.panY, dw, dh);
}

zoomInput.addEventListener('input', () => {
  view.zoom = Number(zoomInput.value) / 100;
  zoomVal.textContent = zoomInput.value + '%';
  scheduleRender();
});

let panning = null;
stage.addEventListener('pointerdown', (e) => {
  if (!srcImg) return;
  panning = { x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY };
  stage.setPointerCapture(e.pointerId);
  e.preventDefault();
});
stage.addEventListener('pointermove', (e) => {
  if (!panning) return;
  const r = canvas.getBoundingClientRect();
  const t = targetDims();
  const sx = t.w / r.width;
  const sy = t.h / r.height;
  view.panX = panning.panX + (e.clientX - panning.x) * sx;
  view.panY = panning.panY + (e.clientY - panning.y) * sy;
  scheduleRender();
});
for (const ev of ['pointerup', 'pointercancel']) {
  stage.addEventListener(ev, () => { panning = null; });
}

/* ---------------- Clearing (auto-fix + sliders) ---------------- */
function getAutoCanvas() {
  if (autoCache.file === srcFile && autoCache.canvas) return autoCache.canvas;
  const w = srcImg.w;
  const h = srcImg.h;
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const tctx = tmp.getContext('2d', { willReadFrequently: true });
  tctx.drawImage(srcImg.bmp, 0, 0);
  const img = tctx.getImageData(0, 0, w, h);
  const d = img.data;
  const n = w * h;

  let rMean = 0; let gMean = 0; let bMean = 0;
  const lum = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const r = d[i * 4]; const g = d[i * 4 + 1]; const b = d[i * 4 + 2];
    rMean += r; gMean += g; bMean += b;
    lum[i] = (r * 77 + g * 150 + b * 29) >> 8;
  }
  rMean /= n; gMean /= n; bMean /= n;
  const gray = (rMean + gMean + bMean) / 3 || 1;
  // Gentle gray-world white balance (±12% max shift).
  const clampGain = (v) => Math.max(0.88, Math.min(1.12, v));
  const rGain = clampGain(gray / (rMean || 1));
  const gGain = clampGain(gray / (gMean || 1));
  const bGain = clampGain(gray / (bMean || 1));

  // 1st/99th percentile levels from a 64-bin luminance histogram.
  const bins = new Uint32Array(64);
  for (let i = 0; i < n; i += 1) bins[lum[i] >> 2] += 1;
  const loTarget = n * 0.01;
  const hiTarget = n * 0.99;
  let acc = 0; let lo = 0; let hi = 255;
  for (let b = 0; b < 64; b += 1) {
    acc += bins[b];
    if (acc >= loTarget && lo === 0) lo = b * 4;
    if (acc >= hiTarget) { hi = Math.min(255, b * 4 + 3); break; }
  }
  if (hi - lo < 24) { lo = 0; hi = 255; } // already contrasty: don't touch
  const span = Math.max(1, hi - lo);

  const lutR = new Uint8ClampedArray(256);
  const lutG = new Uint8ClampedArray(256);
  const lutB = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v += 1) {
    lutR[v] = ((v * rGain - lo) * 255) / span;
    lutG[v] = ((v * gGain - lo) * 255) / span;
    lutB[v] = ((v * bGain - lo) * 255) / span;
  }
  for (let i = 0; i < n; i += 1) {
    d[i * 4] = lutR[d[i * 4]];
    d[i * 4 + 1] = lutG[d[i * 4 + 1]];
    d[i * 4 + 2] = lutB[d[i * 4 + 2]];
  }
  tctx.putImageData(img, 0, 0);

  // Mild unsharp mask: blurred copy via canvas filter, blend back 35%.
  const blurC = document.createElement('canvas');
  blurC.width = w; blurC.height = h;
  const bctx = blurC.getContext('2d');
  bctx.filter = 'blur(2px)';
  bctx.drawImage(tmp, 0, 0);
  let blurImg;
  try {
    blurImg = bctx.getImageData(0, 0, w, h);
  } catch {
    blurImg = null; // filter unsupported: keep levels-only result
  }
  if (blurImg) {
    const sharp = tctx.getImageData(0, 0, w, h);
    const sd = sharp.data;
    const bd = blurImg.data;
    for (let i = 0; i < n; i += 1) {
      for (let k = 0; k < 3; k += 1) {
        const idx = i * 4 + k;
        sd[idx] = sd[idx] + (sd[idx] - bd[idx]) * 0.35;
      }
    }
    tctx.putImageData(sharp, 0, 0);
  }
  autoCache = { file: srcFile, canvas: tmp };
  return tmp;
}

function sliderFilter() {
  return `brightness(${enhance.bright}%) contrast(${enhance.contrast}%) saturate(${enhance.sat}%)`;
}

autoBtn.addEventListener('click', () => {
  enhance.auto = !enhance.auto;
  autoBtn.classList.toggle('active', enhance.auto);
  autoBtn.setAttribute('aria-pressed', String(enhance.auto));
  renderAll();
  showToast(enhance.auto ? 'Auto-fix applied.' : 'Auto-fix removed.');
});

compareBtn.addEventListener('click', () => {
  comparing = !comparing;
  compareBtn.classList.toggle('active', comparing);
  compareBtn.setAttribute('aria-pressed', String(comparing));
  renderAll();
});

resetBtn.addEventListener('click', () => {
  enhance = { auto: true, bright: 100, contrast: 100, sat: 100 };
  comparing = false;
  compareBtn.classList.remove('active');
  compareBtn.setAttribute('aria-pressed', 'false');
  autoBtn.classList.add('active');
  autoBtn.setAttribute('aria-pressed', 'true');
  for (const [input, def] of [[brightInput, 100], [contrastInput, 100], [satInput, 100]]) {
    input.value = String(def);
    input.closest('.pp-slider').querySelector('.pp-val').textContent = def + '%';
  }
  renderAll();
  showToast('Enhancements reset.');
});

for (const [input, key] of [[brightInput, 'bright'], [contrastInput, 'contrast'], [satInput, 'sat']]) {
  input.addEventListener('input', () => {
    enhance[key] = Number(input.value);
    input.closest('.pp-slider').querySelector('.pp-val').textContent = input.value + '%';
    scheduleRender();
  });
}

/* ---------------- Background swap (AI cut-out) ---------------- */
function bgSwap(targetCanvas, hexColor) {
  // ML mask or nothing: without a usable cut-out the original photo stays.
  if (!mlMaskReady()) return;
  applyMLMask(targetCanvas, hexColor);
}

// Runs portrait segmentation once per photo and caches a keep-map canvas.
// Mask detail beyond 800px is wasted (the model sees 256x256), so the cache
// stays small no matter how large the upload is.
async function ensureMLMask() {
  if (mlState.key === srcFile && mlState.maskCanvas) return true;
  if (!window.PassportML) throw new Error('Background AI failed to load.');
  const { confidence, width, height } = await window.PassportML.segmentPerson(mlPaths(), srcImg.bmp);
  // Geometry guard: a scrambled buffer must fall back, never render.
  if (!window.PassportML.validMaskGeometry(confidence, width, height)) {
    throw new Error(
      `Background AI returned an unusable mask (${confidence ? confidence.length : 0} values for ${width}x${height}).`,
    );
  }
  const keep = window.PassportML.confidenceToKeep(confidence);
  const small = document.createElement('canvas');
  small.width = width; small.height = height;
  const sctx = small.getContext('2d');
  const sImg = sctx.createImageData(width, height);
  for (let i = 0; i < keep.length; i += 1) {
    sImg.data[i * 4] = keep[i];
    sImg.data[i * 4 + 1] = keep[i];
    sImg.data[i * 4 + 2] = keep[i];
    sImg.data[i * 4 + 3] = 255;
  }
  sctx.putImageData(sImg, 0, 0);
  const scale = Math.min(1, 800 / Math.max(srcImg.w, srcImg.h));
  const mw = Math.max(1, Math.round(srcImg.w * scale));
  const mh = Math.max(1, Math.round(srcImg.h * scale));
  const mc = document.createElement('canvas');
  mc.width = mw; mc.height = mh;
  const mctx = mc.getContext('2d');
  mctx.imageSmoothingEnabled = true;
  mctx.imageSmoothingQuality = 'high';
  mctx.drawImage(small, 0, 0, mw, mh);
  mlState.key = srcFile;
  mlState.maskCanvas = mc;
  mlState.maskDims = { w: width, h: height };
  mlState.failed = false;
  return true;
}

function mlMaskReady() {
  return Boolean(mlState.key === srcFile && mlState.maskCanvas && !mlState.failed);
}

// Applies the cached ML mask with the identical cover transform as the
// photo, so mask and image stay aligned under any pan/zoom.
function applyMLMask(targetCanvas, hexColor) {
  const w = targetCanvas.width;
  const h = targetCanvas.height;
  const t = document.createElement('canvas');
  t.width = w; t.height = h;
  const tctx = t.getContext('2d', { willReadFrequently: true });
  coverDrawRaw(tctx, mlState.maskCanvas, w, h);
  const pixels = tctx.getImageData(0, 0, w, h).data;
  const soft = new Uint8Array(w * h);
  for (let i = 0; i < soft.length; i += 1) soft[i] = pixels[i * 4];
  const tctx2 = targetCanvas.getContext('2d', { willReadFrequently: true });
  const img = tctx2.getImageData(0, 0, w, h);
  const d = img.data;
  const bgR = parseInt(hexColor.slice(1, 3), 16);
  const bgG = parseInt(hexColor.slice(3, 5), 16);
  const bgB = parseInt(hexColor.slice(5, 7), 16);
  for (let i = 0; i < soft.length; i += 1) {
    const keep = soft[i] / 255;
    d[i * 4] = d[i * 4] * keep + bgR * (1 - keep);
    d[i * 4 + 1] = d[i * 4 + 1] * keep + bgG * (1 - keep);
    d[i * 4 + 2] = d[i * 4 + 2] * keep + bgB * (1 - keep);
    d[i * 4 + 3] = 255;
  }
  tctx2.putImageData(img, 0, 0);
}

swatches.forEach((sw) => {
  sw.addEventListener('click', () => {
    swatches.forEach((s) => { s.classList.remove('active'); s.setAttribute('aria-checked', 'false'); });
    document.querySelector('.pp-custom').classList.remove('active');
    sw.classList.add('active');
    sw.setAttribute('aria-checked', 'true');
    bg.mode = sw.dataset.bg;
    mlState.failed = false; // re-picking retries a previously failed engine
    scheduleRender();
  });
});

customColor.addEventListener('input', () => {
  bg.custom = customColor.value.toUpperCase();
  bg.mode = 'custom';
  mlState.failed = false; // re-picking retries a previously failed engine
  swatches.forEach((s) => { s.classList.remove('active'); s.setAttribute('aria-checked', 'false'); });
  document.querySelector('.pp-custom').classList.add('active');
  document.querySelector('.pp-custom').style.setProperty('--custom', bg.custom);
  scheduleRender();
});

function bgColor() {
  if (bg.mode === 'custom') return bg.custom;
  return BG_COLORS[bg.mode] || null; // null = original
}

/* ---------------- Render pipeline ---------------- */
function renderPhoto() {
  if (!srcImg) return null;
  const t = targetDims();
  const out = document.createElement('canvas');
  out.width = t.w; out.height = t.h;
  const octx = out.getContext('2d', { willReadFrequently: true });
  if (comparing) {
    coverDrawRaw(octx, srcImg, t.w, t.h);
  } else {
    const source = enhance.auto ? getAutoCanvas() : srcImg.bmp;
    const shaped = { bmp: source, w: source.width || srcImg.w, h: source.height || srcImg.h };
    if ('filter' in octx) octx.filter = sliderFilter();
    coverDrawRaw(octx, shaped, t.w, t.h);
    if ('filter' in octx) octx.filter = 'none';
    const color = bgColor();
    if (color) bgSwap(out, color);
  }
  photoCanvas = out;
  // Display 1:1 (CSS scales responsively).
  canvas.width = t.w; canvas.height = t.h;
  canvas.getContext('2d').drawImage(out, 0, 0);
  return out;
}

// Cover-fit draw against an explicit source (filter applied by the caller).
function coverDrawRaw(targetCtx, source, tW, tH) {
  const iw = source.w || source.width;
  const ih = source.h || source.height;
  const s0 = Math.max(tW / iw, tH / ih);
  const s = s0 * view.zoom;
  const dw = iw * s;
  const dh = ih * s;
  const mx = Math.max(0, (dw - tW) / 2);
  const my = Math.max(0, (dh - tH) / 2);
  view.panX = Math.max(-mx, Math.min(mx, view.panX));
  view.panY = Math.max(-my, Math.min(my, view.panY));
  targetCtx.drawImage(source.bmp || source, (tW - dw) / 2 + view.panX, (tH - dh) / 2 + view.panY, dw, dh);
}

function gridLayoutLocal(sheetW, sheetH, photoW, photoH, margin, gap) {
  const cols = Math.max(1, Math.floor((sheetW - margin * 2 + gap) / (photoW + gap)));
  const rows = Math.max(1, Math.floor((sheetH - margin * 2 + gap) / (photoH + gap)));
  const gridW = cols * photoW + (cols - 1) * gap;
  const gridH = rows * photoH + (rows - 1) * gap;
  return {
    cols, rows, count: cols * rows, gap,
    offsetX: Math.round((sheetW - gridW) / 2),
    offsetY: Math.round((sheetH - gridH) / 2),
  };
}

function renderGrid() {
  if (!photoCanvas) return null;
  const t = targetDims();
  const sheetW = Math.round(SHEET.wIn * PP_DPI);
  const sheetH = Math.round(SHEET.hIn * PP_DPI);
  const layout = gridLayoutLocal(sheetW, sheetH, t.w, t.h, 30, 10);
  const c = document.createElement('canvas');
  c.width = sheetW; c.height = sheetH;
  const gtx = c.getContext('2d');
  gtx.fillStyle = '#FFFFFF';
  gtx.fillRect(0, 0, sheetW, sheetH);
  for (let r = 0; r < layout.rows; r += 1) {
    for (let col = 0; col < layout.cols; col += 1) {
      const x = layout.offsetX + col * (t.w + layout.gap);
      const y = layout.offsetY + r * (t.h + layout.gap);
      gtx.drawImage(photoCanvas, x, y);
      gtx.strokeStyle = '#9AA0A6';
      gtx.lineWidth = 2;
      gtx.setLineDash([12, 8]);
      gtx.strokeRect(x, y, t.w, t.h);
    }
  }
  gtx.setLineDash([]);
  sheetCanvas = c;
  sheetLayout = layout;
  gridCanvasEl.width = sheetW; gridCanvasEl.height = sheetH;
  gridCanvasEl.getContext('2d').drawImage(c, 0, 0);
  countEl.textContent = `${layout.count} photo${layout.count === 1 ? '' : 's'} · ${PRESETS[preset].label} · ${SHEET.label} sheet — cut along the dashed lines.`;
  return c;
}

function bgNeeded() {
  return Boolean(srcImg) && bg.mode !== 'original';
}

function mlFailureReason(err) {
  const text = (err && err.message) || String(err || '');
  const stage = /\[ml:([a-z-]+)\]/.exec(text)?.[1];
  const detail = text.replace(/\[ml:[a-z-]+\]\s*/, '').slice(0, 140);
  const label = {
    'engine-download': 'AI code download failed',
    'runtime-download': 'AI runtime download failed',
    'model-load': 'AI model failed to start',
    segment: 'AI could not read this photo',
  }[stage || ''] || 'Background AI failed';
  return detail && detail !== label ? `${label}: ${detail}` : label;
}

async function renderAll() {
  try {
    // First render with a non-Original background prepares the AI mask
    // (one-time ~12 MB download, then cached per photo). Concurrent renders
    // share the in-flight run; a failed engine keeps the original photo.
    if (bgNeeded() && mlState.key !== srcFile && !mlState.failed && window.PassportML) {
      if (!mlPromise) {
        statusEl.textContent = 'Preparing background AI (one-time ~12 MB download)…';
        mlPromise = ensureMLMask().catch((err) => {
          console.error(err);
          mlState.failed = true;
          showToast(`${mlFailureReason(err)} — keeping the original background.`, 6000);
        }).finally(() => { mlPromise = null; });
      }
      await mlPromise;
    }
    if (mlMaskReady() && autoFramedKey !== srcFile) {
      autoFrameFromMask();
      autoFramedKey = srcFile;
    }
    renderPhoto();
    renderGrid();
    if (statusEl.textContent.startsWith('Preparing background AI')) {
      statusEl.textContent = (mlMaskReady() && mlState.maskDims)
        ? `Background AI ready (mask ${mlState.maskDims.w}×${mlState.maskDims.h}).`
        : statusEl.textContent;
    }
  } catch (err) {
    console.error(err);
    showToast('Could not update the preview: ' + (err && err.message ? err.message : 'unknown error'), 4000);
  }
}

function scheduleRender() {
  if (renderQueued || !srcImg) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderAll();
  });
}

/* ---------------- Export ---------------- */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function blobFromCanvas(c) {
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png');
  });
}

function needJsPDF() {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error('PDF library failed to load. Refresh the page and try again.');
  }
  return window.jspdf.jsPDF;
}

async function exportGridPNG() {
  if (!sheetCanvas) return;
  const blob = await blobFromCanvas(sheetCanvas);
  downloadBlob(blob, `${baseName()}_passport_${sheetLayout ? sheetLayout.count : 'sheet' }up.png`);
}

async function exportGridPDF() {
  if (!sheetCanvas) return;
  const jsPDF = needJsPDF();
  const wPt = SHEET.wIn * 72;
  const hPt = SHEET.hIn * 72;
  const doc = new jsPDF({ unit: 'pt', format: [wPt, hPt], orientation: wPt >= hPt ? 'l' : 'p' });
  doc.addImage(sheetCanvas.toDataURL('image/png'), 'PNG', 0, 0, wPt, hPt);
  doc.save(`${baseName()}_passport_${sheetLayout ? sheetLayout.count : 'sheet'}up.pdf`);
}

async function exportSinglePNG() {
  if (!photoCanvas) return;
  const blob = await blobFromCanvas(photoCanvas);
  downloadBlob(blob, baseName() + '_passport_single.png');
}

async function exportSinglePDF() {
  if (!photoCanvas) return;
  const jsPDF = needJsPDF();
  const p = PRESETS[preset];
  const wPt = mmToPt(p.wMm);
  const hPt = mmToPt(p.hMm);
  const doc = new jsPDF({ unit: 'pt', format: [wPt, hPt], orientation: wPt >= hPt ? 'l' : 'p' });
  doc.addImage(photoCanvas.toDataURL('image/png'), 'PNG', 0, 0, wPt, hPt);
  doc.save(baseName() + '_passport_single.pdf');
}

for (const [btn, fn, label] of [
  [$('pp-grid-png'), exportGridPNG, 'sheet PNG'],
  [$('pp-grid-pdf'), exportGridPDF, 'sheet PDF'],
  [$('pp-single-png'), exportSinglePNG, 'single PNG'],
  [$('pp-single-pdf'), exportSinglePDF, 'single PDF'],
]) {
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    statusEl.textContent = 'Preparing…';
    try {
      await fn();
      const n = sheetLayout ? sheetLayout.count : 0;
      statusEl.textContent = `Done! ${label} downloaded${n ? ` (${n} photos)` : ''}. Print at 100% scale.`;
      showToast(`Downloaded ${label}. Print at 100% scale (no fit-to-page).`, 4000);
    } catch (err) {
      console.error(err);
      statusEl.textContent = '';
      showToast('Export failed: ' + (err && err.message ? err.message : 'unknown error'), 4000);
    } finally {
      btn.disabled = !srcImg;
    }
  });
}

/* ---------------- Init ---------------- */
updateUI();
