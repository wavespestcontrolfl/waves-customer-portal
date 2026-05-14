const {
  hashResolvedSnapshot,
  storeResolvedSnapshot,
} = require('../services/completion-attempts');

function makeKnex(ops) {
  const calls = [];
  const knex = jest.fn((table) => {
    const op = ops.shift() || {};
    calls.push({ table, op });
    const chain = {
      where: jest.fn((criteria) => { op.whereCriteria = criteria; return chain; }),
      whereNull: jest.fn((col) => { op.whereNull = (op.whereNull || []).concat(col); return chain; }),
      update: jest.fn((payload) => { op.updatePayload = payload; return chain; }),
      returning: jest.fn(async () => op.returning ?? [{ id: 'attempt-1' }]),
    };
    op.chain = chain;
    return chain;
  });
  knex.calls = calls;
  return knex;
}

const VALID_ONE_TAP = {
  snapshot: { protocolKey: 'gp_perim', visit: 'completed', items: ['demand', 'alpine'] },
  completionSource: 'one_tap_completion',
  protocolTemplateId: '11111111-1111-1111-1111-111111111111',
  protocolTemplateVersion: '2026.05',
};

describe('hashResolvedSnapshot', () => {
  test('is stable for key-order-permuted equivalent objects', () => {
    const a = { products: ['x', 'y'], areas: ['perim', 'garage'], protocol: 'gp' };
    const b = { protocol: 'gp', areas: ['perim', 'garage'], products: ['x', 'y'] };
    expect(hashResolvedSnapshot(a)).toBe(hashResolvedSnapshot(b));
  });

  test('changes when any value changes', () => {
    const a = { products: ['demand', 'alpine'] };
    const b = { products: ['demand', 'tempo'] };
    expect(hashResolvedSnapshot(a)).not.toBe(hashResolvedSnapshot(b));
  });

  test('changes when array order changes — array order is semantic', () => {
    const a = { products: ['demand', 'alpine'] };
    const b = { products: ['alpine', 'demand'] };
    expect(hashResolvedSnapshot(a)).not.toBe(hashResolvedSnapshot(b));
  });
});

describe('storeResolvedSnapshot', () => {
  test('writes snapshot, hash, source, template_id, version, and timestamp to the claimed attempt (pending-only)', async () => {
    const knex = makeKnex([{}]);
    const attempt = { id: 'attempt-1' };

    const result = await storeResolvedSnapshot(attempt, VALID_ONE_TAP, knex);

    expect(result.snapshotHash).toBe(hashResolvedSnapshot(VALID_ONE_TAP.snapshot));
    // WHERE clause must restrict to pre-record state — id + pending + no snapshot + no service_record_id.
    expect(knex.calls[0].op.whereCriteria).toEqual({ id: 'attempt-1', status: 'pending' });
    expect(knex.calls[0].op.whereNull).toEqual(['snapshot_written_at', 'service_record_id']);
    const payload = knex.calls[0].op.updatePayload;
    expect(payload.resolved_completion_snapshot).toBe(JSON.stringify(VALID_ONE_TAP.snapshot));
    expect(payload.resolved_completion_snapshot_hash).toBe(result.snapshotHash);
    expect(payload.completion_source).toBe('one_tap_completion');
    expect(payload.protocol_template_id).toBe(VALID_ONE_TAP.protocolTemplateId);
    expect(payload.protocol_template_version).toBe(VALID_ONE_TAP.protocolTemplateVersion);
    expect(payload.snapshot_written_at).toBeInstanceOf(Date);
    expect(payload.updated_at).toBeInstanceOf(Date);
  });

  test('throws when zero rows updated — attempt already resolved/resumed (codex P1 #1 round 2)', async () => {
    const knex = makeKnex([{ returning: [] }]);
    await expect(storeResolvedSnapshot(
      { id: 'attempt-1' },
      VALID_ONE_TAP,
      knex
    )).rejects.toMatchObject({
      code: 'snapshot_write_not_eligible',
    });
  });

  test('accepts a caller-supplied snapshotHash when it matches hash(snapshot)', async () => {
    const knex = makeKnex([{}]);
    const matching = hashResolvedSnapshot(VALID_ONE_TAP.snapshot);
    const result = await storeResolvedSnapshot(
      { id: 'attempt-1' },
      { ...VALID_ONE_TAP, snapshotHash: matching },
      knex
    );
    expect(result.snapshotHash).toBe(matching);
    expect(knex.calls[0].op.updatePayload.resolved_completion_snapshot_hash).toBe(matching);
  });

  test('rejects an unverified caller-supplied snapshotHash that does not match (codex P1 #3)', async () => {
    const knex = makeKnex([]);
    await expect(storeResolvedSnapshot(
      { id: 'attempt-1' },
      { ...VALID_ONE_TAP, snapshotHash: 'attacker-supplied-or-stale-hash' },
      knex
    )).rejects.toMatchObject({
      message: expect.stringMatching(/does not match hash\(snapshot\)/),
      code: 'snapshot_hash_mismatch',
    });
    // No DB write attempted.
    expect(knex.calls).toHaveLength(0);
  });

  test('detailed_form does not require a protocol template', async () => {
    const knex = makeKnex([{}]);
    await storeResolvedSnapshot(
      { id: 'attempt-1' },
      { snapshot: { freeform: true }, completionSource: 'detailed_form' },
      knex
    );
    const payload = knex.calls[0].op.updatePayload;
    expect(payload.completion_source).toBe('detailed_form');
    expect(payload.protocol_template_id).toBeNull();
    expect(payload.protocol_template_version).toBeNull();
  });

  test('one_tap_completion without protocol_template_id throws', async () => {
    const knex = makeKnex([{}]);
    await expect(storeResolvedSnapshot(
      { id: 'attempt-1' },
      {
        snapshot: { x: 1 },
        completionSource: 'one_tap_completion',
        protocolTemplateVersion: '2026.05',
      },
      knex
    )).rejects.toThrow(/one_tap_completion requires/);
  });

  test('one_tap_completion without protocol_template_version throws', async () => {
    const knex = makeKnex([{}]);
    await expect(storeResolvedSnapshot(
      { id: 'attempt-1' },
      {
        snapshot: { x: 1 },
        completionSource: 'one_tap_completion',
        protocolTemplateId: '11111111-1111-1111-1111-111111111111',
      },
      knex
    )).rejects.toThrow(/one_tap_completion requires/);
  });

  test('missing snapshot throws', async () => {
    await expect(storeResolvedSnapshot(
      { id: 'attempt-1' },
      { completionSource: 'one_tap_completion', protocolTemplateId: 'x', protocolTemplateVersion: 'v1' },
      makeKnex([])
    )).rejects.toThrow(/requires a snapshot/);
  });

  test('missing completionSource throws', async () => {
    await expect(storeResolvedSnapshot(
      { id: 'attempt-1' },
      { snapshot: { x: 1 } },
      makeKnex([])
    )).rejects.toThrow(/completion_source/);
  });

  test('missing attempt id throws', async () => {
    await expect(storeResolvedSnapshot(null, VALID_ONE_TAP, makeKnex([]))).rejects.toThrow(/claimed attempt/);
    await expect(storeResolvedSnapshot({}, VALID_ONE_TAP, makeKnex([]))).rejects.toThrow(/claimed attempt/);
  });
});
