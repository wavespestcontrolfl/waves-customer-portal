const {
  installCreditKeyPool,
  createCreditKeyFetch,
  getCreditKeyPoolStatus,
} = require('../services/llm/credit-key-pool');

const MAIN_A = 'main-anthropic-key';
const MAIN_O = 'main-openai-key';
const A1 = 'credit-a-1';
const A2 = 'credit-a-2';
const O1 = 'credit-o-1';
const O2 = 'credit-o-2';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_CHAT = 'https://api.openai.com/v1/chat/completions';
const OPENAI_RESP = 'https://api.openai.com/v1/responses';

function baseEnv(extra = {}) {
  return {
    GATE_AI_CREDIT_KEYS: 'true',
    ANTHROPIC_API_KEY: MAIN_A,
    OPENAI_API_KEY: MAIN_O,
    ANTHROPIC_CREDIT_KEYS: `${A1},${A2}`,
    OPENAI_CREDIT_KEYS: `${O1},${O2}`,
    ...extra,
  };
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
const ok = () => json(200, { id: 'msg_1' });
const creditLow = () => json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } });
const quota = () => json(429, { error: { code: 'insufficient_quota', type: 'insufficient_quota', message: 'You exceeded your current quota' } });

// Fake base fetch: records each call; answers come from `script` (a function
// of the recorded call) or default to 200.
function makeBase(script) {
  const calls = [];
  const fn = jest.fn(async (input, init) => {
    const headers = new Headers(init && init.headers);
    const call = { input, init, headers, key: headers.get('x-api-key') || headers.get('authorization') };
    calls.push(call);
    return script ? script(call, calls.length) : ok();
  });
  fn.calls = calls;
  return fn;
}

function anthropicInit(key = MAIN_A, extra = {}) {
  return {
    method: 'POST',
    headers: { 'x-api-key': key, 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-workspace-id': 'wrkspc_main' },
    body: JSON.stringify({ model: 'm', messages: [] }),
    ...extra,
  };
}
function openaiInit(key = MAIN_O, extra = {}) {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'openai-organization': 'org_main', 'openai-project': 'proj_main' },
    body: JSON.stringify({ model: 'm', messages: [] }),
    ...extra,
  };
}

function silentLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function pool(base, { env = baseEnv(), now = () => 1_000_000, logger = silentLogger() } = {}) {
  return { f: createCreditKeyFetch(base, { env, now, logger }), logger };
}

describe('installCreditKeyPool', () => {
  function target() {
    return { fetch: jest.fn(async () => ok()) };
  }

  test('gate off: nothing installed', () => {
    const t = target();
    const original = t.fetch;
    const res = installCreditKeyPool({ env: baseEnv({ GATE_AI_CREDIT_KEYS: 'false' }), logger: silentLogger(), target: t });
    expect(res.installed).toBe(false);
    expect(t.fetch).toBe(original);
    const unset = baseEnv();
    delete unset.GATE_AI_CREDIT_KEYS;
    expect(installCreditKeyPool({ env: unset, logger: silentLogger(), target: t }).installed).toBe(false);
    expect(t.fetch).toBe(original);
  });

  test('gate on but no usable credit keys: not installed', () => {
    const t = target();
    const original = t.fetch;
    const env = baseEnv({ ANTHROPIC_CREDIT_KEYS: ` , ${MAIN_A},`, OPENAI_CREDIT_KEYS: '' });
    expect(installCreditKeyPool({ env, logger: silentLogger(), target: t }).installed).toBe(false);
    expect(t.fetch).toBe(original);
    const env2 = baseEnv();
    delete env2.ANTHROPIC_CREDIT_KEYS;
    delete env2.OPENAI_CREDIT_KEYS;
    expect(installCreditKeyPool({ env: env2, logger: silentLogger(), target: t }).installed).toBe(false);
  });

  test('installs once; a second install is a no-op; status has no key material', async () => {
    const t = target();
    const original = t.fetch;
    const logger = silentLogger();
    expect(installCreditKeyPool({ env: baseEnv(), logger, target: t }).installed).toBe(true);
    const wrapped = t.fetch;
    expect(wrapped).not.toBe(original);
    const second = installCreditKeyPool({ env: baseEnv(), logger, target: t });
    expect(second.installed).toBe(true);
    expect(t.fetch).toBe(wrapped);

    await wrapped(ANTHROPIC_URL, anthropicInit());
    expect(original).toHaveBeenCalledTimes(1);
    const status = getCreditKeyPoolStatus();
    expect(status.installed).toBe(true);
    expect(status.anthropic).toEqual([
      { index: 1, pausedUntil: null, reason: null },
      { index: 2, pausedUntil: null, reason: null },
    ]);
    const text = JSON.stringify(status) + JSON.stringify(logger.info.mock.calls);
    for (const k of [A1, A2, O1, O2, MAIN_A, MAIN_O]) expect(text).not.toContain(k);
  });

  test('de-duplicates keys and drops the main key', async () => {
    const t = target();
    const env = baseEnv({ ANTHROPIC_CREDIT_KEYS: ` ${A1} ,${A1},,${MAIN_A}, ${A2}` });
    installCreditKeyPool({ env, logger: silentLogger(), target: t });
    expect(getCreditKeyPoolStatus().anthropic.map((k) => k.index)).toEqual([1, 2]);
  });
});

