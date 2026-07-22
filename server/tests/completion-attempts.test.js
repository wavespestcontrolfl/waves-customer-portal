const {
  claimCompletionAttempt,
  hashCompletionRequest,
  requestHashMatches,
  resumeHashMatches,
  coreHashSegment,
  markCompletionAttemptFailed,
  markCompletionAttemptSideEffectsPending,
  markCompletionAttemptSucceeded,
} = require('../services/completion-attempts');

function uniqueViolation() {
  const err = new Error('duplicate key value violates unique constraint');
  err.code = '23505';
  return err;
}

function makeKnex(ops) {
  const calls = [];
  const knex = jest.fn((table) => {
    const op = ops.shift();
    if (!op) throw new Error(`Unexpected table call: ${table}`);
    calls.push({ table, op });
    const chain = {
      insert: jest.fn((payload) => {
        op.insertPayload = payload;
        if (op.insertError) throw op.insertError;
        return chain;
      }),
      where: jest.fn((criteria) => {
        op.whereCriteria = criteria;
        return chain;
      }),
      whereIn: jest.fn((col, values) => {
        op.whereIn = { col, values };
        return chain;
      }),
      whereNot: jest.fn((col, value) => {
        op.whereNot = { col, value };
        return chain;
      }),
      whereNotNull: jest.fn((col) => {
        op.whereNotNull = (op.whereNotNull || []).concat(col);
        return chain;
      }),
      andWhere: jest.fn((...args) => {
        op.andWhereArgs = args;
        return chain;
      }),
      orderBy: jest.fn((col, dir) => {
        op.orderBy = { col, dir };
        return chain;
      }),
      update: jest.fn((payload) => {
        op.updatePayload = payload;
        return chain;
      }),
      returning: jest.fn(async () => op.returning || []),
      first: jest.fn(async () => op.first),
    };
    op.chain = chain;
    return chain;
  });
  knex.calls = calls;
  return knex;
}

// claimCompletionAttempt always begins with a per-service "any prior
// success?" lookup. This shorthand stands for "no, no prior success."
const noPriorSuccess = () => ({ first: undefined });
const noResumableCompletion = () => ({ first: undefined });
const noCompletedRecord = () => ({ first: undefined });
// Round-9 global snapshot-bypass guard: every code path that reaches
// the INSERT (fresh attempt) flow first checks for a prior non-
// succeeded attempt with snapshot_written_at. This shorthand stands
// for "no prior snapshot attempt exists."
const noPriorSnapshotAttempt = () => ({ first: undefined });

