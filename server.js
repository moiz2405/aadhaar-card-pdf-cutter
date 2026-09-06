// Aadhaar Card PDF Cutter - tiny static file server (Node core only)
// Serves the app folder over localhost so pdf.js's ES-module worker
// can load same-origin. No dependencies.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const {
  parseResumeRequest,
  ResumeServiceError,
  getClientId,
} = require('./lib/resume-service.cjs');

const ROOT = __dirname;

function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const contents = fs.readFileSync(envPath, 'utf8');
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const PORT = Number(process.env.PORT) || 8080;
const OPEN_BROWSER = process.env.OPEN_BROWSER === '1';

// Bind BOTH IPv4 and IPv6 loopback. On many Windows machines "localhost"
// resolves to IPv6 ::1 while "127.0.0.1" is IPv4 — listening on both makes
// either URL work. Binding to loopback only keeps the app private to this PC.
const HOSTS = ['127.0.0.1', '::1'];
const MAX_API_BODY_BYTES = 30000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.tflite': 'application/octet-stream',
};

// Only these extensions are ever served as static files. In particular this
// blocks server-side code (.cjs), launchers (.cmd), and logs.
const PUBLIC_EXTENSIONS = new Set(Object.keys(MIME));
// Local-only files that must never be served even though their extension is public.
const BLOCKED_FILES = new Set(['server.js', 'package.json', 'package-lock.json']);
// Directories that are never served as static files. Note lib/ is NOT
// blocked: it hosts client-side .js (e.g. passport-bg.js). Server-side
// .cjs files stay blocked by the PUBLIC_EXTENSIONS filter below.
const BLOCKED_DIRS = new Set(['api', 'test']);

function resolveSafe(urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (p.includes('\u0000')) return null;
  if (p === '/' || p === '') p = '/index.html';
  const normalized = path.posix.normalize('/' + String(p).replace(/\\/g, '/'));
  const segments = normalized.split('/').filter(Boolean);
  // Block dotfiles/dot-directories (.env, .env.example, .git/*) and traversal.
  if (segments.some((segment) => segment === '..' || segment.startsWith('.'))) return null;
  // Block underscore-prefixed leftovers (_downloads/, _t_locked.pdf).
  if (segments.some((segment) => segment.startsWith('_'))) return null;
  if (segments.length && BLOCKED_DIRS.has(segments[0])) return null;
  const base = segments[segments.length - 1] || '';
  if (BLOCKED_FILES.has(base)) return null;
  // Normalize and prevent path traversal outside ROOT.
  const resolved = path.normalize(path.join(ROOT, normalized));
  if (!resolved.startsWith(ROOT + path.sep) && resolved !== ROOT) return null;
  const ext = path.extname(resolved).toLowerCase();
  if (!PUBLIC_EXTENSIONS.has(ext)) return null;
  return resolved;
}

function openBrowser() {
  const url = 'http://127.0.0.1:' + PORT + '/';
  const { spawn } = require('child_process');
  const cmd = spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' });
  cmd.on('error', () => {
    console.log('Could not open your browser automatically. Open this in your browser:');
    console.log('  ' + url);
  });
  cmd.unref();
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let receivedBytes = 0;
    let tooLarge = false;

    req.on('data', (chunk) => {
      if (tooLarge) return;
      receivedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      if (receivedBytes > MAX_API_BODY_BYTES) {
        tooLarge = true;
        // Stop a slow oversized body from tying up the connection.
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new ResumeServiceError('request_too_large', 'Request body is too large.', 413));
        return;
      }
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        reject(new ResumeServiceError('invalid_json', 'Send valid JSON.', 400));
      }
    });
    req.on('error', () => reject(new ResumeServiceError('request_error', 'Could not read the request.', 400)));
  });
}

async function handleResumeParse(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'Use POST for resume parsing.' } });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const result = await parseResumeRequest({
      body,
      origin: req.headers.origin,
      host: req.headers.host,
      clientId: getClientId({
        ip: req.socket && req.socket.remoteAddress,
        forwardedFor: req.headers['x-forwarded-for'],
      }),
    });
    sendJson(res, 200, result);
  } catch (error) {
    const serviceError = error instanceof ResumeServiceError
      ? error
      : new ResumeServiceError('internal_error', 'Resume parsing failed.', 500);
    sendJson(res, serviceError.statusCode, {
      error: { code: serviceError.code, message: serviceError.message },
    });
  }
}

function handleRequest(req, res) {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/api/parse-resume') {
      handleResumeParse(req, res).catch(() => {
        if (!res.writableEnded) {
          sendJson(res, 500, { error: { code: 'internal_error', message: 'Resume parsing failed.' } });
        }
      });
      return;
    }

    const filePath = resolveSafe(url.pathname);

    if (!filePath) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 Forbidden');
      return;
    }

    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-cache',
      });

      const stream = fs.createReadStream(filePath);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    });
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 Internal Server Error');
  }
}

const servers = [];
let bound = 0;
let opened = false;

function startLocalServers() {
  for (const host of HOSTS) {
    const srv = http.createServer(handleRequest);
    servers.push(srv);

    srv.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        console.log('The app is already running at http://localhost:' + PORT + '/');
        if (OPEN_BROWSER && !opened) { opened = true; openBrowser(); }
        process.exit(0);
      } else if (e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT') {
        // This address family isn't available (e.g. no IPv6); that's fine.
        return;
      } else {
        console.error('Server error:', e.message);
      }
    });

    srv.listen(PORT, host, () => {
      bound++;
      if (bound === 1) {
        console.log('Aadhaar Card PDF Cutter is ready:');
        console.log('  http://127.0.0.1:' + PORT + '/');
        console.log('  http://localhost:' + PORT + '/');
        console.log('Keep this window open while you use the app. Press Ctrl+C to stop.');
        // Open the browser only AFTER the server is actually listening,
        // so the page loads on the first try (no connection-refused race).
        if (OPEN_BROWSER && !opened) { opened = true; openBrowser(); }
      }
    });
  }
}

// Only bind ports when run directly (`node server.js` / start.cmd).
// When required as a module — e.g. as the Vercel server entrypoint —
// just export the request handler without side effects.
if (require.main === module) {
  startLocalServers();
}

module.exports = handleRequest;
module.exports.handleRequest = handleRequest;
module.exports.resolveSafe = resolveSafe;
