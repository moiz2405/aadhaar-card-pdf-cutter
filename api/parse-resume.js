'use strict';

const {
  parseResumeRequest,
  ResumeServiceError,
  getClientId,
} = require('../lib/resume-service.cjs');

function sendJson(res, status, payload) {
  res.status(status).setHeader('Cache-Control', 'no-store');
  res.json(payload);
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);

  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 22000) {
        reject(new ResumeServiceError('request_too_large', 'Request body is too large.', 413));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        reject(new ResumeServiceError('invalid_json', 'Send valid JSON.', 400));
      }
    });
    req.on('error', () => reject(new ResumeServiceError('request_error', 'Could not read the request.', 400)));
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
