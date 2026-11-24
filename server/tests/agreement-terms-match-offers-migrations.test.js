// Owner rulings 2026-11-23: signable agreement texts and the service catalog match what Waves sells.
//   20261124030000 residential pest agreement: real month-to-month cancellation terms (replaces the staff placeholder)
//   20261124030100 rodent_guarantee catalog description: exclusion guarantee, trapping + exclusion only
//   20261124030200 termite bond agreements: bond term billed with each quarterly station check, renewable at the end
// The first block of each pair is pure. The second runs the migration against the migrated PostgreSQL database
// inside a transaction that is rolled back. Skips without DATABASE_URL (CI runs it).
const SKIP = !process.env.DATABASE_URL;

const knexLib = require('knex');
const cancel = require('../models/migrations/20261124030000_residential_pest_agreement_cancellation_terms');
const rodent = require('../models/migrations/20261124030100_rodent_guarantee_catalog_description');
const bonds = require('../models/migrations/20261124030200_termite_bond_agreements_term_billing');

const RATE_REVIEW = 'Rates are reviewed once a year after your first 12 months, with at least 30 days’ written notice before any change.';
const RECAP = 'Visit recap: your technician may record short video clips of the work for your visit recap.';

describe('residential pest cancellation terms (pure)', () => {
  test('the terms pin the website promises: month-to-month, no contract, no fee, any channel, late window, free re-treat', () => {
    expect(cancel.CANCELLATION_TERMS).toBe(
      'This agreement is month-to-month. There is no long-term contract and no cancellation fee. '
      + 'The customer may cancel at any time online, by phone, or by email. '
      + 'A visit that is already inside its late-cancellation window when the customer cancels may still carry the scheduled-visit fee. '
      + 'If pests this plan covers return between scheduled visits, Waves will re-treat at no charge.',
    );
    expect(cancel.CANCELLATION_TERMS).not.toMatch(/\bsafe\b|re-?entry/i);
  });

  test('replaces only the placeholder sentence; the rate-review and recap lines stay', () => {
    const body = `Intro. ${RATE_REVIEW}\n\nCustomer responsibilities: access.\n\n${RECAP}\n\nCancellation and changes: either party may request changes in writing. ${cancel.PLACEHOLDER}\n\nElectronic signature: x.`;
    const result = cancel.spliceCancellationTerms(body);
    expect(result.changed).toBe(true);
    expect(result.body).toBe(`Intro. ${RATE_REVIEW}\n\nCustomer responsibilities: access.\n\n${RECAP}\n\nCancellation and changes: either party may request changes in writing. ${cancel.CANCELLATION_TERMS}\n\nElectronic signature: x.`);
    expect(result.body).not.toContain('should be reviewed before sending');
  });

  test('idempotent, and no splice when the placeholder is gone', () => {
    const once = cancel.spliceCancellationTerms(`Cancellation and changes: a. ${cancel.PLACEHOLDER}`);
    expect(cancel.spliceCancellationTerms(once.body)).toEqual({ body: once.body, changed: false, reason: 'already_present' });
    expect(cancel.spliceCancellationTerms('Cancellation and changes: custom.')).toMatchObject({ changed: false, reason: 'anchor_missing' });
  });
});

describe('rodent guarantee description (pure)', () => {
  test('new text follows the signed agreement: exclusion guarantee, up to 4 callbacks, trapping + exclusion', () => {
    expect(rodent.NEW_DESCRIPTION).toContain('up to 4 callbacks and re-sealing of the original exclusion points');
    expect(rodent.NEW_DESCRIPTION).toContain('Eligibility requires completed trapping and completed exclusion.');
    expect(rodent.NEW_DESCRIPTION).not.toMatch(/rodent-free|sanitation|photo baseline/i);
    expect(rodent.OLD_DESCRIPTION).toMatch(/rodent-free/);
  });

  test('the old text is the one the gap catalog migration seeded', () => {
    const src = require('fs').readFileSync(require.resolve('../models/migrations/20260808080000_estimate_gap_catalog_rows'), 'utf8');
    expect(src).toContain(rodent.OLD_DESCRIPTION);
  });
});

describe('termite bond renewal paragraph (pure)', () => {
  const seedSource = require('fs').readFileSync(require.resolve('../models/migrations/20260623000003_seed_termite_bond_agreements'), 'utf8');

  test.each(bonds.TARGETS.map((t) => [t.template_key, t]))('%s: the old paragraph is in the seed; the new one replaces it', (key, target) => {
    // The seed source writes each paragraph as one quoted JS string.
    expect(seedSource).toContain(target.oldParagraph);
    const seedBody = `Header\nAnnual renewal: {{bond.renewal_price}}\n\n${target.oldParagraph}\n\nExcluded: (g) failure to maintain the annual renewal.`;
    const result = bonds.spliceBondTerms(seedBody, target);
    expect(result.changed).toBe(true);
    expect(result.body).toContain('Quarterly station check charge: {{bond.quarterly_price}}\nRenewal amount (next term): {{bond.renewal_price}}');
    expect(result.body).toContain('Coverage runs for the bond term shown ({{bond.term}}).');
    expect(result.body).toContain('billed with each quarterly station check');
    expect(result.body).toContain('If a quarterly charge is not paid by its due date, the bond lapses');
    expect(result.body).toContain('At the end of the term, the customer may renew the bond');
    expect(result.body).toContain('failure to pay the quarterly charges or to renew the bond at the end of its term.');
    expect(result.body).not.toMatch(/each year|annual renewal/i);
    expect(bonds.spliceBondTerms(result.body, target)).toMatchObject({ changed: false, reason: 'already_present' });
    expect(bonds.spliceBondTerms('Edited by an admin.', target)).toMatchObject({ changed: false, reason: 'anchor_missing' });
  });

  test('the repair coverage limit language is untouched', () => {
    const repair = bonds.TARGETS.find((t) => t.template_key.endsWith('termite_bond_repair'));
    const body = `up to the coverage terms confirmed in writing with this bond.\n\n${repair.oldParagraph}`;
    expect(bonds.spliceBondTerms(body, repair).body).toContain('up to the coverage terms confirmed in writing with this bond.');
  });

  test('the new variable is the only one added', () => {
    expect(bonds.NEW_VARIABLE).toBe('bond.quarterly_price');
  });
});

