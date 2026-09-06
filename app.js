// Aadhaar Card PDF Cutter - main application logic
import * as pdfjs from './vendor/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf-worker-bootstrap.mjs', import.meta.url).toString();

/* ------------------------------------------------------------------ *
 *  DOM references
 * ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);

const stepUpload = $('step-upload');
const stepUnlock = $('step-unlock');
const stepPreview = $('step-preview');
const stepExport = $('step-export');

const dropzone = $('dropzone');
const fileInput = $('file-input');
const unlockForm = $('unlock-form');
const nameInput = $('name-input');
const yearInput = $('year-input');
const passwordInput = $('password-input');
const unlockError = $('unlock-error');
const unlockBtn = $('unlock-btn');

const pageControl = $('page-control');
const pageSelect = $('page-select');
const pageCount = $('page-count');

const canvasWrap = $('canvas-wrap');
const canvas = $('page-canvas');
const cropBox = $('crop-box');
const cropInfo = $('crop-info');
const autoDetectBtn = $('auto-detect-btn');
const resetCropBtn = $('reset-crop-btn');

const outPng = $('out-png');
const outPdf = $('out-pdf');
const downloadBtn = $('download-btn');
const exportStatus = $('export-status');
const toast = $('toast');
const startOverLink = $('start-over-link');
const docChips = document.querySelectorAll('.doc-chip');
const unlockTitle = $('unlock-title');
const unlockHint = $('unlock-hint');
const fieldName = $('field-name');
const fieldYear = $('field-year');
const fieldDob = $('field-dob');
const dobInput = $('dob-input');
const fatalError = $('fatal-error');

/* ------------------------------------------------------------------ *
 *  State
 * ------------------------------------------------------------------ */
const DEFAULT_SCALE = 3;   // pdf.js render scale (relative to 1pt = 1 CSS px)
const MAX_DIM = 4000;      // cap on rendered device-pixel dimension

let pdfDoc = null;
let pdfData = null;
let fileName = 'aadhaar';
let currentPage = 1;
let currentScale = DEFAULT_SCALE;
let viewport = null;       // CSS-pixel size of the page at currentScale
let pixelScale = 1;        // device px per CSS px (dpr), canvas.width / viewport.width

let crop = null; // { x, y, w, h } in CSS px (matches the displayed page)
let docType = 'aadhaar';
const DOC_SCHEMES = {
  aadhaar: { name: 'Aadhaar', password: 'name+year', fields: ['name','year'], hint: 'First 4 letters of name (UPPER) + birth year, e.g. RAJE1990' },
  pan: { name: 'PAN', password: 'dob', fields: ['dob'], hint: 'Date of birth in DDMMYYYY format, e.g. 15051990' },
  epic: { name: 'Voter ID', password: 'name+year|dob', fields: ['name','year','dob'], hint: 'Try first 4 letters (UPPER) + birth year, or DOB in DDMMYYYY' },
  dl: { name: 'Driving License', password: 'manual', fields: [], hint: 'Usually not password-protected. Enter manually if needed.' },
  passport: { name: 'Passport', password: 'manual', fields: [], hint: 'Usually not password-protected. Enter manually if needed.' },
  generic: { name: 'Generic', password: 'manual', fields: [], hint: 'Enter password manually if the PDF is locked.' }
};

/* ------------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------------ */
function showToast(msg, ms = 2600) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), ms);
}

function showStep(step) {
  [stepUpload, stepUnlock, stepPreview, stepExport].forEach((s) => s.classList.remove('active'));
  step.classList.add('active');

  // Drive the header stepper: mark previous steps "done", current "active".
  const order = [stepUpload, stepUnlock, stepPreview, stepExport];
  const idx = order.indexOf(step);
  document.querySelectorAll('.step-indicator').forEach((el) => {
    el.classList.remove('done', 'active');
    const i = order.findIndex((s) => s.dataset.step === el.dataset.step);
    if (i < idx) el.classList.add('done');
    else if (i === idx) el.classList.add('active');
  });
}

