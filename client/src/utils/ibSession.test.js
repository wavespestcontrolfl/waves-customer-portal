// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

it('creates UUID identities without browser randomUUID and keeps requests distinct', async () => {
  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  vi.stubGlobal('crypto', { getRandomValues });
  const { createRequestIdentity, ibSessionId } = await import('./ibSession');
  const session = ibSessionId();
  expect(session).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(ibSessionId()).toBe(session);
  const identity = createRequestIdentity(session);
  const first = identity.begin('{"prompt":"first"}'), second = identity.begin('{"prompt":"second"}');
  expect(first.session_id).toBe(session);
  expect(first.request_key).not.toBe(second.request_key);
  localStorage.setItem('waves_admin_user', JSON.stringify({ id: 'another-actor' }));
  expect(ibSessionId()).not.toBe(session);
});

it('keeps one request key for the same request until the server answers', async () => {
  const { createRequestIdentity } = await import('./ibSession');
  const identity = createRequestIdentity('existing-session');
  const first = identity.begin('{"prompt":"text alice"}');
  // A dropped response: the retry of the same request replays the saved task.
  expect(identity.begin('{"prompt":"text alice"}')).toEqual(first);
  // A different request is a new logical request even before the first settles.
  expect(identity.begin('{"prompt":"text bob"}').request_key).not.toBe(first.request_key);
  identity.settle();
  expect(identity.begin('{"prompt":"text alice"}').request_key).not.toBe(first.request_key);
});

it('returns a valid in-memory identity when session storage is unavailable', async () => {
  vi.stubGlobal('sessionStorage', { getItem() { throw new Error('Storage unavailable'); } });
  const { ibSessionId } = await import('./ibSession');
  expect(ibSessionId()).toMatch(/^[0-9a-f-]{36}$/);
});

it('formats cryptographic fallback bytes with UUID v4 version and variant bits', async () => {
  const getRandomValues = vi.fn(bytes => bytes.fill(255));
  vi.stubGlobal('crypto', { getRandomValues });
  const { createRequestIdentity } = await import('./ibSession');
  expect(createRequestIdentity('existing-session').begin('{}').request_key).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
  expect(getRandomValues).toHaveBeenCalledOnce();
});
