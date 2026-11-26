// Owner ruling 2026-11-25 ("retreatment only until insurance confirms a cap"): the signable bond seeded as
// service_agreement.termite_bond_repair stops promising damage repair. The first block is pure; the second runs
// the migration against the migrated PostgreSQL database in a transaction that is rolled back (skips without
// DATABASE_URL; CI runs it).
const SKIP = !process.env.DATABASE_URL;

const fs = require('fs');
const knexLib = require('knex');
const seed = require('../models/migrations/20260623000003_seed_termite_bond_agreements');
const mig = require('../models/migrations/20261125210000_termite_bond_repair_template_retreatment_only');
const bonds = require('../models/migrations/20261124030200_termite_bond_agreements_term_billing');

const seedSource = fs.readFileSync(require.resolve('../models/migrations/20260623000003_seed_termite_bond_agreements'), 'utf8');

// The seeded repair bond as the term-billing migration (20261124030200) left it, built by running the real seed
// against a recording knex and then the real splice, so the migration's SEEDED_BODY cannot drift from production text.
async function seededBodyAsProductionHolds() {
  let body = null;
  const chain = { first: async () => null, update: async () => 1 };
  const knex = () => ({
    where: () => chain,
    insert: (row) => ({
      returning: async () => {
        if (row.title === 'Termite Repair & Retreatment Bond Agreement' && row.body) body = row.body;
        return [{ id: 1, ...row }];
      },
    }),
  });
  knex.fn = { now: () => 'now' };
  await seed.up(knex);
  const target = bonds.TARGETS.find((t) => t.template_key === mig.TEMPLATE_KEY);
  return bonds.spliceBondTerms(body, target).body;
}

const norm = (t) => String(t).replace(/\s+/g, ' ').trim();
const SEEDED_BODY = mig.SEEDED_BODY;

describe('repair bond becomes retreatment only (pure)', () => {
  test('SEEDED_BODY is exactly the seed text after 20261124030200', async () => {
    expect(norm(await seededBodyAsProductionHolds())).toBe(norm(mig.SEEDED_BODY));
  });

  test('the new coverage paragraph is the retreatment bond seed text', () => {
    expect(seedSource).toContain(mig.NEW_COVERAGE);
  });

  test('known bodies are recognised, whitespace aside; the converted body makes no repair promise', () => {
    expect(mig.classifyBody(mig.SEEDED_BODY)).toBe('seeded');
    expect(mig.classifyBody(`${mig.SEEDED_BODY}\n`.replace(/\n\n/g, '\r\n\r\n'))).toBe('seeded');
    expect(mig.classifyBody(mig.CONVERTED_BODY)).toBe('converted');
    expect(mig.CONVERTED_BODY.startsWith('Termite Retreatment Bond Agreement\n')).toBe(true);
    const withoutDenials = mig.CONVERTED_BODY
      .replace('It does NOT include repair of any termite damage', '')
      .replace('does NOT include repair of termite damage', '');
    expect(withoutDenials).not.toMatch(/repair/i);
  });

  test('any other body is unrecognised, whatever it says', () => {
    expect(mig.classifyBody('Edited by an admin.')).toBe('unrecognised');
    expect(mig.classifyBody(`${SEEDED_BODY}\n\nAdditional coverage: Waves will repair damaged fascia caused by termites.`)).toBe('unrecognised');
    // No "repair" in it at all: still unrecognised, so it is paused, never published.
    expect(mig.classifyBody(`${SEEDED_BODY}\n\nWaves will replace termite-damaged wood at our expense.`)).toBe('unrecognised');
    expect(mig.classifyBody(`${mig.CONVERTED_BODY}\n\nWaves will replace termite-damaged wood at our expense.`)).toBe('unrecognised');
    expect(mig.classifyBody(`${mig.CONVERTED_BODY}\n\nWaves will repair termite damage at no charge.`)).toBe('unrecognised');
    expect(mig.classifyBody('')).toBe('unrecognised');
  });

  test('title and signer disclosure must be the seeded values', () => {
    const ok = { title: 'Termite Repair & Retreatment Bond Agreement', signer_disclosure: 'I agree to receive and sign this document electronically.' };
    expect(mig.fieldsRecognised(ok)).toBe(true);
    expect(mig.fieldsRecognised({ ...ok, title: 'Termite Retreatment Bond Agreement' })).toBe(true);
    expect(mig.fieldsRecognised({ ...ok, title: 'Termite Damage Repair Bond' })).toBe(false);
    expect(mig.fieldsRecognised({ ...ok, signer_disclosure: 'I agree to a repair bond.' })).toBe(false);
  });
});

