import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenRouterClient } from '../src/openrouter.js';

const success = () => Response.json({
  choices: [{ message: { content: 'generated hook' } }],
});

const allowance = (remaining = 10) => Response.json({
  data: { free_model_daily_requests: { remaining } },
});

test('spaces free-router requests to stay below the per-minute limit', async () => {
  let clock = 0;
  const requestTimes = [];
  const complete = createOpenRouterClient({
    apiKey: 'test-key',
    baseUrl: 'https://openrouter.example/api/v1',
    model: 'openrouter/free',
    now: () => clock,
    sleepImpl: async (ms) => { clock += ms; },
    fetchImpl: async (url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      if (new URL(url).pathname.endsWith('/key')) return allowance();
      requestTimes.push(clock);
      return success();
    },
  });

  await complete([]);
  await complete([]);
  await complete([]);

  assert.deepEqual(requestTimes, [0, 3_100, 6_200]);
});

test('honors Retry-After and retries a rate-limited free-model request', async () => {
  let clock = 0;
  let requests = 0;
  const waits = [];
  const complete = createOpenRouterClient({
    apiKey: 'test-key',
    baseUrl: 'https://openrouter.example/api/v1',
    model: 'openrouter/free',
    now: () => clock,
    sleepImpl: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    fetchImpl: async (url) => {
      if (new URL(url).pathname.endsWith('/key')) return allowance();
      requests += 1;
      if (requests === 1) {
        return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
          headers: { 'Retry-After': '8' },
        });
      }
      return success();
    },
  });

  assert.equal(await complete([]), 'generated hook');
  assert.equal(requests, 2);
  assert.deepEqual(waits, [8_000]);
});

test('does not retry permanent API errors', async () => {
  let requests = 0;
  const complete = createOpenRouterClient({
    apiKey: 'test-key',
    baseUrl: 'https://openrouter.example/api/v1',
    model: 'provider/model',
    fetchImpl: async () => {
      requests += 1;
      return new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 });
    },
  });

  await assert.rejects(complete([]), /OpenRouter 401: invalid key/);
  assert.equal(requests, 1);
});

test('stops before inference when the free-model daily allowance is exhausted', async () => {
  let completionRequests = 0;
  const complete = createOpenRouterClient({
    apiKey: 'test-key',
    baseUrl: 'https://openrouter.example/api/v1',
    model: 'openrouter/free',
    fetchImpl: async (url) => {
      if (new URL(url).pathname.endsWith('/key')) return allowance(0);
      completionRequests += 1;
      return success();
    },
  });

  await assert.rejects(complete([]), /daily request allowance is exhausted/);
  assert.equal(completionRequests, 0);
});

test('retries transient server errors with exponential backoff', async () => {
  let requests = 0;
  const waits = [];
  const complete = createOpenRouterClient({
    apiKey: 'test-key',
    baseUrl: 'https://openrouter.example/api/v1',
    model: 'provider/model',
    sleepImpl: async (ms) => { waits.push(ms); },
    fetchImpl: async () => {
      requests += 1;
      return requests < 3
        ? new Response('temporary failure', { status: 529 })
        : success();
    },
  });

  assert.equal(await complete([]), 'generated hook');
  assert.equal(requests, 3);
  assert.deepEqual(waits, [5_000, 10_000]);
});
