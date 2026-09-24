const knex = require('knex')({ client: 'pg' });
const {
  validateGratitudeDraftContract,
  pendingGratitudeWork,
  gratitudeThreadAdvanced,
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

test('pending-work SQL covers every customer and same-thread operational queue', async () => {
  const { dbh, queries } = compilingDb();
  await expect(pendingGratitudeWork(dbh, {
    customerId: '00000000-0000-4000-8000-000000000003', threadLast10: '9415550100',
  })).resolves.toBe(false);
  expect(queries.map((q) => q.table)).toEqual([
    'service_requests', 'call_commitments as cc', 'call_commitments as cc_sms',
    'triage_items as ti', 'operator_inbox_items as oi', 'agent_decisions as ad',
  ]);
  const sql = queries.map((q) => q.sql).join('\n');
  expect(sql).toContain('"ti"."sms_log_id" = "ti_sms"."id"');
  expect(sql).toContain('"oi"."customer_id"');
  expect(sql).toContain('"ad"."customer_id"');
  expect(sql).toContain('REGEXP_REPLACE');
  expect(queries.flatMap((q) => q.bindings)).toContain('9415550100');
});

test('thread advancement SQL excludes only anchor and owned reservation', async () => {
  const { dbh, queries } = compilingDb();
  await expect(gratitudeThreadAdvanced(dbh, {
    inboundId: '00000000-0000-4000-8000-000000000002',
    fromPhone: '+19415550100', toPhone: '+19413529161',
    skipReservationId: '00000000-0000-4000-8000-000000000099',
  })).resolves.toBe(false);
  expect(queries).toHaveLength(1);
  expect(queries[0].sql.match(/not "id" = \?/g)).toHaveLength(2);
  expect(queries[0].sql).toContain("status IN ('queued','sent','delivered','scheduled','sending')");
  expect(queries[0].bindings).toEqual(expect.arrayContaining([
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000099',
  ]));
});
