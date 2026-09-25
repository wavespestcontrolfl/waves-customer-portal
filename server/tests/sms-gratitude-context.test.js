const knex = require('knex')({ client: 'pg' });
const {
  validateGratitudeDraftContract,
  pendingGratitudeWork,
  gratitudeThreadAdvanced,
  readGratitudeContext,
} = require('../services/sms-gratitude-context');
const { GRATITUDE_INTENT, GRATITUDE_POLICY_VERSION } = require('../services/sms-gratitude');

afterAll(() => knex.destroy());

function contractRow(overrides = {}) {
  return {
    id: 'draft-1', sms_log_id: 'sms-1', customer_id: 'customer-1', status: 'shadow',
    intent: GRATITUDE_INTENT, scheduling_intent: false, model: 'model-under-test',
    prompt_version: 'house_voice_v11', draft_response: 'Our pleasure, Dana!', flags: [],
    intended_actions: {
      actions: [{ type: 'none' }], missing_info: null, verify: { converged: true },
      gratitude: {
        source: 'live_webhook', policy_version: GRATITUDE_POLICY_VERSION,
        actions_verified_safe: true, verifier_enabled: true,
      },
    },
    ...overrides,
  };
}

function compilingDb() {
  const queries = [];
  const dbh = (table) => {
    const query = knex(table);
    const originalFirst = query.first.bind(query);
    query.first = (...columns) => {
      const built = originalFirst(...columns).toSQL();
      queries.push({ table, sql: built.sql, bindings: built.bindings });
      return Promise.resolve(null);
    };
    return query;
  };
  dbh.raw = knex.raw.bind(knex);
  return { dbh, queries };
}

function readContextDb({
  pendingRequest = false, inboundAvailable = true,
  inboundFrom = '+1 (941) 555-0100', customerPhone = '+19415550100',
} = {}) {
  const inboundCreatedAt = '2026-09-24T12:00:00.000Z';
  const draft = contractRow({
    created_at: '2026-09-24T12:00:01.000Z',
    inbound_message: 'Thank you!',
  });
  const inbound = {
    id: 'sms-1', customer_id: 'customer-1', direction: 'inbound',
    from_phone: inboundFrom, to_phone: '+19413187612',
    message_body: 'Thank you!', metadata: { media: [] }, created_at: inboundCreatedAt,
  };
  const rows = [
    inbound,
    {
      id: 'sms-outbound', direction: 'outbound',
      message_body: 'Your service report: https://portal.example/report',
      message_type: 'service_report', status: 'delivered', metadata: { media: [] },
      created_at: '2026-09-24T11:59:00.000Z',
    },
  ];
  const firstResults = {
    message_drafts: [draft],
    sms_log: [inboundAvailable ? inbound : null, null],
    service_requests: [pendingRequest ? { id: 'request-1' } : null],
    'call_commitments as cc': [null],
    'call_commitments as cc_sms': [null],
    'triage_items as ti': [null],
    'operator_inbox_items as oi': [null],
    'agent_decisions as ad': [null],
  };
  const selectedTables = [];
  const dbh = jest.fn((table) => {
    const query = {};
    for (const method of [
      'where', 'whereNot', 'whereNotIn', 'whereIn', 'whereNull', 'whereRaw',
      'orWhere', 'orWhereRaw', 'join', 'leftJoin', 'orderBy', 'limit',
    ]) query[method] = jest.fn(() => query);
    query.first = jest.fn(() => Promise.resolve(firstResults[table]?.shift() ?? null));
    query.select = jest.fn(() => {
      selectedTables.push(table);
      if (table === 'customers') return Promise.resolve([
        { id: 'customer-1', first_name: 'Dana', phone: customerPhone },
      ]);
      if (table === 'sms_log') return Promise.resolve(rows);
      return Promise.resolve([]);
    });
    return query;
  });
  dbh.raw = knex.raw.bind(knex);
  return { dbh, selectedTables };
}

test('persisted gratitude contract accepts only verified live fixed copy', () => {
  const args = { expectedReply: 'Our pleasure, Dana!', expectedPromptVersion: 'house_voice_v11' };
  expect(validateGratitudeDraftContract(contractRow(), args)).toBeNull();
  expect(validateGratitudeDraftContract(contractRow({ draft_response: 'Edited' }), args)).toBe('edited_draft');
  expect(validateGratitudeDraftContract(contractRow({
    intended_actions: { ...contractRow().intended_actions, gratitude: {
      ...contractRow().intended_actions.gratitude, source: 'historical_replay',
    } },
  }), args)).toBe('invalid_gratitude_provenance');
  expect(validateGratitudeDraftContract(contractRow({ flags: [{ type: 'open_complaint' }] }), args)).toBe('unsafe_flags');
});