function baseName() {
  return fileName.replace(/\.pdf$/i, '').replace(/[^\w\-]+/g, '_') || 'aadhaar';
}
function resetUnlockForm() {
  nameInput.value = '';
  yearInput.value = '';
  dobInput.value = '';
  passwordInput.value = '';
  unlockError.textContent = '';
  unlockError.classList.add('hidden');
  unlockBtn.disabled = false;
}


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

/* ------------------------------------------------------------------ *
 *  Upload
 * ------------------------------------------------------------------ */
function onFileSelected(file) {
  if (!file) return;
  const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
  const isImage = /\.(jpe?g|png|webp)$/i.test(file.name) || file.type.startsWith('image/');
  if (!isPdf && !isImage) {
    showToast('Please choose a PDF or image file (JPG, PNG, WebP).');
    fileInput.value = '';
    return;
  }
  fileName = file.name;
  crop = null;
  currentPage = 1;
  resetUnlockForm();
  updateCropUI();
  if (isPdf) {
    const reader = new FileReader();
    reader.onload = async () => {
      pdfData = reader.result;
      pdfDoc = null;
      await openPdf();
    };
    reader.onerror = () => { fileInput.value = ''; showToast('Could not read the PDF.'); };
    reader.readAsArrayBuffer(file);
  } else {
    loadImage(file);
  }
}

async function loadImage(file) {
  showToast('Loading image…', 1500);
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = 'auto';
    viewport = { width: w, height: h };
    pixelScale = canvas.width / viewport.width;
    currentScale = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.scale(pixelScale, pixelScale);
    ctx.drawImage(img, 0, 0);
    cropBox.classList.add('hidden');
    crop = null;
    updateCropUI();
    pageSelect.replaceChildren();
    const opt = document.createElement('option');
    opt.value = '1';
    opt.textContent = 'Page 1';
    pageSelect.appendChild(opt);
    pageSelect.value = '1';
    pageCount.textContent = '/ 1 page';
    pageControl.classList.add('hidden');
    currentPage = 1;
    pdfDoc = null;
    showStep(stepPreview);
    stepExport.classList.add('active');
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    showToast('Could not load image. Try another format.', 3000);
  };
  img.src = url;
}

fileInput.addEventListener('change', () => onFileSelected(fileInput.files[0]));

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
['dragover', 'dragenter'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); })
);
['dragleave', 'drop'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); })
);
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) onFileSelected(file);
});

startOverLink.addEventListener('click', (e) => {
  e.preventDefault();
  pdfDoc = null; pdfData = null; crop = null;
  fileInput.value = '';
  resetUnlockForm();
  updateCropUI();
  showStep(stepUpload);
});

// Document selector
function updateUnlockFields() {
  const scheme = DOC_SCHEMES[docType];
  unlockTitle.textContent = 'This document is password-protected';
  unlockHint.textContent = scheme.hint;
  fieldName.classList.toggle('hidden', !scheme.fields.includes('name'));
  fieldYear.classList.toggle('hidden', !scheme.fields.includes('year'));
  fieldDob.classList.toggle('hidden', !scheme.fields.includes('dob'));
  if (scheme.password === 'manual') {
    fieldName.classList.add('hidden');
    fieldYear.classList.add('hidden');
    fieldDob.classList.add('hidden');
    unlockHint.textContent = 'This document is usually not password-protected. If it is, enter the password manually below.';
  }
}
docChips.forEach(chip => {
  chip.addEventListener('click', () => {
    docChips.forEach(c => { c.classList.remove('active'); c.setAttribute('aria-checked', 'false'); });
    chip.classList.add('active');
    chip.setAttribute('aria-checked', 'true');
    docType = chip.dataset.doc;
    updateUnlockFields();
  });
});
updateUnlockFields();

/* ------------------------------------------------------------------ *
 *  PDF open / unlock
 * ------------------------------------------------------------------ */