describe('pass-through (original arguments, untouched)', () => {
  async function expectUntouched(input, init) {
    const base = makeBase();
    const { f } = pool(base);
    await f(input, init);
    expect(base).toHaveBeenCalledTimes(1);
    expect(base.mock.calls[0][0]).toBe(input);
    expect(base.mock.calls[0][1]).toBe(init);
  }

  test('non-AI host', () => expectUntouched('https://example.com/v1/messages', anthropicInit()));
  test('lookalike host', () => expectUntouched('https://api.anthropic.com.evil.test/v1/messages', anthropicInit()));
  test('GET', () => expectUntouched(ANTHROPIC_URL, anthropicInit(MAIN_A, { method: 'GET', body: undefined })));
  test('no init', () => expectUntouched(ANTHROPIC_URL, undefined));
  test.each(['/v1/sessions', '/v1/files', '/v1/messages/batches'])('anthropic path %s', (p) => expectUntouched(`https://api.anthropic.com${p}`, anthropicInit()));
  test('openai path outside the allowlist', () => expectUntouched('https://api.openai.com/v1/files', openaiInit()));
  test('anthropic call with some other key', () => expectUntouched(ANTHROPIC_URL, anthropicInit('some-other-key')));
  test('openai call with some other key', () => expectUntouched(OPENAI_CHAT, openaiInit('some-other-key')));
  test('ReadableStream body', () => expectUntouched(ANTHROPIC_URL, anthropicInit(MAIN_A, { body: new ReadableStream(), duplex: 'half' })));
  test('async iterable body', () => expectUntouched(OPENAI_CHAT, openaiInit(MAIN_O, { body: (async function* () { yield 'x'; })() })));
  test('Request object input', async () => {
    const base = makeBase();
    const { f } = pool(base);
    const req = new Request(ANTHROPIC_URL, { method: 'POST', headers: { 'x-api-key': MAIN_A }, body: '{}' });
    await f(req);
    expect(base.mock.calls[0][0]).toBe(req);
    expect(base.mock.calls[0][1]).toBeUndefined();
  });
  test('anthropic body naming a file_id or container', async () => {
    await expectUntouched(ANTHROPIC_URL, anthropicInit(MAIN_A, { body: '{"source":{"type":"file","file_id":"file_1"}}' }));
    await expectUntouched(ANTHROPIC_URL, anthropicInit(MAIN_A, { body: '{"container":"c1"}' }));
  });
  test('openai conversations that ask for or replay encrypted reasoning stay on the main key', async () => {
    await expectUntouched(OPENAI_RESP, openaiInit(MAIN_O, { body: '{"model":"m","store":false,"include":["reasoning.encrypted_content"]}' }));
    await expectUntouched(OPENAI_RESP, openaiInit(MAIN_O, { body: '{"model":"m","store":false,"input":[{"type":"reasoning","encrypted_content":"gAAA"}]}' }));
  });
  test('provider with no credit keys passes through', async () => {
    const base = makeBase();
    const { f } = pool(base, { env: baseEnv({ OPENAI_CREDIT_KEYS: '' }) });
    const init = openaiInit();
    await f(OPENAI_CHAT, init);
    expect(base.mock.calls[0][1]).toBe(init);
  });
});

