/**
 * 20260831000070_prepay_acceptance_sms_post_delivery_copy — the revived
 * annual-prepay acceptance SMS sends AFTER the invoice delivery, so its body
 * must not promise the invoice in the future tense. Pins:
 *  - up() rewrites ONLY the exact seeded body (admin edits preserved);
 *  - the new body no longer promises a future review/send, is channel-neutral
 *    about delivery (invoiceLinkDelivered = SMS OR email went out; quiet hours
 *    queue the text — GH Codex P2 r4), says "WaveGuard <Tier>" (ruling
 *    2026-08-30), keeps every placeholder, and renders as ONE GSM-7 segment
 *    with a long name + amount (customer SMS ≤ 2 rendered segments);
 *  - is_active is never touched; down() restores the prior body verbatim;
 *  - active sms_template_variants of the key are rewritten when they match
 *    the seeded body and RETIRED otherwise (GH Codex P2 r5 — getTemplate
 *    prefers an active variant, which would keep sending retired copy);
 *    down() restores exactly the rows this migration retired.
 */
const migration = require('../models/migrations/20260831000070_prepay_acceptance_sms_post_delivery_copy');
const { countSegments } = require('../services/messaging/segment-counter');

const { TEMPLATE_KEY, PREVIOUS_BODY, NEXT_BODY } = migration;

function createKnex({ templates = {}, variants = [] } = {}) {
  const state = { rows: templates, variants, updates: [] };
  const knex = jest.fn((table) => {
    if (table === 'sms_templates') {
      const q = {
        criteria: null,
        where(criteria) { q.criteria = criteria; return q; },
        async update(patch) {
          const row = state.rows[q.criteria.template_key];
          if (!row || row.body !== q.criteria.body) return 0;
          Object.assign(row, patch);
          state.updates.push({ key: q.criteria.template_key, patch });
          return 1;
        },
        columnInfo: async () => ({ template_key: {}, body: {}, is_active: {}, updated_at: {} }),
      };
      return q;
    }
    if (table === 'sms_template_variants') {
      const q = {
        criteria: {},
        notCriteria: null,
        rawMarker: null,
        where(criteria) { Object.assign(q.criteria, criteria); return q; },
        whereNot(criteria) { q.notCriteria = criteria; return q; },
        whereRaw(sql, bindings) { q.rawMarker = { sql, bindings }; return q; },
        matches(row) {
          for (const [k, v] of Object.entries(q.criteria)) if (row[k] !== v) return false;
          if (q.notCriteria) for (const [k, v] of Object.entries(q.notCriteria)) if (row[k] === v) return false;
          if (q.rawMarker) {
            let meta = {};
            try { meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {}); } catch { meta = {}; }
            if (meta.retired_by !== q.rawMarker.bindings[0]) return false;
          }
          return true;
        },
        async select() { return state.variants.filter((row) => q.matches(row)); },
        async update(patch) {
          let n = 0;
          for (const row of state.variants) if (q.matches(row)) { Object.assign(row, patch); n += 1; }
          return n;
        },
        columnInfo: async () => ({ template_key: {}, body: {}, status: {}, weight: {}, metadata: {}, updated_at: {} }),
      };
      return q;
    }
    throw new Error(`unexpected table ${table}`);
  });
  knex.schema = { hasTable: jest.fn(async () => true) };
  knex.__state = state;
  return knex;
}

beforeAll(() => { jest.spyOn(console, 'log').mockImplementation(() => {}); });
afterAll(() => { console.log.mockRestore(); });

test('up() rewrites the seeded body; is_active untouched', async () => {
  const knex = createKnex({ templates: { [TEMPLATE_KEY]: { body: PREVIOUS_BODY, is_active: true } } });
  await migration.up(knex);
  expect(knex.__state.rows[TEMPLATE_KEY].body).toBe(NEXT_BODY);
  expect(knex.__state.rows[TEMPLATE_KEY].is_active).toBe(true);
  expect(knex.__state.updates).toHaveLength(1);
  expect(knex.__state.updates[0].patch).not.toHaveProperty('is_active');
});

test('an admin-edited row is preserved', async () => {
  const knex = createKnex({ templates: { [TEMPLATE_KEY]: { body: 'Custom admin copy {first_name}', is_active: true } } });
  await migration.up(knex);
  expect(knex.__state.rows[TEMPLATE_KEY].body).toBe('Custom admin copy {first_name}');
  expect(knex.__state.updates).toHaveLength(0);
});

test('down() restores the prior body verbatim', async () => {
  const knex = createKnex({ templates: { [TEMPLATE_KEY]: { body: NEXT_BODY, is_active: true } } });
  await migration.down(knex);
  expect(knex.__state.rows[TEMPLATE_KEY].body).toBe(PREVIOUS_BODY);
});

test('up() rewrites seed-matching variants, retires the rest; down() restores exactly those', async () => {
  const variants = [
    { id: 1, template_key: TEMPLATE_KEY, status: 'active', body: PREVIOUS_BODY, metadata: null },
    { id: 2, template_key: TEMPLATE_KEY, status: 'active', body: 'Hey {first_name}, plan approved!', metadata: '{"note":"ab-test"}' },
    { id: 3, template_key: TEMPLATE_KEY, status: 'retired', body: 'old idea', metadata: null },
    { id: 4, template_key: 'other_key', status: 'active', body: PREVIOUS_BODY, metadata: null },
  ];
  const knex = createKnex({ templates: { [TEMPLATE_KEY]: { body: PREVIOUS_BODY, is_active: true } }, variants });
  await migration.up(knex);
  expect(variants[0]).toMatchObject({ status: 'active', body: NEXT_BODY });
  expect(variants[1].status).toBe('retired');
  expect(JSON.parse(variants[1].metadata)).toMatchObject({ note: 'ab-test', retired_by: expect.stringContaining('20260831000070') });
  expect(variants[2].status).toBe('retired');
  expect(variants[2].metadata).toBeNull();
  expect(variants[3]).toMatchObject({ status: 'active', body: PREVIOUS_BODY });

  await migration.down(knex);
  expect(variants[0]).toMatchObject({ status: 'active', body: PREVIOUS_BODY });
  expect(variants[1].status).toBe('active');
  expect(variants[2].status).toBe('retired');
  expect(variants[3]).toMatchObject({ status: 'active', body: PREVIOUS_BODY });
});

test('new copy: no future-tense promise, WaveGuard <Tier>, all placeholders kept, one rendered segment', () => {
  expect(NEXT_BODY).not.toMatch(/will review|We'll review|will send/i);
  expect(NEXT_BODY).toContain('WaveGuard {waveguard_tier}');
  for (const ph of ['{first_name}', '{waveguard_tier}', '{amount_text}']) expect(NEXT_BODY).toContain(ph);
  expect(NEXT_BODY).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  const rendered = NEXT_BODY
    .replace('{first_name}', 'Christopher-Alexander')
    .replace('{waveguard_tier}', 'Platinum')
    .replace('{amount_text}', ' for $1,234.56');
  const seg = countSegments(rendered);
  expect(seg.encoding).toBe('GSM_7');
  expect(seg.segmentCount).toBe(1);
});
