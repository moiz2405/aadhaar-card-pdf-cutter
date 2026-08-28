'use strict';

const { MAX_RESUME_INPUT_CHARS } = require('./resume-schema.cjs');
const { ResumeServiceError, parseResumeText } = require('./resume-provider.cjs');

const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 8;
const requestBuckets = new Map();

function getClientId({ ip, forwardedFor }) {
  const firstForwarded = String(forwardedFor || '').split(',')[0].trim();
  return firstForwarded || String(ip || 'unknown');
}

function enforceOrigin(origin, host) {
  if (!origin) return;
  try {
    const originUrl = new URL(origin);
    if (originUrl.host !== host) {
      throw new ResumeServiceError('origin_rejected', 'This request origin is not allowed.', 403);
    }
  } catch (error) {
    if (error instanceof ResumeServiceError) throw error;
    throw new ResumeServiceError('origin_rejected', 'This request origin is not allowed.', 403);
  }
}

function enforceRateLimit(clientId) {
  const now = Date.now();
  const recent = (requestBuckets.get(clientId) || []).filter((time) => now - time < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    throw new ResumeServiceError('rate_limited', 'Too many parse requests. Please try again later.', 429);
  }
  recent.push(now);
  requestBuckets.set(clientId, recent);

  // Keep the in-memory guardrail bounded on long-lived local servers.
  if (requestBuckets.size > 1000) {
    for (const [key, times] of requestBuckets) {
      if (!times.some((time) => now - time < RATE_WINDOW_MS)) requestBuckets.delete(key);
    }
  }
}

async function parseResumeRequest({ body, origin, host, clientId }) {
  enforceOrigin(origin, host);
  enforceRateLimit(clientId || 'unknown');

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ResumeServiceError('invalid_request', 'Send a JSON object containing resume text.', 400);
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    throw new ResumeServiceError('invalid_request', 'Paste some information about yourself first.', 400);
  }
  if (text.length > MAX_RESUME_INPUT_CHARS) {
    throw new ResumeServiceError(
      'input_too_large',
      `Please keep the pasted text under ${MAX_RESUME_INPUT_CHARS.toLocaleString()} characters.`,
      413,
    );
  }

  const resume = await parseResumeText(text);
  return {
    resume,
    warnings: ['Review every field before using the resume. AI extraction can miss or misread details.'],
  };
}

module.exports = {
  parseResumeRequest,
  ResumeServiceError,
  getClientId,
};
