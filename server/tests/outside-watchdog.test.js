/**
 * Outside watchdog (ops/outside-watchdog/): the MacBook Air job that polls the portal from
 * outside. Covers the poll script's --json report against a stub portal that checks the
 * signature with the portal's own signer, the delivery rules (reconcile + outbox), the row
 * words against composeAdminAlert and the ingest route's validator, the email hand-off, and
 * one end-to-end run of deliver.js.
 */
jest.mock('../models/db', () => {
  const db = jest.fn();
  db.raw = jest.fn();
  db.transaction = jest.fn();
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { signCanonical, canonicalTarget, KEY_RECORDS } = require('../middleware/link-worker-auth');
const { composeAdminAlert } = require('../services/admin-alert-compose');
const { validateDigest } = require('../routes/ops-digest-ingest')._private;
const deliver = require('../../ops/outside-watchdog/deliver');

jest.setTimeout(60000);

const REPO = path.join(__dirname, '..', '..');
const PYTHON = process.env.OUTSIDE_WATCHDOG_TEST_PYTHON || 'python3';
const SECRET = 'outside-watchdog-test-secret-0123456789abcdef';
const TOKEN = 'outside-watchdog-test-token-0123456789';
const EMPTY_SHA = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');

const tmpDirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-watchdog-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// The Air layout: the poll next to sign-request.py copied as sign_request.py.
function installPollFiles(dir) {
  fs.copyFileSync(path.join(REPO, 'docs/hermes/watchdog_poll.py'), path.join(dir, 'watchdog_poll.py'));
  fs.copyFileSync(path.join(REPO, 'docs/hermes/sign-request.py'), path.join(dir, 'sign_request.py'));
}

function snapshot({ reasons = [], scheduler = {} } = {}) {
  return {
    observed_at: '2026-11-06T20:00:00.000Z',
    environment: 'production',
    uptime_s: 3600,
    database: { ok: true, latency_ms: 3 },
    scheduler: {
      available: true, crons_enabled: true, heartbeat_job: 'hermes-watchdog-liveness', last_tick_at: '2026-11-06T19:50:00.000Z',
      age_minutes: 10, silent_after_minutes: 60, ok: true, ...scheduler,
    },
    jobs: { available: true, total: 3, unhealthy: 0, items: [] },
    ops_queue: { available: true, pending: 0, parked: 0, failed: 0, lanes: [] },
    link_worker: { available: true, last_claim_at: null, last_report_at: null, open_leases: 0, stale_leases: 0 },
    verdict: reasons.length ? 'attention' : 'healthy',
    reasons,
  };
}

// A stub portal: the watchdog status route (signature checked with the portal's signer)
// and the ops digest ingest (each body run through the route's own validator).
async function startPortal() {
  const portal = { status: 200, body: snapshot(), ingestStatus: 201, polls: [], posts: [], resolves: [] };
  const send = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  portal.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url.startsWith('/api/integrations/watchdog-worker/status')) {
        const h = req.headers;
        const expected = signCanonical(SECRET, {
          timestamp: h['x-waves-timestamp'], nonce: h['x-waves-nonce'], method: 'GET', target: canonicalTarget(req.url), bodyHash: EMPTY_SHA,
        });
        const signed = h['x-waves-key-id'] === 'hermes_watchdog' && h['x-waves-signature'] === expected;
        portal.polls.push({ signed });
        if (!signed) return send(res, 401, { error: 'invalid signature' });
        return send(res, portal.status, portal.body);
      }
      if (req.method === 'POST' && req.url === '/api/ops/digest') {
        const body = JSON.parse(raw);
        portal.posts.push({ auth: req.headers.authorization, body, check: validateDigest(body) });
        if (portal.ingestStatus !== 201) return send(res, portal.ingestStatus, { ok: false, reason: 'in_app_disabled' });
        return send(res, 201, { ok: true, id: `row-${portal.posts.length}`, deduped: false });
      }
      if (req.method === 'POST' && req.url === '/api/ops/digest/resolve') {
        portal.resolves.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
        return send(res, 200, { ok: true, resolved: 1 });
      }
      return send(res, 404, { error: 'not found' });
    });
  });
  await new Promise((resolve) => { portal.server.listen(0, '127.0.0.1', resolve); });
  portal.url = `http://127.0.0.1:${portal.server.address().port}`;
  portal.close = () => new Promise((resolve) => { portal.server.close(resolve); });
  return portal;
}