// In-memory knex for the two tables the migration touches, so up() runs without PostgreSQL.
function fakeKnex({ template, versions }) {
  const db = { document_templates: [template], document_template_versions: versions };
  const match = (row, cond) => Object.entries(cond).every(([k, v]) => row[k] === v);
  const knex = (table) => {
    let rows = db[table];
    const q = {
      where: (cond) => { rows = rows.filter((r) => match(r, cond)); return q; },
      forUpdate: () => q,
      orderBy: () => q,
      first: async () => rows[0],
      then: (resolve) => resolve(rows),
      insert: (row) => ({
        returning: async () => {
          const withId = { id: `v${db[table].length + 1}`, ...row };
          db[table].push(withId);
          return [withId];
        },
      }),
      update: async (patch) => { rows.forEach((r) => Object.assign(r, patch)); return rows.length; },
    };
    return q;
  };
  knex.fn = { now: () => 'now' };
  knex.schema = { hasTable: async () => true };
  knex.db = db;
  return knex;
}

function repairBondState({ body, title = 'Termite Repair & Retreatment Bond Agreement', disclosure = 'I agree to receive and sign this document electronically.' }) {
  return fakeKnex({
    template: {
      id: 't1', template_key: mig.TEMPLATE_KEY, status: 'active', active_version_id: 'v1',
      name: 'Termite Repair & Retreatment Bond Agreement', description: 'Signable termite bond covering retreatment plus repair of new covered termite damage. Term billing.',
      tags: JSON.stringify(['agreement', 'termite', 'bond', 'repair']),
    },
    versions: [{ id: 'v1', template_id: 't1', version_number: 1, title, body, signer_disclosure: disclosure, variables: '[]', required_fields: '["initials","signedName"]' }],
  });
}

