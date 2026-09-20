/**
 * Public interview self-scheduling routes (server/routes/public-careers.js,
 * /interview/:token). Dark-gate 404 before the limiter, token format gate
 * before any DB read, generic 404 for unknown/ineligible tokens, the GET
 * open/booked shape, book's atomic-update 409 on a race, book's 400s,
 * withdraw's happy path + 404 on a race, and no PII in logger calls.
 */

const mockIsEnabled = jest.fn(() => true);
jest.mock('../config/feature-gates', () => ({ isEnabled: (...args) => mockIsEnabled(...args) }));

const mockListInterviewSlots = jest.fn(async () => []);
const mockFormatSlotLabel = jest.fn(() => 'Tue Mar 16, 4:00 PM');
jest.mock('../services/interview-slots', () => ({
  listInterviewSlots: (...args) => mockListInterviewSlots(...args),
  formatSlotLabel: (...args) => mockFormatSlotLabel(...args),
}));

const mockSendStageComms = jest.fn(async () => ({ sms: 'not_requested', email: 'not_requested' }));
const mockConfirmationSmsEligible = jest.fn(() => false);
const mockErrorSummary = jest.fn((err) => (err && err.message) || 'error');
jest.mock('../services/recruiting-comms', () => ({
  contactOf: (app) => (app && app.contact_snapshot) || {},
  firstNameOf: (name) => (String(name || '').trim().split(/\s+/)[0] || 'there'),
  sendStageComms: (...args) => mockSendStageComms(...args),
  confirmationSmsEligible: (...args) => mockConfirmationSmsEligible(...args),
  errorSummary: (...args) => mockErrorSummary(...args),
}));

const mockTriggerNotification = jest.fn(async () => {});
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: (...args) => mockTriggerNotification(...args),
}));

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../services/logger', () => mockLogger);

// job_applications-only fake db, keyed on interview_token / id / status.
let onFirstReadOnce = null;
const onNthFirstAfterHooks = {};
// Counter-based hooks, keyed by which .first() call (1-based) they should
// run BEFORE — unlike onFirstReadOnce (which fires AFTER the snapshot, to
// simulate a race with the row-lock read itself), these mutate the row
// before it is read, so a specific LATER .first() call (e.g. the book
// route's post-commit confirmation re-read) sees the mutated state. The
// book route's calls in order: #1 the row-lock read inside the txn, #2 the
// confirmation block's post-commit re-read.
let firstCallCount = 0;
const onNthFirstHooks = {};
const mockDb = jest.fn((table) => {
  if (table !== 'job_applications') throw new Error(`unexpected table in test: ${table}`);
  let whereCond = {};
  const builder = {
    where(cond) { whereCond = { ...whereCond, ...cond }; return builder; },
    forUpdate() { return builder; },
    first() {
      firstCallCount += 1;
      const preHook = onNthFirstHooks[firstCallCount];
      if (preHook) {
        delete onNthFirstHooks[firstCallCount];
        preHook();
      }
      const row = mockDb.__rows().find((r) => Object.entries(whereCond).every(([k, v]) => r[k] === v));
      // Snapshot BEFORE running the hook — the hook mutates the same
      // underlying row object in place to simulate a race with a later
      // write, and the caller of first() must see the pre-mutation value
      // exactly as a real SELECT already in flight would.
      const snapshot = row ? { ...row } : undefined;
      if (onFirstReadOnce) {
        const fn = onFirstReadOnce;
        onFirstReadOnce = null;
  for (const k of Object.keys(onNthFirstAfterHooks)) delete onNthFirstAfterHooks[k];
        fn();
      }
      // Post-snapshot hook on the Nth read (same race semantics as
      // onFirstReadOnce, for routes that read more than once).
      const postHook = onNthFirstAfterHooks[firstCallCount];
      if (postHook) {
        delete onNthFirstAfterHooks[firstCallCount];
        postHook();
      }
      return Promise.resolve(snapshot);
    },
    update(payload) {
      return {
        returning: () => {
          // jsonb columns round-trip through Postgres as parsed values —
          // the real route JSON.stringify()s status_history before writing.
          const resolved = { ...payload };
          const appends = {};
          for (const key of ['status_history', 'comms_history']) {
            if (typeof resolved[key] === 'string') {
              try { resolved[key] = JSON.parse(resolved[key]); } catch { /* leave as-is */ }
            } else if (resolved[key] && resolved[key].__rawAppend) {
              // The route appends history in SQL (`status_history || ?::jsonb`)
              // — simulate the concat against the row's current value.
              appends[key] = resolved[key].__rawAppend;
              delete resolved[key];
            }
          }
          const matches = mockDb.__rows().filter((r) => Object.entries(whereCond).every(([k, v]) => r[k] === v));
          for (const r of matches) {
            Object.assign(r, resolved);
            for (const [key, entries] of Object.entries(appends)) {
              r[key] = [...(Array.isArray(r[key]) ? r[key] : []), ...entries];
            }
          }
          return Promise.resolve(matches.map((r) => ({ ...r })));
        },
      };
    },
  };
  return builder;
});
let dbRows = [];
mockDb.__rows = () => dbRows;
mockDb.__setRows = (rows) => { dbRows = rows; };
mockDb.__onFirstReadOnce = (fn) => { onFirstReadOnce = fn; };
mockDb.__onNthFirst = (n, fn) => { onNthFirstHooks[n] = fn; };
mockDb.__onNthFirstAfter = (n, fn) => { onNthFirstAfterHooks[n] = fn; };
mockDb.schema = { hasTable: jest.fn(async () => true) };
// The book route runs inside one transaction: the trx is the same mock, and
// every raw call is recorded so the test can prove the advisory lock is
// taken BEFORE the slot listing.
mockDb.__rawCalls = [];
mockDb.transaction = async (fn) => fn(mockDb);
// db.raw is only used for the jsonb history append; carry the bound entries
// so update() above can apply them like Postgres would.
mockDb.raw = jest.fn((sql, bindings) => {
  mockDb.__rawCalls.push(sql);
  if (/\|\| \?::jsonb/.test(sql) && Array.isArray(bindings)) {
    return { __rawAppend: JSON.parse(bindings[0]) };
  }
  return { sql, bindings };
});
jest.mock('../models/db', () => mockDb);