function run(cmd, args, env) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function pollEnv(dir, portal, extra = {}) {
  const env = { ...process.env, PORTAL_URL: portal.url, WAVES_WATCHDOG_STATE: path.join(dir, 'poll-state.json'), LINK_WORKER_SECRET_HERMES_WATCHDOG: SECRET, ...extra };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return env;
}

const pollJson = async (dir, portal, extra) => {
  const r = await run(PYTHON, [path.join(dir, 'watchdog_poll.py'), '--json'], pollEnv(dir, portal, extra));
  expect(r.code).toBe(0);
  const lines = r.stdout.trim().split('\n');
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]);
};

describe('watchdog_poll.py --json against a portal that checks the signature', () => {
  let portal;
  let dir;
  beforeEach(async () => {
    portal = await startPortal();
    dir = tmpDir();
    installPollFiles(dir);
  });
  afterEach(() => portal.close());

  test('a healthy poll: one JSON line, no pages, the scheduler block, a signed request', async () => {
    const report = await pollJson(dir, portal);
    expect(report).toMatchObject({ result: 'ok', detail: 'ok', pages: [], reasons: [], consecutive_failures: 0, down_since: null });
    expect(report.scheduler).toMatchObject({ heartbeat_job: 'hermes-watchdog-liveness', age_minutes: 10, ok: true });
    expect(report.observed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(portal.polls).toEqual([{ signed: true }]);
  });

  test('plain mode is unchanged: a healthy poll prints nothing', async () => {
    const r = await run(PYTHON, [path.join(dir, 'watchdog_poll.py')], pollEnv(dir, portal));
    expect(r).toMatchObject({ code: 0, stdout: '' });
  });

  test('3 failed polls page "down"; the first good poll pages "back" with the outage start', async () => {
    portal.status = 500;
    const first = await pollJson(dir, portal);
    expect(first).toMatchObject({ result: 'down', pages: [], consecutive_failures: 1 });
    await pollJson(dir, portal);
    const third = await pollJson(dir, portal);
    expect(third.consecutive_failures).toBe(3);
    expect(third.pages).toHaveLength(1);
    expect(third.pages[0].type).toBe('down');
    expect(third.pages[0].text.startsWith(`🚨 Waves portal DOWN or degraded since ${third.down_since} — HTTP 500`)).toBe(true);
    portal.status = 200;
    const back = await pollJson(dir, portal);
    expect(back).toMatchObject({ result: 'ok', consecutive_failures: 0, down_since: null });
    expect(back.pages).toEqual([{ type: 'back', since: third.down_since, text: `✅ Waves portal reachable again (down since ${third.down_since}).` }]);
  });

  test('a 404 is setup, not an outage: one config page, then quiet for 24 h', async () => {
    portal.status = 404;
    portal.body = { error: 'watchdog lane disabled' };
    const first = await pollJson(dir, portal);
    expect(first).toMatchObject({ result: 'config', consecutive_failures: 0 });
    expect(first.detail).toMatch(/^HTTP 404: /);
    expect(first.pages).toEqual([{ type: 'config', text: `🔧 Waves watchdog not configured: ${first.detail}. Polls continue; nothing is down.` }]);
    expect((await pollJson(dir, portal)).pages).toEqual([]);
  });

  test('a silent scheduler shows in reasons and as an attention page', async () => {
    portal.body = snapshot({ reasons: ['scheduler:silent'], scheduler: { age_minutes: 74, ok: false } });
    const report = await pollJson(dir, portal);
    expect(report).toMatchObject({ result: 'ok', reasons: ['scheduler:silent'] });
    expect(report.scheduler).toMatchObject({ age_minutes: 74, silent_after_minutes: 60 });
    expect(report.pages.map((p) => p.type)).toEqual(['attention']);
  });

  test('no secret in env or on disk is a local error (exit 2), never a poll', async () => {
    const r = await run(PYTHON, [path.join(dir, 'watchdog_poll.py'), '--json'], pollEnv(dir, portal, { LINK_WORKER_SECRET_HERMES_WATCHDOG: undefined }));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('LINK_WORKER_SECRET_HERMES_WATCHDOG');
    expect(portal.polls).toEqual([]);
  });

  test('sign_request SECRET_ENV names the same env var the portal reads for each key', async () => {
    const r = await run(PYTHON, ['-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(dir)}); import sign_request as s; print(json.dumps({"env": s.SECRET_ENV, "files": sorted(s.SECRET_FILES)}))`], process.env);
    expect(r.code).toBe(0);
    const { env, files } = JSON.parse(r.stdout);
    expect(Object.keys(env).sort()).toEqual(files);
    expect(env).toEqual(Object.fromEntries(Object.entries(KEY_RECORDS).map(([id, rec]) => [id, rec.secretEnv])));
  });
});

// ---------------------------------------------------------------------------
// Delivery rules
// ---------------------------------------------------------------------------

const T0 = Date.parse('2026-11-06T20:00:00.000Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const report = (over = {}) => ({
  result: 'ok', detail: 'ok', pages: [], reasons: [], consecutive_failures: 0, down_since: null,
  scheduler: { age_minutes: 5, silent_after_minutes: 60 }, ...over,
});

function fakeIo({ post = () => ({ ok: true }), resolve = () => ({ ok: true }), mail = () => ({ ok: true }) } = {}) {
  const calls = { posts: [], resolves: [], mails: [] };
  const io = {
    runPoll: async () => { throw new Error('not used here'); },
    postRow: async (row) => { calls.posts.push(row); return post(row); },
    resolveRow: async (key, observedAt) => { calls.resolves.push({ key, observedAt }); return resolve(key, observedAt); },
    sendEmail: async (m) => { calls.mails.push(m); return mail(m); },
  };
  return { io, calls };
}

async function step(state, rep, io, minute) {
  deliver.reconcile(state, rep, at(minute));
  return deliver.flush(state, io, new Date(at(minute)));
}

const down = (n, minute = 0, detail = 'unreachable (URLError)') => report({ result: 'down', detail, consecutive_failures: n, down_since: at(minute - (n - 1) * 10) });

describe('delivery: portal down', () => {
  test('the down alert waits for 3 failed polls; a down portal takes no row, so it goes by email', async () => {
    const state = deliver.defaultState();
    const { io, calls } = fakeIo({ post: () => ({ ok: false, reason: 'unreachable:TimeoutError' }) });
    await step(state, down(1, 0), io, 0);
    await step(state, down(2, 10), io, 10);
    expect(calls.posts).toHaveLength(0);
    await step(state, down(3, 20), io, 20);
    expect(calls.posts).toHaveLength(1);
    expect(calls.posts[0]).toMatchObject({ key: deliver.KEYS.down, headline: 'System — check why the portal is down or degraded' });
    expect(calls.mails).toHaveLength(1);
    expect(calls.mails[0].subject).toBe('FIX: Waves portal down or degraded (outside watchdog)');
    expect(state.down).toMatchObject({ open: true, via: 'email' });
    expect(state.outbox).toEqual([]);
    await step(state, down(4, 30), io, 30);
    await step(state, down(5, 40), io, 40);
    expect(calls.mails).toHaveLength(1);
  });

  test('recovery after an email alert: a closing email, the down row retired, one outage row', async () => {
    const state = deliver.defaultState();
    let portalUp = false;
    const { io, calls } = fakeIo({ post: () => (portalUp ? { ok: true } : { ok: false, reason: 'unreachable:TimeoutError' }) });
    await step(state, down(3, 20), io, 20);
    portalUp = true;
    await step(state, report(), io, 50);
    expect(calls.mails.map((m) => m.subject)).toEqual([
      'FIX: Waves portal down or degraded (outside watchdog)',
      'Waves portal answering again (outside watchdog)',
    ]);
    expect(calls.resolves.map((r) => r.key)).toContain(deliver.KEYS.down);
    const outage = calls.posts[calls.posts.length - 1];
    expect(outage.key).toBe(`outside-watchdog-outage:${at(0)}`);
    expect(outage.headline).toBe('System — find why the portal was down');
    expect(outage.summary).toBe('It was down or degraded from Nov 6, 3:00 PM to Nov 6, 3:50 PM.');
    expect(state.down).toMatchObject({ open: false, via: null });
    expect(state.outbox).toEqual([]);
  });

  test('a down alert that landed as a row closes as a row: no email at all', async () => {
    const state = deliver.defaultState();
    const { io, calls } = fakeIo();
    await step(state, down(3, 20, 'HTTP 500 '), io, 20);
    expect(state.down.via).toBe('row');
    await step(state, report(), io, 40);
    expect(calls.mails).toEqual([]);
    expect(calls.posts.map((p) => p.key)).toEqual([deliver.KEYS.down, `outside-watchdog-outage:${at(0)}`]);
  });

  test('an alert that fails both ways stays owed and is retried; recovery drops it, still retires its row, and keeps the outage row', async () => {
    const state = deliver.defaultState();
    const failing = fakeIo({ post: () => ({ ok: false, reason: 'unreachable:TypeError' }), mail: () => ({ ok: false, reason: 'exit_1' }) });
    await step(state, down(3, 20), failing.io, 20);
    expect(state.outbox).toHaveLength(1);
    expect(state.outbox[0]).toMatchObject({ kind: 'alert', slot: 'down', tries: 1 });
    await step(state, down(4, 30), failing.io, 30);
    expect(state.outbox[0].tries).toBe(2);
    expect(failing.calls.mails).toHaveLength(2);
    const healthy = fakeIo();
    await step(state, report(), healthy.io, 40);
    // A timed-out POST may have landed, so the dropped alert's row is retired anyway.
    expect(healthy.calls.resolves).toEqual([{ key: deliver.KEYS.down, observedAt: at(40) }]);
    expect(healthy.calls.mails).toEqual([]);
    expect(healthy.calls.posts.map((p) => p.key)).toEqual([`outside-watchdog-outage:${at(0)}`]);
    expect(state.outbox).toEqual([]);
  });

  test('the closing email goes once while the retire is retried', async () => {
    const state = deliver.defaultState();
    const viaEmail = fakeIo({ post: () => ({ ok: false, reason: 'unreachable:TimeoutError' }) });
    await step(state, down(3, 20), viaEmail.io, 20);
    expect(state.down.via).toBe('email');
    const noResolve = fakeIo({ resolve: () => ({ ok: false, reason: 'unreachable:TypeError' }) });
    await step(state, report(), noResolve.io, 30);
    await deliver.flush(state, noResolve.io, new Date(at(40)));
    expect(noResolve.calls.mails.map((m) => m.subject)).toEqual(['Waves portal answering again (outside watchdog)']);
    expect(state.outbox).toEqual([expect.objectContaining({ kind: 'clear', slot: 'down', resolved: false, emailed: true, tries: 2 })]);
    const healthy = fakeIo();
    await deliver.flush(state, healthy.io, new Date(at(50)));
    expect(healthy.calls.mails).toEqual([]);
    expect(healthy.calls.resolves).toEqual([{ key: deliver.KEYS.down, observedAt: at(30) }]);
    expect(state.outbox).toEqual([]);
  });

  test('a configuration answer also ends the outage (the portal answered)', async () => {
    const state = deliver.defaultState();
    const { io, calls } = fakeIo();
    await step(state, down(3, 20), io, 20);
    await step(state, report({ result: 'config', detail: 'HTTP 404: the watchdog lane is off' }), io, 30);
    expect(state.down.open).toBe(false);
    expect(calls.posts.map((p) => p.key)).toEqual([deliver.KEYS.down, `outside-watchdog-outage:${at(0)}`, deliver.KEYS.setup]);
  });
});

describe('delivery: job runner', () => {
  const silent = (age = 74) => report({ reasons: ['scheduler:silent', 'job:x:failing'], scheduler: { age_minutes: age, silent_after_minutes: 60 } });

  test('a runner reason opens one row after 2 good polls in a row, replacing any standing row, and closes itself', async () => {
    const state = deliver.defaultState();
    const { io, calls } = fakeIo();
    await step(state, silent(74), io, 0);
    expect(calls.posts).toEqual([]);
    await step(state, silent(84), io, 10);
    expect(calls.resolves).toEqual([{ key: deliver.KEYS.runner, observedAt: at(10) }]);
    expect(calls.posts).toHaveLength(1);
    expect(calls.posts[0]).toMatchObject({
      key: deliver.KEYS.runner, kind: 'FIX', audience: 'engineering', link: '/admin/agents?tab=queue',
      headline: 'System — find why portal crons stopped', summary: 'No scheduler tick for 84 min, so no scheduled job runs.', observedAt: at(10),
    });
    await step(state, silent(94), io, 20);
    expect(calls.posts).toHaveLength(1);
    await step(state, report(), io, 30);
    expect(calls.resolves[calls.resolves.length - 1]).toEqual({ key: deliver.KEYS.runner, observedAt: at(30) });
    expect(calls.mails).toEqual([]);
    expect(state.runner).toMatchObject({ open: null, seen: null, polls: 0 });
  });

  test('one dropped tick (seen once, gone on the next poll) writes nothing', async () => {
    const state = deliver.defaultState();
    const { io, calls } = fakeIo();
    await step(state, silent(), io, 0);
    await step(state, report(), io, 10);
    expect(calls).toEqual({ posts: [], resolves: [], mails: [] });
  });

  test('a changed reason rewrites the row (crons turned off while silent)', async () => {
    const state = deliver.defaultState();
    const { io, calls } = fakeIo();
    await step(state, silent(), io, 0);
    await step(state, silent(), io, 10);
    const off = report({ reasons: ['scheduler:disabled'], scheduler: { age_minutes: 90, ok: false } });
    await step(state, off, io, 20);
    expect(calls.posts).toHaveLength(1);
    await step(state, off, io, 30);
    expect(calls.posts.map((p) => p.headline)).toEqual(['System — find why portal crons stopped', 'System — check why portal crons are off']);
    expect(state.runner.open).toBe('scheduler:disabled');
  });

  test('a down or refused poll cannot see the scheduler: the runner count holds', async () => {
    const state = deliver.defaultState();
    const { io, calls } = fakeIo();
    await step(state, silent(), io, 0);
    await step(state, down(1, 10), io, 10);
    expect(state.runner).toMatchObject({ seen: 'scheduler:silent', polls: 1 });
    await step(state, silent(), io, 20);
    expect(calls.posts.map((p) => p.key)).toEqual([deliver.KEYS.runner]);
  });

  test('an emailed alert keeps its closing email when a changed reason lands as a row', async () => {
    const state = deliver.defaultState();
    let ingestUp = false;
    const { io, calls } = fakeIo({ post: () => (ingestUp ? { ok: true } : { ok: false, status: 409, reason: 'in_app_disabled' }) });
    await step(state, silent(), io, 0);
    await step(state, silent(), io, 10);
    expect(state.runner).toMatchObject({ via: 'email', emailed: true });
    ingestUp = true;
    const off = report({ reasons: ['scheduler:disabled'], scheduler: { age_minutes: 90, ok: false } });
    await step(state, off, io, 20);
    await step(state, off, io, 30);
    expect(state.runner).toMatchObject({ open: 'scheduler:disabled', via: 'row', emailed: true });
    await step(state, report(), io, 40);
    expect(calls.mails.map((m) => m.subject)).toEqual(['FIX: Waves portal crons stopped (outside watchdog)', 'Waves portal crons running again (outside watchdog)']);
    expect(state.runner).toMatchObject({ open: null, via: null, emailed: false });
  });

  test('a row the portal refuses goes by email, and the email gets its closing email', async () => {
    const state = deliver.defaultState();
    const { io, calls } = fakeIo({ post: () => ({ ok: false, status: 409, reason: 'in_app_disabled' }) });
    await step(state, silent(), io, 0);
    await step(state, silent(), io, 10);
    expect(state.runner.via).toBe('email');
    await step(state, report(), io, 20);
    expect(calls.mails.map((m) => m.subject)).toEqual(['FIX: Waves portal crons stopped (outside watchdog)', 'Waves portal crons running again (outside watchdog)']);
  });
});

describe('delivery: setup and the outbox', () => {
  test('a refused poll opens one setup row; a changed refusal rewrites it; a good poll closes it', async () => {
    const state = deliver.defaultState();
    const { io, calls } = fakeIo();
    const refused = (detail) => report({ result: 'config', detail });
    await step(state, refused('HTTP 404: the watchdog lane is off'), io, 0);
    await step(state, refused('HTTP 404: the watchdog lane is off'), io, 10);
    expect(calls.posts).toHaveLength(1);
    expect(calls.posts[0].summary).toBe('The watchdog lane is off on the portal, so the outside check sees nothing.');
    await step(state, refused('HTTP 401: the watchdog signature was rejected'), io, 20);
    expect(calls.posts.map((p) => p.summary)).toEqual([
      'The watchdog lane is off on the portal, so the outside check sees nothing.',
      'The portal rejected the watchdog signature, so the outside check sees nothing.',
    ]);
    await step(state, report(), io, 30);
    expect(calls.resolves[calls.resolves.length - 1]).toEqual({ key: deliver.KEYS.setup, observedAt: at(30) });
    expect(state.setup.open).toBe(false);
  });

  test('a setup alert that went by email keeps its closing email after a changed refusal lands as a row', async () => {
    const state = deliver.defaultState();
    let ingestUp = false;
    const { io, calls } = fakeIo({ post: () => (ingestUp ? { ok: true } : { ok: false, reason: 'unreachable:TimeoutError' }) });
    await step(state, report({ result: 'config', detail: 'HTTP 404: the watchdog lane is off' }), io, 0);
    expect(state.setup).toMatchObject({ via: 'email', emailed: true });
    ingestUp = true;
    await step(state, report({ result: 'config', detail: 'HTTP 401: the watchdog signature was rejected' }), io, 10);
    expect(state.setup).toMatchObject({ via: 'row', emailed: true });
    await step(state, report(), io, 20);
    expect(calls.mails.map((m) => m.subject)).toEqual(['FIX: the Waves portal refuses the outside watchdog poll', 'Outside watchdog poll working again']);
  });

  test('a write owed for over 48 h is dropped', async () => {
    const state = deliver.defaultState();
    const failing = fakeIo({ post: () => ({ ok: false, reason: 'x' }), mail: () => ({ ok: false, reason: 'y' }) });
    await step(state, down(3, 20), failing.io, 20);
    expect(state.outbox).toHaveLength(1);
    const wrote = await deliver.flush(state, failing.io, new Date(T0 + 49 * 3600 * 1000));
    expect(wrote).toEqual(['alert:down=dropped']);
    expect(state.outbox).toEqual([]);
  });

  test('a clear for a row that stands is retried until the resolve lands', async () => {
    const state = deliver.defaultState();
    const ok = fakeIo();
    await step(state, report({ result: 'config', detail: 'HTTP 403: refused' }), ok.io, 0);
    const failing = fakeIo({ resolve: () => ({ ok: false, reason: 'unreachable:TypeError' }) });
    await step(state, report(), failing.io, 10);
    expect(state.outbox).toEqual([expect.objectContaining({ kind: 'clear', slot: 'setup', resolved: false, tries: 1 })]);
    expect(state.outbox[0]).not.toHaveProperty('email');
    await deliver.flush(state, ok.io, new Date(at(20)));
    expect(state.outbox).toEqual([]);
  });

  test('state round-trips; a corrupt file or a malformed outbox item starts clean', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'deliver-state.json');
    const state = deliver.defaultState();
    state.runner = { ...state.runner, seen: 'scheduler:silent', polls: 1 };
    deliver.saveState(file, state);
    expect(deliver.loadState(file, [])).toEqual(state);
    fs.writeFileSync(file, '{not json');
    const notes = [];
    expect(deliver.loadState(file, notes)).toEqual(deliver.defaultState());
    expect(notes).toEqual(['state file corrupt, starting fresh']);
    fs.writeFileSync(file, JSON.stringify({ outbox: [{ id: 'a', kind: 'alert', key: 'k', at: at(0) }, { id: 'b', kind: 'clear', key: 'k', at: at(0), via: 'row' }] }));
    expect(deliver.loadState(file, []).outbox.map((i) => i.id)).toEqual(['b']);
    fs.writeFileSync(file, JSON.stringify({ down: 'open', runner: ['x'] }));
    expect(deliver.loadState(file, [])).toEqual(deliver.defaultState());
  });
});

