/**
 * Commercial Pest Service Agreement version 2 (migration 20261025120000, owner 2026-10-24 "autopay default"): the
 * payment paragraph becomes {{agreement.payment_terms}}. Runs the real version 1 seed into an in-memory store, then the
 * version 2 migration, so the test proves the replacement against the seeded text itself. Synthetic data only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const seed = require('../models/migrations/20260623000005_seed_commercial_service_agreement');
const v2 = require('../models/migrations/20261025120000_commercial_agreement_payment_terms');
const { AGREEMENT_PAYMENT_TEXT } = require('../../shared/commercial-agreement-terms.cjs');
const { renderDocumentText } = require('../services/document-template-library');

// The document template tables in memory: the query shapes the two migrations use, nothing more.
function memoryKnex() {
  const store = { document_templates: [], document_template_versions: [], customer_contracts: [], audit_log: [], locks: [] };
  let nextId = 1;
  const matches = (row, where) => Object.entries(where).every(([k, v]) => row[k] === v);
  const knex = (table) => {
    const q = { where: {} };
    const rows = () => store[table].filter((row) => matches(row, q.where));
    const api = {
      where(obj) { Object.assign(q.where, obj); return api; },
      forUpdate() { store.locks.push(table); return api; },
      max() { q.max = true; return api; },
      async first() {
        if (q.max) return { n: Math.max(0, ...rows().map((r) => r.version_number)) || null };
        return rows()[0] || undefined;
      },
      insert(row) {
        const stored = { id: `${table}-${nextId++}`, ...row };
        store[table].push(stored);
        const result = Promise.resolve([stored]);
        result.returning = async () => [stored];
        return result;
      },
      async update(patch) {
        const hit = rows();
        hit.forEach((row) => Object.assign(row, patch));
        return hit.length;
      },
      async del() {
        const hit = rows();
        store[table] = store[table].filter((row) => !hit.includes(row));
        return hit.length;
      },
    };
    return api;
  };
  knex.fn = { now: () => 'now()' };
  knex.schema = { hasTable: async (table) => table in store };
  return { knex, store };
}

async function seeded() {
  const made = memoryKnex();
  await seed.up(made.knex);
  const [template] = made.store.document_templates;
  return { ...made, template, v1: made.store.document_template_versions[0] };
}
const activeVersion = ({ store, template }) => store.document_template_versions.find((v) => v.id === template.active_version_id);

describe('commercial agreement payment paragraph migration (version 2)', () => {
  test('version 1 seeds the exact Net 30 paragraph the migration replaces, once', async () => {
    const { v1 } = await seeded();
    expect(v1.body.split(v2.V1_PAYMENT)).toHaveLength(2);
  });

  test('the Net 30 text fills the slot back into version 1\'s paragraph, byte for byte', () => {
    const { rendered, unresolvedVariables } = renderDocumentText(v2.V2_PAYMENT, { agreement: { payment_terms: AGREEMENT_PAYMENT_TEXT.net30 } });
    expect(unresolvedVariables).toEqual([]);
    expect(rendered).toBe(v2.V1_PAYMENT);
  });

  test('up publishes version 2: one paragraph replaced, the slot declared, the active pointer moved; earlier version kept', async () => {
    const made = await seeded();
    await v2.up(made.knex);
    expect(made.store.locks).toEqual(['document_templates']);
    const versions = made.store.document_template_versions;
    expect(versions).toHaveLength(2);
    const next = activeVersion(made);
    expect(next.version_number).toBe(2);
    expect(next.body).toBe(made.v1.body.replace(v2.V1_PAYMENT, v2.V2_PAYMENT));
    expect(JSON.parse(next.variables)).toEqual(['customer.name', 'customer.address', 'service.name', 'agreement.start_date', 'agreement.payment_terms']);
    expect(JSON.parse(next.required_fields)).toEqual(['initials', 'signedName']);
    expect(next).toMatchObject({ title: made.v1.title, signer_disclosure: made.v1.signer_disclosure });
    // Rendered with the Net 30 text, version 2 reads exactly as version 1.
    expect(renderDocumentText(next.body, { agreement: { payment_terms: AGREEMENT_PAYMENT_TEXT.net30 } }).rendered)
      .toBe(made.v1.body);
  });

  test('up is idempotent, and re-activates its own row by body instead of minting a third', async () => {
    const made = await seeded();
    await v2.up(made.knex);
    await v2.up(made.knex);
    expect(made.store.document_template_versions).toHaveLength(2);
    made.template.active_version_id = made.v1.id;
    await v2.up(made.knex);
    expect(made.store.document_template_versions).toHaveLength(2);
    expect(activeVersion(made).version_number).toBe(2);
  });

  test('an admin-edited active body without version 1\'s exact paragraph is left alone', async () => {
    const made = await seeded();
    made.v1.body = made.v1.body.replace('Net 30 terms', 'Net 45 terms');
    await v2.up(made.knex);
    expect(made.store.document_template_versions).toHaveLength(1);
    expect(made.template.active_version_id).toBe(made.v1.id);
  });

  test('the publish writes one audit_log row naming both versions', async () => {
    const made = await seeded();
    await v2.up(made.knex);
    expect(made.store.audit_log).toHaveLength(1);
    expect(made.store.audit_log[0]).toMatchObject({
      actor_type: 'system',
      action: 'migration:20261025120000:publish',
      resource_type: 'document_template',
      resource_id: made.template.id,
      metadata: { templateKey: 'service_agreement.commercial_pest', fromVersionId: made.v1.id, toVersionId: activeVersion(made).id, versionNumber: 2, created: true },
    });
    // A skipped run (already on version 2) writes no second row.
    await v2.up(made.knex);
    expect(made.store.audit_log).toHaveLength(1);
  });

  test('down is a documented no-op: nothing is re-pointed or deleted', async () => {
    const made = await seeded();
    await v2.up(made.knex);
    const before = JSON.stringify(made.store);
    await v2.down(made.knex);
    expect(JSON.stringify(made.store)).toBe(before);
  });
});