const express = require('express');
const publicCareersRouter = require('../routes/public-careers');

const TOKEN = 'a'.repeat(64);
const PII_PHONE = '9415550142';
const PII_EMAIL = 'jane@example.com';
const PII_NAME = 'Jane Doe';

function appRow(overrides = {}) {
  return {
    id: 'app-1',
    status: 'interview',
    interview_token: TOKEN,
    interview_mode: null,
    interview_at: null,
    interview_end_at: null,
    interview_booked_at: null,
    sms_consent: false,
    comms_history: [],
    status_history: [],
    contact_snapshot: { name: PII_NAME, phone: PII_PHONE, email: PII_EMAIL },
    language: 'en',
    ...overrides,
  };
}

let server;
let base;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/public/careers', publicCareersRouter);
  server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

beforeEach(() => {
  jest.clearAllMocks();
  mockIsEnabled.mockReturnValue(true);
  mockListInterviewSlots.mockResolvedValue([]);
  mockFormatSlotLabel.mockReturnValue('Tue Mar 16, 4:00 PM');
  mockConfirmationSmsEligible.mockReturnValue(false);
  mockSendStageComms.mockResolvedValue({ sms: 'not_requested', email: 'not_requested' });
  mockTriggerNotification.mockResolvedValue(undefined);
  mockDb.__setRows([]);
  onFirstReadOnce = null;
  firstCallCount = 0;
  for (const k of Object.keys(onNthFirstHooks)) delete onNthFirstHooks[k];
});

describe('dark gate', () => {
  test('GATE_RECRUITING_COMMS off -> 404 on every interview route, before the limiter', async () => {
    mockIsEnabled.mockReturnValue(false);
    mockDb.__setRows([appRow()]);
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production'; // arm the real limiter (30/10min)
    try {
      // 40 rapid requests exceeds the 30/10min cap — if the limiter ran
      // BEFORE the gate, request #31+ would 429, not 404.
      for (let i = 0; i < 40; i++) {
         
        const res = await fetch(`${base}/api/public/careers/interview/${TOKEN}`);
         
        const body = await res.json();
        expect(res.status).toBe(404);
        expect(body).toEqual({ error: 'Not found' });
      }
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('dark gate also covers book and withdraw', async () => {
    mockIsEnabled.mockReturnValue(false);
    const bookRes = await fetch(`${base}/api/public/careers/interview/${TOKEN}/book`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'phone', start: 'x' }),
    });
    expect(bookRes.status).toBe(404);
    const withdrawRes = await fetch(`${base}/api/public/careers/interview/${TOKEN}/withdraw`, { method: 'POST' });
    expect(withdrawRes.status).toBe(404);
  });
});