// ---------------------------------------------------------------------------
// Words: every row is contract-clean and passes the ingest route's validator.
// ---------------------------------------------------------------------------

describe('row words', () => {
  const cases = [
    ['down', deliver.downAlert({ since: at(0), failures: 3, detail: 'unreachable (URLError)', portalUrl: 'https://portal.wavespestcontrol.com' })],
    ['outage', deliver.outageAlert({ since: at(0), until: at(50), failures: 5 })],
    ['runner silent', deliver.runnerAlert('scheduler:silent', { age_minutes: 74, silent_after_minutes: 60 })],
    ['runner never ticked', deliver.runnerAlert('scheduler:silent', { age_minutes: null })],
    ['runner off', deliver.runnerAlert('scheduler:disabled', {})],
    ['runner unreadable', deliver.runnerAlert('scheduler:unavailable', null)],
    ...['HTTP 401: x', 'HTTP 403: x', 'HTTP 404: x', 'HTTP 503: x', 'HTTP 418: x'].map((d) => [`setup ${d}`, deliver.setupAlert(d)]),
  ];

  test.each(cases)('%s: composeAdminAlert accepts it and the row matches the composed words', (_name, parts) => {
    const composed = composeAdminAlert(parts.spec);
    expect(parts.headline).toBe(composed.headline);
    expect(parts.summary).toBe(composed.why);
    expect(composed.metadata).toMatchObject({ area: 'System', severity: 'broken', who: 'claude', subject: { type: 'check', id: deliver.CHECK_ID } });
    expect(parts.body.endsWith(deliver.SIGNATURE)).toBe(true);
    expect(parts.emailSubject.length).toBeLessThanOrEqual(180);
  });

  test.each(cases)('%s: the ingest route accepts the row as an engineering FIX row for Claude', (_name, parts) => {
    const row = deliver.rowFor('outside-watchdog-runner', parts, at(0));
    const checked = validateDigest(row);
    expect(checked.error).toBeUndefined();
    expect(checked.value).toMatchObject({ kind: 'FIX', audience: 'engineering', link: '/admin/agents?tab=queue', headline: parts.headline, summary: parts.summary });
    // The fault launcher's mark (who claude + severity broken) survives the route.
    expect(checked.value.metadata).toMatchObject({ who: 'claude', severity: 'broken', check: { id: 'outside-watchdog' } });
  });

  test('an outage key passes the ingest key rule', () => {
    const state = deliver.defaultState();
    deliver.reconcile(state, down(3, 20), at(20));
    deliver.reconcile(state, report(), at(30));
    const outage = state.outbox.find((i) => i.key.startsWith('outside-watchdog-outage:'));
    expect(validateDigest(outage.row).error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The email hand-off and one end-to-end run
// ---------------------------------------------------------------------------

function fakeEmailScript(dir, { exitCode = 0, printSent = true } = {}) {
  const script = path.join(dir, 'send-email.js');
  fs.writeFileSync(script, `
const fs = require('fs');
const args = process.argv.slice(2);
const file = args[args.indexOf('--body-file') + 1];
fs.appendFileSync(${JSON.stringify(path.join(dir, 'sent.jsonl'))}, JSON.stringify({ args, body: fs.readFileSync(file, 'utf8') }) + '\\n');
${printSent ? "console.log('[2026-11-06T20:00:00.000Z] SENT <id> response=250');" : ''}
process.exit(${exitCode});
`);
  return script;
}
const sentMail = (dir) => {
  const file = path.join(dir, 'sent.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

describe('email hand-off to send-email.js', () => {
  test('internal inbox, --force-email, the body in a file that is removed after', async () => {
    const dir = tmpDir();
    const cfg = { ...deliver.settings({ HOME: dir, OUTSIDE_WATCHDOG_DIR: dir }), emailScript: fakeEmailScript(dir) };
    await expect(deliver.sendEmail(cfg, { subject: 'FIX: test', body: 'line one' })).resolves.toEqual({ ok: true });
    const [mail] = sentMail(dir);
    expect(mail.args.slice(0, 5)).toEqual(['--force-email', '--to', deliver.OPS_INBOX, '--subject', 'FIX: test']);
    expect(mail.body).toBe('line one\n');
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('email-body-'))).toEqual([]);
  });

  test('a crash after the SENT line counts as sent (a retry would send it twice); no SENT and a failed exit is a failure', async () => {
    const dir = tmpDir();
    const base = deliver.settings({ HOME: dir, OUTSIDE_WATCHDOG_DIR: dir });
    await expect(deliver.sendEmail({ ...base, emailScript: fakeEmailScript(dir, { exitCode: 1 }) }, { subject: 's', body: 'b' })).resolves.toEqual({ ok: true });
    await expect(deliver.sendEmail({ ...base, emailScript: fakeEmailScript(dir, { exitCode: 1, printSent: false }) }, { subject: 's', body: 'b' }))
      .resolves.toEqual({ ok: false, reason: 'exit_1' });
  });
});

describe('deliver.js end to end (node + the poll script + a stub portal)', () => {
  test('3 failed polls post a down row, recovery retires it and posts the outage row', async () => {
    const portal = await startPortal();
    try {
      const dir = tmpDir();
      installPollFiles(dir);
      const env = {
        ...process.env,
        HOME: dir,
        OUTSIDE_WATCHDOG_DIR: dir,
        OUTSIDE_WATCHDOG_PORTAL_URL: portal.url,
        OUTSIDE_WATCHDOG_PYTHON: PYTHON,
        OUTSIDE_WATCHDOG_EMAIL_SCRIPT: fakeEmailScript(dir),
        OPS_DIGEST_INGEST_TOKEN: TOKEN,
        LINK_WORKER_SECRET_HERMES_WATCHDOG: SECRET,
      };
      const once = () => run(process.execPath, [path.join(REPO, 'ops/outside-watchdog/deliver.js')], env);

      const healthy = await once();
      expect(healthy.code).toBe(0);
      expect(healthy.stdout).toMatch(/ poll=ok failures=0 runner=- wrote=- owed=0\n$/);

      portal.status = 503;
      portal.body = { ok: false };
      await once();
      await once();
      const third = await once();
      expect(third.code).toBe(0);
      expect(third.stdout).toContain('poll=down failures=3');
      expect(third.stdout).toContain('wrote=alert:down=row');

      portal.status = 200;
      portal.body = snapshot();
      const back = await once();
      expect(back.code).toBe(0);
      expect(back.stdout).toContain('wrote=clear:down=row,alert:outage=row');

      expect(portal.polls.every((p) => p.signed)).toBe(true);
      expect(portal.posts.map((p) => p.body.key)).toEqual([deliver.KEYS.down, expect.stringMatching(/^outside-watchdog-outage:/)]);
      for (const post of portal.posts) {
        expect(post.auth).toBe(`Bearer ${TOKEN}`);
        expect(post.check.error).toBeUndefined();
      }
      // The replace before the down post, the down row's retire after recovery.
      expect(portal.resolves.map((r) => r.body.key)).toEqual([deliver.KEYS.down, deliver.KEYS.down]);
      expect(sentMail(dir)).toEqual([]);
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'deliver-state.json'), 'utf8'));
      expect(saved.outbox).toEqual([]);
    } finally {
      await portal.close();
    }
  });

  test('a poll that cannot run is a local error (exit 2) and the log line says why', async () => {
    const dir = tmpDir();
    const r = await run(process.execPath, [path.join(REPO, 'ops/outside-watchdog/deliver.js')], {
      ...process.env, HOME: dir, OUTSIDE_WATCHDOG_DIR: dir, OUTSIDE_WATCHDOG_PYTHON: PYTHON, OUTSIDE_WATCHDOG_POLL_SCRIPT: path.join(dir, 'missing.py'),
    });
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/poll=error .* note=the poll failed \(exit 2\)/);
  });
});
