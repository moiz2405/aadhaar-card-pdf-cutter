'use strict';

const {
  parseResumeRequest,
  ResumeServiceError,
  getClientId,
} = require('../lib/resume-service.cjs');

function sendJson(res, status, payload) {
  // Vercel serverless functions receive a raw http.ServerResponse (no
  // Express-style res.status()/res.json()), so set headers explicitly.
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') {
    // Some platforms pre-parse JSON bodies; still enforce the size cap.
    const serialized = JSON.stringify(req.body);
    if (Buffer.byteLength(serialized) > 22000) {
      return Promise.reject(new ResumeServiceError('request_too_large', 'Request body is too large.', 413));
    }
    return Promise.resolve(req.body);
  }

  return new Promise((resolve, reject) => {
    let receivedBytes = 0;
    let settled = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += buffer.length;
      if (receivedBytes > 22000) {
        settled = true;
        // Destroy the connection and stop; the 'end' handler below is
        // guarded by `settled` so it will not double-reject.
        req.destroy();
        reject(new ResumeServiceError('request_too_large', 'Request body is too large.', 413));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new ResumeServiceError('invalid_json', 'Send valid JSON.', 400));
      }
    });
    req.on('error', () => {
      if (settled) return;
      settled = true;
      reject(new ResumeServiceError('request_error', 'Could not read the request.', 400));
    });
    req.on('close', () => {
      if (settled) return;
      settled = true;
      reject(new ResumeServiceError('request_error', 'Could not read the request.', 400));
    });
  });
}

module.exports = async function parseResumeHandler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'Use POST for resume parsing.' } });
  }

  try {
    const body = await readBody(req);
    const result = await parseResumeRequest({
      body,
      origin: req.headers.origin,
      host: req.headers.host,
      clientId: getClientId({
        ip: req.socket && req.socket.remoteAddress,
        forwardedFor: req.headers['x-forwarded-for'],
      }),
    });
    return sendJson(res, 200, result);
  } catch (error) {
    const serviceError = error instanceof ResumeServiceError
      ? error
      : new ResumeServiceError('internal_error', 'Resume parsing failed.', 500);
    return sendJson(res, serviceError.statusCode, {
      error: { code: serviceError.code, message: serviceError.message },
    });
  }
};
