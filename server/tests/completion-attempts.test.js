const {
  claimCompletionAttempt,
  hashCompletionRequest,
  markCompletionAttemptFailed,
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

describe('completion attempts', () => {
  test('first request claims and proceeds', async () => {
    const row = { id: 'attempt-1', status: 'pending' };
    const knex = makeKnex([{ returning: [row] }]);

    const result = await claimCompletionAttempt({
      serviceId: 'svc-1',
      idempotencyKey: 'key-1',
      requestHash: 'hash-1',
    }, knex);

    expect(result).toEqual({ action: 'proceed', attempt: row });
    expect(knex.calls[0].op.insertPayload).toMatchObject({
      service_id: 'svc-1',
      idempotency_key: 'key-1',
      status: 'pending',
      request_hash: 'hash-1',
    });
  });

  test('same key while pending returns 409', async () => {
    const knex = makeKnex([
      { insertError: uniqueViolation() },
      { first: { id: 'attempt-1', status: 'pending' } },
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

  test('same key after success replays stored response', async () => {
    const response = { success: true, serviceRecordId: 'record-1', invoiceId: 'invoice-1' };
    const knex = makeKnex([
      { insertError: uniqueViolation() },
      { first: { id: 'attempt-1', status: 'succeeded', response } },
    ]);

    const result = await claimCompletionAttempt({
      serviceId: 'svc-1',
      idempotencyKey: 'key-1',
      requestHash: 'hash-1',
    }, knex);

    expect(result).toEqual({ action: 'replay', payload: { ...response, replayed: true } });
  });

  test('failed attempt can retry with the same key', async () => {
    const retried = { id: 'attempt-1', status: 'pending' };
    const knex = makeKnex([
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
    expect(knex.calls[2].op.whereCriteria).toEqual({ id: 'attempt-1', status: 'failed' });
    expect(knex.calls[2].op.updatePayload).toMatchObject({
      status: 'pending',
      request_hash: 'hash-2',
      response: null,
      error: null,
    });
  });

  test('different key while service has a pending attempt returns 409', async () => {
    const knex = makeKnex([
      { insertError: uniqueViolation() },
      { first: undefined },
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
  });

  test('request hash is stable for equivalent bodies', () => {
    expect(hashCompletionRequest({ a: 1, b: 'x' })).toBe(hashCompletionRequest({ a: 1, b: 'x' }));
    expect(hashCompletionRequest({ a: 1 })).not.toBe(hashCompletionRequest({ a: 2 }));
  });
});
