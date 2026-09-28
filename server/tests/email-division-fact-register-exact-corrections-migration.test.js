jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => ({})) }));

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { recordAuditEvent } = require('../services/audit-log');
const exact = require('../models/migrations/20260928060500_email_division_fact_register_exact_corrections');
const loose = require('../models/migrations/20260928061000_email_division_fact_register_label_corrections');

const { SEEDED_FINGERPRINTS, fingerprint, EDITED_SOURCE } = exact._internals;
const SOURCE = 'email-division-fact-register';
const SLUGS = Object.keys(SEEDED_FINGERPRINTS);

// The rows exactly as the (frozen) seed migration writes them.
function seededFacts() {
  const file = path.join(__dirname, '../models/migrations/20260928050000_email_division_fact_register.js');
  const src = `${fs.readFileSync(file, 'utf8')}\nmodule.exports.__FACTS = FACTS;`;
  const m = { exports: {} };
  vm.runInNewContext(src, { module: m, exports: m.exports, require: () => ({}) });
  return m.exports.__FACTS.filter((f) => SLUGS.includes(f.slug));
}

function seededRows() {
  return Object.fromEntries(seededFacts().map((f, i) => [f.slug, {
    id: `kb-${i + 1}`, slug: f.slug, source: SOURCE, title: f.title, content: f.content, summary: f.quote, version: 1,
  }]));
}

// One shared table for both migrations, so running them in order is real.
function knexStub(rows, { hasAuditLog = true } = {}) {
  const updates = [];
  const knex = jest.fn(() => {
    let where = {};
    const q = {
      where: jest.fn((cond) => { where = { ...where, ...cond }; return q; }),
      first: jest.fn(async () => {
        const row = where.slug ? rows[where.slug] : Object.values(rows).find((r) => r.id === where.id);
        return row && (!where.source || row.source === where.source) ? { ...row } : undefined;
      }),
      update: jest.fn(async (patch) => {
        const target = Object.values(rows).find((r) => r.id === where.id);
        updates.push({ id: where.id, patch });
        if (target) Object.assign(target, patch);
        return 1;
      }),
    };
    return q;
  });
  knex.schema = { hasTable: jest.fn(async (t) => (t === 'audit_log' ? hasAuditLog : true)) };
  return { knex, updates };
}

beforeEach(() => jest.clearAllMocks());

describe('email division fact register: exact-match corrections', () => {
  test('the stored fingerprints are those of the rows the seed writes', () => {
    const rows = seededRows();
    expect(Object.keys(rows).sort()).toEqual([...SLUGS].sort());
    for (const slug of SLUGS) expect(fingerprint(rows[slug])).toBe(SEEDED_FINGERPRINTS[slug]);
  });

  test('an untouched seeded row is rewritten, and the later marker migration then skips it', async () => {
    const rows = seededRows();
    const first = knexStub(rows);
    await exact.up(first.knex);
    expect(first.updates).toHaveLength(3);
    expect(Object.values(rows).every((r) => r.version === 2 && r.source === SOURCE)).toBe(true);

    const second = knexStub(rows);
    await loose.up(second.knex);
    expect(second.updates).toHaveLength(0);
  });

  test('a row a person edited around the marker keeps their text through BOTH migrations', async () => {
    const rows = seededRows();
    const edited = rows['fact-gentrol-igr-hydroprene'];
    edited.title = 'Gentrol: office note';
    edited.content = `${edited.content} Office correction: check the label before quoting this.`;
    const personsText = edited.content;

    const first = knexStub(rows);
    await exact.up(first.knex);
    const second = knexStub(rows);
    await loose.up(second.knex);

    expect(edited.content).toBe(personsText);
    expect(edited.title).toBe('Gentrol: office note');
    expect(edited.source).toBe(EDITED_SOURCE);
    expect(edited.version).toBe(1);
    expect(second.updates.map((u) => u.id)).not.toContain(edited.id);
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'knowledge_base.fact_correction_held', resource_id: edited.id, critical: true,
    }));
  });

  test('a row already corrected, or edited with the marker removed, is left alone', async () => {
    const rows = seededRows();
    rows['fact-taurus-sc-non-repellent'].content = 'Rewritten by the office with no timeline at all.';
    const { knex, updates } = knexStub(rows);

    await exact.up(knex);

    expect(updates.map((u) => u.id)).not.toContain(rows['fact-taurus-sc-non-repellent'].id);
    expect(rows['fact-taurus-sc-non-repellent'].source).toBe(SOURCE);
  });

  test('is idempotent and audits each write inside the migration transaction', async () => {
    const rows = seededRows();
    const first = knexStub(rows);
    await exact.up(first.knex);
    expect(recordAuditEvent).toHaveBeenCalledTimes(3);
    for (const [args] of recordAuditEvent.mock.calls) {
      expect(args).toMatchObject({ action: 'knowledge_base.fact_corrected', trx: first.knex, critical: true });
    }

    const again = knexStub(rows);
    await exact.up(again.knex);
    expect(again.updates).toHaveLength(0);
  });
});