describe('swap', () => {
  test('/v1/messages uses the credit key, removes the workspace header, ignores the query string', async () => {
    const base = makeBase();
    const { f } = pool(base);
    const res = await f(`${ANTHROPIC_URL}?beta=true`, anthropicInit());
    expect(res.status).toBe(200);
    expect(base).toHaveBeenCalledTimes(1);
    const h = base.calls[0].headers;
    expect(h.get('x-api-key')).toBe(A1);
    expect(h.get('anthropic-workspace-id')).toBeNull();
    expect(h.get('anthropic-version')).toBe('2023-06-01');
  });

  test('count_tokens and URL objects are swapped too', async () => {
    const base = makeBase();
    const { f } = pool(base);
    await f(new URL('https://api.anthropic.com/v1/messages/count_tokens'), anthropicInit());
    expect(base.calls[0].key).toBe(A1);
  });

  test('openai swap replaces authorization and drops org and project', async () => {
    const base = makeBase();
    const { f } = pool(base);
    await f(OPENAI_CHAT, openaiInit());
    const h = base.calls[0].headers;
    expect(h.get('authorization')).toBe(`Bearer ${O1}`);
    expect(h.get('openai-organization')).toBeNull();
    expect(h.get('openai-project')).toBeNull();
  });

  test('buffer and FormData bodies are swapped', async () => {
    const base = makeBase();
    const { f } = pool(base);
    const fd = new FormData();
    fd.append('model', 'whisper-1');
    await f('https://api.openai.com/v1/audio/transcriptions', openaiInit(MAIN_O, { body: fd }));
    await f('https://api.openai.com/v1/embeddings', openaiInit(MAIN_O, { body: Buffer.from('{}') }));
    expect(base.calls.map((c) => c.key)).toEqual([`Bearer ${O1}`, `Bearer ${O1}`]);
  });

  test('caller headers and init are never mutated (object, Headers, pairs)', async () => {
    const shapes = {
      object: () => ({ 'x-api-key': MAIN_A, 'anthropic-workspace-id': 'w' }),
      headers: () => new Headers({ 'x-api-key': MAIN_A, 'anthropic-workspace-id': 'w' }),
      pairs: () => [['x-api-key', MAIN_A], ['anthropic-workspace-id', 'w']],
    };
    for (const make of Object.values(shapes)) {
      const base = makeBase();
      const { f } = pool(base);
      const headers = make();
      const init = { method: 'POST', headers, body: '{}' };
      const snapshot = JSON.stringify([...new Headers(headers)]);
      await f(ANTHROPIC_URL, init);
      expect(base.calls[0].key).toBe(A1);
      expect(base.calls[0].headers.get('anthropic-workspace-id')).toBeNull();
      expect(init.headers).toBe(headers);
      expect(JSON.stringify([...new Headers(init.headers)])).toBe(snapshot);
      expect(Object.keys(init)).toEqual(['method', 'headers', 'body']);
    }
  });

  test('/v1/responses is swapped only with "store":false', async () => {
    const base = makeBase();
    const { f } = pool(base);
    await f(OPENAI_RESP, openaiInit(MAIN_O, { body: '{"model":"m", "store" : false}' }));
    expect(base.calls[0].key).toBe(`Bearer ${O1}`);

    const kept = openaiInit(MAIN_O, { body: '{"model":"m","store":true}' });
    await f(OPENAI_RESP, kept);
    expect(base.mock.calls[1][1]).toBe(kept);
    const none = openaiInit(MAIN_O, { body: '{"model":"m"}' });
    await f(OPENAI_RESP, none);
    expect(base.mock.calls[2][1]).toBe(none);
  });
});

