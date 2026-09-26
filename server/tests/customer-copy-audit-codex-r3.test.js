jest.mock('../models/db', () => require('knex')({ client: 'pg' }));
const r3 = require('../models/migrations/20260926120400_customer_copy_audit_codex_r3');
const { countSegments } = require('../services/messaging/segment-counter');
const { _internals: { segmentQuery } } = require('../routes/admin-automations');

test('the service-request text keeps the time on the review, not the follow-up', () => {
  const [[, before, after]] = r3._SWAPS;
  expect(after).toContain("We'll review it within {response_time}");
  expect(after).not.toMatch(/get back to you within/);
  expect([...after.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort())
    .toEqual([...before.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort());
  const rendered = after.replace('{first_name}', 'Longtestname').replace('{category}', 'service')
    .replace('{response_time}', '24 hours');
  expect(countSegments(rendered)).toMatchObject({ encoding: 'GSM_7', segmentCount: 1 });
});

describe('Automations-tab segment query', () => {
  const sql = (templateKey, segment = { scope: 'customers' }) => segmentQuery(segment, templateKey).toSQL().sql;

  test.each([
    ['whole base', { scope: 'customers' }],
    ['program members at one office', { scope: 'program', locationId: 'bradenton' }],
  ])('a renewal segment (%s) counts only termite-bond customers', (_, segment) => {
    expect(sql('service_renewal', segment)).toMatch(/"termite_renewal_date" is not null/);
  });

  test('other automations keep the full segment', () => {
    expect(sql('pricing_update')).not.toMatch(/termite_renewal_date/);
  });
});
