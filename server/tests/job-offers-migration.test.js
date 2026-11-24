/**
 * 20261119120000_job_offers: the table and its constraints (checked against the migration source, so the frozen file
 * cannot drift unnoticed), the text-template seed (insert-only, one audit event per added row, no overwrite) and the
 * documented down(). The migrated table itself is exercised in job-offers-postgres.test.js (CI).
 */
const fs = require('fs');
const path = require('path');

const mockAudit = [];
jest.mock('../services/audit-log', () => ({
  recordAuditEvent: jest.fn(async (event) => { mockAudit.push(event); }),
}));

const FILE = path.join(__dirname, '..', 'models', 'migrations', '20261119120000_job_offers.js');
const migration = require(FILE);
const source = fs.readFileSync(FILE, 'utf8');

describe('the table', () => {
  test('keeps one draft and one offer out per application as two partial unique indexes (a revise needs both at once)', () => {
    expect(source).toMatch(/CREATE UNIQUE INDEX job_offers_one_draft_per_application\s+ON job_offers \(application_id\) WHERE status = 'draft'/);
    expect(source).toMatch(/CREATE UNIQUE INDEX job_offers_one_out_per_application\s+ON job_offers \(application_id\) WHERE status IN \('sent', 'date_requested'\)/);
    expect(source).not.toMatch(/IN \('draft', 'sent', 'date_requested'\)/);
  });

  test('allows exactly the eight statuses', () => {
    expect(migration._STATUSES).toEqual(['draft', 'sent', 'accepted', 'declined', 'date_requested', 'expired', 'withdrawn', 'superseded']);
    expect(source).toContain('job_offers_status_check');
  });

  test('indexes the sweeps (status + expiry, status + start date) and cascades from the application', () => {
    expect(source).toContain("t.index(['status', 'expires_at']");
    expect(source).toContain("t.index(['status', 'start_date']");
    expect(source).toMatch(/references\('id'\)\.inTable\('job_applications'\)\.onDelete\('CASCADE'\)/);
  });

  test('every audit action fits the varchar(96) column', () => {
    expect(migration._AUDIT_ACTION.length).toBeLessThanOrEqual(96);
  });
});

describe('the text template seed', () => {
  function makeKnex({ existing = null, hasAudit = true, hasTemplates = true, hasOffers = false } = {}) {
    const inserted = [];
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
      createTable: jest.fn(async () => {}),
    };
    knex.raw = jest.fn(async () => {});
    knex.fn = { now: () => 'NOW' };
    return { knex, inserted };
  }
  beforeEach(() => { mockAudit.length = 0; });

  test('inserts job_offer_sent active, with the owner-approved words and variables, and audits it', async () => {
    const { knex, inserted } = makeKnex();
    await migration.up(knex);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      template_key: 'job_offer_sent', category: 'recruiting', is_active: true, variables: JSON.stringify(['first_name', 'offer_link', 'expires_on']),
      body: "Hi {first_name}, it's Adam with Waves. Your job offer is ready to read and sign: {offer_link} It stays open until {expires_on}. Reply STOP to opt out.",
    });
    expect(mockAudit).toHaveLength(1);
    expect(mockAudit[0]).toMatchObject({ action: 'sms_template.job_offer_sent_seeded', resource_type: 'sms_templates', critical: true });
  });

  test('never overwrites an existing row (someone edited the wording)', async () => {
    const { knex, inserted } = makeKnex({ existing: { id: 't-1', body: 'edited' } });
    await migration.up(knex);
    expect(inserted).toHaveLength(0);
    expect(mockAudit).toHaveLength(0);
  });

  test('says Waves, never the long company name, and promises no reply time', () => {
    const [{ body }] = migration._TEMPLATES;
    expect(body).not.toMatch(/Waves Pest Control/);
    expect(body).not.toMatch(/within|business day|hours/i);
    expect(body).toMatch(/Reply STOP to opt out\.$/);
  });

  test('does not create the table twice, and skips the seed without sms_templates', async () => {
    const { knex } = makeKnex({ hasOffers: true, hasTemplates: false });
    await migration.up(knex);
    expect(knex.schema.createTable).not.toHaveBeenCalled();
    expect(knex).not.toHaveBeenCalled();
  });
});

describe('down()', () => {
  test('drops the table and leaves the admin-editable template row alone', async () => {
    const dropTableIfExists = jest.fn(async () => {});
    const knex = jest.fn(() => { throw new Error('down must not touch sms_templates'); });
    knex.schema = { dropTableIfExists };
    await migration.down(knex);
    expect(dropTableIfExists).toHaveBeenCalledWith('job_offers');
  });
});
