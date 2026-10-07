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
  'add_customer_property', 'set_primary_property', 'update_customer_property',
  'update_lead_contact', 'update_lead_status',
  'query_stock', 'adjust_stock', 'query_products',
  'get_estimate_detail', 'find_available_slots',
];
// Property writes run only through the registry (executePropertyTool refuses
// unless GATE_IB_PLATFORM), so the legacy list cannot offer them.
const REGISTRY_ONLY = new Set(['add_customer_property', 'set_primary_property', 'update_customer_property']);
const LEGACY_CORE = CORE.filter(name => !REGISTRY_ONLY.has(name));
const names = tools => tools.map(t => t.name);

test('the shared list names exactly the core tools, each with a reviewed policy', () => {
  expect([...registry.EVERY_PAGE_TOOL_NAMES].sort()).toEqual([...CORE].sort());
  for (const name of CORE) expect(registry.actions.get(name)).toBeDefined();
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
    getToolsForContext('customers', false, false),
  ];
  for (const list of lists) for (const name of CORE) expect(names(list)).not.toContain(name);
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
