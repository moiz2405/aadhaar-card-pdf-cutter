'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  emptyResume,
  normalizeResume,
} = require('../lib/resume-schema.cjs');
const {
  parseResumeText,
} = require('../lib/resume-provider.cjs');
const {
  parseResumeRequest,
  ResumeServiceError,
} = require('../lib/resume-service.cjs');

test('normalizes provider data into the stable resume shape', () => {
  const result = normalizeResume({
    fullName: '  Jane Doe  ',
    contact: { email: 'jane@example.com' },
    skills: ['JavaScript', 123, ''],
    experience: [{ jobTitle: 'Developer', bullets: ['Built a thing'] }],
  });

  assert.equal(result.fullName, 'Jane Doe');
  assert.equal(result.contact.email, 'jane@example.com');
  assert.deepEqual(result.skills, ['JavaScript']);
  assert.equal(result.experience[0].jobTitle, 'Developer');
  assert.deepEqual(result.experience[0].bullets, ['Built a thing']);
  assert.deepEqual(result.projects, []);
});

test('opencode adapter sends a keyless chat-completions request and parses JSON', async () => {
  const previousFetch = global.fetch;
  const previousProviders = process.env.RESUME_AI_PROVIDERS;
  const previousKey = process.env.OPENCODE_API_KEY;
  let request;
  const payload = emptyResume();
  payload.fullName = 'Jane Doe';

  process.env.RESUME_AI_PROVIDERS = 'opencode';
  delete process.env.OPENCODE_API_KEY;
  global.fetch = async (url, init) => {
    request = { url, init };
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: `Here is the object:\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\nDone.` },
        }],
      }),
    };
  };

  try {
    const result = await parseResumeText('Jane Doe is a developer.');
    assert.equal(result.fullName, 'Jane Doe');
    assert.equal(request.url, 'https://opencode.ai/zen/v1/chat/completions');
    assert.equal(request.init.headers.Authorization, undefined);
    const requestBody = JSON.parse(request.init.body);
    assert.equal(requestBody.model, 'hy3-free');
    assert.equal(requestBody.reasoning_effort, 'low');
  } finally {
    global.fetch = previousFetch;
    if (previousProviders === undefined) delete process.env.RESUME_AI_PROVIDERS;
    else process.env.RESUME_AI_PROVIDERS = previousProviders;
    if (previousKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = previousKey;
  }
});

test('starts both configured providers and returns the first usable result', async () => {
  const previousFetch = global.fetch;
  const previousProviders = process.env.RESUME_AI_PROVIDERS;
  const previousKey = process.env.HCNSEC_API_KEY;
  const fastPayload = emptyResume();
  fastPayload.fullName = 'Fast HCNSEC Result';
  const requests = [];
  let slowSignal;

  process.env.RESUME_AI_PROVIDERS = 'opencode,hcnsec';
  process.env.HCNSEC_API_KEY = 'test-key';
  global.fetch = async (url, init) => {
    requests.push(url);
    if (url.includes('opencode.ai')) {
      slowSignal = init.signal;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({
          ok: true,
          json: async () => ({ choices: [{ message: { content: JSON.stringify(emptyResume()) } }] }),
        }), 80);
        init.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    }
    return new Promise((resolve) => setTimeout(() => resolve({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(fastPayload) } }] }),
    }), 5));
  };

  try {
    const result = await parseResumeText('Fast HCNSEC Result is a developer.');
    assert.equal(result.fullName, 'Fast HCNSEC Result');
    assert.deepEqual(requests, [
      'https://opencode.ai/zen/v1/chat/completions',
      'https://api.hcnsec.cn/v1/chat/completions',
    ]);
    assert.equal(slowSignal.aborted, true);
  } finally {
    global.fetch = previousFetch;
    if (previousProviders === undefined) delete process.env.RESUME_AI_PROVIDERS;
    else process.env.RESUME_AI_PROVIDERS = previousProviders;
    if (previousKey === undefined) delete process.env.HCNSEC_API_KEY;
    else process.env.HCNSEC_API_KEY = previousKey;
  }
});

test('rejects an incomplete reasoning response instead of silently parsing nothing', async () => {
  const previousFetch = global.fetch;
  const previousProviders = process.env.RESUME_AI_PROVIDERS;

  process.env.RESUME_AI_PROVIDERS = 'opencode';
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
    }),
  });

  try {
    await assert.rejects(
      () => parseResumeText('Incomplete User is a developer.'),
      (error) => error instanceof ResumeServiceError && error.code === 'provider_incomplete_response',
    );
  } finally {
    global.fetch = previousFetch;
    if (previousProviders === undefined) delete process.env.RESUME_AI_PROVIDERS;
    else process.env.RESUME_AI_PROVIDERS = previousProviders;
  }
});

test('tries the configured fallback provider after the first provider fails', async () => {
  const previousFetch = global.fetch;
  const previousProviders = process.env.RESUME_AI_PROVIDERS;
  const previousKey = process.env.HCNSEC_API_KEY;
  const payload = emptyResume();
  payload.fullName = 'Fallback User';
  const requests = [];

  process.env.RESUME_AI_PROVIDERS = 'opencode,hcnsec';
  process.env.HCNSEC_API_KEY = 'test-key';
  global.fetch = async (url, init) => {
    requests.push({ url, init });
    if (url.includes('opencode.ai')) return { ok: false, json: async () => ({}) };
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    };
  };

  try {
    const result = await parseResumeText('Fallback User is a developer.');
    assert.equal(result.fullName, 'Fallback User');
    assert.equal(requests.length, 2);
    assert.equal(requests[1].init.headers.Authorization, 'Bearer test-key');
    assert.equal(JSON.parse(requests[1].init.body).model, 'MiniMax-M3');
  } finally {
    global.fetch = previousFetch;
    if (previousProviders === undefined) delete process.env.RESUME_AI_PROVIDERS;
    else process.env.RESUME_AI_PROVIDERS = previousProviders;
    if (previousKey === undefined) delete process.env.HCNSEC_API_KEY;
    else process.env.HCNSEC_API_KEY = previousKey;
  }
});

test('rejects an empty parse request before calling a provider', async () => {
  await assert.rejects(
    () => parseResumeRequest({ body: { text: ' ' }, origin: 'http://localhost:8080', host: 'localhost:8080', clientId: 'test-empty' }),
    (error) => error instanceof ResumeServiceError && error.code === 'invalid_request' && error.statusCode === 400,
  );
});
