process.env.JWT_SECRET = 'synthetic-ib-test';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const registry = require('../services/intelligence-bar/action-registry');
const { tierFor } = require('../services/intelligence-bar/authorization-contract');

test('every tool-bearing module in the existing tool census joins the registry', () => {
  const fs = require('fs'), path = require('path');
  const directory = path.join(__dirname, '../services/intelligence-bar');
  for (const file of fs.readdirSync(directory).filter(name => name === 'tools.js' || name.endsWith('-tools.js'))) {
    const definitions = Object.values(require(path.join(directory, file))).filter(Array.isArray).flat()
      .filter(tool => tool && typeof tool.name === 'string' && tool.input_schema?.type === 'object');
    for (const definition of definitions) expect(registry.actions.get(definition.name)?.module).toBe(file);
  }
});

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

test('the dedicated agent estimate workflow preloads its permitted draft tool', () => {
  const scope = { role: 'admin', context: 'agent_estimate' };
  expect(registry.initialTools(scope.context, scope).some(tool => tool.name === 'create_agent_estimate_draft')).toBe(true);
  expect(registry.initialTools('estimates', { ...scope, context: 'estimates' }).some(tool => tool.name === 'create_agent_estimate_draft')).toBe(false);
});

test('technicians cannot discover admin tools or forge a tool scope', async () => {
  const scope = { role: 'technician', context: 'estimates' };
  expect(registry.discover({ query: 'customer inventory' }, scope).result.code).toBe('permission_denied');
  expect(registry.validateInput('update_customer', { customer_id: 'fixture' }, scope).code).toBe('permission_denied');
  expect(await registry.execute('send_sms', {}, scope)).toMatchObject({ code: 'permission_denied' });
  expect(registry.initialTools('tech', { role: 'technician', context: 'tech' }).some(t => t.name === 'discover_capabilities')).toBe(false);
  expect(registry.initialTools('tech', { role: 'admin', context: 'tech' }).some(t => t.name === 'discover_capabilities')).toBe(false);
});