async function openPdf(passwords = []) {
  showToast('Opening PDF\u2026', 1500);
  try {
    // pdf.js transfers (detaches) the ArrayBuffer to its worker, so pass a
    // fresh copy every time — otherwise a password retry reuses a detached buffer.
    const params = { data: new Uint8Array(pdfData.slice(0)) };
    if (passwords.length) params.password = passwords[0];
    const task = pdfjs.getDocument(params);
    pdfDoc = await task.promise;
    await afterOpen();
  } catch (err) {
    if (err && err.name === 'PasswordException') {
      if (passwords.length > 1) {
        await openPdf(passwords.slice(1));
        return;
      }
      if (passwords.length) {
        unlockError.textContent = 'Incorrect password. Please check the document details, or enter the password manually.';
        unlockError.classList.remove('hidden');
        unlockBtn.disabled = false;
      } else {
        showStep(stepUnlock);
      }
    } else {
      unlockBtn.disabled = false;
      console.error(err);
      showToast('Could not open this PDF: ' + (err && err.message ? err.message : 'unknown error'), 4000);
    }
  }
}

async function afterOpen() {
  const n = pdfDoc.numPages;
  pageSelect.replaceChildren();
  for (let i = 1; i <= n; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = 'Page ' + i;
    pageSelect.appendChild(opt);
  }
  pageSelect.value = String(currentPage);
  pageCount.textContent = '/ ' + n + (n > 1 ? ' pages' : ' page');
  pageControl.classList.toggle('hidden', n <= 1);

  crop = null;
  await renderPage(currentPage);

  showStep(stepPreview);
  stepExport.classList.add('active'); // export controls appear below preview
}

unlockForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const manual = passwordInput.value.trim();
  const scheme = DOC_SCHEMES[docType];
  const passwords = manual ? [manual] : [];

  if (!manual) {
    if (scheme.password === 'manual') {
      unlockError.textContent = 'Please enter the password manually.';
      unlockError.classList.remove('hidden');
      return;
    }

    const name = nameInput.value.trim();
    const year = yearInput.value.trim();
    const dob = dobInput.value.trim();
    const hasNameYear = Boolean(name) && /^\d{4}$/.test(year);
    const hasDob = /^\d{8}$/.test(dob);

    if (scheme.password === 'name+year') {
      if (!hasNameYear) {
        unlockError.textContent = 'Enter the name and a 4-digit birth year.';
        unlockError.classList.remove('hidden');
        return;
      }
      passwords.push(name.toUpperCase().replace(/\s+/g, '').slice(0, 4) + year);
    } else if (scheme.password === 'dob') {
      if (!hasDob) {
        unlockError.textContent = 'Enter date of birth in DDMMYYYY format (8 digits).';
        unlockError.classList.remove('hidden');
        return;
      }
      passwords.push(dob);
    } else if (scheme.password === 'name+year|dob') {
      if (!hasNameYear && !hasDob) {
        unlockError.textContent = 'Enter a name and 4-digit birth year, or DOB in DDMMYYYY format.';
        unlockError.classList.remove('hidden');
        return;
      }
      if (hasNameYear) passwords.push(name.toUpperCase().replace(/\s+/g, '').slice(0, 4) + year);
      if (hasDob && !passwords.includes(dob)) passwords.push(dob);
    }
  }

  if (!passwords.length) {
    unlockError.textContent = 'Could not generate password. Enter manually.';
    unlockError.classList.remove('hidden');
    return;
  }
  unlockError.classList.add('hidden');
  unlockBtn.disabled = true;
  await openPdf(passwords);
});

/* ------------------------------------------------------------------ *
 *  Render
 * ------------------------------------------------------------------ */
async function renderPage(pageNumber) {
  const page = await pdfDoc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const maxBase = Math.max(base.width, base.height);
  // Allow sub-1 scales so MAX_DIM actually caps huge pages; previously the
  // `currentScale = 1` floor re-inflated them to full resolution.
  currentScale = Math.min(DEFAULT_SCALE, MAX_DIM / maxBase);
  if (!Number.isFinite(currentScale) || currentScale <= 0) currentScale = 1;

  viewport = page.getViewport({ scale: currentScale });

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // Hard clamp: even a sub-1 scale combined with high DPR must not exceed MAX_DIM.
  canvas.width = Math.min(MAX_DIM, Math.max(1, Math.floor(viewport.width * dpr)));
  canvas.height = Math.min(MAX_DIM, Math.max(1, Math.floor(viewport.height * dpr)));
  canvas.style.width = viewport.width + 'px';
  canvas.style.height = 'auto';           // preserve aspect ratio when CSS shrinks the canvas
  pixelScale = canvas.width / viewport.width; // device px per viewport CSS px (= dpr)

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;

  await page.render({ canvasContext: ctx, viewport, transform }).promise;

  cropBox.classList.add('hidden');
  crop = null;
  updateCropUI();
}

