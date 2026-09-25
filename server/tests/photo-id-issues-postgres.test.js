/** Real PostgreSQL proof for issue ownership, property scope and atomic save. */
const { randomUUID } = require('node:crypto');

const SKIP = !process.env.DATABASE_URL;
const connection = process.env.DATABASE_URL;
const ownedQa = connection && process.env.WAVES_LOCAL_DEV === '1'
  && process.env.WAVES_WORKTREE_ID
  && new URL(connection).pathname === `/waves_qa_${process.env.WAVES_WORKTREE_ID.replaceAll('-', '')}`;
if (connection && !ownedQa && process.env.CI !== 'true') {
  throw new Error('Photo ID issue tests require this worktree\'s private QA database or isolated CI.');
}
const suite = !SKIP && (ownedQa || process.env.CI === 'true') ? describe : describe.skip;

suite('photo ID issues against migrated PostgreSQL', () => {
  let database;
  let trx;
  let ids;
  let service;

  beforeAll(() => {
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    service = require('../services/photo-id-issues');
  });

  beforeEach(async () => {
    trx = await database.transaction();
    ids = {
      customer: randomUUID(), otherCustomer: randomUUID(), property: randomUUID(), otherProperty: randomUUID(),
    };
    await trx('customers').insert([
      { id: ids.customer, first_name: 'Synthetic', phone: `qa-${ids.customer.slice(0, 8)}` },
      { id: ids.otherCustomer, first_name: 'Synthetic', phone: `qa-${ids.otherCustomer.slice(0, 8)}` },
    ]);
    await trx('customer_properties').insert([
      { id: ids.property, customer_id: ids.customer, label: 'Fixture one' },
      { id: ids.otherProperty, customer_id: ids.customer, label: 'Fixture two' },
    ]);
  });

  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => {
    await database?.destroy();
    await require('../models/db').destroy();
  });

  function submission(overrides = {}) {
    return {
      mode: 'customer', status: 'analyzed', source: 'portal', customer_id: ids.customer,
      property_id: ids.property, ai_analysis: {}, report_contract: {}, ...overrides,
    };
  }

  test('ownership and exact property scope are required', async () => {
    const [issue] = await trx('photo_id_issues').insert({
      customer_id: ids.customer, property_id: ids.property, area: 'front_yard',
    }).returning('id');

    await expect(service.requireOwnedIssue({
      database: trx, issueId: issue.id, customerId: ids.customer, propertyId: ids.property,
    })).resolves.toMatchObject({ id: issue.id });
    await expect(service.requireOwnedIssue({
      database: trx, issueId: issue.id, customerId: ids.otherCustomer, propertyId: ids.property,
    })).rejects.toMatchObject({ code: 'issue_not_found', status: 404 });
    await expect(service.requireOwnedIssue({
      database: trx, issueId: issue.id, customerId: ids.customer, propertyId: ids.otherProperty,
    })).rejects.toMatchObject({ code: 'issue_not_found', status: 404 });
  });

  test('save creates one issue and preserves unknown or explicit observation dates', async () => {
    const first = await service.savePestSubmission({
      database: trx, customerId: ids.customer, propertyId: ids.property, area: 'front_yard',
      observedOn: null, submission: submission(),
    });
    expect(first.observed_on).toBeNull();
    const second = await service.savePestSubmission({
      database: trx, issueId: first.issue_id, customerId: ids.customer, propertyId: ids.property,
      area: 'front_yard', observedOn: '2026-09-20', submission: submission(),
    });
    expect(second).toMatchObject({ issue_id: first.issue_id, observed_on: '2026-09-20' });
    const storedSecond = await trx('pest_identifications').where({ id: second.id }).first('observed_on');
    expect(service.serializeObservedOn(storedSecond.observed_on)).toBe('2026-09-20');
    expect(await trx('photo_id_issues').where({ id: first.issue_id })).toHaveLength(1);
    expect(await trx('pest_identifications').where({ issue_id: first.issue_id })).toHaveLength(2);
  });

  test('the transactional recheck refuses a changed property before append', async () => {
    const [issue] = await trx('photo_id_issues').insert({
      customer_id: ids.customer, property_id: ids.property,
    }).returning('id');
    await service.requireOwnedIssue({
      database: trx, issueId: issue.id, customerId: ids.customer, propertyId: ids.property,
    });
    await trx('photo_id_issues').where({ id: issue.id }).update({ property_id: ids.otherProperty });

    await expect(service.savePestSubmission({
      database: trx, issueId: issue.id, customerId: ids.customer, propertyId: ids.property,
      observedOn: null, submission: submission(),
    })).rejects.toMatchObject({ code: 'issue_not_found', status: 409 });
    expect(await trx('pest_identifications').where({ issue_id: issue.id })).toHaveLength(0);
  });

  test('a submission constraint failure rolls back the newly-created issue', async () => {
    const before = Number((await trx('photo_id_issues').count('* as count').first()).count);
    await expect(service.savePestSubmission({
      database: trx, customerId: ids.customer, propertyId: ids.property, area: 'front_yard',
      observedOn: null, submission: submission({ status: 'not-a-real-status' }),
    })).rejects.toThrow();
    const after = Number((await trx('photo_id_issues').count('* as count').first()).count);
    expect(after).toBe(before);
  });
});