describe('failover', () => {
  test('anthropic credit too low: next credit key, then the main key, original request', async () => {
    const base = makeBase((call) => (call.key === MAIN_A ? ok() : creditLow()));
    const { f, logger } = pool(base);
    const init = anthropicInit();
    const res = await f(ANTHROPIC_URL, init);
    expect(res.status).toBe(200);
    expect(base.calls.map((c) => c.key)).toEqual([A1, A2, MAIN_A]);
    expect(base.mock.calls[2][1]).toBe(init);
    expect(logger.warn).toHaveBeenCalledWith('[credit-keys] anthropic key 1 paused 6h: credit balance too low');
    expect(logger.warn).toHaveBeenCalledWith('[credit-keys] anthropic key 2 paused 6h: credit balance too low');
  });

  test('the "usage limits" message also fails over', async () => {
    const base = makeBase((call) => (call.key === A1
      ? json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'You have reached your specified API usage limits. You will regain access on 2026-11-01.' } })
      : ok()));
    const { f } = pool(base);
    await f(ANTHROPIC_URL, anthropicInit());
    expect(base.calls.map((c) => c.key)).toEqual([A1, A2]);
  });

  test('a pause skips the key until now passes it, then the key is used again', async () => {
    let t = 1_000_000;
    let a1Broke = true;
    const base = makeBase((call) => (call.key === A1 && a1Broke ? creditLow() : ok()));
    const { f, logger } = pool(base, { now: () => t });
    await f(ANTHROPIC_URL, anthropicInit());
    expect(base.calls.map((c) => c.key)).toEqual([A1, A2]);

    a1Broke = false;
    await f(ANTHROPIC_URL, anthropicInit());
    expect(base.calls.map((c) => c.key)).toEqual([A1, A2, A2]); // A1 skipped

    t += 6 * 60 * 60 * 1000 - 1;
    await f(ANTHROPIC_URL, anthropicInit());
    expect(base.calls[3].key).toBe(A2);

    t += 1;
    await f(ANTHROPIC_URL, anthropicInit());
    expect(base.calls[4].key).toBe(A1);
    expect(logger.info).toHaveBeenCalledWith('[credit-keys] anthropic key 1 back in use');
  });

  test('openai insufficient_quota: next credit key', async () => {
    const base = makeBase((call) => (call.key === `Bearer ${O1}` ? quota() : ok()));
    const { f, logger } = pool(base);
    const res = await f(OPENAI_CHAT, openaiInit());
    expect(res.status).toBe(200);
    expect(base.calls.map((c) => c.key)).toEqual([`Bearer ${O1}`, `Bearer ${O2}`]);
    expect(logger.warn).toHaveBeenCalledWith('[credit-keys] openai key 1 paused 6h: insufficient quota');
  });

  test('openai model_not_found 404 pauses 1 h', async () => {
    let t = 0;
    const base = makeBase((call) => (call.key === `Bearer ${O1}` ? json(404, { error: { code: 'model_not_found' } }) : ok()));
    const { f } = pool(base, { now: () => t });
    await f(OPENAI_CHAT, openaiInit());
    t = 60 * 60 * 1000 - 1;
    await f(OPENAI_CHAT, openaiInit());
    expect(base.calls[2].key).toBe(`Bearer ${O2}`);
    t = 60 * 60 * 1000;
    await f(OPENAI_CHAT, openaiInit());
    expect(base.calls[3].key).toBe(`Bearer ${O1}`);
  });

  test('a rate-limit 429 honors retry-after and is capped at 300 s', async () => {
    let t = 0;
    const base = makeBase((call) => (call.key === A1
      ? json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { 'retry-after': '120' })
      : ok()));
    const { f } = pool(base, { now: () => t });
    await f(ANTHROPIC_URL, anthropicInit());
    expect(base.calls.map((c) => c.key)).toEqual([A1, A2]);
    t = 119_999;
    await f(ANTHROPIC_URL, anthropicInit());
    expect(base.calls[2].key).toBe(A2);
    t = 120_000;
    await f(ANTHROPIC_URL, anthropicInit());
    expect(base.calls[3].key).toBe(A1);

    const capped = makeBase((call) => (call.key === A1 ? json(429, { error: {} }, { 'retry-after': '99999' }) : ok()));
    const second = pool(capped, { now: () => t });
    await second.f(ANTHROPIC_URL, anthropicInit());
    t += 299_999;
    await second.f(ANTHROPIC_URL, anthropicInit());
    expect(capped.calls[2].key).toBe(A2);
    t += 1;
    await second.f(ANTHROPIC_URL, anthropicInit());
    expect(capped.calls[3].key).toBe(A1);
  });

  test('a rate-limit 429 without retry-after pauses 60 s', async () => {
    let t = 0;
    const base = makeBase((call) => (call.key === A1 ? json(429, { error: {} }) : ok()));
    const { f } = pool(base, { now: () => t });
    await f(ANTHROPIC_URL, anthropicInit());
    t = 59_999;
    await f(ANTHROPIC_URL, anthropicInit());
    expect(base.calls[2].key).toBe(A2);
    t = 60_000;
    await f(ANTHROPIC_URL, anthropicInit());
    expect(base.calls[3].key).toBe(A1);
  });

  test('401 pauses the key 1 h and logs at error level', async () => {
    let t = 0;
    const base = makeBase((call) => (call.key === A1 ? json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) : ok()));
    const { f, logger } = pool(base, { now: () => t });
    await f(ANTHROPIC_URL, anthropicInit());
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toMatch(/^\[credit-keys\] anthropic key 1 paused 1h: /);
    t = 60 * 60 * 1000 - 1;
    await f(ANTHROPIC_URL, anthropicInit());
    expect(base.calls[2].key).toBe(A2);
    expect(logger.error).toHaveBeenCalledTimes(1);
    t = 60 * 60 * 1000;
    await f(ANTHROPIC_URL, anthropicInit());
    expect(base.calls[3].key).toBe(A1);
  });

  test('a 403 pauses the key 1 h for that model only', async () => {
    let t = 0;
    const base = makeBase((call) => (call.key === `Bearer ${O1}` && JSON.parse(call.init.body).model === 'm'
      ? json(403, { error: { message: 'no access to this model' } })
      : ok()));
    const { f, logger } = pool(base, { now: () => t });
    await f(OPENAI_CHAT, openaiInit());
    expect(base.calls.map((c) => c.key)).toEqual([`Bearer ${O1}`, `Bearer ${O2}`]);
    expect(logger.error).toHaveBeenCalledWith('[credit-keys] openai key 1 paused 1h for m: credit key refused (HTTP 403)');
    await f(OPENAI_CHAT, openaiInit());
    expect(base.calls[2].key).toBe(`Bearer ${O2}`);
    await f(OPENAI_CHAT, openaiInit(MAIN_O, { body: JSON.stringify({ model: 'other', messages: [] }) }));
    expect(base.calls[3].key).toBe(`Bearer ${O1}`);
    t = 60 * 60 * 1000;
    await f(OPENAI_CHAT, openaiInit());
    expect(base.calls[4].key).toBe(`Bearer ${O1}`);
    expect(logger.info).toHaveBeenCalledWith('[credit-keys] openai key 1 back in use for m');
  });

  test('an anthropic not_found_error 404 moves that model to the next key, other models stay', async () => {
    const base = makeBase((call) => (call.key === A1 && JSON.parse(call.init.body).model === 'claude-new'
      ? json(404, { type: 'error', error: { type: 'not_found_error', message: 'model: claude-new' } })
      : ok()));
    const { f } = pool(base);
    const res = await f(ANTHROPIC_URL, anthropicInit(MAIN_A, { body: JSON.stringify({ model: 'claude-new', messages: [] }) }));
    expect(res.status).toBe(200);
    expect(base.calls.map((c) => c.key)).toEqual([A1, A2]);
    await f(ANTHROPIC_URL, anthropicInit());
    expect(base.calls[2].key).toBe(A1);
  });

  test('an ordinary 400 goes back to the caller without failover', async () => {
    const bad = json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages: field required' } });
    const base = makeBase(() => bad);
    const { f } = pool(base);
    const res = await f(ANTHROPIC_URL, anthropicInit());
    expect(res).toBe(bad);
    expect(base).toHaveBeenCalledTimes(1);
  });

  test('non-JSON error body, 5xx and 529 are returned as-is', async () => {
    for (const make of [
      () => new Response('<html>nope</html>', { status: 429 }),
      () => json(500, { error: {} }),
      () => json(529, { type: 'error', error: { type: 'overloaded_error' } }),
    ]) {
      const res0 = make();
      const base = makeBase(() => res0);
      const { f } = pool(base);
      const res = await f(ANTHROPIC_URL, anthropicInit());
      expect(res).toBe(res0);
      expect(base).toHaveBeenCalledTimes(1);
    }
  });

  test('a network error on a credit key is rethrown, no failover', async () => {
    const base = makeBase(() => { throw new TypeError('fetch failed'); });
    const { f } = pool(base);
    await expect(f(ANTHROPIC_URL, anthropicInit())).rejects.toThrow('fetch failed');
    expect(base).toHaveBeenCalledTimes(1);
  });

  test('the main key response is always returned, even an error', async () => {
    const mainErr = creditLow();
    const base = makeBase((call) => (call.key === MAIN_A ? mainErr : creditLow()));
    const { f } = pool(base);
    const res = await f(ANTHROPIC_URL, anthropicInit());
    expect(res).toBe(mainErr);
    expect(base.calls.map((c) => c.key)).toEqual([A1, A2, MAIN_A]);
  });

  test('an SSE 200 response reaches the caller untouched', async () => {
    const sse = new Response('event: message_start\ndata: {}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const base = makeBase(() => sse);
    const { f } = pool(base);
    const res = await f(ANTHROPIC_URL, anthropicInit(MAIN_A, { body: JSON.stringify({ stream: true }) }));
    expect(res).toBe(sse);
    expect(res.bodyUsed).toBe(false);
    expect(await res.text()).toContain('message_start');
  });

  test('status never carries key material', async () => {
    const base = makeBase(() => creditLow());
    const { f } = pool(base);
    await f(ANTHROPIC_URL, anthropicInit());
    // status is read through the installed pool; check the pool object directly
    const status = f.__creditKeyPool.status();
    expect(status.anthropic[0].reason).toBe('credit balance too low');
    expect(status.anthropic[0].pausedUntil).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const text = JSON.stringify(status);
    for (const k of [A1, A2, O1, O2, MAIN_A, MAIN_O]) expect(text).not.toContain(k);
  });
});