pageSelect.addEventListener('change', async () => {
  try {
    currentPage = Number(pageSelect.value);
    await renderPage(currentPage);
  } catch (err) {
    console.error(err);
    showToast('Could not render that page: ' + (err && err.message ? err.message : 'unknown error'), 4000);
  }
});

/* ------------------------------------------------------------------ *
 *  Crop interaction  (coordinates in CSS px, matching the canvas box)
 * ------------------------------------------------------------------ */
function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  // Convert from on-screen (displayed) px to the page's own coordinate space
  // (viewport CSS px). The canvas may be scaled down by CSS, so a raw
  // client position does not equal a page position.
  const sx = viewport.width / r.width;
  const sy = viewport.height / r.height;
  return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
}

function clampCrop() {
  const w = viewport.width, h = viewport.height;
  if (!crop) return;
  crop.w = Math.max(4, Math.min(crop.w, w));
  crop.h = Math.max(4, Math.min(crop.h, h));
  crop.x = Math.max(0, Math.min(crop.x, w - crop.w));
  crop.y = Math.max(0, Math.min(crop.y, h - crop.h));
}

function buildGrips() {
  const labels = {
    nw: 'Resize top-left', n: 'Resize top', ne: 'Resize top-right',
    e: 'Resize right', se: 'Resize bottom-right', s: 'Resize bottom',
    sw: 'Resize bottom-left', w: 'Resize left',
  };
  cropBox.querySelectorAll('.grip').forEach((g) => g.remove());
  for (const d of ['nw','n','ne','e','se','s','sw','w']) {
    const g = document.createElement('button');
    g.type = 'button';
    g.className = 'grip';
    g.dataset.dir = d;
    g.setAttribute('aria-label', labels[d]);
    g.tabIndex = -1;
    cropBox.appendChild(g);
  }
}

function positionGrips() {
  // Buttons are 24px hit areas with the 12px visual dot inset by 6px, so the
  // box origin sits 12px outside the corner to keep the dot centered on it.
  const positions = {
    nw: ['-12px', '-12px', 'none'], n: ['50%', '-12px', 'translateX(-50%)'],
    ne: ['calc(100% - 12px)', '-12px', 'none'],
    e: ['calc(100% - 12px)', '50%', 'translateY(-50%)'],
    se: ['calc(100% - 12px)', 'calc(100% - 12px)', 'none'],
    s: ['50%', 'calc(100% - 12px)', 'translateX(-50%)'],
    sw: ['-12px', 'calc(100% - 12px)', 'none'], w: ['-12px', '50%', 'translateY(-50%)'],
  };
  for (const g of cropBox.querySelectorAll('.grip')) {
    const [l, t, transform] = positions[g.dataset.dir];
    g.style.left = l;
    g.style.top = t;
    g.style.transform = transform;
  }
}

function updateCropUI() {
  if (!crop || crop.w < 4 || crop.h < 4) {
    cropBox.classList.add('hidden');
    cropInfo.textContent = '';
    cropBox.removeAttribute('aria-label');
    downloadBtn.disabled = true;
    return;
  }
  cropBox.classList.remove('hidden');
  // crop is stored in viewport CSS px; the overlay is positioned in on-screen
  // px, so scale by the current display size.
  const r = canvas.getBoundingClientRect();
  const sx = r.width / viewport.width;
  const sy = r.height / viewport.height;
  cropBox.style.left = crop.x * sx + 'px';
  cropBox.style.top = crop.y * sy + 'px';
  cropBox.style.width = crop.w * sx + 'px';
  cropBox.style.height = crop.h * sy + 'px';
  cropInfo.textContent =
    'Selection: ' + Math.round(crop.w) + ' × ' + Math.round(crop.h) +
    ' px  (' + Math.round(crop.w / currentScale) + ' × ' + Math.round(crop.h / currentScale) + ' pt)';
  cropBox.setAttribute('role', 'application');
  cropBox.setAttribute('aria-label', 'Crop selection. Use arrow keys to move, Shift plus arrows to resize.');
  downloadBtn.disabled = false;
}