const describeDb = SKIP ? describe.skip : describe;

describeDb('agreement terms migrations (PostgreSQL, rolled back)', () => {
  let database;
  let trx;
  beforeAll(() => {
    database = knexLib({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });
  beforeEach(async () => { trx = await database.transaction(); });
  afterEach(async () => { await trx.rollback(); });
  afterAll(async () => { if (database) await database.destroy(); });

  async function activeOf(key) {
    const template = await trx('document_templates').where({ template_key: key }).first();
    if (!template) return { template: null, active: null };
    const active = await trx('document_template_versions').where({ id: template.active_version_id }).first();
    return { template, active };
  }

  // CI migrates every file first: put a template back to a version in the pre-migration wording so each test
  // runs the migration from the state it was written for.
  async function asBefore(key, mutate) {
    const { template, active } = await activeOf(key);
    if (!active) return;
    const top = await trx('document_template_versions').where({ template_id: template.id }).max('version_number as max').first();
    const [prior] = await trx('document_template_versions').insert({
      template_id: template.id,
      version_number: Number(top.max) + 1,
      title: active.title,
      body: mutate(active.body),
      signer_disclosure: active.signer_disclosure,
      variables: JSON.stringify(typeof active.variables === 'string' ? JSON.parse(active.variables) : (active.variables ?? [])),
      required_fields: JSON.stringify(active.required_fields ?? ['initials', 'signedName']),
      created_by: null,
      published_at: trx.fn.now(),
    }).returning('*');
    await trx('document_templates').where({ id: template.id }).update({ active_version_id: prior.id });
  }

  test('pest agreement: new active version with the terms once; older version kept; second run adds nothing', async () => {
    await asBefore('service_agreement.residential_pest', (b) => b.replace(cancel.CANCELLATION_TERMS, cancel.PLACEHOLDER));
    const before = await activeOf('service_agreement.residential_pest');
    expect(before.active.body).toContain(cancel.PLACEHOLDER);

    await migration(cancel);
    const after = await activeOf('service_agreement.residential_pest');
    expect(after.active.id).not.toBe(before.active.id);
    expect(after.active.body).toContain(cancel.CANCELLATION_TERMS);
    expect(after.active.body).not.toContain(cancel.PLACEHOLDER);
    expect(after.active.body).toContain(RECAP);
    const oldRow = await trx('document_template_versions').where({ id: before.active.id }).first();
    expect(oldRow.body).toBe(before.active.body);

    const count = await trx('document_template_versions').where({ template_id: after.template.id }).count('* as n').first();
    await migration(cancel);
    const again = await activeOf('service_agreement.residential_pest');
    const countAgain = await trx('document_template_versions').where({ template_id: after.template.id }).count('* as n').first();
    expect(again.active.id).toBe(after.active.id);
    expect(Number(countAgain.n)).toBe(Number(count.n));
  });

  test('rodent_guarantee row: seeded text is replaced; an admin edit is kept', async () => {
    await trx('services').where({ service_key: rodent.SERVICE_KEY }).update({ description: rodent.OLD_DESCRIPTION });
    await migration(rodent);
    let row = await trx('services').where({ service_key: rodent.SERVICE_KEY }).first();
    expect(row.description).toBe(rodent.NEW_DESCRIPTION);

    await trx('services').where({ service_key: rodent.SERVICE_KEY }).update({ description: 'Admin wording.' });
    await migration(rodent);
    row = await trx('services').where({ service_key: rodent.SERVICE_KEY }).first();
    expect(row.description).toBe('Admin wording.');
  });

  test.each(bonds.TARGETS.map((t) => [t.template_key, t]))('%s: a new active version with the term wording; second run adds nothing', async (key, target) => {
    const { active } = await activeOf(key);
    if (!active) return; // not seeded on this database
    await asBefore(key, (b) => b
      .replace(target.newParagraph, target.oldParagraph)
      .replace('Quarterly station check charge: {{bond.quarterly_price}}\nRenewal amount (next term): {{bond.renewal_price}}', 'Annual renewal: {{bond.renewal_price}}'));
    const before = await activeOf(key);

    await migration(bonds);
    const after = await activeOf(key);
    expect(after.active.id).not.toBe(before.active.id);
    expect(after.active.body).toContain(target.newParagraph);
    expect(after.active.body).not.toMatch(/renewed each year/);
    const variables = typeof after.active.variables === 'string' ? JSON.parse(after.active.variables) : after.active.variables;
    expect(variables).toEqual(expect.arrayContaining(['bond.term', 'bond.renewal_price', 'bond.quarterly_price']));

    const count = await trx('document_template_versions').where({ template_id: after.template.id }).count('* as n').first();
    await migration(bonds);
    const again = await activeOf(key);
    const countAgain = await trx('document_template_versions').where({ template_id: after.template.id }).count('* as n').first();
    expect(again.active.id).toBe(after.active.id);
    expect(Number(countAgain.n)).toBe(Number(count.n));
  });

  function migration(mod) { return mod.up(trx); }
});
