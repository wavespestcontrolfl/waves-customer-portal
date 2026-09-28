jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => ({})) }));

const { recordAuditEvent } = require('../services/audit-log');
const migration = require('../models/migrations/20260928061000_email_division_fact_register_label_corrections');

const { CORRECTIONS } = migration._internals;
const SEEDED = {
  'fact-taurus-sc-non-repellent': 'visible activity can continue for 1 to 2 weeks after treatment, up to 90 days',
  'fact-bifenthrin-talstar-p-residual': 'residual outdoor control for about 30 days under typical conditions',
  'fact-gentrol-igr-hydroprene': 'a visible drop typically appears within 7 to 14 days, full control over 30- to 90-day',
};

function knexStub({ hasTable = true, hasAuditLog = true, rows = {} } = {}) {
  const updates = [];
  const knex = jest.fn(() => {
    let where = {};
    const q = {
      where: jest.fn((cond) => { where = { ...where, ...cond }; return q; }),
      first: jest.fn(async () => {
        const row = rows[where.slug];
        return row && row.source === where.source ? row : undefined;
      }),
      update: jest.fn(async (patch) => {
        updates.push({ where, patch });
        const target = Object.values(rows).find((r) => r.id === where.id);
        if (target) Object.assign(target, patch);
        return 1;
      }),
    };
    return q;
  });
  knex.schema = { hasTable: jest.fn(async (t) => (t === 'audit_log' ? hasAuditLog : hasTable)) };
  return { knex, updates };
}

function seededRows() {
  return Object.fromEntries(Object.entries(SEEDED).map(([slug, content], i) => [slug, {
    id: `kb-${i + 1}`, slug, source: 'email-division-fact-register', content, version: 1,
  }]));
}

beforeEach(() => jest.clearAllMocks());

describe('email division fact register: label corrections migration', () => {
  test('rewrites the three seeded product facts and audits each in the migration transaction', async () => {
    const { knex, updates } = knexStub({ rows: seededRows() });

    await migration.up(knex);

    expect(updates.map((u) => u.where.id).sort()).toEqual(['kb-1', 'kb-2', 'kb-3']);
    for (const { patch } of updates) {
      expect(patch.version).toBe(2);
      expect(JSON.parse(patch.metadata).verified_on).toBe('2026-09-28');
    }
    expect(recordAuditEvent).toHaveBeenCalledTimes(3);
    for (const [args] of recordAuditEvent.mock.calls) {
      expect(args).toMatchObject({ action: 'knowledge_base.fact_corrected', trx: knex, critical: true });
    }
  });

  test('no corrected text or quote states a timeline the label does not', () => {
    for (const fix of CORRECTIONS) {
      const text = `${fix.title} ${fix.quote} ${fix.content}`;
      expect(text).not.toMatch(/1\s*(?:–|-|to)\s*2\s+weeks/i);
      expect(text).not.toMatch(/\b90\s+days\b/i);
      expect(text).not.toMatch(/\babout\s+30\s+days\b/i);
      expect(text).not.toMatch(/\b7\s*(?:–|-|to)\s*14\s+days\b/i);
      expect(text).not.toMatch(/\b30\s*(?:–|-|to)\s*90\b/i);
      expect(text).not.toContain(fix.seededMarker);
      expect(fix.sourceUrl).not.toMatch(/domyown|solutionsstores/i);
    }
  });

  test('is idempotent: a second run changes nothing', async () => {
    const rows = seededRows();
    const first = knexStub({ rows });
    await migration.up(first.knex);
    const second = knexStub({ rows });

    await migration.up(second.knex);

    expect(second.updates).toHaveLength(0);
  });

  test('leaves a row a person has edited untouched', async () => {
    const rows = seededRows();
    rows['fact-gentrol-igr-hydroprene'].content = 'Edited by the office: see the label.';
    const { knex, updates } = knexStub({ rows });

    await migration.up(knex);

    expect(updates.map((u) => u.where.id).sort()).toEqual(['kb-1', 'kb-2']);
  });

  test('skips facts that were never seeded here and rows from another source', async () => {
    const rows = seededRows();
    delete rows['fact-taurus-sc-non-repellent'];
    rows['fact-bifenthrin-talstar-p-residual'].source = 'manual';
    const { knex, updates } = knexStub({ rows });

    await migration.up(knex);

    expect(updates.map((u) => u.where.id)).toEqual(['kb-3']);
  });

  test('no-ops without the knowledge_base table and skips the audit write without audit_log', async () => {
    const missing = knexStub({ hasTable: false, rows: seededRows() });
    await migration.up(missing.knex);
    expect(missing.updates).toHaveLength(0);

    const noAudit = knexStub({ hasAuditLog: false, rows: seededRows() });
    await migration.up(noAudit.knex);
    expect(noAudit.updates).toHaveLength(3);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });
});