test.each([
  ['missing row', null, 'draft_not_shadow_gratitude'],
  ['earlier row failure', contractRow({ sms_log_id: null, model: null }), 'draft_unlinked'],
  ['malformed metadata', contractRow({ intended_actions: null }), 'invalid_draft_metadata'],
  ['malformed flags', contractRow({ flags: null }), 'invalid_flags'],
])('persisted gratitude contract fails closed for %s', (_label, row, reason) => {
  expect(validateGratitudeDraftContract(row, {
    expectedReply: 'Our pleasure, Dana!', expectedPromptVersion: 'house_voice_v11',
  })).toBe(reason);
});

test('pending-work SQL covers every customer and same-thread operational queue', async () => {
  const { dbh, queries } = compilingDb();
  await expect(pendingGratitudeWork(dbh, {
    customerId: '00000000-0000-4000-8000-000000000003', threadKey: '9415550100',
    excludeDecisionId: '00000000-0000-4000-8000-000000000004',
  })).resolves.toBe(false);
  expect(queries.map((q) => q.table)).toEqual([
    'service_requests', 'call_commitments as cc', 'call_commitments as cc_sms',
    'triage_items as ti', 'operator_inbox_items as oi', 'agent_decisions as ad',
  ]);
  const serviceRequest = queries.find((q) => q.table === 'service_requests');
  expect(serviceRequest.sql).toContain("COALESCE(status, 'new') not in");
  const callCommitment = queries.find((q) => q.table === 'call_commitments as cc');
  expect(callCommitment.sql).toContain('cl.from_phone');
  expect(callCommitment.sql).toContain('cl.to_phone');
  expect(callCommitment.bindings.filter(value => value === '9415550100')).toHaveLength(2);
  const decision = queries.find((q) => q.table === 'agent_decisions as ad');
  expect(decision.bindings).toEqual(expect.arrayContaining([
    'pending_review', 'pending', 'scheduled', 'sending', 'initiated', 'active',
    '00000000-0000-4000-8000-000000000004',
  ]));
  expect(decision.sql).toContain('not "ad"."id" = ?');
  const sql = queries.map((q) => q.sql).join('\n');
  expect(sql).toContain('"ti"."sms_log_id" = "ti_sms"."id"');
  expect(sql).toContain('"oi"."customer_id"');
  expect(sql).toContain('"ad"."customer_id"');
  expect(sql).toContain('REGEXP_REPLACE');
  expect(sql).toContain("NOT LIKE '+%'");
  expect(queries.flatMap((q) => q.bindings)).toContain('9415550100');
});

function pendingDecisionDb(decisionIds) {
  const dbh = jest.fn((table) => {
    const query = {};
    let excludedDecisionId = null;
    for (const method of [
      'whereNotIn', 'whereIn', 'whereRaw', 'orWhereRaw', 'orWhere', 'join', 'leftJoin',
    ]) query[method] = jest.fn(() => query);
    query.where = jest.fn((...args) => {
      if (typeof args[0] === 'function') args[0].call(query);
      return query;
    });
    query.whereNot = jest.fn((column, value) => {
      if (column === 'ad.id') excludedDecisionId = value;
      return query;
    });
    query.first = jest.fn(async () => {
      if (table !== 'agent_decisions as ad') return null;
      const id = decisionIds.find((candidateId) => candidateId !== excludedDecisionId);
      return id ? { id } : null;
    });
    return query;
  });
  dbh.raw = knex.raw.bind(knex);
  return dbh;
}

test('provider-boundary pending-work check excludes only its own decision claim', async () => {
  const ownDecisionId = '00000000-0000-4000-8000-000000000004';
  await expect(pendingGratitudeWork(pendingDecisionDb([ownDecisionId]), {
    customerId: '00000000-0000-4000-8000-000000000003',
    threadKey: '9415550100',
    excludeDecisionId: ownDecisionId,
  })).resolves.toBe(false);
  await expect(pendingGratitudeWork(pendingDecisionDb([
    ownDecisionId,
    '00000000-0000-4000-8000-000000000005',
  ]), {
    customerId: '00000000-0000-4000-8000-000000000003',
    threadKey: '9415550100',
    excludeDecisionId: ownDecisionId,
  })).resolves.toBe(true);
});

