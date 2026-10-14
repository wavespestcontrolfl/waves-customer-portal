/**
 * Core IB tools are offered from EVERY admin page, not only their home page
 * (owner IB history 10-06: stock counts, a second property, a lead's name,
 * an estimate's line prices and open slots failed with "no tool" on the
 * Customers page or dashboard). Covers both tool-list paths: the platform
 * registry (GATE_IB_PLATFORM on) and the legacy getToolsForContext. Only the
 * offer widens: the writes keep their UI-confirm card, and technicians and
 * the tech portal never see them.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/models', () => ({ FLAGSHIP: 'test-model' }));

const registry = require('../services/intelligence-bar/action-registry');
const { getToolsForContext } = require('../routes/admin-intelligence-bar');
const { UI_GATED_WRITE_TOOL_NAMES } = require('../services/intelligence-bar/write-gates');

const CORE = [
  'add_customer_property', 'set_primary_property', 'update_customer_property', 'remove_customer_property',
  'update_lead_contact', 'update_lead_status',
  'query_stock', 'adjust_stock', 'query_products',
  'get_estimate_detail', 'find_available_slots',
  'offer_choices', 'check_address',
  'create_appointment', 'reschedule_appointment', 'cancel_appointment',
  'update_customer', 'get_call_log',
];
// Property writes run only through the registry (executePropertyTool refuses
// unless GATE_IB_PLATFORM), so the legacy list cannot offer them.
const REGISTRY_ONLY = new Set(['add_customer_property', 'set_primary_property', 'update_customer_property', 'remove_customer_property']);
const LEGACY_CORE = CORE.filter(name => !REGISTRY_ONLY.has(name));
const names = tools => tools.map(t => t.name);

// The general admin read rides every page for the owner login only, behind its gate.
const GENERAL_READ = ['find_admin_reads', 'read_admin_data'];

test('the shared list names exactly the core tools and the general read pair, each with a reviewed policy', () => {
  expect([...registry.EVERY_PAGE_TOOL_NAMES].sort()).toEqual([...CORE, ...GENERAL_READ].sort());
  for (const name of [...CORE, ...GENERAL_READ]) expect(registry.actions.get(name)).toBeDefined();
});

describe('the general admin read on every page', () => {
  const owner = context => ({ role: 'admin', context, fullAccess: true });
  let gateBefore;
  let platformBefore;
  beforeEach(() => {
    gateBefore = process.env.GATE_IB_GENERAL_READ;
    platformBefore = process.env.GATE_IB_PLATFORM;
    process.env.GATE_IB_GENERAL_READ = 'true';
    process.env.GATE_IB_PLATFORM = 'true'; // the general read needs the platform gate
  });
  afterEach(() => {
    if (gateBefore === undefined) delete process.env.GATE_IB_GENERAL_READ; else process.env.GATE_IB_GENERAL_READ = gateBefore;
    if (platformBefore === undefined) delete process.env.GATE_IB_PLATFORM; else process.env.GATE_IB_PLATFORM = platformBefore;
  });

  test.each(['customers', 'dashboard', 'revenue', 'comms', 'email', 'ops'])('the owner login on %s is offered the finder and the read, once each', (context) => {
    const offered = names(registry.initialTools(context, owner(context)));
    for (const name of GENERAL_READ) expect(offered.filter(n => n === name)).toHaveLength(1);
  });

  test.each(['customers', 'dashboard'])('another admin on %s is not offered either', (context) => {
    const offered = names(registry.initialTools(context, { role: 'admin', context, fullAccess: false }));
    for (const name of GENERAL_READ) expect(offered).not.toContain(name);
    expect(names(registry.initialTools(context, { role: 'admin', context }))).not.toContain('find_admin_reads');
  });

  test.each(['customers', 'dashboard', 'ops'])('with the gate off the owner login on %s is not offered either', (context) => {
    process.env.GATE_IB_GENERAL_READ = 'false';
    const offered = names(registry.initialTools(context, owner(context)));
    for (const name of GENERAL_READ) expect(offered).not.toContain(name);
  });

  test('technicians, the tech rail and the agent-estimate rail never see them', () => {
    for (const list of [
      registry.initialTools('customers', { role: 'technician', context: 'customers', fullAccess: true }),
      registry.initialTools('tech', { role: 'technician', context: 'tech', fullAccess: true }),
      registry.initialTools('tech', { role: 'admin', context: 'tech', fullAccess: true }),
      registry.initialTools('agent_estimate', owner('agent_estimate')),
      getToolsForContext('dashboard', true, true),
    ]) for (const name of GENERAL_READ) expect(names(list)).not.toContain(name);
  });

  test('with tool search the owner finds them deferred, not eager', () => {
    const list = registry.initialTools('dashboard', { ...owner('dashboard'), toolSearch: true });
    for (const name of GENERAL_READ) {
      expect(list.find(t => t.name === name)).toMatchObject({ defer_loading: true });
    }
  });
});

test.each(['customers', 'dashboard', 'revenue', 'comms'])('platform list on %s offers every core tool', (context) => {
  const offered = names(registry.initialTools(context, { role: 'admin', context }));
  for (const name of CORE) expect(offered).toContain(name);
  expect(new Set(offered).size).toBe(offered.length);
});

test.each(['customers', 'dashboard', 'revenue', 'comms', 'email'])('legacy list on %s offers the core tools its modules execute', (context) => {
  const offered = names(getToolsForContext(context, true, false));
  for (const name of LEGACY_CORE) expect(offered).toContain(name);
  for (const name of REGISTRY_ONLY) expect(offered).not.toContain(name);
  expect(new Set(offered).size).toBe(offered.length);
});

test('tech portal and technician tokens get none of the core tools on either path', () => {
  const lists = [
    registry.initialTools('tech', { role: 'technician', context: 'tech' }),
    registry.initialTools('tech', { role: 'admin', context: 'tech' }),
    registry.initialTools('customers', { role: 'technician', context: 'customers' }),
    getToolsForContext('tech', false, false),
    getToolsForContext('tech', true, false),
  ];
  for (const list of lists) for (const name of CORE) expect(names(list)).not.toContain(name);
  // The legacy base list (BASE_TOOLS) has always carried these five on a
  // non-tech context whatever the role; the route forces a technician token
  // to the tech context, and the registry path above refuses them outright.
  const LEGACY_BASE = new Set(['create_appointment', 'reschedule_appointment', 'cancel_appointment', 'update_customer', 'get_call_log']);
  const legacyNonAdmin = names(getToolsForContext('customers', false, false));
  for (const name of CORE.filter(n => !LEGACY_BASE.has(n))) expect(legacyNonAdmin).not.toContain(name);
});

test('the agent-estimate rail keeps its own fixed list', () => {
  const offered = names(registry.initialTools('agent_estimate', { role: 'admin', context: 'agent_estimate' }));
  for (const name of ['adjust_stock', 'update_lead_contact', 'add_customer_property']) expect(offered).not.toContain(name);
  expect(names(getToolsForContext('agent_estimate', true, false))).not.toContain('adjust_stock');
});

test('every core write still needs the UI-confirm card', () => {
  for (const name of CORE.filter(n => registry.actions.get(n).kind !== 'read')) {
    expect(UI_GATED_WRITE_TOOL_NAMES.has(name)).toBe(true);
    expect(registry.actions.get(name).approval).toBe('ui_confirm');
  }
});
