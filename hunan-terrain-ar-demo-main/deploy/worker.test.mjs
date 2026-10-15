import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './worker.mjs';

const expiry = '2026-10-08T11:00:00.000Z';
const deadline = Date.parse(expiry);
test('serves assets before expiry with non-caching headers', async () => {
  let calls = 0;
  const env = { PREVIEW_EXPIRES_AT: expiry, ASSETS: { fetch: async () => { calls++; return new Response('demo'); } } };
  const response = await handleRequest(new Request('https://preview.example/assets/terrain-height.f32'), env, deadline - 1);
  assert.equal(await response.text(), 'demo');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-preview-expires-at'), expiry);
  assert.equal(calls, 1);
});
test('deadline blocks homepage, scripts and direct asset URLs before binding access', async () => {
  const env = { PREVIEW_EXPIRES_AT: expiry, ASSETS: { fetch: () => { throw Error('Expiry bypass'); } } };
  for (const path of ['/', '/?review=scan', '/app.js', '/assets/terrain-height.f32', '/vendor/three/three.module.js']) {
    assert.equal((await handleRequest(new Request('https://preview.example' + path), env, deadline)).status, 410);
  }
  assert.equal((await handleRequest(new Request('https://preview.example/'), { ...env, PREVIEW_EXPIRES_AT: '' }, 0)).status, 410);
});