describe('completion attempts', () => {
  test('first request claims and proceeds', async () => {
    const row = { id: 'attempt-1', status: 'pending' };
    const knex = makeKnex([
      noPriorSuccess(),
      noResumableCompletion(),
      noCompletedRecord(),
      noPriorSnapshotAttempt(),
      { returning: [row] },
    ]);

    const result = await claimCompletionAttempt({
      serviceId: 'svc-1',
      idempotencyKey: 'key-1',
      requestHash: 'hash-1',
    }, knex);

    expect(result).toEqual({ action: 'proceed', attempt: row });
    expect(knex.calls[4].op.insertPayload).toMatchObject({
      service_id: 'svc-1',
      idempotency_key: 'key-1',
      status: 'pending',
      request_hash: 'hash-1',
    });
  });

  test('same key while pending returns 409', async () => {
    const knex = makeKnex([
      noPriorSuccess(),
      noResumableCompletion(),
      noCompletedRecord(),
      noPriorSnapshotAttempt(),
      { insertError: uniqueViolation() },
      { first: { id: 'attempt-1', status: 'pending', updated_at: new Date() } },
    ]);

    const result = await claimCompletionAttempt({
      serviceId: 'svc-1',
      idempotencyKey: 'key-1',
      requestHash: 'hash-1',
    }, knex);

    expect(result.action).toBe('conflict');
    expect(result.status).toBe(409);
    expect(result.payload.code).toBe('completion_pending');
  });

  test('same key reclaims a stale pending attempt and proceeds', async () => {
    const stale = {
      id: 'attempt-1',
      idempotency_key: 'key-1',
      status: 'pending',
      request_hash: 'hash-1',
      updated_at: new Date(Date.now() - 12 * 60 * 1000),
    };
    const reclaimed = { ...stale, updated_at: new Date() };
    const knex = makeKnex([
      noPriorSuccess(),
      noResumableCompletion(),
      noCompletedRecord(),
      noPriorSnapshotAttempt(),
      { insertError: uniqueViolation() },
      { first: stale },
      { first: undefined },
      { returning: [reclaimed] },
    ]);

    const result = await claimCompletionAttempt({
      serviceId: 'svc-1',
      idempotencyKey: 'key-1',
      requestHash: 'hash-1',
    }, knex);

    expect(result).toEqual({ action: 'proceed', attempt: reclaimed });
    expect(knex.calls[6].table).toBe('service_records');
    expect(knex.calls[7].op.whereCriteria).toEqual({ id: 'attempt-1', status: 'pending' });
    expect(knex.calls[7].op.andWhereArgs[0]).toBe('updated_at');
    expect(knex.calls[7].op.updatePayload.request_hash).toBe('hash-1');
  });

  test('same key after success replays stored response (upfront fast path)', async () => {
    const response = { success: true, serviceRecordId: 'record-1', invoiceId: 'invoice-1' };
    const knex = makeKnex([
      { first: { id: 'attempt-1', idempotency_key: 'key-1', status: 'succeeded', response } },
    ]);

    const result = await claimCompletionAttempt({
      serviceId: 'svc-1',
      idempotencyKey: 'key-1',
      requestHash: 'hash-1',
    }, knex);

    expect(result).toEqual({ action: 'replay', payload: { ...response, replayed: true } });
    // No insert attempted — fast path returned before catch block.
    expect(knex.calls).toHaveLength(1);
  });

  test('different key after success returns 409 service_already_completed (P0 dedupe)', async () => {
    // Money-correctness: panel reload generates a fresh idempotency key.
    // Without the per-service guard, the new key would slip past both
    // unique constraints and re-run /complete on an already-completed
    // service, creating a duplicate service_record / invoice / SMS.
    const response = { success: true, serviceRecordId: 'record-1', invoiceId: 'invoice-1' };
    const knex = makeKnex([
      {
        first: {
          id: 'attempt-1',
          idempotency_key: 'old-key',
          status: 'succeeded',
          response,
          service_record_id: 'record-1',
          invoice_id: 'invoice-1',
        },
      },
    ]);

    const result = await claimCompletionAttempt({
      serviceId: 'svc-1',
      idempotencyKey: 'fresh-key-after-reload',
      requestHash: 'hash-1',
    }, knex);

    expect(result.action).toBe('conflict');
    expect(result.status).toBe(409);
    expect(result.payload.code).toBe('service_already_completed');
    expect(result.payload.serviceRecordId).toBe('record-1');
    expect(result.payload.invoiceId).toBe('invoice-1');
    // No insert attempted.
    expect(knex.calls).toHaveLength(1);
  });

  test('failed attempt can retry with the same key', async () => {
    const retried = { id: 'attempt-1', status: 'pending' };
    const knex = makeKnex([
      noPriorSuccess(),
      noResumableCompletion(),
      noCompletedRecord(),
      noPriorSnapshotAttempt(),
      { insertError: uniqueViolation() },
      { first: { id: 'attempt-1', status: 'failed', error: 'transient' } },
      { returning: [retried] },
    ]);

    const result = await claimCompletionAttempt({
      serviceId: 'svc-1',
      idempotencyKey: 'key-1',
      requestHash: 'hash-2',
    }, knex);

    expect(result).toEqual({ action: 'proceed', attempt: retried });
    expect(knex.calls[6].op.whereCriteria).toEqual({ id: 'attempt-1', status: 'failed' });
    expect(knex.calls[6].op.updatePayload).toMatchObject({
      status: 'pending',
      request_hash: 'hash-2',
      response: null,
      error: null,
    });
  });

  test('failed retry that loses the reclaim race returns 409 instead of proceeding', async () => {
    const knex = makeKnex([
      noPriorSuccess(),
      noResumableCompletion(),
      noCompletedRecord(),
      noPriorSnapshotAttempt(),
      { insertError: uniqueViolation() },
      { first: { id: 'attempt-1', status: 'failed', request_hash: 'hash-1' } },
      { returning: [] },
    ]);

    const result = await claimCompletionAttempt({
      serviceId: 'svc-1',
      idempotencyKey: 'key-1',
      requestHash: 'hash-1',
    }, knex);

    expect(result.action).toBe('conflict');
    expect(result.status).toBe(409);
    expect(result.payload.code).toBe('completion_pending');
  });

  test('succeeded replay rejects when request hash differs from stored', async () => {
    const response = { success: true, serviceRecordId: 'record-1' };
    const knex = makeKnex([
      {
        first: {
          id: 'attempt-1',
          idempotency_key: 'key-1',
          status: 'succeeded',
          response,
          request_hash: 'hash-old',
        },
      },
    ]);

    const result = await claimCompletionAttempt({
      serviceId: 'svc-1',
      idempotencyKey: 'key-1',
      requestHash: 'hash-new',
    }, knex);

    expect(result.action).toBe('conflict');
    expect(result.status).toBe(409);
    expect(result.payload.code).toBe('idempotency_key_mismatch');
  });

  test('failed retry rejects when request hash differs from stored', async () => {
    const knex = makeKnex([
      noPriorSuccess(),
      noResumableCompletion(),
      noCompletedRecord(),
      noPriorSnapshotAttempt(),
      { insertError: uniqueViolation() },
      { first: { id: 'attempt-1', status: 'failed', request_hash: 'hash-old' } },
    ]);

    const result = await claimCompletionAttempt({
      serviceId: 'svc-1',
      idempotencyKey: 'key-1',
      requestHash: 'hash-new',
    }, knex);

    expect(result.action).toBe('conflict');
    expect(result.status).toBe(409);
    expect(result.payload.code).toBe('idempotency_key_mismatch');
  });

  test('succeeded replay still works when stored request_hash is null (legacy rows)', async () => {
    const response = { success: true };
    const knex = makeKnex([
      {
        first: {
          id: 'attempt-1',
          idempotency_key: 'key-1',
          status: 'succeeded',
          response,
          request_hash: null,
        },
      },
    ]);

    const result = await claimCompletionAttempt({
      serviceId: 'svc-1',
      idempotencyKey: 'key-1',
      requestHash: 'hash-new',
    }, knex);

    expect(result.action).toBe('replay');
  });

  test('different key while service has a fresh pending attempt returns 409', async () => {
    const knex = makeKnex([
      noPriorSuccess(),
      noResumableCompletion(),
      noCompletedRecord(),
      noPriorSnapshotAttempt(),
      { insertError: uniqueViolation() },
      { first: undefined },     // no same-key match
      { first: undefined },     // no stale pending → no reclaim path
    ]);

    const result = await claimCompletionAttempt({
      serviceId: 'svc-1',
      idempotencyKey: 'different-key',
      requestHash: 'hash-1',
    }, knex);

    expect(result.action).toBe('conflict');
    expect(result.status).toBe(409);
    expect(result.payload.code).toBe('service_completion_pending');
  });

  test('different key reclaims a stale pending attempt and proceeds', async () => {
    // Caller crashed mid-completion 12min ago; a new retry comes in
    // with a fresh idempotency key. The partial pending-only unique
    // index would otherwise block this forever.
    const stale = {
      id: 'orphan-1',
      idempotency_key: 'old-key',
      status: 'pending',
      updated_at: new Date(Date.now() - 12 * 60 * 1000),
    };
    const reclaimed = { ...stale, status: 'failed' };
    const newRow = { id: 'attempt-2', status: 'pending', idempotency_key: 'fresh-key' };

    const knex = makeKnex([
      noPriorSuccess(),
      noResumableCompletion(),
      noCompletedRecord(),
      noPriorSnapshotAttempt(),
      { insertError: uniqueViolation() },   // first insert hits partial index
      { first: undefined },                 // no same-key match
      { first: stale },                     // stale pending found
      { first: undefined },                 // service_records: no completed record (safe to reclaim)
      { returning: [reclaimed] },           // conditional UPDATE wins reclaim
      { returning: [newRow] },              // re-insert succeeds
    ]);

    const result = await claimCompletionAttempt({
      serviceId: 'svc-1',
      idempotencyKey: 'fresh-key',
      requestHash: 'hash-1',
    }, knex);

    expect(result).toEqual({ action: 'proceed', attempt: newRow });
    // Reclaim UPDATE was scoped to the stale row + status='pending' guard.
    expect(knex.calls[8].op.whereCriteria).toEqual({ id: 'orphan-1', status: 'pending' });
    expect(knex.calls[8].op.updatePayload.status).toBe('failed');
  });

  test('any service with a prior non-succeeded attempt + persisted snapshot returns 409 (rounds 5/6/7/8/9 — single global guard)', async () => {
    // Round-9's global guard at step 4 (after priorSuccess /
    // resumable / completedRecord, before INSERT) catches every
    // snapshot-bearing recovery case in one place:
    //   - same-key pending with snapshot
    //   - same-key failed with snapshot
    //   - different-key reclaim (round-5 case)
    //   - fresh-key bypass after failed-with-snapshot (round-9 case)
    // The guard doesn't branch on key match or staleness, just on the
    // existence of any non-succeeded snapshot-bearing row for this
    // service.
    const priorSnapshotRow = {
      id: 'orphan-1',
      idempotency_key: 'old-key',
      status: 'pending',
      snapshot_written_at: new Date(Date.now() - 60 * 1000),
      resolved_completion_snapshot_hash: 'snap-hash-abc',
    };
    const knex = makeKnex([
      noPriorSuccess(),
      noResumableCompletion(),
      noCompletedRecord(),
      { first: priorSnapshotRow },
    ]);

    const result = await claimCompletionAttempt({
      serviceId: 'svc-1',
      idempotencyKey: 'fresh-key-from-panel-reload',
      requestHash: 'hash-1',
    }, knex);

    expect(result.action).toBe('conflict');
    expect(result.status).toBe(409);
    expect(result.payload.code).toBe('completion_snapshot_resume_not_yet_supported');
    expect(result.payload.attemptId).toBe('orphan-1');
    expect(result.payload.snapshotHash).toBe('snap-hash-abc');
    expect(knex.calls).toHaveLength(4);
    // Guard scoped correctly: same service, not succeeded, snapshot bytes present.
    expect(knex.calls[3].op.whereCriteria).toEqual({ service_id: 'svc-1' });
    expect(knex.calls[3].op.whereNot).toEqual({ col: 'status', value: 'succeeded' });
    expect(knex.calls[3].op.whereNotNull).toEqual(['snapshot_written_at']);
  });

  test('fresh idempotency key after a failed-with-snapshot attempt is blocked (codex P1 round 9)', async () => {
    // Original attempt under key K1 wrote snapshot, then failed.
    // markCompletionAttemptFailed left the snapshot intact. Panel
    // reload generates fresh key K2. Without the global guard, K2's
    // claim would slip past every same-key check and start fresh,
    // orphaning K1's snapshot.
    const failedK1WithSnapshot = {
      id: 'attempt-k1',
      idempotency_key: 'k1',
      status: 'failed',
      snapshot_written_at: new Date(Date.now() - 5 * 60 * 1000),
      resolved_completion_snapshot_hash: 'k1-snap',
    };
    const knex = makeKnex([
      noPriorSuccess(),
      noResumableCompletion(),
      noCompletedRecord(),
      { first: failedK1WithSnapshot },
    ]);

    const result = await claimCompletionAttempt({
      serviceId: 'svc-1',
      idempotencyKey: 'k2-fresh-after-reload',
      requestHash: 'hash-different-from-k1',
    }, knex);

    expect(result.action).toBe('conflict');
    expect(result.status).toBe(409);
    expect(result.payload.code).toBe('completion_snapshot_resume_not_yet_supported');
    expect(result.payload.attemptId).toBe('attempt-k1');
    expect(knex.calls).toHaveLength(4);
  });


  test('different key falls through to 409 when reclaim race is lost', async () => {
    const stale = {
      id: 'orphan-1',
      idempotency_key: 'old-key',
      status: 'pending',
      updated_at: new Date(Date.now() - 12 * 60 * 1000),
    };

    const knex = makeKnex([
      noPriorSuccess(),
      noResumableCompletion(),
      noCompletedRecord(),
      noPriorSnapshotAttempt(),
      { insertError: uniqueViolation() },
      { first: undefined },             // no same-key match
      { first: stale },                 // stale pending found
      { first: undefined },             // service_records: no completed record
      { returning: [] },                // another retry already reclaimed it
    ]);

    const result = await claimCompletionAttempt({
      serviceId: 'svc-1',
      idempotencyKey: 'fresh-key',
      requestHash: 'hash-1',
    }, knex);

    expect(result.action).toBe('conflict');
    expect(result.status).toBe(409);
    expect(result.payload.code).toBe('service_completion_pending');
  });

  test('fresh key refuses when service_record already exists (P0 defense in depth)', async () => {
    // A deploy, manual repair, or legacy path could leave a committed
    // service_record without a succeeded attempt row. A fresh panel key must
    // still refuse instead of re-running service_record / invoice / SMS work.
    const completedRecord = { id: 'record-1', scheduled_service_id: 'svc-1' };

    const knex = makeKnex([
      noPriorSuccess(),
      noResumableCompletion(),
      { first: completedRecord },
    ]);

    const result = await claimCompletionAttempt({
      serviceId: 'svc-1',
      idempotencyKey: 'fresh-key',
      requestHash: 'hash-1',
    }, knex);

    expect(result.action).toBe('conflict');
    expect(result.status).toBe(409);
    expect(result.payload.code).toBe('service_already_completed');
    expect(result.payload.serviceRecordId).toBe('record-1');
    expect(knex.calls).toHaveLength(3);
  });

  test('side-effect pending completion is atomically claimed before resume', async () => {
    const pending = {
      id: 'attempt-1',
      status: 'side_effects_pending',
      service_record_id: 'record-1',
      request_hash: 'hash-1',
    };
    const claimed = { ...pending, status: 'side_effects_running' };
    const knex = makeKnex([
      noPriorSuccess(),
      { first: pending },
      { returning: [claimed] },
    ]);

    const result = await claimCompletionAttempt({
      serviceId: 'svc-1',
      idempotencyKey: 'key-1',
      requestHash: 'hash-1',
    }, knex);

    expect(result).toEqual({ action: 'resume', attempt: claimed, serviceRecordId: 'record-1' });
    expect(knex.calls[1].op.whereIn).toEqual({
      col: 'status',
      values: ['side_effects_pending', 'side_effects_running'],
    });
    expect(knex.calls[2].op.whereCriteria).toEqual({ id: 'attempt-1', status: 'side_effects_pending' });
    expect(knex.calls[2].op.updatePayload.status).toBe('side_effects_running');
  });

  test('fresh side-effect running completion returns 409 instead of concurrent resume', async () => {
    const running = {
      id: 'attempt-1',
      status: 'side_effects_running',
      service_record_id: 'record-1',
      request_hash: 'hash-1',
      updated_at: new Date(),
    };
    const knex = makeKnex([
      noPriorSuccess(),
      { first: running },
    ]);

    const result = await claimCompletionAttempt({
      serviceId: 'svc-1',
      idempotencyKey: 'key-1',
      requestHash: 'hash-1',
    }, knex);

    expect(result.action).toBe('conflict');
    expect(result.status).toBe(409);
    expect(result.payload.code).toBe('completion_side_effects_running');
    expect(knex.calls).toHaveLength(2);
  });

  test('stale side-effect running completion can be reclaimed for resume', async () => {
    const running = {
      id: 'attempt-1',
      status: 'side_effects_running',
      service_record_id: 'record-1',
      request_hash: 'hash-1',
      updated_at: new Date(Date.now() - 12 * 60 * 1000),
    };
    const claimed = { ...running, updated_at: new Date() };
    const knex = makeKnex([
      noPriorSuccess(),
      { first: running },
      { returning: [claimed] },
    ]);

    const result = await claimCompletionAttempt({
      serviceId: 'svc-1',
      idempotencyKey: 'key-1',
      requestHash: 'hash-1',
    }, knex);

    expect(result).toEqual({ action: 'resume', attempt: claimed, serviceRecordId: 'record-1' });
    expect(knex.calls[2].op.whereCriteria).toEqual({ id: 'attempt-1', status: 'side_effects_running' });
    expect(knex.calls[2].op.andWhereArgs[0]).toBe('updated_at');
    expect(knex.calls[2].op.updatePayload.status).toBe('side_effects_running');
  });

  test('marks attempts succeeded and failed', async () => {
    const successKnex = makeKnex([{ returning: [] }]);
    await markCompletionAttemptSucceeded({
      id: 'attempt-1',
    }, {
      record: { id: 'record-1' },
      invoice: { id: 'invoice-1' },
      response: { success: true },
    }, successKnex);

    expect(successKnex.calls[0].op.whereCriteria).toEqual({ id: 'attempt-1' });
    expect(successKnex.calls[0].op.updatePayload).toMatchObject({
      status: 'succeeded',
      service_record_id: 'record-1',
      invoice_id: 'invoice-1',
      response: { success: true },
      error: null,
    });

    const failedKnex = makeKnex([{ returning: [] }]);
    await markCompletionAttemptFailed({ id: 'attempt-1' }, new Error('boom'), failedKnex);
    expect(failedKnex.calls[0].op.updatePayload).toMatchObject({
      status: 'failed',
      error: 'boom',
    });

    const sideEffectsKnex = makeKnex([{ returning: [] }]);
    await markCompletionAttemptSideEffectsPending({
      id: 'attempt-1',
    }, {
      record: { id: 'record-1' },
      response: { success: true },
    }, sideEffectsKnex);
    expect(sideEffectsKnex.calls[0].op.updatePayload).toMatchObject({
      status: 'side_effects_running',
      service_record_id: 'record-1',
      response: { success: true },
      error: null,
    });
  });

  test('request hash is stable for equivalent bodies', () => {
    expect(hashCompletionRequest({ a: 1, b: 'x' })).toBe(hashCompletionRequest({ a: 1, b: 'x' }));
    expect(hashCompletionRequest({ a: 1, b: { c: 2, d: 3 } }))
      .toBe(hashCompletionRequest({ b: { d: 3, c: 2 }, a: 1 }));
    expect(hashCompletionRequest({ a: 1 })).not.toBe(hashCompletionRequest({ a: 2 }));
  });

  test('mode fields (backfill/timeOnSite) split the FULL hash but never the CORE segment (Codex P1, fix round 10)', () => {
    // Round 6 stripped `backfill` (and earlier `timeOnSite`) from EVERY
    // hash, so a same-key retry after a PRE-commit failure could flip
    // loud↔quiet or the typed duration while passing the idempotency check.
    // They now hash into a second MODE segment: pre-commit comparisons use
    // the full composite; only the committed-record resume claim
    // (claimSideEffectsRun) matches on the core.
    const base = { notes: 'done', visitOutcome: 'routine' };
    const flagged = hashCompletionRequest({ ...base, backfill: true, timeOnSite: 45 });
    const flagless = hashCompletionRequest(base);
    const retimed = hashCompletionRequest({ ...base, backfill: true, timeOnSite: 25 });
    expect(flagged).not.toBe(flagless);
    expect(flagged).not.toBe(retimed);
    expect(coreHashSegment(flagged)).toBe(coreHashSegment(flagless));
    expect(coreHashSegment(flagged)).toBe(coreHashSegment(retimed));
    // Same-intent normalizations do NOT split even the full hash: an
    // omitted flag ≡ explicit false; omitted duration ≡ null.
    expect(hashCompletionRequest({ ...base, backfill: false })).toBe(flagless);
    expect(hashCompletionRequest({ ...base, timeOnSite: null })).toBe(flagless);
    // NORMAL completions post the panel's auto-elapsed timer as timeOnSite —
    // it ticks every second, so it never enters the hash (fix round 13): a
    // transient pre-commit failure must retry cleanly on the next tick, not
    // 409 idempotency_key_mismatch. Only a backfill's operator-TYPED
    // minutes bind pre-commit (the `retimed` split above).
    expect(hashCompletionRequest({ ...base, timeOnSite: 61 }))
      .toBe(hashCompletionRequest({ ...base, timeOnSite: 62 }));
    expect(hashCompletionRequest({ ...base, timeOnSite: 61 })).toBe(flagless);
    // Matcher semantics: strict wants the full composite; resume wants core.
    expect(requestHashMatches(flagged, flagless)).toBe(false);
    expect(requestHashMatches(flagged, flagged)).toBe(true);
    expect(resumeHashMatches(flagged, flagless)).toBe(true);
    expect(resumeHashMatches(flagged, hashCompletionRequest({ notes: 'other' }))).toBe(false);
    // Null tolerance (legacy rows without a stored hash) is preserved.
    expect(requestHashMatches(null, flagged)).toBe(true);
    expect(resumeHashMatches(undefined, flagged)).toBe(true);
  });

  test('legacy single-segment stored hashes keep matching across the deploy (core-projection compatibility)', () => {
    // Attempts stored before round 10 carry a single-segment hash whose
    // projection equals today's CORE exactly. Both matchers must treat a
    // separator-free stored value as core-only so an in-flight retry does
    // not 409 on the format change alone.
    const body = { notes: 'done', backfill: true, timeOnSite: 45 };
    const legacyStored = coreHashSegment(hashCompletionRequest(body));
    expect(legacyStored).not.toContain(':');
    expect(requestHashMatches(legacyStored, hashCompletionRequest(body))).toBe(true);
    // Legacy rows cannot enforce the mode segment they never stored — a
    // flipped mode still matches them (pre-round-10 behavior), but a real
    // payload change does not.
    expect(requestHashMatches(legacyStored, hashCompletionRequest({ notes: 'done' }))).toBe(true);
    expect(requestHashMatches(legacyStored, hashCompletionRequest({ notes: 'other' }))).toBe(false);
    expect(resumeHashMatches(legacyStored, hashCompletionRequest(body))).toBe(true);
  });

  test('pre-commit same-key retry may NOT flip the mode: failed attempt + flagless retry → idempotency_key_mismatch (Codex P1, fix round 10)', () => {
    // The exact reported hole: a completion attempt FAILS before any record
    // commits, then the same key retries WITHOUT the backfill flag (or with
    // a different typed duration). No committed record exists, so the body
    // is the only truth — the retry must 409, never re-run under a flipped
    // loud/quiet + duration contract.
    const committedBody = { notes: 'done', visitOutcome: 'routine', backfill: true, timeOnSite: 45 };
    const storedHash = hashCompletionRequest(committedBody);
    const retryHash = hashCompletionRequest({ notes: 'done', visitOutcome: 'routine' });

    const run = async (existingStatus) => {
      const knex = makeKnex([
        noPriorSuccess(),
        noResumableCompletion(),
        noCompletedRecord(),
        noPriorSnapshotAttempt(),
        { insertError: uniqueViolation() },
        { first: { id: 'attempt-1', status: existingStatus, request_hash: storedHash, updated_at: new Date() } },
      ]);
      return claimCompletionAttempt({
        serviceId: 'svc-1',
        idempotencyKey: 'key-1',
        requestHash: retryHash,
      }, knex);
    };

    return (async () => {
      for (const status of ['failed', 'pending']) {
        const result = await run(status);
        expect(result.action).toBe('conflict');
        expect(result.status).toBe(409);
        expect(result.payload.code).toBe('idempotency_key_mismatch');
      }
      // A BACKFILL retry that changes the operator-TYPED minutes pre-commit
      // is equally a different payload — 409.
      const typedFlipKnex = makeKnex([
        noPriorSuccess(),
        noResumableCompletion(),
        noCompletedRecord(),
        noPriorSnapshotAttempt(),
        { insertError: uniqueViolation() },
        { first: { id: 'attempt-1', status: 'failed', request_hash: storedHash, updated_at: new Date() } },
      ]);
      const typedFlip = await claimCompletionAttempt({
        serviceId: 'svc-1',
        idempotencyKey: 'key-1',
        requestHash: hashCompletionRequest({ notes: 'done', visitOutcome: 'routine', backfill: true, timeOnSite: 60 }),
      }, typedFlipKnex);
      expect(typedFlip.payload.code).toBe('idempotency_key_mismatch');
      // A NORMAL completion's retry after a pre-commit failure carries the
      // panel's NEXT timer tick — that is noise, not a payload change: the
      // failed row resets to pending and the retry proceeds (fix round 13;
      // pre-fix this 409'd idempotency_key_mismatch on the next tick).
      const normalStored = hashCompletionRequest({ notes: 'done', visitOutcome: 'routine', timeOnSite: 61 });
      const retryRow = { id: 'attempt-1', status: 'pending' };
      const tickKnex = makeKnex([
        noPriorSuccess(),
        noResumableCompletion(),
        noCompletedRecord(),
        noPriorSnapshotAttempt(),
        { insertError: uniqueViolation() },
        { first: { id: 'attempt-1', status: 'failed', request_hash: normalStored, updated_at: new Date() } },
        { returning: [retryRow] },
      ]);
      const tickRetry = await claimCompletionAttempt({
        serviceId: 'svc-1',
        idempotencyKey: 'key-1',
        requestHash: hashCompletionRequest({ notes: 'done', visitOutcome: 'routine', timeOnSite: 62 }),
      }, tickKnex);
      expect(tickRetry).toEqual({ action: 'proceed', attempt: retryRow });
      // The same flagless retry against a COMMITTED record (side-effects
      // resume) is the round-6 recovery case and still resumes — the frozen
      // structured_notes are authoritative for the mode there.
      const pending = {
        id: 'attempt-1',
        status: 'side_effects_pending',
        service_record_id: 'record-1',
        request_hash: storedHash,
      };
      const claimed = { ...pending, status: 'side_effects_running' };
      const knex = makeKnex([
        noPriorSuccess(),
        { first: pending },
        { returning: [claimed] },
      ]);
      const resumed = await claimCompletionAttempt({
        serviceId: 'svc-1',
        idempotencyKey: 'key-1',
        requestHash: retryHash,
      }, knex);
      expect(resumed).toEqual({ action: 'resume', attempt: claimed, serviceRecordId: 'record-1' });
    })();
  });
});

describe('request hash fits its column', () => {
  // Regression: the fix-round-10 two-segment hash (`<core>:<mode>`, 129
  // chars) shipped while service_completion_attempts.request_hash was still
  // varchar(64) — every completion INSERT then 500'd with "value too long
  // for type character varying(64)" across all service types (lawn, tree &
  // shrub, pest share the one /complete route). Migration
  // 20260722000002_widen_completion_request_hash widened the column to 160.
  // If the hash format ever grows again, this must fail until a widening
  // migration ships with it.
  const REQUEST_HASH_COLUMN_WIDTH = 160;

  test('composite hash length is stable and within varchar(160)', () => {
    const hash = hashCompletionRequest({
      notes: 'x'.repeat(50000), // hash length must not scale with payload size
      products: Array.from({ length: 200 }, (_, i) => ({ id: i })),
      backfill: true,
      timeOnSite: 95,
    });
    expect(hash).toMatch(/^[0-9a-f]{64}:[0-9a-f]{64}$/);
    expect(hash.length).toBe(129);
    expect(hash.length).toBeLessThanOrEqual(REQUEST_HASH_COLUMN_WIDTH);
  });
});
