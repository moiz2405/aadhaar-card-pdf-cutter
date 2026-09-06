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
});