test('thread advancement normalizes formatted endpoints and excludes only anchor and owned reservation', async () => {
  const { dbh, queries } = compilingDb();
  await expect(gratitudeThreadAdvanced(dbh, {
    inboundId: '00000000-0000-4000-8000-000000000002',
    fromPhone: '+19415550100', toPhone: '+19413187612',
    skipReservationId: '00000000-0000-4000-8000-000000000099',
  })).resolves.toBe(false);
  expect(queries).toHaveLength(1);
  expect(queries[0].sql.match(/not "id" = \?/g)).toHaveLength(2);
  expect(queries[0].sql).toContain("status IN ('accepted','queued','sent','delivered','scheduled','sending')");
  expect(queries[0].sql).toContain("OR (direction = 'outbound' AND status IN ('accepted','queued','scheduled','sending'))");
  expect(queries[0].sql).toContain("BTRIM(COALESCE(to_phone, ''))");
  expect(queries[0].sql).toContain("metadata->>'channel' = 'push'");
  expect(queries[0].sql).toContain("metadata->>'providerAccepted' = 'true'");
  expect(queries[0].sql).toContain("metadata->>'provider_from_number'");
  expect(queries[0].sql).not.toContain('to_phone = ?');
  expect(queries[0].bindings).toEqual(expect.arrayContaining([
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000099',
    '9415550100',
    '9413187612',
  ]));
  expect(queries[0].bindings.filter((value) => value === '9413187612')).toHaveLength(3);
});

test('read context rejects when authoritative queues contain pending work', async () => {
  const { dbh } = readContextDb({ pendingRequest: true });
  await expect(readGratitudeContext({
    draftId: 'draft-1', smsLogId: 'sms-1', expectedPromptVersion: 'house_voice_v11',
    now: '2026-09-24T12:05:00.000Z', activatedAt: '2026-09-24T11:00:00.000Z', dbh,
  })).resolves.toEqual({ ok: false, reason: 'pending_work' });
  expect(dbh).toHaveBeenCalledWith('service_requests');
});

test('read context fails closed without dereferencing a missing inbound', async () => {
  const { dbh } = readContextDb({ inboundAvailable: false });
  await expect(readGratitudeContext({
    draftId: 'draft-1', smsLogId: 'sms-1', expectedPromptVersion: 'house_voice_v11',
    now: '2026-09-24T12:05:00.000Z', activatedAt: '2026-09-24T11:00:00.000Z', dbh,
  })).resolves.toEqual({ ok: false, reason: 'inbound_unavailable' });
});

test('read context rejects a foreign sender that only shares a US customer suffix', async () => {
  const { dbh } = readContextDb({
    inboundFrom: '+445550000001', customerPhone: '+15550000001',
  });
  await expect(readGratitudeContext({
    draftId: 'draft-1', smsLogId: 'sms-1', expectedPromptVersion: 'house_voice_v11',
    now: '2026-09-24T12:05:00.000Z', activatedAt: '2026-09-24T11:00:00.000Z', dbh,
  })).resolves.toEqual({ ok: false, reason: 'customer_untrusted' });
});

test('read context validates against only the explicitly supplied prompt version', async () => {
  const matching = readContextDb();
  await expect(readGratitudeContext({
    draftId: 'draft-1', smsLogId: 'sms-1', expectedPromptVersion: 'house_voice_v11',
    now: '2026-09-24T12:05:00.000Z', activatedAt: '2026-09-24T11:00:00.000Z', dbh: matching.dbh,
  })).resolves.toEqual(expect.objectContaining({ ok: true, expectedReply: 'Our pleasure, Dana!' }));

  const mismatched = readContextDb();
  await expect(readGratitudeContext({
    draftId: 'draft-1', smsLogId: 'sms-1', expectedPromptVersion: 'house_voice_v10',
    now: '2026-09-24T12:05:00.000Z', activatedAt: '2026-09-24T11:00:00.000Z', dbh: mismatched.dbh,
  })).resolves.toEqual({ ok: false, reason: 'prompt_version_mismatch' });
  expect(mismatched.selectedTables).not.toContain('sms_log');

  const missing = readContextDb();
  await expect(readGratitudeContext({
    draftId: 'draft-1', smsLogId: 'sms-1',
    now: '2026-09-24T12:05:00.000Z', activatedAt: '2026-09-24T11:00:00.000Z', dbh: missing.dbh,
  })).resolves.toEqual({ ok: false, reason: 'prompt_version_mismatch' });
});
