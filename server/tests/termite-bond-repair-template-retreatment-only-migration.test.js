// Owner ruling 2026-11-25 ("retreatment only until insurance confirms a cap"): the signable bond seeded as
// service_agreement.termite_bond_repair stops promising damage repair. The first block is pure; the second runs
// the migration against the migrated PostgreSQL database in a transaction that is rolled back (skips without
// DATABASE_URL; CI runs it).
const SKIP = !process.env.DATABASE_URL;

const fs = require('fs');
const knexLib = require('knex');
const mig = require('../models/migrations/20261125210000_termite_bond_repair_template_retreatment_only');
const bonds = require('../models/migrations/20261124030200_termite_bond_agreements_term_billing');

const seedSource = fs.readFileSync(require.resolve('../models/migrations/20260623000003_seed_termite_bond_agreements'), 'utf8');

// The seeded repair bond as the term-billing migration (20261124030200) left it.
const repairTarget = bonds.TARGETS.find((t) => t.template_key === mig.TEMPLATE_KEY);
const SEEDED_BODY = [
  'Termite Repair & Retreatment Bond Agreement',
  '',
  'Customer: {{customer.name}}',
  '',
  'Coverage — retreatment and repair: Waves Pest Control, LLC warrants the covered termite treatment at the property above for the bond term shown. If covered subterranean termite activity is found at the property during the active bond period, Waves will (1) re-treat the affected area(s) at no additional charge, and (2) repair new termite damage caused by covered termite activity that occurs during the active bond period, up to the coverage terms confirmed in writing with this bond. This bond does NOT cover repair of damage that existed before the bond effective date, or damage from termites or pests not covered by this bond.',
  '',
  repairTarget.newParagraph,
  '',
  'Customer responsibilities: Provide safe access for inspections, retreatment, and repair work; correct conducive conditions and moisture issues when notified; and notify Waves promptly of suspected termite activity.',
  '',
  'Electronic signature: By signing, the customer confirms they reviewed this agreement, understand the retreatment and repair coverage and its limits, and intend to sign it electronically.',
].join('\n');

describe('repair bond becomes retreatment only (pure)', () => {
  test('the old coverage and e-signature wording is the seeded text', () => {
    const oldCoverage = SEEDED_BODY.split('\n').find((l) => l.startsWith('Coverage — retreatment and repair'));
    expect(seedSource).toContain(oldCoverage);
    expect(seedSource).toContain('understand the retreatment and repair coverage and its limits, and intend to sign it electronically.');
    expect(seedSource).toContain('Provide safe access for inspections, retreatment, and repair work;');
  });

  test('the new coverage paragraph is the retreatment bond seed text', () => {
    expect(seedSource).toContain(mig.NEW_COVERAGE);
  });

  test('every promise of repair is gone; the no-repair disclosure is in', () => {
    const result = mig.toRetreatmentOnly(SEEDED_BODY);
    expect(result.changed).toBe(true);
    expect(result.body.startsWith('Termite Retreatment Bond Agreement\n')).toBe(true);
    expect(result.body).toContain('This bond covers RE-TREATMENT ONLY. It does NOT include repair of any termite damage');
    expect(result.body).toContain('does NOT include repair of termite damage, and intend to sign it electronically.');
    // The only "repair" left is a denial of repair.
    for (const sentence of result.body.split(/(?<=[.;])\s+/).filter((s) => /repair/i.test(s))) {
      expect(sentence).toMatch(/NOT include repair|does NOT cover repair|no repair/i);
    }
    expect(result.body).not.toMatch(/retreatment and repair|and \(2\) repair|repair work|Repair & Retreatment/);
  });

  test('idempotent, and an admin-edited coverage paragraph is left alone', () => {
    const once = mig.toRetreatmentOnly(SEEDED_BODY);
    expect(mig.toRetreatmentOnly(once.body)).toMatchObject({ changed: false, reason: 'already_present' });
    expect(mig.toRetreatmentOnly('Edited by an admin.')).toMatchObject({ changed: false, reason: 'anchor_missing' });
  });

  test('a repair promise added elsewhere is never published: the result pauses for review', () => {
    const extra = `${SEEDED_BODY}\n\nAdditional coverage: Waves will repair damaged fascia caused by termites.`;
    expect(mig.toRetreatmentOnly(extra)).toMatchObject({ changed: false, reason: 'repair_remains' });
    // An already-converted body that still carries the old coverage paragraph, or a repair promise, is not clean.
    const once = mig.toRetreatmentOnly(SEEDED_BODY).body;
    expect(mig.toRetreatmentOnly(`${once}\n\n${SEEDED_BODY.split('\n')[4]}`)).toMatchObject({ reason: 'repair_remains' });
    expect(mig.toRetreatmentOnly(`${once}\n\nWe will repair the damage.`)).toMatchObject({ reason: 'repair_remains' });
    expect(mig.promisesRepair(once)).toBe(false);
    // A sentence that merely contains "no" is still a promise.
    expect(mig.toRetreatmentOnly(`${SEEDED_BODY}\n\nWaves will repair termite damage at no charge.`)).toMatchObject({ reason: 'repair_remains' });
    expect(mig.promisesRepair('Termite Damage Repair Bond')).toBe(true);
    expect(mig.promisesRepair('I agree to a repair bond.')).toBe(true);
    expect(mig.promisesRepair('I agree to receive and sign this document electronically.')).toBe(false);
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
      signer_disclosure: before.active.signer_disclosure,
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
      signer_disclosure: before.active.signer_disclosure,
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
