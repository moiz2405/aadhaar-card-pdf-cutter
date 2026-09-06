'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// The server.js Vercel entrypoint serves static files from disk, so every
// static asset must be inside its includeFiles allowlist — otherwise the
// live page 404s even though the build is green (seen with passport.html).
test('server bundle allowlist covers every static entry file', () => {
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const includeFiles = vercel.functions['server.js'].includeFiles || '';
  const required = [
    'index.html',
    'resume.html',
    'passport.html',
    'id-card-cutter.js',
    'resume-maker.js',
    'passport-photos.js',
    'style.css',
    'logo.jpg',
  ];
  for (const file of required) {
    assert.ok(
      fs.existsSync(path.join(ROOT, file)),
      `expected static file to exist: ${file}`,
    );
    assert.ok(
      includeFiles.includes(file),
      `server includeFiles is missing ${file} (live page would 404)`,
    );
  }
  assert.ok(includeFiles.includes('vendor/**'), 'server includeFiles must cover vendor/**');
  assert.ok(
    includeFiles.includes('lib/passport-bg.js'),
    'server includeFiles must cover the client background engine',
  );
  for (const file of [
    'vendor/mediapipe/vision_bundle.mjs',
    'vendor/mediapipe/wasm/vision_wasm_internal.js',
    'vendor/mediapipe/wasm/vision_wasm_internal.wasm',
    'vendor/mediapipe/selfie_segmenter.tflite',
    'lib/passport-ml.js',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `expected vendored file: ${file}`);
  }
  // Guard against the recurring live-404 class: every page-referenced local
  // script must be reachable from the server bundle (explicitly or via a
  // covering glob like vendor/**).
  const vercelIncludes = vercel.functions['server.js'].includeFiles || '';
  // Dynamic import() only resolves explicitly relative URLs — a bare
  // 'vendor/...' specifier throws "Failed to resolve module specifier".
  // (Already-relative './vendor/...' strings cannot match this pattern.)
  const ppSrc = fs.readFileSync(path.join(ROOT, 'passport-photos.js'), 'utf8');
  const bare = [...ppSrc.matchAll(/['"](vendor\/[^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(bare, [], `bare vendor specifiers break import(): ${bare.join(', ')}`);
  // Engine URLs feed dynamic import() (script-relative) and fetch()
  // (document-relative): only root-absolute paths are correct for both.
  const mlPathsBlock = /function mlPaths\(\) \{[\s\S]*?\n\}/.exec(ppSrc)?.[0] || '';
  for (const key of ['bundle', 'wasmDir', 'model']) {
    const m = new RegExp(key + ":\\s*'([^']+)'").exec(mlPathsBlock);
    assert.ok(m && m[1].startsWith('/'), `mlPaths.${key} must be root-absolute, got: ${m && m[1]}`);
  }
  for (const page of ['index.html', 'resume.html', 'passport.html']) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    for (const match of html.matchAll(/<script\s+src="([^"]+)"/g)) {
      const src = match[1].split('?')[0].replace(/^\.\//, '');
      if (/^(https?:)?\/\//.test(src)) continue;
      const covered = src.startsWith('vendor/')
        ? vercelIncludes.includes('vendor/**')
        : vercelIncludes.includes(src);
      assert.ok(covered, `${page} loads ${src}, missing from server includeFiles (live 404)`);
    }
  }
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(serverSrc.includes('.wasm'), 'server.js must serve .wasm for the AI runtime');
  assert.ok(serverSrc.includes('.tflite'), 'server.js must serve the .tflite model');
});
