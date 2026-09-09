'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFixtures, source } = require('../estimate-foundation-fixtures.cjs');
const baseUrl = 'http://127.0.0.1:12345';
const body = { customerName: 'Example customer', estimateData: {
  inputs: { homeSqFt: '2000' }, result: { total: 50 }, engineRequest: { selectedServices: ['PEST'] },
} };

test('fixture dispatch rejects wrong methods, unknown IDs, and suffix/prefix lookalikes', async () => {
  const fixtures = createFixtures({ baseUrl });
  for (const [method, endpoint] of [
    ['POST', '/api/admin/auth/me'],
    ['GET', '/api/admin/estimates'],
    ['GET', '/api/admin/unexpected/unread-count'],
    ['GET', '/api/admin/customers/unknown/properties'],
    ['GET', '/api/admin/estimates/unknown/edit-source'],
    ['GET', '/api/admin/estimates/unknown/group'],
    ['GET', '/api/admin/pricing-config/unknown'],
    ['GET', '/api/admin/estimates/customer-spend/unknown'],
    ['PUT', '/api/admin/estimates/unknown'],
    ['POST', '/api/admin/estimates/estimate-example-created/send'],
  ]) await assert.rejects(fixtures.dispatch(method, endpoint, body), /Unexpected fixture request/);
  assert.equal(fixtures.records.size, 1);
});

test('create waits, fails without saving, and retry supports reopen, preview, dry-run and revision', async () => {
  let release;
  const fixtures = createFixtures({ baseUrl, pendingCreate: new Promise((resolve) => { release = resolve; }) });
  const first = fixtures.dispatch('POST', '/api/admin/estimates', body);
  await Promise.resolve();
  assert.equal(fixtures.state.failCreate, true);
  assert.equal(fixtures.records.size, 1);
  release();
  assert.equal((await first).status, 503);
  assert.equal(fixtures.records.size, 1);
  const created = await fixtures.dispatch('POST', '/api/admin/estimates', structuredClone(body));
  assert.equal(created.status, 200);
  const endpoint = `/api/admin/estimates/${created.body.id}`;
  assert.deepEqual((await fixtures.dispatch('GET', `${endpoint}/edit-source`)).body.inputs, body.estimateData.inputs);
  const update = { ...body, customerName: 'Updated example', expectedEditVersion: created.body.editVersion };
  const preview = await fixtures.dispatch('PUT', endpoint, { ...update, dryRun: true });
  assert.equal(preview.body.customerName, 'Updated example');
  assert.equal(fixtures.records.get(created.body.id).customerName, body.customerName);
  const revised = await fixtures.dispatch('PUT', endpoint, update);
  assert.notEqual(revised.body.editVersion, created.body.editVersion);
  await assert.rejects(fixtures.dispatch('PUT', endpoint, update), /current revision/);
  const send = await fixtures.dispatch('GET', `${endpoint}/send-preview`);
  assert.equal(send.body.customerName, update.customerName);
  assert.equal(send.body.customerUrl, `${baseUrl}/preview-estimate.html?scenario=pest`);
  fixtures.state.conflictRevision = true;
  assert.equal((await fixtures.dispatch('PUT', endpoint, { ...update, customerName: 'Unstored example' })).status, 409);
  assert.equal(fixtures.records.get(created.body.id).customerName, update.customerName);
});

test('browser fixtures and returned data are isolated between scenarios', async () => {
  const first = createFixtures({ baseUrl }), second = createFixtures({ baseUrl });
  const endpoint = `/api/admin/estimates/${source.id}/edit-source`;
  const returned = await first.dispatch('GET', endpoint);
  returned.body.inputs.homeSqFt = '1';
  first.records.get(source.id).inputs.homeSqFt = '2';
  assert.equal((await second.dispatch('GET', endpoint)).body.inputs.homeSqFt, '2000');
  assert.equal(source.inputs.homeSqFt, '2000');
  await assert.rejects(first.dispatch('GET', '/api/admin/estimates/estimate-example-created/edit-source'), /unsaved fixture/);
});
