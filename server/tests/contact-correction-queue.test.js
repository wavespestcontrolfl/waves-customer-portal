/**
 * Durable contact-correction queue (codex #3413 r17): DB-backed
 * replacement for the in-memory reservation slot. Contracts under test:
 *
 *  - reserve/enqueue/cancel lifecycle — a reservation records arrival
 *    order durably; enqueue attaches the payload and never resurrects a
 *    cancelled row; cancel only touches rows still 'reserved'.
 *  - per-sender ordering fence — a newer job never runs while an older
 *    job for the same sender is reserved, queued, or running, so source
 *    order holds across overlapping deploy instances.
 *  - crash recovery — stale 'running' locks requeue; stale 'reserved'
 *    rows (route died before its finally) are promoted when the message
 *    still shows correction intent and links to a single customer, and
 *    cancelled otherwise. This is the replay for a message whose
 *    MessageSid claim was durable but whose detached run died.
 *  - runner integration — the worker passes the persisted CAS baseline
 *    as matchedSnapshot and retries ONLY the runner's internal-error
 *    shape, up to max_attempts.
 *
 * Synthetic fixtures only — never real customer data.
 */

const CUSTOMER_ID = '00000000-0000-4000-8000-0000000000c1';

jest.mock('../models/db', () => {
  const dbMock = jest.fn();
  dbMock.fn = { now: jest.fn(() => ({ __now: true })) };
  dbMock.raw = jest.fn((sql) => ({ __raw: sql }));
  dbMock.transaction = jest.fn();
  dbMock.schema = { hasTable: jest.fn(async () => false) };
  return dbMock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockDetectIntent = jest.fn();
const mockRunSms = jest.fn();
jest.mock('../services/contact-correction', () => ({
  detectContactCorrectionIntent: (...args) => mockDetectIntent(...args),
  runSmsContactCorrection: (...args) => mockRunSms(...args),
}));

const queue = require('../services/contact-correction-queue');

// ---------------------------------------------------------------------------
// Minimal thenable knex stub — supports exactly the shapes the queue issues.
// Timestamps are epoch ms; fn.now()/raw('now() ± interval …') resolve
// against Date.now() at evaluation time.
// ---------------------------------------------------------------------------
function makeStubKnex(rowsByTable = {}) {
  const data = {};
  for (const [table, rows] of Object.entries(rowsByTable)) data[table] = rows.map((r) => ({ ...r }));
  let nextId = 1000;

  const MIN = 60_000;
  function resolveVal(v) {
    if (v && v.__now) return Date.now();
    if (v && v.__raw) {
      const m = /now\(\)\s*([+-])\s*interval\s*'(\d+)\s*minutes?'/i.exec(v.__raw);
      if (m) return Date.now() + (m[1] === '-' ? -1 : 1) * Number(m[2]) * MIN;
      return v.__raw;
    }
    return v;
  }

  function builder(table) {
    if (!data[table]) data[table] = [];
    const preds = [];
    let order = null;
    let lim = null;
    const chain = {
      where(a, b, c) {
        if (typeof a === 'object' && a !== null) {
          for (const [k, v] of Object.entries(a)) preds.push((r) => r[k] === v);
        } else if (c !== undefined) {
          preds.push((r) => {
            const rv = r[a];
            const cv = resolveVal(c);
            if (b === '<=') return rv != null && rv <= cv;
            if (b === '<') return rv != null && rv < cv;
            if (b === '>=') return rv != null && rv >= cv;
            if (b === '>') return rv != null && rv > cv;
            return rv === cv;
          });
        } else {
          preds.push((r) => r[a] === b);
        }
        return chain;
      },
      whereIn(col, vals) { preds.push((r) => vals.includes(r[col])); return chain; },
      whereNotIn(col, vals) { preds.push((r) => !vals.includes(r[col])); return chain; },
      whereNot(col, val) { preds.push((r) => r[col] !== val); return chain; },
      whereNull(col) { preds.push((r) => r[col] == null); return chain; },
      orderBy(col, dir = 'asc') { order = { col, dir }; return chain; },
      limit(n) { lim = n; return chain; },
      forUpdate() { return chain; },
      skipLocked() { return chain; },
      _select() {
        let rows = data[table].filter((r) => preds.every((p) => p(r)));
        if (order) rows = [...rows].sort((x, y) => (x[order.col] < y[order.col] ? -1 : 1) * (order.dir === 'desc' ? -1 : 1));
        if (lim != null) rows = rows.slice(0, lim);
        return rows.map((r) => ({ ...r }));
      },
      then(onOk, onErr) { return Promise.resolve(chain._select()).then(onOk, onErr); },
      first(...cols) {
        const row = chain._select()[0];
        if (!row) return Promise.resolve(undefined);
        if (!cols.length) return Promise.resolve(row);
        return Promise.resolve(Object.fromEntries(cols.map((c) => [c, row[c]])));
      },
      update(vals) {
        const matched = data[table].filter((r) => preds.every((p) => p(r)));
        for (const r of matched) {
          for (const [k, v] of Object.entries(vals)) {
            if (v && v.__raw === 'attempts + 1') r[k] = Number(r.attempts || 0) + 1;
            else if (v && v.__raw && /GREATEST/i.test(v.__raw)) r[k] = Math.max(Number(r.attempts || 0) - 1, 0);
            else r[k] = resolveVal(v);
          }
        }
        const result = Promise.resolve(matched.length);
        result.returning = () => Promise.resolve(matched.map((r) => ({ ...r })));
        return result;
      },
      insert(row) {
        const stored = {
          id: ++nextId,
          status: 'reserved',
          attempts: 0,
          max_attempts: 3,
          next_attempt_at: Date.now(),
          created_at: Date.now(),
          ...row,
        };
        data[table].push(stored);
        const result = Promise.resolve([{ ...stored }]);
        result.returning = () => Promise.resolve([{ ...stored }]);
        return result;
      },
    };
    return chain;
  }

  const stub = (table) => builder(table);
  stub.fn = { now: () => ({ __now: true }) };
  stub.raw = (sql) => ({ __raw: sql });
  stub.schema = { hasTable: async () => true };
  stub.transaction = async (fn) => fn(stub);
  stub._data = data;
  return stub;
}

const jobRow = (over = {}) => ({
  id: 1,
  sender_key: '5550001111',
  sender_phone: '+15550001111',
  message_sid: 'SM-test-1',
  body: 'You spelled my last name wrong, it is Rivers',
  customer_id: null,
  sms_log_id: null,
  expected_values: null,
  status: 'reserved',
  attempts: 0,
  max_attempts: 3,
  next_attempt_at: Date.now() - 1000,
  locked_at: null,
  locked_by: null,
  created_at: Date.now() - 1000,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockDetectIntent.mockReturnValue(true);
  mockRunSms.mockResolvedValue({ applied: [], skipped: [], reason: 'no_corrections' });
});

describe('reservation lifecycle', () => {
  it('reserve inserts an arrival-order row keyed on the sender tail-10', async () => {
    const knex = makeStubKnex();
    const id = await queue.reserveContactCorrectionJob({
      senderPhone: '+1 (555) 000-1111', messageSid: 'SM-1', body: 'my name is wrong, it is Rivers', knex,
    });
    expect(id).toBeTruthy();
    const row = knex._data.contact_correction_jobs[0];
    expect(row.sender_key).toBe('5550001111');
    expect(row.status).toBe('reserved');
  });

  it('enqueue attaches the payload and never resurrects a cancelled row', async () => {
    const knex = makeStubKnex({ contact_correction_jobs: [jobRow(), jobRow({ id: 2, status: 'cancelled' })] });
    const ok = await queue.enqueueContactCorrectionJob(1, {
      customerId: CUSTOMER_ID, smsLogId: 'sms-1', expectedValues: { last_name: 'Riverz' }, knex,
    });
    expect(ok).toBe(true);
    expect(knex._data.contact_correction_jobs[0].status).toBe('queued');
    expect(knex._data.contact_correction_jobs[0].customer_id).toBe(CUSTOMER_ID);

    const revived = await queue.enqueueContactCorrectionJob(2, { customerId: CUSTOMER_ID, knex });
    expect(revived).toBe(false);
    expect(knex._data.contact_correction_jobs[1].status).toBe('cancelled');
  });

  it('cancel releases only rows still reserved', async () => {
    const knex = makeStubKnex({ contact_correction_jobs: [jobRow(), jobRow({ id: 2, status: 'queued' })] });
    expect(await queue.cancelContactCorrectionJob(1, 'route_exit', { knex })).toBe(true);
    expect(knex._data.contact_correction_jobs[0].status).toBe('cancelled');
    expect(await queue.cancelContactCorrectionJob(2, 'route_exit', { knex })).toBe(false);
    expect(knex._data.contact_correction_jobs[1].status).toBe('queued');
  });
});

describe('per-sender ordering fence', () => {
  it('an older active job blocks the same sender\'s newer queued job — across passes, source order wins', async () => {
    const knex = makeStubKnex({
      contact_correction_jobs: [
        jobRow({ id: 1, status: 'queued', customer_id: CUSTOMER_ID, body: 'older correction, it is Riverson' }),
        jobRow({ id: 2, status: 'queued', customer_id: CUSTOMER_ID, body: 'newer correction, it is Rivers' }),
      ],
      customers: [{ id: CUSTOMER_ID, deleted_at: null, last_name: 'Riverz' }],
    });
    // Claim-one-per-iteration (round-18): the pass drains the sender's
    // queue in id order — the newer job is claimed only AFTER the older
    // one completed and released the fence.
    const first = await queue.processDueContactCorrectionJobs({ limit: 3, knex });
    expect(first.claimed).toBe(2);
    expect(mockRunSms).toHaveBeenCalledTimes(2);
    expect(mockRunSms.mock.calls[0][0].body).toContain('older correction');
    expect(mockRunSms.mock.calls[1][0].body).toContain('newer correction');
    expect(knex._data.contact_correction_jobs[0].status).toBe('done');
    expect(knex._data.contact_correction_jobs[1].status).toBe('done');
  });

  it('a still-reserved older message blocks the sender\'s queue (no out-of-order run)', async () => {
    const knex = makeStubKnex({
      contact_correction_jobs: [
        jobRow({ id: 1, status: 'reserved', created_at: Date.now() - 1000 }),
        jobRow({ id: 2, status: 'queued', customer_id: CUSTOMER_ID }),
      ],
      customers: [{ id: CUSTOMER_ID, deleted_at: null }],
    });
    const summary = await queue.processDueContactCorrectionJobs({ limit: 3, knex });
    expect(summary.claimed).toBe(0);
    expect(mockRunSms).not.toHaveBeenCalled();
  });

  it('different senders claim independently in one pass', async () => {
    const knex = makeStubKnex({
      contact_correction_jobs: [
        jobRow({ id: 1, status: 'queued', customer_id: CUSTOMER_ID }),
        jobRow({ id: 2, status: 'queued', customer_id: CUSTOMER_ID, sender_key: '5550002222', sender_phone: '+15550002222' }),
      ],
      customers: [{ id: CUSTOMER_ID, deleted_at: null }],
    });
    const summary = await queue.processDueContactCorrectionJobs({ limit: 3, knex });
    expect(summary.claimed).toBe(2);
  });
});

describe('crash recovery', () => {
  it('requeues stale running locks', async () => {
    const knex = makeStubKnex({
      contact_correction_jobs: [
        jobRow({ id: 1, status: 'running', customer_id: CUSTOMER_ID, locked_at: Date.now() - 11 * 60_000, locked_by: 'dead:1' }),
      ],
      customers: [{ id: CUSTOMER_ID, deleted_at: null }],
    });
    const summary = await queue.processDueContactCorrectionJobs({ limit: 3, knex });
    expect(summary.recovered).toBe(1);
    // Recovered job is claimable in the same pass.
    expect(summary.claimed).toBe(1);
    expect(knex._data.contact_correction_jobs[0].status).toBe('done');
  });

  it('promotes a stale reservation carrying its source-time context (linkage + CAS baseline)', async () => {
    // (round-19) The route stamped linkage + match-time baseline before
    // dying — promotion replays exactly that context, never re-deriving
    // linkage from current phone ownership.
    const snapshot = { last_name: 'Riverz', phone: '+15550001111' };
    const knex = makeStubKnex({
      contact_correction_jobs: [jobRow({ id: 1, customer_id: CUSTOMER_ID, expected_values: snapshot, created_at: Date.now() - 11 * 60_000 })],
      customers: [{ id: CUSTOMER_ID, deleted_at: null }],
      sms_log: [{ id: 'sms-9', twilio_sid: 'SM-test-1', direction: 'inbound', created_at: Date.now() }],
    });
    const summary = await queue.processDueContactCorrectionJobs({ limit: 3, knex });
    expect(summary.promoted).toBe(1);
    expect(summary.claimed).toBe(1);
    const job = knex._data.contact_correction_jobs[0];
    expect(job.status).toBe('done');
    expect(job.customer_id).toBe(CUSTOMER_ID);
    expect(job.sms_log_id).toBe('sms-9');
    // The stored match-time baseline rides into the runner.
    expect(mockRunSms.mock.calls[0][0].matchedSnapshot).toEqual(snapshot);
  });

  it('cancels stale reservations with no intent or no source-time context', async () => {
    // (round-19) A reservation that died before the route's context stamp
    // (or on a pre-match exit path like spam-block whose cancel failed)
    // fails closed — re-deriving linkage from current phone ownership
    // could attach an old SMS to a number's new owner.
    mockDetectIntent.mockReturnValueOnce(false);
    const knex = makeStubKnex({
      contact_correction_jobs: [
        jobRow({ id: 1, customer_id: CUSTOMER_ID, created_at: Date.now() - 11 * 60_000 }),
        jobRow({ id: 2, sender_key: '5550002222', sender_phone: '+15550002222', message_sid: 'SM-test-2', created_at: Date.now() - 11 * 60_000 }),
      ],
    });
    const summary = await queue.processDueContactCorrectionJobs({ limit: 3, knex });
    expect(summary.promoted).toBe(0);
    expect(knex._data.contact_correction_jobs[0].status).toBe('cancelled');
    expect(knex._data.contact_correction_jobs[0].cancel_reason).toBe('stale_no_intent');
    expect(knex._data.contact_correction_jobs[1].status).toBe('cancelled');
    expect(knex._data.contact_correction_jobs[1].cancel_reason).toBe('stale_no_context');
  });

  it('a fresh reservation is left alone by the stale sweep', async () => {
    const knex = makeStubKnex({ contact_correction_jobs: [jobRow({ id: 1, created_at: Date.now() - 1000 })] });
    await queue.processDueContactCorrectionJobs({ limit: 3, knex });
    expect(knex._data.contact_correction_jobs[0].status).toBe('reserved');
  });
});

describe('runner integration', () => {
  it('passes the persisted CAS baseline as matchedSnapshot and records the result', async () => {
    const snapshot = { first_name: 'Jordan', last_name: 'Riverz', phone: '+15550001111' };
    const knex = makeStubKnex({
      contact_correction_jobs: [jobRow({ id: 1, status: 'queued', customer_id: CUSTOMER_ID, sms_log_id: 'sms-1', expected_values: snapshot })],
      customers: [{ id: CUSTOMER_ID, deleted_at: null, last_name: 'Riverz' }],
    });
    mockRunSms.mockResolvedValue({ applied: [{ field: 'last_name' }], skipped: [], reason: undefined });
    const summary = await queue.processDueContactCorrectionJobs({ limit: 3, knex });
    expect(summary.succeeded).toBe(1);
    const args = mockRunSms.mock.calls[0][0];
    expect(args.customer.id).toBe(CUSTOMER_ID);
    expect(args.smsLogId).toBe('sms-1');
    expect(args.senderPhone).toBe('+15550001111');
    expect(args.matchedSnapshot).toEqual(snapshot);
    expect(knex._data.contact_correction_jobs[0].status).toBe('done');
  });

  it('a deleted customer resolves the job without running the extractor', async () => {
    const knex = makeStubKnex({
      contact_correction_jobs: [jobRow({ id: 1, status: 'queued', customer_id: CUSTOMER_ID })],
      customers: [{ id: CUSTOMER_ID, deleted_at: Date.now() }],
    });
    const summary = await queue.processDueContactCorrectionJobs({ limit: 3, knex });
    expect(summary.succeeded).toBe(1);
    expect(mockRunSms).not.toHaveBeenCalled();
    expect(knex._data.contact_correction_jobs[0].status).toBe('done');
  });

  it('retries only the runner\'s internal-error shape, then fails terminally at max_attempts', async () => {
    mockRunSms.mockResolvedValue({ applied: [], skipped: [], reason: 'error' });
    const knex = makeStubKnex({
      contact_correction_jobs: [jobRow({ id: 1, status: 'queued', customer_id: CUSTOMER_ID, max_attempts: 2 })],
      customers: [{ id: CUSTOMER_ID, deleted_at: null }],
    });
    let summary = await queue.processDueContactCorrectionJobs({ limit: 3, knex });
    expect(summary.failed).toBe(1);
    const job = knex._data.contact_correction_jobs[0];
    expect(job.status).toBe('queued');
    expect(job.attempts).toBe(1);
    // Backoff pushed next_attempt_at into the future — not claimable yet.
    summary = await queue.processDueContactCorrectionJobs({ limit: 3, knex });
    expect(summary.claimed).toBe(0);
    // Force due; second (final) attempt fails terminally.
    job.next_attempt_at = Date.now() - 1000;
    summary = await queue.processDueContactCorrectionJobs({ limit: 3, knex });
    expect(summary.failed).toBe(1);
    expect(job.status).toBe('failed');
    expect(job.attempts).toBe(2);
  });
});

describe('round-18 hardening', () => {
  it('rebases a queued snapshot over an earlier queue write, so the newer message still wins', async () => {
    // Both webhooks snapshotted the same original value; job 1 applied
    // 'Riverson' AFTER job 2's snapshot was taken. Without the rebase,
    // job 2's CAS would read job 1's write as a concurrent change and
    // stale out — leaving the OLDER correction as the winner.
    const snapshot = { last_name: 'Riverz', phone: '+15550001111' };
    const knex = makeStubKnex({
      contact_correction_jobs: [
        jobRow({
          id: 1, status: 'done', customer_id: CUSTOMER_ID,
          result: { applied: [{ field: 'last_name', oldValue: 'Riverz', newValue: 'Riverson' }], skipped: [] },
          completed_at: Date.now() - 100,
        }),
        jobRow({ id: 2, status: 'queued', customer_id: CUSTOMER_ID, expected_values: { ...snapshot }, created_at: Date.now() - 1000 }),
      ],
      customers: [{ id: CUSTOMER_ID, deleted_at: null, last_name: 'Riverson' }],
    });
    const summary = await queue.processDueContactCorrectionJobs({ limit: 3, knex });
    expect(summary.succeeded).toBe(1);
    expect(mockRunSms.mock.calls[0][0].matchedSnapshot).toEqual({ last_name: 'Riverson', phone: '+15550001111' });
  });

  it('does not rebase over a write that completed BEFORE the snapshot was taken', async () => {
    // A job that finished before this message's webhook matched is already
    // reflected in the persisted snapshot — overlaying it again would mask
    // an admin edit that restored the older value in between.
    const knex = makeStubKnex({
      contact_correction_jobs: [
        jobRow({
          id: 1, status: 'done', customer_id: CUSTOMER_ID,
          result: { applied: [{ field: 'last_name', oldValue: 'Riverz', newValue: 'Riverson' }], skipped: [] },
          completed_at: Date.now() - 60_000,
        }),
        jobRow({ id: 2, status: 'queued', customer_id: CUSTOMER_ID, expected_values: { last_name: 'Riverz', phone: '+15550001111' }, created_at: Date.now() - 1000 }),
      ],
      customers: [{ id: CUSTOMER_ID, deleted_at: null, last_name: 'Riverz' }],
    });
    await queue.processDueContactCorrectionJobs({ limit: 3, knex });
    expect(mockRunSms.mock.calls[0][0].matchedSnapshot).toEqual({ last_name: 'Riverz', phone: '+15550001111' });
  });

  it('cancels a stale duplicate-sid reservation instead of replaying it', async () => {
    // Twilio redelivery reserved before the idempotency claim, then the
    // route died — the original delivery's job already owns this message.
    const knex = makeStubKnex({
      contact_correction_jobs: [
        jobRow({ id: 1, status: 'done', customer_id: CUSTOMER_ID }),
        jobRow({ id: 2, created_at: Date.now() - 11 * 60_000 }),
      ],
      customers: [{ id: CUSTOMER_ID, deleted_at: null }],
    });
    const summary = await queue.processDueContactCorrectionJobs({ limit: 3, knex });
    expect(summary.promoted).toBe(0);
    expect(knex._data.contact_correction_jobs[1].status).toBe('cancelled');
    expect(knex._data.contact_correction_jobs[1].cancel_reason).toBe('duplicate_sid');
  });

  it('with both same-sid deliveries dead-reserved, promotes the oldest and cancels the rest', async () => {
    const knex = makeStubKnex({
      contact_correction_jobs: [
        jobRow({ id: 1, customer_id: CUSTOMER_ID, created_at: Date.now() - 12 * 60_000 }),
        jobRow({ id: 2, customer_id: CUSTOMER_ID, created_at: Date.now() - 11 * 60_000 }),
      ],
      customers: [{ id: CUSTOMER_ID, deleted_at: null }],
      sms_log: [],
    });
    const summary = await queue.processDueContactCorrectionJobs({ limit: 3, knex });
    expect(summary.promoted).toBe(1);
    expect(knex._data.contact_correction_jobs[0].status).toBe('done');
    expect(knex._data.contact_correction_jobs[1].status).toBe('cancelled');
    expect(knex._data.contact_correction_jobs[1].cancel_reason).toBe('duplicate_sid');
  });

  it('a worker whose lock was reclaimed cannot overwrite the new owner\'s state', async () => {
    const knex = makeStubKnex({
      contact_correction_jobs: [jobRow({ id: 1, status: 'running', customer_id: CUSTOMER_ID, locked_by: 'replacement:2', locked_at: Date.now() })],
      customers: [{ id: CUSTOMER_ID, deleted_at: null }],
    });
    const job = { ...knex._data.contact_correction_jobs[0] };
    // Stale worker (different wid) finishes its long-running extraction
    // after the job was reclaimed — its done mark must match zero rows.
    await queue._internals.runContactCorrectionJob(job, knex, 'stale:1');
    expect(knex._data.contact_correction_jobs[0].status).toBe('running');
    expect(knex._data.contact_correction_jobs[0].locked_by).toBe('replacement:2');
  });
});

describe('round-19 hardening', () => {
  it('context attach stamps linkage + baseline on a reservation without changing status', async () => {
    const knex = makeStubKnex({ contact_correction_jobs: [jobRow(), jobRow({ id: 2, status: 'queued' })] });
    const ok = await queue.attachContactCorrectionContext(1, {
      customerId: CUSTOMER_ID, expectedValues: { last_name: 'Riverz' }, knex,
    });
    expect(ok).toBe(true);
    expect(knex._data.contact_correction_jobs[0].status).toBe('reserved');
    expect(knex._data.contact_correction_jobs[0].customer_id).toBe(CUSTOMER_ID);
    // Only reserved rows accept context — a fired job's payload is settled.
    expect(await queue.attachContactCorrectionContext(2, { customerId: CUSTOMER_ID, knex })).toBe(false);
  });

  it('each processing pass claims under a distinct lock owner', async () => {
    // (round-19) A shared hostname:pid owner let a pass whose lock went
    // stale overwrite the state of the in-process sibling that reclaimed
    // the job.
    const knex = makeStubKnex({
      contact_correction_jobs: [
        jobRow({ id: 1, status: 'queued', customer_id: CUSTOMER_ID }),
        jobRow({ id: 2, status: 'queued', customer_id: CUSTOMER_ID }),
      ],
      customers: [{ id: CUSTOMER_ID, deleted_at: null }],
    });
    // The done mark clears locked_by, so capture the owner mid-run.
    const owners = [];
    mockRunSms.mockImplementation(async () => {
      const running = knex._data.contact_correction_jobs.find((r) => r.status === 'running');
      owners.push(running?.locked_by);
      return { applied: [], skipped: [], reason: 'no_corrections' };
    });
    await queue.processDueContactCorrectionJobs({ limit: 1, knex });
    await queue.processDueContactCorrectionJobs({ limit: 1, knex });
    expect(owners).toHaveLength(2);
    expect(owners[0]).toBeTruthy();
    expect(owners[1]).toBeTruthy();
    expect(owners[0]).not.toBe(owners[1]);
  });
});

describe('round-20 hardening', () => {
  it('the worker hands the runner an owner fence bound to its own claim', async () => {
    const knex = makeStubKnex({
      contact_correction_jobs: [jobRow({ id: 1, status: 'queued', customer_id: CUSTOMER_ID })],
      customers: [{ id: CUSTOMER_ID, deleted_at: null }],
    });
    let fenceWhileOwned;
    let fenceAfterReclaim;
    mockRunSms.mockImplementation(async (args) => {
      // While this pass still owns the lock the fence passes…
      fenceWhileOwned = await args.ownerFence(knex).then(() => 'ok', (e) => e.message);
      // …and after a peer reclaims (rewrites locked_by) it throws, rolling
      // back the apply transaction it runs inside.
      knex._data.contact_correction_jobs[0].locked_by = 'replacement:9';
      fenceAfterReclaim = await args.ownerFence(knex).then(() => 'ok', (e) => e.message);
      return { applied: [], skipped: [], reason: 'no_corrections' };
    });
    await queue.processDueContactCorrectionJobs({ limit: 1, knex });
    expect(fenceWhileOwned).toBe('ok');
    expect(fenceAfterReclaim).toBe('queue_lock_lost');
  });
});

describe('round-21 hardening', () => {
  it('rebase skips a write whose oldValue does not chain off the baseline (admin restored in between)', async () => {
    // Job 1 wrote Riverz→Riverson AFTER this job's snapshot, but an admin
    // then restored Riverz — the snapshot legitimately holds Riverz via a
    // fresh capture; overlaying Riverson would resurrect the queue's older
    // value over the admin's newer one. oldValue (Riverz) matches here, so
    // the guard alone can't distinguish — the context-time cut does.
    const snapAt = Date.now() - 500;
    const knex = makeStubKnex({
      contact_correction_jobs: [
        jobRow({
          id: 1, status: 'done', customer_id: CUSTOMER_ID,
          result: { applied: [{ field: 'last_name', oldValue: 'Riverz', newValue: 'Riverson' }], skipped: [] },
          completed_at: snapAt - 200, // BEFORE the snapshot was captured
        }),
        jobRow({
          id: 2, status: 'queued', customer_id: CUSTOMER_ID,
          expected_values: { last_name: 'Riverz', phone: '+15550001111' },
          created_at: snapAt - 400, // reservation predates the earlier write…
          context_attached_at: snapAt, // …but the snapshot does not
        }),
      ],
      customers: [{ id: CUSTOMER_ID, deleted_at: null, last_name: 'Riverz' }],
    });
    await queue.processDueContactCorrectionJobs({ limit: 3, knex });
    expect(mockRunSms.mock.calls[0][0].matchedSnapshot).toEqual({ last_name: 'Riverz', phone: '+15550001111' });
  });

  it('rebase skips a post-snapshot write whose oldValue mismatches the baseline', async () => {
    // Earlier queue write AdminX→Riverson post-dates the snapshot, but the
    // snapshot holds Riverz — some other write sits between them, and
    // overlaying would fabricate a chain that never existed.
    const knex = makeStubKnex({
      contact_correction_jobs: [
        jobRow({
          id: 1, status: 'done', customer_id: CUSTOMER_ID,
          result: { applied: [{ field: 'last_name', oldValue: 'AdminX', newValue: 'Riverson' }], skipped: [] },
          completed_at: Date.now() - 100,
        }),
        jobRow({
          id: 2, status: 'queued', customer_id: CUSTOMER_ID,
          expected_values: { last_name: 'Riverz', phone: '+15550001111' },
          created_at: Date.now() - 1000,
          context_attached_at: Date.now() - 900,
        }),
      ],
      customers: [{ id: CUSTOMER_ID, deleted_at: null, last_name: 'Riverson' }],
    });
    await queue.processDueContactCorrectionJobs({ limit: 3, knex });
    expect(mockRunSms.mock.calls[0][0].matchedSnapshot).toEqual({ last_name: 'Riverz', phone: '+15550001111' });
  });

  it('the owner fence refreshes the lease while holding the row', async () => {
    const staleLockedAt = Date.now() - 9 * 60_000;
    const knex = makeStubKnex({
      contact_correction_jobs: [jobRow({ id: 1, status: 'queued', customer_id: CUSTOMER_ID })],
      customers: [{ id: CUSTOMER_ID, deleted_at: null }],
    });
    mockRunSms.mockImplementation(async (args) => {
      // Simulate a long extraction: age the lock, then run the fence the
      // apply transaction would run — the lease must come back fresh so a
      // recovery pass waiting on the row lock re-evaluates to NOT stale.
      knex._data.contact_correction_jobs[0].locked_at = staleLockedAt;
      await args.ownerFence(knex);
      return { applied: [{ field: 'last_name', oldValue: 'Riverz', newValue: 'Rivers' }], skipped: [] };
    });
    await queue.processDueContactCorrectionJobs({ limit: 1, knex });
    const job = knex._data.contact_correction_jobs[0];
    expect(job.status).toBe('done');
  });
});