let drag = null; // { mode: 'draw'|'move'|'resize', dir, startX, startY, orig }

canvasWrap.addEventListener('pointerdown', (e) => {
  if (!viewport) return;
  const p = canvasPoint(e);

  const grip = e.target.closest('.grip');
  if (grip) {
    drag = { mode: 'resize', dir: grip.dataset.dir, startX: p.x, startY: p.y, orig: { ...crop } };
    canvasWrap.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }

  if (crop && crop.w >= 4 && crop.h >= 4 && p.x >= crop.x && p.x <= crop.x + crop.w && p.y >= crop.y && p.y <= crop.y + crop.h) {
    drag = { mode: 'move', startX: p.x, startY: p.y, orig: { ...crop } };
    canvasWrap.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }

  crop = { x: p.x, y: p.y, w: 0, h: 0 };
  drag = { mode: 'draw', startX: p.x, startY: p.y };
  canvasWrap.setPointerCapture(e.pointerId);
  e.preventDefault();
  updateCropUI();
});

canvasWrap.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = canvasPoint(e);
  const o = drag.orig;
  const dx = p.x - drag.startX;
  const dy = p.y - drag.startY;

  if (drag.mode === 'draw') {
    crop.x = Math.min(drag.startX, p.x);
    crop.y = Math.min(drag.startY, p.y);
    crop.w = Math.abs(p.x - drag.startX);
    crop.h = Math.abs(p.y - drag.startY);
  } else if (drag.mode === 'move') {
    crop.x = o.x + dx;
    crop.y = o.y + dy;
  } else if (drag.mode === 'resize') {
    const d = drag.dir;
    let x = o.x, y = o.y, w = o.w, h = o.h;
    if (d.includes('e')) w = o.w + dx;
    if (d.includes('s')) h = o.h + dy;
    if (d.includes('w')) { w = o.w - dx; x = o.x + dx; }
    if (d.includes('n')) { h = o.h - dy; y = o.y + dy; }
    if (w < 4) { if (d.includes('w')) x = o.x + o.w - 4; w = 4; }
    if (h < 4) { if (d.includes('n')) y = o.y + o.h - 4; h = 4; }
    crop = { x, y, w, h };
  }

  clampCrop();
  updateCropUI();
});
function endDrag() { drag = null; }

canvasWrap.addEventListener('pointerup', endDrag);
canvasWrap.addEventListener('pointercancel', endDrag);


resetCropBtn.addEventListener('click', () => {
  crop = null;
  updateCropUI();
});

// Keep the crop box glued to the same page region when the canvas's displayed
// size changes (window resize, zoom, container reflow).
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => { if (crop) updateCropUI(); }).observe(canvas);
}

/* ------------------------------------------------------------------ *
 *  Auto-detect (best-effort)
 * ------------------------------------------------------------------ */