describe('repair bond migration up() (in-memory)', () => {
  test('known seeded text is converted into a new version; the old version is untouched; a second run adds nothing', async () => {
    const knex = repairBondState({ body: mig.SEEDED_BODY });
    await mig.up(knex);
    const { document_templates: [template], document_template_versions: versions } = knex.db;
    expect(versions).toHaveLength(2);
    expect(versions[0].body).toBe(mig.SEEDED_BODY);
    expect(versions[1]).toMatchObject({ version_number: 2, title: 'Termite Retreatment Bond Agreement', body: mig.CONVERTED_BODY });
    expect(template).toMatchObject({ status: 'active', active_version_id: versions[1].id, name: 'Termite Retreatment Bond Agreement (former repair bond)' });
    expect(JSON.parse(template.tags)).not.toContain('repair');
    await mig.up(knex);
    expect(knex.db.document_template_versions).toHaveLength(2);
  });

  test.each([
    ['an added clause that never says repair', () => `${mig.SEEDED_BODY}\n\nWaves will replace termite-damaged wood at our expense.`],
    ['an added repair clause', () => `${mig.SEEDED_BODY}\n\nWaves will repair damaged fascia.`],
    ['an edited coverage paragraph', () => mig.SEEDED_BODY.replace('Waves will (1) re-treat', 'Waves will (1) retreat')],
    ['a clause added to an already converted body', () => `${mig.CONVERTED_BODY}\n\nWaves will replace termite-damaged wood at our expense.`],
  ])('%s pauses the template, keeps the text and publishes nothing', async (_name, makeBody) => {
    const body = makeBody();
    const knex = repairBondState({ body });
    await mig.up(knex);
    const { document_templates: [template], document_template_versions: versions } = knex.db;
    expect(template.status).toBe('paused');
    expect(template.active_version_id).toBe('v1');
    expect(versions).toHaveLength(1);
    expect(versions[0].body).toBe(body);
  });

  test('a repair reference in the title or the signer disclosure pauses the template', async () => {
    for (const patch of [{ title: 'Termite Damage Repair Bond' }, { disclosure: 'I agree to a repair bond.' }]) {
      const knex = repairBondState({ body: mig.SEEDED_BODY, ...patch });
      await mig.up(knex);
      expect(knex.db.document_templates[0].status).toBe('paused');
      expect(knex.db.document_template_versions).toHaveLength(1);
    }
  });

  test('a converted body that still has the repair title gets a new version with the corrected title and the same body', async () => {
    const knex = repairBondState({ body: mig.CONVERTED_BODY });
    await mig.up(knex);
    const { document_templates: [template], document_template_versions: versions } = knex.db;
    expect(template.status).toBe('active');
    expect(versions).toHaveLength(2);
    expect(versions[1]).toMatchObject({ title: 'Termite Retreatment Bond Agreement', body: mig.CONVERTED_BODY });
    expect(template.active_version_id).toBe(versions[1].id);
  });

  test('a fully converted template is left alone', async () => {
    const knex = repairBondState({ body: mig.CONVERTED_BODY, title: 'Termite Retreatment Bond Agreement' });
    knex.db.document_templates[0].name = 'Termite Retreatment Bond Agreement (former repair bond)';
    knex.db.document_templates[0].description = 'x';
    knex.db.document_templates[0].tags = JSON.stringify(['agreement']);
    await mig.up(knex);
    expect(knex.db.document_template_versions).toHaveLength(1);
    expect(knex.db.document_templates[0].active_version_id).toBe('v1');
  });
});


const describeDb = SKIP ? describe.skip : describe;

