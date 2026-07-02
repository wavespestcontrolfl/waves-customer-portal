/**
 * Cadence-collapse migrations: schema half (booleans → timestamps with
 * backfill) and template half (seed 3-touch copy, retire the old ladder).
 */

const schemaMigration = require('../models/migrations/20260702000030_estimate_followup_cadence_timestamps');
const templateMigration = require('../models/migrations/20260702000031_estimate_followup_cadence_templates');

// ── Schema migration ──────────────────────────────────────────────────────

function makeSchemaKnex({ columns }) {
  const present = new Set(columns);
  const added = [];
  const dropped = [];
  const backfills = [];

  const knex = jest.fn((table) => {
    const b = { _orWhereCols: [], _whereNullCol: null };
    b.where = jest.fn((arg) => {
      if (typeof arg === 'function') {
        arg.call({
          orWhere: (col) => {
            b._orWhereCols.push(col);
            return this;
          },
        });
      }
      return b;
    });
    b.whereNull = jest.fn((col) => {
      b._whereNullCol = col;
      return b;
    });
    b.whereNotNull = jest.fn(() => b);
    b.update = jest.fn(async (payload) => {
      backfills.push({
        table,
        from: [...b._orWhereCols],
        guard: b._whereNullCol,
        payload,
      });
      return 1;
    });
    return b;
  });
  knex.raw = jest.fn((expr) => expr);
  knex.schema = {
    hasTable: jest.fn(async () => true),
    hasColumn: jest.fn(async (_table, col) => present.has(col)),
    alterTable: jest.fn(async (_table, cb) => {
      cb({
        timestamp: (col) => {
          present.add(col);
          added.push(col);
          return { nullable: () => {} };
        },
        boolean: (col) => {
          present.add(col);
          added.push(col);
          return { defaultTo: () => {} };
        },
        dropColumn: (col) => {
          present.delete(col);
          dropped.push(col);
        },
      });
    }),
  };
  return { knex, added, dropped, backfills };
}

describe('estimate_followup_cadence_timestamps migration', () => {
  test('up() adds the four timestamp columns, maps old flags onto them, drops the flags', async () => {
    const { knex, added, dropped, backfills } = makeSchemaKnex({
      columns: [
        'followup_unviewed_sent',
        'followup_viewed_sent',
        'followup_final_sent',
        'followup_expiring_sent',
        'followup_deposit_abandoned_sent',
      ],
    });

    await schemaMigration.up(knex);

    expect(added).toEqual([
      'followup_questions_sent_at',
      'followup_credit_sent_at',
      'followup_expiring_sent_at',
      'followup_deposit_abandoned_sent_at',
    ]);
    // In-flight estimates: either old questions-era nudge marks the new
    // questions touch; final → the day-5 slot; expiring/deposit map 1:1.
    expect(backfills).toEqual([
      expect.objectContaining({
        from: ['followup_unviewed_sent', 'followup_viewed_sent'],
        guard: 'followup_questions_sent_at',
        payload: {
          followup_questions_sent_at: 'COALESCE(last_follow_up_at, CURRENT_TIMESTAMP)',
        },
      }),
      expect.objectContaining({
        from: ['followup_final_sent'],
        guard: 'followup_credit_sent_at',
      }),
      expect.objectContaining({
        from: ['followup_expiring_sent'],
        guard: 'followup_expiring_sent_at',
      }),
      expect.objectContaining({
        from: ['followup_deposit_abandoned_sent'],
        guard: 'followup_deposit_abandoned_sent_at',
      }),
    ]);
    expect(dropped).toEqual([
      'followup_unviewed_sent',
      'followup_viewed_sent',
      'followup_final_sent',
      'followup_expiring_sent',
      'followup_deposit_abandoned_sent',
    ]);
  });

  test('up() is idempotent-safe when a flag column is already gone', async () => {
    const { knex, dropped, backfills } = makeSchemaKnex({
      columns: ['followup_expiring_sent'], // partial schema (e.g. re-run)
    });

    await schemaMigration.up(knex);

    expect(backfills).toEqual([
      expect.objectContaining({ from: ['followup_expiring_sent'] }),
    ]);
    expect(dropped).toEqual(['followup_expiring_sent']);
  });

  test('up() no-ops without the estimates table', async () => {
    const knex = jest.fn();
    knex.schema = { hasTable: jest.fn(async () => false) };

    await schemaMigration.up(knex);

    expect(knex).not.toHaveBeenCalled();
  });
});

