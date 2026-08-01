const migration = require('../models/migrations/20260801200000_billing_copy_no_false_interruption');

// Claims of a consequence we do not actually carry out. A balance never
// withholds service — the visit is scheduled, dispatched and performed
// regardless — so none of these may appear in billing copy. The positive
// framings are here because the first pass of this sweep missed all three:
// "keep you on schedule" is the same promise as "won't be interrupted".
const FALSE_CONSEQUENCE = new RegExp([
  'interrupt', 'disrupt', 'suspend', 'shut off', 'stop service', 'discontinue',
  'keep you on schedule', 'keep your appointment', 'keep service active',
  'keeps? your service',
].join('|'), 'i');

function placeholders(body) {
  return (String(body).match(/\{[a-z_]+\}/g) || []).sort();
}

function buildKnex({ rows = [], variants = [], hasVariantsTable = true } = {}) {
  const state = { updates: [] };
  const knex = jest.fn((table) => {
    expect(['sms_templates', 'sms_template_variants']).toContain(table);
    const target = table === 'sms_template_variants' ? variants : rows;
    const query = {
      columnInfo: jest.fn(async () => ({ body: {}, updated_at: {}, template_key: {} })),
      where: jest.fn((criteria) => {
        query.__where = criteria;
        return query;
      }),
      update: jest.fn(async (patch) => {
        // Mirror a real UPDATE ... WHERE template_key = ? AND body = ?:
        // zero rows matched when the stored body no longer equals the one
        // the migration audited.
        const matched = target.filter(
          (r) => r.template_key === query.__where.template_key && r.body === query.__where.body,
        );
        state.updates.push({ table, where: query.__where, patch, matched: matched.length });
        matched.forEach((r) => { r.body = patch.body; });
        return matched.length;
      }),
    };
    return query;
  });
  knex.schema = { hasTable: jest.fn(async (t) => (t === 'sms_template_variants' ? hasVariantsTable : true)) };
  return { knex, state, rows, variants };
}

describe('billing copy — no false service-interruption claim', () => {
  test('every rewrite removes the consequence claim and keeps the copy usable', () => {
    expect(migration.REWRITES.length).toBeGreaterThan(0);
    for (const [key, expected, next] of migration.REWRITES) {
      // The expected body is the thing we are fixing — it must contain the
      // claim, or this migration is targeting the wrong text.
      expect(`${key}: ${expected}`).toMatch(FALSE_CONSEQUENCE);
      expect(`${key}: ${next}`).not.toMatch(FALSE_CONSEQUENCE);
      // Senders interpolate by name; dropping one renders a literal
      // "{pay_url}" into a customer text.
      expect(placeholders(next)).toEqual(placeholders(expected));
      // The ask and the way to act on it both survive.
      expect(next).toMatch(/\{pay_url\}|\{update_card_url\}|portal\.wavespestcontrol\.com/);
    }
  });

  test('up() rewrites rows that still carry the audited body', async () => {
    const rows = migration.REWRITES.map(([template_key, expected]) => ({ template_key, body: expected }));
    const { knex } = buildKnex({ rows });

    await migration.up(knex);

    migration.REWRITES.forEach(([template_key, , next]) => {
      expect(rows.find((r) => r.template_key === template_key).body).toBe(next);
    });
  });

  test('up() skips a row an operator edited in /admin since the audit', async () => {
    const [templateKey, , next] = migration.REWRITES[0];
    const handEdited = 'Hand-written copy an operator saved in /admin.';
    const rows = [{ template_key: templateKey, body: handEdited }];
    const { knex, state } = buildKnex({ rows });

    await migration.up(knex);

    // Clobbering a newer hand edit is the failure mode the predicate guard
    // exists to prevent.
    expect(rows[0].body).toBe(handEdited);
    expect(rows[0].body).not.toBe(next);
    expect(state.updates.find((u) => u.where.template_key === templateKey).matched).toBe(0);
  });

  test('up() rewrites an A/B variant carrying the claim — getTemplate prefers it over the base row', async () => {
    const [templateKey, expected, next] = migration.REWRITES[0];
    const variants = [
      { template_key: templateKey, variant_key: 'b', body: expected },
      { template_key: templateKey, variant_key: 'c', body: 'independently written variant copy' },
    ];
    const { knex } = buildKnex({ rows: [], variants });

    await migration.up(knex);

    // admin-sms-templates.js getTemplate sends `variant?.body || t.body`, so
    // a stale variant would keep the claim live no matter what the base row
    // says.
    expect(variants[0].body).toBe(next);
    // ...but only the ones matching the audited body.
    expect(variants[1].body).toBe('independently written variant copy');
  });

  test('up() also catches a variant still on the PRE-house-voice body', async () => {
    // 20260801000001_sms_house_voice_sweep rewrote sms_templates only, so a
    // variant created before it never got that copy — it would miss an
    // exact-match on the current body while still outranking the base row.
    const [templateKey, , next] = migration.REWRITES[0];
    const legacy = migration.LEGACY_VARIANT_BODIES[templateKey][0];
    const variants = [{ template_key: templateKey, variant_key: 'legacy', body: legacy }];
    const { knex } = buildKnex({ rows: [], variants });

    await migration.up(knex);

    expect(variants[0].body).toBe(next);
  });

  test('every legacy variant body maps to a key this migration rewrites, and carries the claim', () => {
    const keys = new Set(migration.REWRITES.map(([k]) => k));
    for (const [key, bodies] of Object.entries(migration.LEGACY_VARIANT_BODIES)) {
      expect(keys).toContain(key);
      // A legacy body that does NOT carry the claim would be silently
      // overwriting copy that was already fine.
      bodies.forEach((body) => expect(`${key}: ${body}`).toMatch(FALSE_CONSEQUENCE));
    }
  });

  test('up() tolerates a database with no variants table', async () => {
    const rows = migration.REWRITES.map(([template_key, expected]) => ({ template_key, body: expected }));
    const { knex } = buildKnex({ rows, hasVariantsTable: false });

    await expect(migration.up(knex)).resolves.not.toThrow();
    expect(rows[0].body).toBe(migration.REWRITES[0][2]);
  });

  test('down() restores the original body, and only for rows this migration wrote', async () => {
    const [templateKey, expected, next] = migration.REWRITES[0];
    const rows = [
      { template_key: templateKey, body: next },
      { template_key: migration.REWRITES[1][0], body: 'edited after the migration ran' },
    ];
    const { knex } = buildKnex({ rows });

    await migration.down(knex);

    expect(rows[0].body).toBe(expected);
    expect(rows[1].body).toBe('edited after the migration ran');
  });
});