describeDb('repair bond template migration (PostgreSQL, rolled back)', () => {
  let database;
  let trx;
  beforeAll(() => {
    database = knexLib({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });
  beforeEach(async () => { trx = await database.transaction(); });
  afterEach(async () => { await trx.rollback(); });
  afterAll(async () => { if (database) await database.destroy(); });

  async function activeOf() {
    const template = await trx('document_templates').where({ template_key: mig.TEMPLATE_KEY }).first();
    if (!template) return { template: null, active: null };
    const active = await trx('document_template_versions').where({ id: template.active_version_id }).first();
    return { template, active };
  }

  async function setActive(before, { title, body }) {
    const top = await trx('document_template_versions').where({ template_id: before.template.id }).max('version_number as max').first();
    const [row] = await trx('document_template_versions').insert({
      template_id: before.template.id,
      version_number: Number(top.max) + 1,
      title,
      body,
      signer_disclosure: 'I agree to receive and sign this document electronically.',
      variables: typeof before.active.variables === 'string' ? before.active.variables : JSON.stringify(before.active.variables ?? []),
      required_fields: JSON.stringify(before.active.required_fields ?? ['initials', 'signedName']),
      created_by: null,
      published_at: trx.fn.now(),
    }).returning('*');
    await trx('document_templates').where({ id: before.template.id }).update({ active_version_id: row.id, status: 'active' });
    return row;
  }

  test('an admin clause that replaces damaged wood pauses the template and keeps its text', async () => {
    const before = await activeOf();
    if (!before.active) return;
    const edited = `${SEEDED_BODY}\n\nWaves will replace termite-damaged wood at our expense.`;
    const prior = await setActive(before, { title: 'Termite Repair & Retreatment Bond Agreement', body: edited });
    await mig.up(trx);
    const after = await activeOf();
    expect(after.template.status).toBe('paused');
    expect(after.active.id).toBe(prior.id);
    expect(after.active.body).toBe(edited);
  });

  test('a converted body that still carries the repair title gets a new version with the corrected title', async () => {
    const before = await activeOf();
    if (!before.active) return;
    const prior = await setActive(before, { title: 'Termite Repair & Retreatment Bond Agreement', body: mig.CONVERTED_BODY });
    await mig.up(trx);
    const after = await activeOf();
    expect(after.template.status).toBe('active');
    expect(after.active.id).not.toBe(prior.id);
    expect(after.active.title).toBe('Termite Retreatment Bond Agreement');
    expect(after.active.body).toBe(mig.CONVERTED_BODY);
  });

  test('a new active version says retreatment only; the signed-on version keeps its wording; second run adds nothing', async () => {
    const before = await activeOf();
    if (!before.active) return; // not seeded on this database
    // CI migrates every file first, so the template is already retreatment only: put it back to the old wording.
    const top = await trx('document_template_versions').where({ template_id: before.template.id }).max('version_number as max').first();
    const [prior] = await trx('document_template_versions').insert({
      template_id: before.template.id,
      version_number: Number(top.max) + 1,
      title: 'Termite Repair & Retreatment Bond Agreement',
      body: SEEDED_BODY,
      signer_disclosure: 'I agree to receive and sign this document electronically.',
      variables: typeof before.active.variables === 'string' ? before.active.variables : JSON.stringify(before.active.variables ?? []),
      required_fields: JSON.stringify(before.active.required_fields ?? ['initials', 'signedName']),
      created_by: null,
      published_at: trx.fn.now(),
    }).returning('*');
    await trx('document_templates').where({ id: before.template.id }).update({ active_version_id: prior.id });

    await mig.up(trx);
    const after = await activeOf();
    expect(after.active.id).not.toBe(prior.id);
    expect(after.active.title).toBe('Termite Retreatment Bond Agreement');
    expect(after.active.body).toContain(mig.NEW_COVERAGE);
    const oldRow = await trx('document_template_versions').where({ id: prior.id }).first();
    expect(oldRow.body).toBe(SEEDED_BODY);

    const count = await trx('document_template_versions').where({ template_id: after.template.id }).count('* as n').first();
    await mig.up(trx);
    const again = await activeOf();
    const countAgain = await trx('document_template_versions').where({ template_id: after.template.id }).count('* as n').first();
    expect(again.active.id).toBe(after.active.id);
    expect(Number(countAgain.n)).toBe(Number(count.n));
  });

  test('an admin-edited coverage paragraph pauses the template and keeps its text', async () => {
    const before = await activeOf();
    if (!before.active) return;
    const top = await trx('document_template_versions').where({ template_id: before.template.id }).max('version_number as max').first();
    const edited = SEEDED_BODY.replace('Waves will (1) re-treat', 'Waves will (1) retreat');
    const [prior] = await trx('document_template_versions').insert({
      template_id: before.template.id,
      version_number: Number(top.max) + 1,
      title: 'Termite Repair & Retreatment Bond Agreement',
      body: edited,
      signer_disclosure: 'I agree to receive and sign this document electronically.',
      variables: typeof before.active.variables === 'string' ? before.active.variables : JSON.stringify(before.active.variables ?? []),
      required_fields: JSON.stringify(before.active.required_fields ?? ['initials', 'signedName']),
      created_by: null,
      published_at: trx.fn.now(),
    }).returning('*');
    await trx('document_templates').where({ id: before.template.id }).update({ active_version_id: prior.id, status: 'active' });

    await mig.up(trx);
    const after = await activeOf();
    expect(after.template.status).toBe('paused');
    expect(after.active.id).toBe(prior.id);
    expect(after.active.body).toBe(edited);
  });
});