describe('token format gate', () => {
  test('a malformed token 404s before any DB read', async () => {
    for (const bad of ['short', 'A'.repeat(64), `${'a'.repeat(63)}g`, `${'a'.repeat(63)}!`, '']) {
       
      const res = await fetch(`${base}/api/public/careers/interview/${bad || 'x'}`);
      expect(res.status).toBe(404);
    }
    expect(mockDb).not.toHaveBeenCalled();
  });
});

describe('GET /interview/:token', () => {
  test('unknown token -> generic 404', async () => {
    mockDb.__setRows([]);
    const res = await fetch(`${base}/api/public/careers/interview/${TOKEN}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  test('non-interview status -> generic 404', async () => {
    mockDb.__setRows([appRow({ status: 'withdrawn' })]);
    const res = await fetch(`${base}/api/public/careers/interview/${TOKEN}`);
    expect(res.status).toBe(404);
  });

  test('open (not booked) shape', async () => {
    mockDb.__setRows([appRow()]);
    mockListInterviewSlots.mockResolvedValue([{ start: 's', end: 'e', date: 'd', label: 'l' }]);
    const res = await fetch(`${base}/api/public/careers/interview/${TOKEN}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      first_name: 'Jane',
      status: 'open',
      mode_options: ['phone', 'in_person'],
      in_person_address: expect.any(String),
      timezone: 'America/New_York',
      booked: null,
      slots: [{ start: 's', end: 'e', date: 'd', label: 'l' }],
    });
  });

  test('booked shape includes mode/start/end/label', async () => {
    mockDb.__setRows([appRow({
      interview_mode: 'phone',
      interview_at: '2027-03-16T20:00:00.000Z',
      interview_end_at: '2027-03-16T20:30:00.000Z',
      interview_booked_at: '2027-03-15T00:00:00.000Z',
    })]);
    const res = await fetch(`${base}/api/public/careers/interview/${TOKEN}`);
    const body = await res.json();
    expect(body.status).toBe('booked');
    expect(body.booked).toEqual({
      mode: 'phone',
      start: '2027-03-16T20:00:00.000Z',
      end: '2027-03-16T20:30:00.000Z',
      label: 'Tue Mar 16, 4:00 PM',
    });
  });
});

