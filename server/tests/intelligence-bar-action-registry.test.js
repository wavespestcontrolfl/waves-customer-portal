process.env.JWT_SECRET = 'synthetic-ib-test';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const registry = require('../services/intelligence-bar/action-registry');
const { tierFor } = require('../services/intelligence-bar/authorization-contract');

test('every existing tool has an explicit valid policy and a concrete executor', () => {
  expect(registry.policyErrors).toEqual([]);
  expect(registry.actions.size).toBe(Object.keys(require('../services/intelligence-bar/action-policy.json')).length);
  for (const action of registry.actions.values()) {
    expect(typeof action.executor).toBe('function');
    if (action.kind !== 'read') expect(action.approval).toMatch(/^(ui_confirm|confirmed_endpoint)$/);
  }
});

test('Estimates can discover real inventory executors without preloading every definition', () => {
  const scope = { role: 'admin', context: 'estimates' };
  const initial = registry.initialTools(scope.context, scope);
  expect(initial.length).toBeLessThan(40);
  expect(initial.some(t => t.name === 'create_restock_request')).toBe(false);
  const found = registry.discover({ query: 'save inventory restock request', domain: 'procurement' }, scope);
  expect(found.definitions.some(t => t.name === 'create_restock_request')).toBe(true);
  expect(found.result.capabilities).toContainEqual(expect.objectContaining({
    id: 'create_restock_request', kind: 'internal_write', approval: 'ui_confirm', availability: 'loaded',
  }));
});

test('technicians cannot discover admin tools or forge a tool scope', async () => {
  const scope = { role: 'technician', context: 'estimates' };
  expect(registry.discover({ query: 'customer inventory' }, scope).result.code).toBe('permission_denied');
  expect(registry.validateInput('update_customer', { customer_id: 'fixture' }, scope).code).toBe('permission_denied');
  expect(await registry.execute('send_sms', {}, scope)).toMatchObject({ code: 'permission_denied' });
});

test('unknown classification, coerced quantities, and injected approval/actor fields fail closed', () => {
  const scope = { role: 'admin', context: 'estimates' };
  expect(registry.validateInput('arbitrary_action', {}, scope).code).toBe('capability_unimplemented');
  expect(registry.validateInput('query_products', { limit: '10' }, scope).code).toBe('invalid_input');
  expect(registry.validateInput('query_products', { actorId: 'another-actor' }, scope).code).toBe('invalid_input');
  expect(registry.validateInput('query_products', { _approved: true }, scope).code).toBe('invalid_input');
  expect(tierFor('arbitrary_action')).toBe('unknown');
});

test('a legacy bare write cannot execute through the registry without server confirmation', async () => {
  expect(await registry.execute('send_sms', { confirmed: true }, { role: 'admin', context: 'customers' }))
    .toMatchObject({ code: 'approval_required' });
});

test('restricted owner actions remain in their existing workflow and do not become query tools', () => {
  const found = registry.discover({ query: 'request instant payout', domain: 'banking' }, { role: 'admin', context: 'customers' });
  expect(found.definitions.some(t => t.name === 'request_instant_payout')).toBe(false);
  expect(found.result.capabilities).toContainEqual(expect.objectContaining({
    id: 'request_instant_payout', availability: 'requires_existing_owner_workflow', approval: 'confirmed_endpoint',
  }));
});
