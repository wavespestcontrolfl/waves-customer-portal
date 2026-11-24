/**
 * 20261121100000_job_offer_reminder: the column the reminder pass takes an offer with (reminder_claimed_at), the
 * reminder text seed (insert-only, one audit event for the added row, no overwrite) and a down() that removes nothing. The
 * migrated column is exercised in job-offers-postgres.test.js (CI).
 */
const mockAudit = [];
jest.mock('../services/audit-log', () => ({
  recordAuditEvent: jest.fn(async (event) => { mockAudit.push(event); }),
}));

const migration = require('../models/migrations/20261121100000_job_offer_reminder');

function makeKnex({ existing = null, hasAudit = true, hasTemplates = true, hasOffers = true, hasColumn = false } = {}) {
  const inserted = [];
  const columns = { added: [], dropped: [] };
  const knex = jest.fn((table) => {
    expect(table).toBe('sms_templates');
    const q = {
      where: () => q,
      first: async () => existing,
      insert: (row) => { inserted.push(row); return { returning: async () => [{ id: 'tpl-1' }] }; },
    };
    return q;
  });
  knex.schema = {
    hasTable: jest.fn(async (name) => ({ job_offers: hasOffers, sms_templates: hasTemplates, audit_log: hasAudit })[name]),
    hasColumn: jest.fn(async () => hasColumn),
    alterTable: jest.fn(async (table, build) => {
      expect(table).toBe('job_offers');
      build({
        timestamp: (name, opts) => { columns.added.push({ name, opts }); return { nullable: () => {} }; },
        dropColumn: (name) => { columns.dropped.push(name); },
      });
    }),
  };
  return { knex, inserted, columns };
}

beforeEach(() => { mockAudit.length = 0; });

describe('the column', () => {
  test('adds reminder_claimed_at to job_offers as a nullable timestamp with a time zone', async () => {
    const { knex, columns } = makeKnex();
    await migration.up(knex);
    expect(columns.added).toEqual([{ name: 'reminder_claimed_at', opts: { useTz: true } }]);
  });

  test('does not add it twice, and does nothing to a database with no job_offers table', async () => {
    const again = makeKnex({ hasColumn: true });
    await migration.up(again.knex);
    expect(again.knex.schema.alterTable).not.toHaveBeenCalled();
    const none = makeKnex({ hasOffers: false });
    await migration.up(none.knex);
    expect(none.knex.schema.alterTable).not.toHaveBeenCalled();
  });
});

describe('the reminder text seed', () => {
  test('inserts job_offer_reminder active, with the owner-approved words and variables, and audits it', async () => {
    const { knex, inserted } = makeKnex();
    await migration.up(knex);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      template_key: 'job_offer_reminder', category: 'recruiting', is_active: true, variables: JSON.stringify(['first_name', 'offer_link', 'expires_on']),
      body: "Hi {first_name}, it's Adam with Waves. Your job offer is still open until {expires_on}: {offer_link} Reply STOP to opt out.",
    });
    expect(mockAudit).toHaveLength(1);
    expect(mockAudit[0]).toMatchObject({
      action: 'sms_template.job_offer_reminder_seeded', resource_type: 'sms_templates', resource_id: 'tpl-1', critical: true, trx: knex,
    });
    expect(migration._AUDIT_ACTION.length).toBeLessThanOrEqual(96); // the audit_log action column
  });

  test('never overwrites an existing row (someone edited the wording)', async () => {
    const { knex, inserted } = makeKnex({ existing: { id: 't-1', body: 'edited' } });
    await migration.up(knex);
    expect(inserted).toHaveLength(0);
    expect(mockAudit).toHaveLength(0);
  });

  test('says Waves, never the long company name, promises no reply time, and ends with the opt-out line', () => {
    const { body } = migration._TEMPLATE;
    expect(body).not.toMatch(/Waves Pest Control/);
    expect(body).not.toMatch(/within|business day|hours/i);
    expect(body).toMatch(/Reply STOP to opt out\.$/);
  });

  test('skips the seed without sms_templates, and the audit without audit_log', async () => {
    const noTemplates = makeKnex({ hasTemplates: false });
    await migration.up(noTemplates.knex);
    expect(noTemplates.knex).not.toHaveBeenCalled();
    const noAudit = makeKnex({ hasAudit: false });
    await migration.up(noAudit.knex);
    expect(noAudit.inserted).toHaveLength(1);
    expect(mockAudit).toHaveLength(0);
  });
});

describe('down()', () => {
  test('removes nothing: the claims and the admin-editable template row stay, and a second up() adds nothing', async () => {
    const { knex, columns, inserted } = makeKnex({ hasColumn: true, existing: { id: 'tpl-1' } });
    await migration.down(knex);
    expect(knex).not.toHaveBeenCalled();
    expect(knex.schema.alterTable).not.toHaveBeenCalled();
    // up() then finds the column and the row: the claims are still there, so no offer is reminded a second time.
    await migration.up(knex);
    expect(columns.added).toEqual([]);
    expect(columns.dropped).toEqual([]);
    expect(inserted).toEqual([]);
  });
});
