jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => ({})) }));

const { recordAuditEvent } = require('../services/audit-log');
const migration = require('../models/migrations/20260928100000_email_division_fact_register');
const { findUnverifiedClaims } = require('../services/email-division/fact-register');

const { FACTS, SOURCE } = migration._internals;

function knexStub({ hasTable = true, hasAuditLog = true, existingSlugs = [] } = {}) {
  const inserted = [];
  const knex = jest.fn(() => {
    let where = {};
    const q = {
      where: jest.fn((cond) => { where = cond; return q; }),
      first: jest.fn(async () => (existingSlugs.includes(where.slug) ? { id: `kb-${where.slug}` } : undefined)),
      insert: jest.fn((row) => {
        inserted.push(row);
        return { returning: jest.fn(async () => [{ id: `kb-${row.slug}` }]) };
      }),
    };
    return q;
  });
  knex.schema = { hasTable: jest.fn(async (t) => (t === 'audit_log' ? hasAuditLog : hasTable)) };
  return { knex, inserted };
}

beforeEach(() => jest.clearAllMocks());

describe('email division fact register seed', () => {
  test('inserts every fact as an active, high-confidence facts row and audits it in the migration transaction', async () => {
    const { knex, inserted } = knexStub();

    await migration.up(knex);

    expect(inserted).toHaveLength(FACTS.length);
    for (const row of inserted) {
      expect(row).toMatchObject({ category: 'facts', source: SOURCE, status: 'active', active: true, confidence: 'high', version: 1 });
      expect(row.path).toBe(`kb/facts/${row.slug}.md`);
      const meta = JSON.parse(row.metadata);
      expect(meta.source_url).toBe(meta.source_urls[0]);
      expect(meta.quote).toBe(row.summary);
    }
    expect(recordAuditEvent).toHaveBeenCalledTimes(FACTS.length);
    for (const [args] of recordAuditEvent.mock.calls) {
      expect(args).toMatchObject({ action: 'knowledge_base.fact_seeded', trx: knex, critical: true });
    }
  });

  test('is insert-only: a slug already present is never touched', async () => {
    const existing = ['fact-gentrol-igr-hydroprene', 'fact-large-patch'];
    const { knex, inserted } = knexStub({ existingSlugs: existing });

    await migration.up(knex);

    expect(inserted).toHaveLength(FACTS.length - existing.length);
    expect(inserted.map((r) => r.slug)).not.toEqual(expect.arrayContaining(existing));
    expect(recordAuditEvent).toHaveBeenCalledTimes(FACTS.length - existing.length);
  });

  test('no-ops without the knowledge_base table; skips only the audit write without audit_log', async () => {
    const missing = knexStub({ hasTable: false });
    await migration.up(missing.knex);
    expect(missing.inserted).toHaveLength(0);

    const noAudit = knexStub({ hasAuditLog: false });
    await migration.up(noAudit.knex);
    expect(noAudit.inserted).toHaveLength(FACTS.length);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test('slugs are unique and every fact carries a quote and at least one https source', () => {
    expect(new Set(FACTS.map((f) => f.slug)).size).toBe(FACTS.length);
    for (const fact of FACTS) {
      expect(fact.quote.length).toBeGreaterThan(20);
      expect(fact.content.length).toBeGreaterThan(40);
      expect(fact.sourceUrls.length).toBeGreaterThan(0);
      for (const url of fact.sourceUrls) expect(url).toMatch(/^https:\/\//);
    }
  });

  test('no retailer page is a source', () => {
    for (const fact of FACTS) {
      for (const url of fact.sourceUrls) {
        expect(url).not.toMatch(/domyown|solutionsstores|diypestcontrol|amazon\.|walmart\.|homedepot|lowes\./i);
      }
    }
  });

  test('the register holds none of the timelines no label or publication states', () => {
    for (const fact of FACTS) {
      const text = `${fact.title} ${fact.quote} ${fact.content}`;
      expect(text).not.toMatch(/\b1\s*(?:–|-|to)\s*2\s+weeks\b/i);
      expect(text).not.toMatch(/\bup\s+to\s+90\s+days\b/i);
      expect(text).not.toMatch(/\babout\s+30\s+days\b/i);
      expect(text).not.toMatch(/\b7\s*(?:–|-|to)\s*14\s+days\b/i);
      expect(text).not.toMatch(/\b30\s*(?:–|-|to)\s*90\b/i);
      expect(text).not.toMatch(/\b5\s*(?:–|-|to)\s*10\s+days\b/i);
      expect(text).not.toMatch(/\b14\s+days\b/i);
      expect(text).not.toMatch(/four\s+(?:or\s+more\s+)?weeks/i);
    }
  });

  test('the register passes its own claim rules: no fact states a claim the validator blocks', () => {
    for (const fact of FACTS) {
      expect({ slug: fact.slug, claims: findUnverifiedClaims(fact.quote) }).toEqual({ slug: fact.slug, claims: [] });
      expect({ slug: fact.slug, claims: findUnverifiedClaims(fact.content) }).toEqual({ slug: fact.slug, claims: [] });
    }
  });
});