test('execute validates raw model arguments before a two-step executor can see approval fields', async () => {
  const action = registry.actions.get('create_customer');
  const original = action.executor;
  action.executor = jest.fn(async (_name, input) => ({ confirmed: input.confirmed }));
  const scope = { role: 'admin', context: 'customers' };
  const input = { first_name: 'Synthetic', last_name: 'Person', phone: '+15550101234' };
  try {
    expect(await registry.execute('create_customer', { ...input, confirmed: true }, scope)).toMatchObject({ code: 'invalid_input' });
    expect(await registry.execute('create_customer', { ...input, _approved: true }, scope)).toMatchObject({ code: 'invalid_input' });
    expect(action.executor).not.toHaveBeenCalled();
    expect(await registry.execute('create_customer', input, scope)).toEqual({ confirmed: false });
    expect(await registry.execute('create_customer', input, { ...scope, actionContext: { confirmed: true,
      executionPins: { _ib_customer_version: 'server-version', confirmed: false } } })).toEqual({ confirmed: true });
    expect(action.executor.mock.calls.at(-1)[1]).toMatchObject({ _ib_customer_version: 'server-version', confirmed: true });
  } finally { action.executor = original; }
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


test('dedicated estimate cabinet excludes every unrelated write and admin discovery', async () => {
  const scope = { role: 'admin', context: 'agent_estimate' };
  const names = require('../services/intelligence-bar/agent-estimate-policy');
  for (const context of [undefined, 'estimates', 'agent_estimate']) {
    expect(registry.initialTools('agent_estimate', { role: 'admin', context }).map(t => t.name).sort()).toEqual([...names].sort());
  }
  expect(registry.discover({ query: 'create estimate inventory' }, scope).result.code).toBe('permission_denied');
  for (const action of registry.actions.values()) {
    if (names.has(action.id)) continue;
    expect(registry.allowed(action, scope)).toBe(false);
    expect(await registry.execute(action.id, {}, { ...scope, actionContext: { confirmed: true } }))
      .toMatchObject({ code: 'permission_denied' });
  }
});

test('technician execution cannot fall through to the unscoped admin executor', async () => {
  const action = registry.actions.get('get_my_route'), original = action.executor;
  action.executor = jest.fn(async (_name, _input, context) => ({ techId: context.techId || null }));
  const scope = { role: 'technician', context: 'tech' };
  try {
    for (const techContext of [undefined, {}, { techId: '' }, { techId: ' ' }, { techName: 'Synthetic' }]) {
      expect(await registry.execute(action.id, {}, { ...scope, techContext })).toMatchObject({ code: 'permission_denied' });
    }
    expect(action.executor).not.toHaveBeenCalled();
    const techId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(await registry.execute(action.id, {}, { ...scope, techContext: { techId } })).toEqual({ techId });
    expect(await registry.execute(action.id, {}, { role: 'admin', context: 'tech' })).toEqual({ techId: null });
  } finally { action.executor = original; }
});

test('sender blocking declares its Gmail filter side effect', () => {
  expect(registry.actions.get('block_sender')).toMatchObject({ kind: 'external_action', approval: 'ui_confirm' });
});


test('initial and discovered model tools exclude local contract metadata', () => {
  const scope = { role: 'admin', context: 'schedule' };
  for (const action of registry.actions.values()) {
    expect(Object.keys(action.definition).filter(key => key.startsWith('_'))).toEqual([]);
  }
  const initial = registry.initialTools('schedule', scope);
  expect(initial.some(tool => tool.name === 'switch_appointment_property')).toBe(true);
  const discovered = registry.discover({ query: 'switch appointment property', domain: 'schedule' }, scope).definitions;
  expect(discovered.some(tool => tool.name === 'switch_appointment_property')).toBe(true);
  for (const tool of [...initial, ...discovered]) {
    expect(Object.keys(tool).filter(key => key.startsWith('_'))).toEqual([]);
  }
  const original = require('../services/intelligence-bar/schedule-tools').SCHEDULE_TOOLS
    .find(tool => tool.name === 'switch_appointment_property');
  expect(original._sideEffects).toBe(true);
});

test('registry cannot directly execute owner-endpoint actions even with confirmation', async () => {
  for (const action of registry.actions.values()) {
    if (action.approval !== 'confirmed_endpoint') continue;
    const original = action.executor;
    action.executor = jest.fn();
    try {
      for (const confirmed of [false, true]) {
        expect(await registry.execute(action.id, {}, { role: 'admin', context: action.domain,
          actionContext: { confirmed, requestedBy: 'synthetic-owner' } }))
          .toMatchObject({ code: 'requires_existing_owner_workflow' });
      }
      expect(action.executor).not.toHaveBeenCalled();
    } finally { action.executor = original; }
  }
});


test('discovery requires meaningful whole-word matches instead of stopword substrings', () => {
  const scope = { role: 'admin', context: 'customers' };
  for (const query of ['do a frobnicate', 'I would like to frobnicate', 'a I the', 'frobnicate']) {
    expect(registry.discover({ query }, scope)).toMatchObject({ definitions: [], result: { status: 'capability_unimplemented' } });
  }
  expect(registry.discover({ query: 'please create a restock request', domain: 'procurement' }, scope).definitions
    .some(tool => tool.name === 'create_restock_request')).toBe(true);
});

test('appointment cancellation declares its possible Stripe follow-through effect', () => {
  expect(registry.actions.get('cancel_appointment')).toMatchObject({ kind: 'external_action', approval: 'ui_confirm' });
});


test('generic lookup verbs cannot make an unsupported capability appear discovered', () => {
  for (const verb of ['get', 'find', 'show', 'search', 'list']) {
    expect(registry.discover({ query: `${verb} a frobnicate` }, { role: 'admin', context: 'customers' }))
      .toMatchObject({ definitions: [], result: { status: 'capability_unimplemented' } });
  }
  expect(registry.discover({ query: 'get inventory stock' }, { role: 'admin', context: 'customers' })
    .definitions.length).toBeGreaterThan(0);
});