async function autoDetect() {
  if (!viewport) return;
  if (autoDetectBtn.disabled) return;
  autoDetectBtn.disabled = true;
  autoDetectBtn.setAttribute('aria-busy', 'true');
  showToast('Detecting card\u2026', 1500);

  const SW = 480, SH = 480;
  const scaleDown = Math.min(SW / canvas.width, SH / canvas.height, 1);
  const dw = Math.max(1, Math.round(canvas.width * scaleDown));
  const dh = Math.max(1, Math.round(canvas.height * scaleDown));

  const tmp = document.createElement('canvas');
  tmp.width = dw; tmp.height = dh;
  const tctx = tmp.getContext('2d', { willReadFrequently: true });
  tctx.drawImage(canvas, 0, 0, dw, dh);
  const img = tctx.getImageData(0, 0, dw, dh).data;

  const corners = [[0,0],[dw-1,0],[0,dh-1],[dw-1,dh-1]];
  let br = 0, bg = 0, bb = 0;
  for (const [cx, cy] of corners) {
    const i = (cy * dw + cx) * 4;
    br += img[i]; bg += img[i+1]; bb += img[i+2];
  }
  br /= corners.length; bg /= corners.length; bb /= corners.length;

  const THRESH = 42;
  const mask = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const i = (y * dw + x) * 4;
      const dr = img[i] - br, dg = img[i+1] - bg, db = img[i+2] - bb;
      if (Math.sqrt(dr*dr + dg*dg + db*db) > THRESH) mask[y * dw + x] = 1;
    }
  }

  const expectedAr = (docType === 'passport') ? 125/88 : 85.6/53.98;
  const comp = findLargestComponent(mask, dw, dh, expectedAr);
  try {
    if (!comp) {
      showToast('Could not auto-detect. Draw a box manually.', 3000);
      return;
    }
    // Convert downsampled device px -> CSS px
    crop = {
      x: (comp.minX / scaleDown) / pixelScale,
      y: (comp.minY / scaleDown) / pixelScale,
      w: ((comp.maxX - comp.minX + 1) / scaleDown) / pixelScale,
      h: ((comp.maxY - comp.minY + 1) / scaleDown) / pixelScale,
    };
    clampCrop();
    updateCropUI();
    showToast('Card detected. Adjust the box if needed.', 2200);
  } finally {
    autoDetectBtn.disabled = false;
    autoDetectBtn.removeAttribute('aria-busy');
  }
}

function findLargestComponent(mask, w, h, expectedAr) {
  const seen = new Uint8Array(w * h);
  let best = null, bestScore = 0;
  const queue = new Int32Array(w * h);
  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      const idx = sy * w + sx;
      if (!mask[idx] || seen[idx]) continue;
      let head = 0, tail = 0;
      queue[tail++] = idx;
      seen[idx] = 1;
      let minX = sx, maxX = sx, minY = sy, maxY = sy, area = 0;
      while (head < tail) {
        const c = queue[head++];
        const cx = c % w, cy = (c / w) | 0;
        area++;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        const nb = [c - 1, c + 1, c - w, c + w];
        for (const n of nb) {
          if (n < 0 || n >= w * h) continue;
          if (!mask[n] || seen[n]) continue;
          // avoid wrapping across rows
          if ((n === c - 1 && cx === 0) || (n === c + 1 && cx === w - 1)) continue;
          seen[n] = 1; queue[tail++] = n;
        }
      }
      const bw = maxX - minX + 1, bh = maxY - minY + 1;
      const ar = bw / Math.max(1, bh);
      let score = area;
      if (ar >= 1.1 && ar <= 2.4) score *= 2;     // card-like aspect ratio
      if (bw < w * 0.95 && bh < h * 0.95) score *= 1.5; // not the full page
      if (expectedAr) {
        const ratioDiff = Math.abs(ar - expectedAr);
        if (ratioDiff < 0.2) score *= 2;
        else if (ratioDiff < 0.5) score *= 1.3;
      }
      if (score > bestScore) { bestScore = score; best = { minX, maxX, minY, maxY, area }; }
    }
  }
  return best;
}

autoDetectBtn.addEventListener('click', autoDetect);

/* ------------------------------------------------------------------ *
 *  Export
 * ------------------------------------------------------------------ */
function extractRegion() {
  const sx = Math.max(0, Math.min(Math.round(crop.x * pixelScale), Math.max(0, canvas.width - 1)));
  const sy = Math.max(0, Math.min(Math.round(crop.y * pixelScale), Math.max(0, canvas.height - 1)));
  const sw = Math.max(1, Math.min(Math.round(crop.w * pixelScale), canvas.width - sx));
  const sh = Math.max(1, Math.min(Math.round(crop.h * pixelScale), canvas.height - sy));
  const off = document.createElement('canvas');
  off.width = sw;
  off.height = sh;
  const octx = off.getContext('2d');
  octx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return off;
}

function blobFromCanvas(c) {
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png');
  });
}