describe('POST /interview/:token/book', () => {
  test('books under the booking advisory lock, listing slots through the transaction after the lock', async () => {
    const offered = { start: '2027-03-16T20:00:00.000Z', end: '2027-03-16T20:30:00.000Z', date: '2027-03-16', label: 'Tue Mar 16, 4:00 PM' };
    mockDb.__setRows([appRow()]);
    mockDb.__rawCalls.length = 0;
    mockListInterviewSlots.mockClear();
    mockListInterviewSlots.mockResolvedValue([offered]);
    const res = await fetch(`${base}/api/public/careers/interview/${TOKEN}/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'phone', start: offered.start }),
    });
    expect(res.status).toBe(200);
    const lockIdx = mockDb.__rawCalls.findIndex((sql) => /pg_advisory_xact_lock/.test(sql));
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    // Slot listing happened inside the transaction (conn is the trx) and
    // only after the lock was requested.
    // (the response payload lists slots a second time, outside the transaction)
    expect(mockListInterviewSlots).toHaveBeenCalled();
    expect(mockListInterviewSlots.mock.calls[0][0]).toMatchObject({ conn: mockDb });
    expect(mockDb.raw.mock.invocationCallOrder[lockIdx]).toBeLessThan(mockListInterviewSlots.mock.invocationCallOrder[0]);
  });

  const OFFERED = { start: '2027-03-16T20:00:00.000Z', end: '2027-03-16T20:30:00.000Z', date: '2027-03-16', label: 'Tue Mar 16, 4:00 PM' };

  test('a retried identical booking is idempotent: no rewrite, no second confirmation, no second bell', async () => {
    mockDb.__setRows([appRow({
      interview_mode: 'phone', interview_at: OFFERED.start, interview_end_at: OFFERED.end,
      interview_booked_at: '2027-03-01T15:00:00.000Z', status_history: [{ from: 'interview', to: 'interview', by: 'applicant' }],
    })]);
    mockListInterviewSlots.mockResolvedValue([OFFERED]);
    mockSendStageComms.mockClear();
    mockTriggerNotification.mockClear();
    const res = await fetch(`${base}/api/public/careers/interview/${TOKEN}/book`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'phone', start: OFFERED.start }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('booked');
    expect(mockDb.__rows()[0].status_history).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 5));
    expect(mockSendStageComms).not.toHaveBeenCalled();
    expect(mockTriggerNotification).not.toHaveBeenCalled();
  });

  test('unknown token + unparseable body -> generic 404 (eligibility before body validation)', async () => {
    mockDb.__setRows([]);
    const res = await fetch(`${base}/api/public/careers/interview/${TOKEN}/book`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'phone', start: 'not-a-time' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  test('400 on an invalid mode', async () => {
    mockDb.__setRows([appRow()]);
    const res = await fetch(`${base}/api/public/careers/interview/${TOKEN}/book`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'carrier-pigeon', start: OFFERED.start }),
    });
    expect(res.status).toBe(400);
  });

  test('400 when the start is not in the currently offered set (never trusts the client)', async () => {
    mockDb.__setRows([appRow()]);
    mockListInterviewSlots.mockResolvedValue([OFFERED]);
    const res = await fetch(`${base}/api/public/careers/interview/${TOKEN}/book`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'phone', start: '2027-03-16T21:00:00.000Z' }),
    });
    expect(res.status).toBe(400);
  });

  test('happy path: books, writes interview_* columns, notifies, confirms', async () => {
    mockDb.__setRows([appRow()]);
    mockListInterviewSlots.mockResolvedValue([OFFERED]);
    const res = await fetch(`${base}/api/public/careers/interview/${TOKEN}/book`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'phone', start: OFFERED.start }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('booked');
    expect(body.booked.mode).toBe('phone');

    const row = mockDb.__rows()[0];
    expect(row.interview_mode).toBe('phone');
    expect(row.interview_at).toBe(OFFERED.start);
    expect(row.interview_end_at).toBe(OFFERED.end);
    expect(row.interview_booked_at).toBeInstanceOf(Date);
    expect(row.status).toBe('interview'); // status_history note, not a status change
    expect(row.status_history).toHaveLength(1);
    expect(row.status_history[0]).toMatchObject({ from: 'interview', to: 'interview', by: 'applicant' });

    await Promise.resolve(); // let the fire-and-forget block settle
    await new Promise((r) => setImmediate(r));
    expect(mockSendStageComms).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'app-1' }),
      'interview_confirmation',
      expect.objectContaining({ email: true, by: 'applicant' }),
    );
    expect(mockTriggerNotification).toHaveBeenCalledWith('job_interview_booked', expect.objectContaining({
      applicationId: 'app-1', mode: 'phone', whenLabel: OFFERED.label,
    }));
  });

  test('sendStageComms rejecting does not suppress the owner bell — triggerNotification still fires', async () => {
    mockDb.__setRows([appRow()]);
    mockListInterviewSlots.mockResolvedValue([OFFERED]);
    mockSendStageComms.mockRejectedValue(new Error('sendgrid down'));
    const res = await fetch(`${base}/api/public/careers/interview/${TOKEN}/book`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'phone', start: OFFERED.start }),
    });
    expect(res.status).toBe(200);

    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    expect(mockTriggerNotification).toHaveBeenCalledWith('job_interview_booked', expect.objectContaining({
      applicationId: 'app-1', mode: 'phone', whenLabel: OFFERED.label,
    }));
  });

  test('a withdraw racing in right after the commit skips the confirmation send — the owner bell still fires (Codex P2)', async () => {
    mockDb.__setRows([appRow()]);
    mockListInterviewSlots.mockResolvedValue([OFFERED]);
    // .first() call #1 is the row-lock read inside the txn (booking
    // proceeds normally on it); call #2 is the confirmation block's
    // post-commit re-read — mutate the row to 'withdrawn' right before it,
    // simulating a withdraw request that completed in between.
    mockDb.__onNthFirst(3, () => {
      const row = mockDb.__rows()[0];
      row.status = 'withdrawn';
      row.status_history = [...row.status_history, { from: 'interview', to: 'withdrawn', by: 'applicant' }];
    });
    const res = await fetch(`${base}/api/public/careers/interview/${TOKEN}/book`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'phone', start: OFFERED.start }),
    });
    // The HTTP response reflects what THIS request committed — the race is
    // with a second, concurrent request.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('booked');

    await Promise.resolve();
    await new Promise((r) => setImmediate(r));

    expect(mockSendStageComms).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('app-1'));
    // No PII (name/phone/email) in the skip log.
    expect(mockLogger.info.mock.calls.flat().join(' ')).not.toEqual(expect.stringContaining(PII_EMAIL));
    // The owner bell block is independent — it already fired before the
    // confirmation block's re-read runs.
    expect(mockTriggerNotification).toHaveBeenCalledWith('job_interview_booked', expect.objectContaining({
      applicationId: 'app-1', mode: 'phone', whenLabel: OFFERED.label,
    }));
  });

  test('409 when the atomic update matches 0 rows (status changed between read and write)', async () => {
    mockDb.__setRows([appRow()]);
    mockListInterviewSlots.mockResolvedValue([OFFERED]);
    mockDb.__onNthFirstAfter(2, () => { mockDb.__rows()[0].status = 'withdrawn'; });
    const res = await fetch(`${base}/api/public/careers/interview/${TOKEN}/book`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'phone', start: OFFERED.start }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'This link is no longer active.' });
  });

  test('unknown/ineligible token -> generic 404, not a validation error', async () => {
    mockDb.__setRows([]);
    const res = await fetch(`${base}/api/public/careers/interview/${TOKEN}/book`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'phone', start: OFFERED.start }),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /interview/:token/withdraw', () => {
  test('happy path: status -> withdrawn, notifies, 200 ok', async () => {
    mockDb.__setRows([appRow()]);
    const res = await fetch(`${base}/api/public/careers/interview/${TOKEN}/withdraw`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const row = mockDb.__rows()[0];
    expect(row.status).toBe('withdrawn');
    expect(row.status_history[0]).toMatchObject({ from: 'interview', to: 'withdrawn', by: 'applicant' });

    await new Promise((r) => setImmediate(r));
    expect(mockTriggerNotification).toHaveBeenCalledWith('job_application_withdrawn', { applicationId: 'app-1' });
  });

  test('404 when the atomic update matches 0 rows (race)', async () => {
    mockDb.__setRows([appRow()]);
    mockDb.__onFirstReadOnce(() => { mockDb.__rows()[0].status = 'offer'; });
    const res = await fetch(`${base}/api/public/careers/interview/${TOKEN}/withdraw`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  test('unknown token -> 404', async () => {
    mockDb.__setRows([]);
    const res = await fetch(`${base}/api/public/careers/interview/${TOKEN}/withdraw`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('no PII in logger calls', () => {
  test('the phone/email/name from a full GET + book + withdraw cycle never reach the logger', async () => {
    mockDb.__setRows([appRow()]);
    mockListInterviewSlots.mockResolvedValue([{ start: 's', end: 'e', date: 'd', label: 'l' }]);
    await fetch(`${base}/api/public/careers/interview/${TOKEN}`);
    mockDb.__setRows([appRow()]);
    mockListInterviewSlots.mockResolvedValue([
      { start: '2027-03-16T20:00:00.000Z', end: '2027-03-16T20:30:00.000Z', date: '2027-03-16', label: 'l' },
    ]);
    await fetch(`${base}/api/public/careers/interview/${TOKEN}/book`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'phone', start: '2027-03-16T20:00:00.000Z' }),
    });
    await new Promise((r) => setImmediate(r));
    await fetch(`${base}/api/public/careers/interview/${TOKEN}/withdraw`, { method: 'POST' });

    const allLogged = [...mockLogger.info.mock.calls, ...mockLogger.warn.mock.calls, ...mockLogger.error.mock.calls]
      .flat().map((v) => JSON.stringify(v));
    for (const line of allLogged) {
      expect(line).not.toContain(PII_PHONE);
      expect(line).not.toContain(PII_EMAIL);
      expect(line).not.toContain(PII_NAME);
    }
  });
});