// ── Template migration ────────────────────────────────────────────────────

function makeTemplateKnex({ existingKeys = [], hasVariantsTable = true } = {}) {
  const ops = { upserts: [], inserts: [], deletes: [] };
  const knex = jest.fn((table) => {
    const b = { _criteria: null };
    b.columnInfo = jest.fn(async () => ({
      updated_at: true,
      created_at: true,
      is_active: true,
      is_internal: true,
      trigger_event_key: true,
    }));
    b.where = jest.fn((criteria) => {
      b._criteria = criteria;
      return b;
    });
    b.whereIn = jest.fn((col, keys) => {
      b._criteria = { [col]: keys };
      return b;
    });
    b.first = jest.fn(async () =>
      existingKeys.includes(b._criteria?.template_key)
        ? { template_key: b._criteria.template_key }
        : undefined,
    );
    b.update = jest.fn(async (row) => {
      ops.upserts.push({ table, mode: 'update', key: b._criteria.template_key, row });
      return 1;
    });
    b.insert = jest.fn(async (row) => {
      ops.inserts.push({ table, row });
      return [1];
    });
    b.del = jest.fn(async () => {
      ops.deletes.push({ table, criteria: b._criteria });
      return 1;
    });
    return b;
  });
  knex.schema = {
    hasTable: jest.fn(
      async (t) =>
        t === 'sms_templates' || (hasVariantsTable && t === 'sms_template_variants'),
    ),
  };
  return { knex, ops };
}

describe('estimate_followup_cadence_templates migration', () => {
  test('up() seeds the 3-touch set and retires the old ladder incl. A/B variant rows', async () => {
    const { knex, ops } = makeTemplateKnex({
      existingKeys: ['estimate_followup_expiring'], // pre-existing → update path
    });

    await templateMigration.up(knex);

    const insertedKeys = ops.inserts.map((op) => op.row.template_key);
    expect(insertedKeys).toEqual([
      'estimate_followup_questions',
      'estimate_followup_questions_unviewed',
      'estimate_followup_credit',
    ]);
    expect(ops.upserts).toEqual([
      expect.objectContaining({ mode: 'update', key: 'estimate_followup_expiring' }),
    ]);
    expect(ops.deletes).toEqual([
      {
        table: 'sms_templates',
        criteria: {
          template_key: [
            'estimate_followup_unviewed',
            'estimate_followup_viewed',
            'estimate_followup_final',
          ],
        },
      },
      {
        table: 'sms_template_variants',
        criteria: {
          template_key: [
            'estimate_followup_unviewed',
            'estimate_followup_viewed',
            'estimate_followup_final',
          ],
        },
      },
    ]);
  });

  test('up() no-ops without sms_templates', async () => {
    const knex = jest.fn();
    knex.schema = { hasTable: jest.fn(async () => false) };

    await templateMigration.up(knex);

    expect(knex).not.toHaveBeenCalled();
  });

  test('all bodies stay GSM-7 friendly: no em-dashes or curly quotes', async () => {
    for (const t of templateMigration.NEW_TEMPLATES) {
      expect(t.body).not.toMatch(/[—–’‘“”]/);
    }
  });

  test('every declared variable appears in its body and vice versa', () => {
    for (const t of templateMigration.NEW_TEMPLATES) {
      const placeholders = [...t.body.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
      expect([...new Set(placeholders)].sort()).toEqual([...t.variables].sort());
    }
  });
});