downloadBtn.addEventListener('click', async () => {
  if (!crop || crop.w < 4 || crop.h < 4) { showToast('Draw a selection first.'); return; }
  if (!outPng.checked && !outPdf.checked) { showToast('Select at least one output format.'); return; }

  const doPng = outPng.checked;
  const doPdf = outPdf.checked;
  downloadBtn.disabled = true;
  exportStatus.textContent = 'Preparing\u2026';

  try {
    const region = extractRegion();

    if (doPng) {
      const blob = await blobFromCanvas(region);
      downloadBlob(blob, baseName() + '_card.png');
    }

    if (doPdf) {
      if (!window.jspdf || !window.jspdf.jsPDF) {
        throw new Error('PDF library failed to load. Refresh the page and try again.');
      }
      const dataURL = region.toDataURL('image/png');
      // Points sizing: 1pt = 1/72in. PDF pages use the document scale where
      // available (PDF points); images use 300 DPI so an 1800px crop does not
      // become a 25-inch page.
      const wPt = pdfDoc ? (crop.w / currentScale) : (region.width * 72) / 300;
      const hPt = pdfDoc ? (crop.h / currentScale) : (region.height * 72) / 300;
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: 'pt', format: [wPt, hPt], orientation: wPt >= hPt ? 'l' : 'p' });
      doc.addImage(dataURL, 'PNG', 0, 0, wPt, hPt);
      doc.save(baseName() + '_card.pdf');
    }

    exportStatus.textContent = 'Done! Check your downloads folder.';
    showToast('Downloaded ' + [doPng && 'PNG', doPdf && 'PDF'].filter(Boolean).join(' + '), 2200);
  } catch (err) {
    console.error(err);
    exportStatus.textContent = '';
    showToast('Export failed: ' + (err && err.message ? err.message : 'unknown error'), 4000);
  } finally {
    updateCropUI();
  }
});

/* ------------------------------------------------------------------ *
 *  Init
 * ------------------------------------------------------------------ */
try {
  buildGrips();
  positionGrips();
  showStep(stepUpload);
} catch (e) {
  console.error(e);
  fatalError.classList.remove('hidden');
  fatalError.textContent = 'App failed to load. Please use start.cmd or a static server.';
}
window.addEventListener('error', (event) => {
  // Only boot failures are fatal. Runtime errors (e.g. a single failed page
  // render, caught elsewhere with a toast) must not brick the whole app.
  if (stepUpload && stepUpload.classList.contains('active') && !pdfDoc && !pdfData) {
    fatalError.classList.remove('hidden');
    fatalError.textContent = 'App failed to load. Please use start.cmd or a static server.';
    return;
  }
  console.error(event && event.error ? event.error : event);
  showToast('Something went wrong. Your file is still loaded — try again.', 4000);
});
window.addEventListener('unhandledrejection', (event) => {
  if (stepUpload && stepUpload.classList.contains('active') && !pdfDoc && !pdfData) {
    fatalError.classList.remove('hidden');
    fatalError.textContent = 'App failed to load. Please use start.cmd or a static server.';
    return;
  }
  console.error(event && event.reason ? event.reason : event);
  showToast('Something went wrong. Your file is still loaded — try again.', 4000);
});

// Keyboard alternative to pointer dragging: focus the canvas area and use
// arrows to move the selection, Shift+arrows to resize it.
canvasWrap.tabIndex = 0;
canvasWrap.setAttribute('role', 'application');
canvasWrap.setAttribute('aria-label', 'Crop area. Draw with pointer, or use arrow keys on an existing selection.');
canvasWrap.addEventListener('keydown', (e) => {
  if (!crop || !viewport) return;
  const step = e.shiftKey ? 0 : 10;
  const grow = e.shiftKey ? 10 : 0;
  let handled = true;
  if (e.key === 'ArrowLeft') { if (grow) crop.w = Math.max(4, crop.w - grow); else crop.x -= step; }
  else if (e.key === 'ArrowRight') { if (grow) crop.w += grow; else crop.x += step; }
  else if (e.key === 'ArrowUp') { if (grow) crop.h = Math.max(4, crop.h - grow); else crop.y -= step; }
  else if (e.key === 'ArrowDown') { if (grow) crop.h += grow; else crop.y += step; }
  else handled = false;
  if (handled) {
    e.preventDefault();
    clampCrop();
    updateCropUI();
  }
});
