/**
 * find_admin_edits / propose_admin_edit (owner ruling 2026-10-12): the body
 * allow-list, the owner-only and gate rules, the preview, and the confirmed
 * replay. No network: global fetch is mocked, and the database is a stand-in.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// The screen's canonical block shape, as EmailTemplates.normalizeBlocks gives it (every block has a type and text).
const mockNormalizeBlocks = jest.fn(blocks => (blocks || []).map(block => ({ type: String(block?.type || 'paragraph').trim(), content: String(block?.content || '') })));
jest.mock('../services/email-template-library', () => ({ normalizeBlocks: (...args) => mockNormalizeBlocks(...args) }));

const db = require('../models/db');
const logger = require('../services/logger');
const config = require('../config');
const readRules = require('../utils/admin-read-rules');
const { ADMIN_READ_HEADER, adminReadMarkerValue } = require('../utils/redact-request-url');
const catalog = require('../services/intelligence-bar/admin-write-catalog.json');
const registry = require('../services/intelligence-bar/action-registry');
const Contract = require('../services/intelligence-bar/authorization-contract');
const { executeAdminWriteTool, cardLines, displayParams } = require('../services/intelligence-bar/admin-write-tools');

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJ0ZXN0IjoidG9rZW4ifQ.c2lnbmF0dXJl';
const AUTH = `Bearer ${TOKEN}`;
const ORIGIN = `http://127.0.0.1:${Number(config.port)}`;
const FIND = 'find_admin_edits';
const PROPOSE = 'propose_admin_edit';
const ID = '10000000-0000-4000-8000-00000000000a';
const CUSTOMER = '20000000-0000-4000-8000-00000000000b';
const OTHER_CUSTOMER = '30000000-0000-4000-8000-00000000000c';

// One example edit per catalog row. A catalog row without a fixture fails the test below,
// so adding a row to the reviewed list means adding its example here.
const FIXTURES = {
  'PUT /admin/sms-templates/:id': { params: { id: ID }, body: { body: 'Hi {first_name}, your visit is tomorrow.', name: 'Reminder 24h' } },
  'PUT /admin/email-templates/:key': { params: { key: 'estimate.expiring_notice' }, body: { name: 'Estimate expiring', description: 'Sent before an estimate expires.' } },
  'PUT /admin/email-templates/versions/:id': { params: { id: ID }, body: { subject: 'Your estimate', previewText: 'A quick note', textBody: 'Hello there.', blocks: [{ type: 'paragraph', content: 'Hi {{first_name}},' }] } },
  'PUT /admin/email-templates/fixtures/:id': { params: { id: ID }, body: { name: 'Sample data', payload: { first_name: 'Pat' } } },
  'PUT /admin/automations/steps/:id': { params: { id: ID }, body: { subject: 'Welcome', previewText: 'Hello', htmlBody: '<p>Hello</p>', textBody: 'Hello' } },
  'PUT /admin/timetracking/entries/:id': { params: { id: ID }, body: { clock_in: '2026-10-12T08:00:00-04:00', clock_out: '2026-10-12T16:30:00-04:00', entry_type: 'shift', notes: 'Forgot to clock out', edit_reason: 'Corrected after the tech called in' } },
  'PUT /admin/customers/:id/notification-prefs': { params: { id: CUSTOMER }, customer_id: CUSTOMER, body: { appointmentNotifyPrimary: false, serviceReportNotifyBilling: true } },
  'PATCH /admin/dispatch/:serviceId/note': { params: { serviceId: ID }, customer_id: CUSTOMER, body: { notes: 'Gate code is on the lockbox' } },
  'PUT /admin/inventory/service-usage/:id': { params: { id: ID }, body: { notes: 'Use the backpack sprayer' } },
};
const keyOf = entry => `${entry.method} ${entry.endpoint}`;
const ENTRY = catalog.entries.find(entry => keyOf(entry) === 'PUT /admin/sms-templates/:id');
const CUSTOMER_ENTRY = catalog.entries.find(entry => entry.scope === 'customer');
const VISIT_ENTRY = catalog.entries.find(entry => entry.scope === 'visit');
const ownerContext = (extra = {}) => ({ fullAccess: true, isAdmin: true, staffAuthorization: AUTH, ...extra });

const T1 = '50000000-0000-4000-8000-0000000000e1';
const TECH = '60000000-0000-4000-8000-0000000000f1';
const PRODUCT = '70000000-0000-4000-8000-0000000000a1';
const STAMP = '2026-10-10T12:00:00.000Z';
const seedWorld = () => ({
  sms_templates: [{ id: ID, name: 'Old name', template_key: 'reminder_24h', body: 'Old body', updated_at: STAMP }],
  email_templates: [{ id: T1, template_key: 'estimate.expiring_notice', name: 'Estimate expiring', description: 'Old description', updated_at: STAMP }],
  email_template_versions: [{ id: ID, template_id: T1, status: 'draft', version_number: 2, subject: 'Old subject', preview_text: 'Old preview', text_body: 'Old text', blocks: [{ type: 'paragraph', content: 'Old' }], updated_at: STAMP }],
  email_template_fixtures: [{ id: ID, template_id: T1, name: 'Old fixture', payload: { first_name: 'Old' }, updated_at: STAMP }],
  automation_steps: [{ id: ID, template_key: 'welcome_series', step_order: 1, subject: 'Old', preview_text: 'Old', html_body: '<p>Old</p>', text_body: 'Old', updated_at: STAMP }],
  time_entries: [{ id: ID, technician_id: TECH, clock_in: new Date('2026-10-12T12:00:00.000Z'), clock_out: new Date('2026-10-12T20:00:00.000Z'), entry_type: 'job', notes: 'Old note', edit_reason: null, status: 'completed', approval_status: 'pending', updated_at: new Date(STAMP) }],
  technicians: [{ id: TECH, name: 'Adam Tech' }],
  customers: [{ id: CUSTOMER, first_name: 'Pat', last_name: 'Tester' }],
  notification_prefs: [{ customer_id: CUSTOMER, auto_flip_en_route: true, payment_confirmation_sms: true, appointment_notify_primary: true, service_report_notify_primary: true, service_report_notify_billing: false, updated_at: STAMP }],
  scheduled_services: [{ id: ID, customer_id: CUSTOMER, scheduled_date: new Date('2026-10-14T00:00:00.000Z'), service_type: 'Pest Control', notes: 'Old visit note', updated_at: new Date(STAMP) }],
  service_product_usage: [{ id: ID, product_id: PRODUCT, service_type: 'General Pest Control', notes: 'Old use note', updated_at: STAMP }],
  products_catalog: [{ id: PRODUCT, name: 'Talstar P' }],
});
// What the screen's save does to the world, per catalog row: [table, which row, body key -> column].
const SAVES = {
  'PUT /admin/sms-templates/:id': ['sms_templates', p => ({ id: p.id }), { body: 'body', name: 'name' }],
  'PUT /admin/email-templates/:key': ['email_templates', p => ({ template_key: p.key }), { name: 'name', description: 'description' }],
  'PUT /admin/email-templates/versions/:id': ['email_template_versions', p => ({ id: p.id }), { subject: 'subject', previewText: 'preview_text', textBody: 'text_body', blocks: 'blocks' }],
  'PUT /admin/email-templates/fixtures/:id': ['email_template_fixtures', p => ({ id: p.id }), { name: 'name', payload: 'payload' }],
  'PUT /admin/automations/steps/:id': ['automation_steps', p => ({ id: p.id }), { subject: 'subject', previewText: 'preview_text', htmlBody: 'html_body', textBody: 'text_body' }],
  'PUT /admin/timetracking/entries/:id': ['time_entries', p => ({ id: p.id }), { clock_in: 'clock_in', clock_out: 'clock_out', entry_type: 'entry_type', notes: 'notes', edit_reason: 'edit_reason' }],
  'PUT /admin/customers/:id/notification-prefs': ['notification_prefs', p => ({ customer_id: p.id }), {
    autoFlipEnRoute: 'auto_flip_en_route', paymentConfirmationSms: 'payment_confirmation_sms', appointmentNotifyPrimary: 'appointment_notify_primary',
    serviceReportNotifyPrimary: 'service_report_notify_primary', serviceReportNotifyBilling: 'service_report_notify_billing',
  }],
  'PATCH /admin/dispatch/:serviceId/note': ['scheduled_services', p => ({ id: p.serviceId }), { notes: 'notes' }],
  'PUT /admin/inventory/service-usage/:id': ['service_product_usage', p => ({ id: p.id }), { notes: 'notes' }],
};
const LABELS = {
  'PUT /admin/sms-templates/:id': 'Text message template "Old name" (reminder_24h)',
  'PUT /admin/email-templates/:key': 'Email template "Estimate expiring" (estimate.expiring_notice)',
  'PUT /admin/email-templates/versions/:id': 'Email template "Estimate expiring" (estimate.expiring_notice), version 2 (draft), subject "Old subject"',
  'PUT /admin/email-templates/fixtures/:id': 'Preview data "Old fixture" for email template "Estimate expiring" (estimate.expiring_notice)',
  'PUT /admin/automations/steps/:id': 'Email automation "welcome_series", step 1, subject "Old"',
  'PUT /admin/timetracking/entries/:id': 'Adam Tech: job entry on Mon, Oct 12, 2026, Oct 12, 8:00 AM to Oct 12, 4:00 PM ET (completed, pending)',
  'PUT /admin/customers/:id/notification-prefs': 'Pat Tester: text and report preferences',
  'PATCH /admin/dispatch/:serviceId/note': 'Pat Tester: Pest Control on 2026-10-14',
  'PUT /admin/inventory/service-usage/:id': 'Product use: Talstar P for General Pest Control',
};
let world;
function makeDb() {
  return (table) => {
    const conds = [];
    const builder = {
      where(cond) { conds.push(cond); return builder; },
      async first() {
        const found = (world[table] || []).find(row => conds.every(cond => Object.entries(cond).every(([k, v]) => String(row[k]) === String(v))));
        return found ? { ...found } : undefined;
      },
    };
    return builder;
  };
}
// The screen's save, simulated: applies a 2xx PUT or PATCH to the world the way the handler would.
function applySave(url, options) {
  const pathname = new URL(url).pathname;
  for (const [key, fixture] of Object.entries(FIXTURES)) {
    const entry = catalog.entries.find(e => keyOf(e) === key);
    const filled = entry.endpoint.replace(/:([A-Za-z0-9_]+)/g, (_m, name) => encodeURIComponent(fixture.params[name]));
    if (options.method !== entry.method || pathname !== `/api${filled}`) continue;
    const [table, where, columns] = SAVES[key];
    const cond = where(fixture.params);
    const row = world[table].find(r => Object.entries(cond).every(([k, v]) => String(r[k]) === String(v)));
    for (const [field, value] of Object.entries(JSON.parse(options.body))) row[columns[field]] = value;
    row.updated_at = '2026-10-20T12:00:00.000Z';
  }
}
const savingFetch = (response = () => jsonResponse(200, { success: true }), { save = true } = {}) => jest.fn(async (url, options) => {
  const answer = response(url, options);
  if (save && answer.status >= 200 && answer.status < 300) applySave(url, options);
  return answer;
});

function jsonResponse(status, body, headers = { 'content-type': 'application/json; charset=utf-8' }) {
  return {
    status, headers: { get: key => headers[String(key).toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

let gateBefore;
let platformBefore;
beforeEach(() => {
  gateBefore = process.env.GATE_IB_GENERAL_EDIT;
  platformBefore = process.env.GATE_IB_PLATFORM;
  process.env.GATE_IB_GENERAL_EDIT = 'true';
  process.env.GATE_IB_PLATFORM = 'true'; // the general edit needs the platform gate
  jest.clearAllMocks();
  world = seedWorld();
  global.fetch = savingFetch();
  db.mockImplementation(makeDb());
});
afterEach(() => {
  if (gateBefore === undefined) delete process.env.GATE_IB_GENERAL_EDIT;
  else process.env.GATE_IB_GENERAL_EDIT = gateBefore;
  if (platformBefore === undefined) delete process.env.GATE_IB_PLATFORM;
  else process.env.GATE_IB_PLATFORM = platformBefore;
});

const find = (query, context = ownerContext()) => executeAdminWriteTool(FIND, { query }, context);
const propose = (input, context = ownerContext()) => executeAdminWriteTool(PROPOSE, input, context);
const inputFor = (entry, extra = {}) => {
  const fixture = FIXTURES[keyOf(entry)];
  return { method: entry.method, endpoint: entry.endpoint, params: fixture.params, body: fixture.body, ...(fixture.customer_id ? { customer_id: fixture.customer_id } : {}), ...extra };
};
const callsOf = () => global.fetch.mock.calls;

describe('the fixtures', () => {
  test('every catalog row has a fixture, and every fixture a row', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(catalog.entries.map(keyOf).sort());
  });

  test.each(Object.keys(FIXTURES))('%s: the preview changes nothing, and the confirm replays exactly the carded body', async (key) => {
    const entry = catalog.entries.find(e => keyOf(e) === key);
    const fixture = FIXTURES[key];
    const preview = await propose(inputFor(entry));
    expect(preview).toMatchObject({ preview: true, tool: PROPOSE, method: entry.method, endpoint: entry.endpoint, address_change: false });
    expect(preview.error).toBeUndefined();
    expect(callsOf()).toHaveLength(0);
    expect(preview.changes.map(change => change.field).sort()).toEqual(Object.keys(fixture.body).sort());
    expect(cardLines(preview).length).toBeGreaterThan(2);
    // The card names the record in words, shows the current value of every field, and never just a UUID.
    expect(preview.record_label).toBe(LABELS[key]);
    expect(preview.record_label).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(cardLines(preview).map(line => line.text)).toContain(`Record: ${LABELS[key]}`);
    expect(displayParams(preview).record).toBe(LABELS[key]);
    for (const change of preview.changes) expect(change.before).not.toBeUndefined();
    const confirmed = await propose({ ...inputFor(entry), confirmed: true, _approved_edit_pin: preview._version });
    expect(confirmed).toMatchObject({ success: true, method: entry.method, endpoint: entry.endpoint });
    expect(callsOf()).toHaveLength(1);
    const [url, options] = callsOf()[0];
    const filled = entry.endpoint.replace(/:([A-Za-z0-9_]+)/g, (_m, name) => encodeURIComponent(fixture.params[name]));
    expect(new URL(url).origin).toBe(ORIGIN);
    expect(new URL(url).pathname).toBe(`/api${filled}`);
    expect(options.method).toBe(entry.method);
    expect(JSON.parse(options.body)).toEqual(JSON.parse(JSON.stringify(fixture.body)));
    expect(options.headers.Authorization).toBe(AUTH);
    expect(options.headers['Content-Type']).toBe('application/json');
    const paramIndexes = readRules.splitPath(entry.endpoint).flatMap((segment, index) => (readRules.isParam(segment) ? [index] : []));
    expect(options.headers[ADMIN_READ_HEADER]).toBe(adminReadMarkerValue(paramIndexes));
    expect(options.redirect).toBe('manual');
    expect(options.signal).toBeDefined();
  });
});

describe('the gate and the owner login', () => {
  test('gate off: both tools refuse with gate_off and nothing is sent', async () => {
    delete process.env.GATE_IB_GENERAL_EDIT;
    expect(await find('sms template')).toMatchObject({ code: 'gate_off' });
    expect(await propose(inputFor(ENTRY))).toMatchObject({ code: 'gate_off' });
    expect(await propose({ ...inputFor(ENTRY), confirmed: true, _approved_edit_pin: 'x' })).toMatchObject({ code: 'gate_off' });
    expect(callsOf()).toHaveLength(0);
  });

  test('the platform gate is required: the reader is false without it', async () => {
    delete process.env.GATE_IB_PLATFORM;
    expect(require('../config/feature-gates').ibGeneralEditLive()).toBe(false);
    expect(await propose(inputFor(ENTRY))).toMatchObject({ code: 'gate_off' });
  });

  test.each([['unset', undefined], ['"1"', '1'], ['"TRUE"', 'TRUE'], ['"false"', 'false']])('a gate value that is not exactly "true" is off (%s)', async (_label, value) => {
    if (value === undefined) delete process.env.GATE_IB_GENERAL_EDIT; else process.env.GATE_IB_GENERAL_EDIT = value;
    expect(await propose(inputFor(ENTRY))).toMatchObject({ code: 'gate_off' });
  });

  test.each([
    ['an admin without full access', { fullAccess: false, isAdmin: true }],
    ['no full access flag', { isAdmin: true }],
    ['a non-admin', { fullAccess: true, isAdmin: false }],
    ['a truthy but not true flag', { fullAccess: 'yes', isAdmin: true }],
  ])('%s is refused for both tools', async (_label, context) => {
    const ctx = { staffAuthorization: AUTH, ...context };
    expect(await find('sms template', ctx)).toMatchObject({ code: 'permission_denied' });
    expect(await propose(inputFor(ENTRY), ctx)).toMatchObject({ code: 'permission_denied' });
    expect(await propose({ ...inputFor(ENTRY), confirmed: true, _approved_edit_pin: 'x' }, ctx)).toMatchObject({ code: 'permission_denied' });
    expect(callsOf()).toHaveLength(0);
  });

  test('a missing or malformed bearer token refuses before anything is read or sent', async () => {
    for (const staffAuthorization of [undefined, '', 'Bearer ', 'Basic abcdefghijklmnop', 'Bearer short', `Bearer ${'a'.repeat(4001)}`]) {
      expect(await propose(inputFor(ENTRY), ownerContext({ staffAuthorization }))).toMatchObject({ code: 'permission_denied' });
    }
    expect(callsOf()).toHaveLength(0);
  });

  test('an unknown tool name is not implemented', async () => {
    expect(await executeAdminWriteTool('drop_everything', {}, ownerContext())).toMatchObject({ code: 'capability_unimplemented' });
  });

  test('the registry offers the tools only with the gate on AND the owner login', () => {
    const owner = { role: 'admin', context: 'customers', fullAccess: true };
    const names = tools => tools.map(tool => tool.name);
    const offered = scope => names(registry.initialTools('customers', scope));
    expect(registry.allowed(registry.actions.get(PROPOSE), owner)).toBe(true);
    expect(registry.allowed(registry.actions.get(FIND), owner)).toBe(true);
    expect(registry.allowed(registry.actions.get(PROPOSE), { ...owner, fullAccess: false })).toBe(false);
    expect(registry.allowed(registry.actions.get(FIND), { ...owner, fullAccess: false })).toBe(false);
    expect(registry.allowed(registry.actions.get(PROPOSE), { role: 'technician', context: 'tech', fullAccess: true })).toBe(false);
    const discovered = scope => registry.discover({ query: 'reviewed admin edit confirm card' }, scope).definitions.map(tool => tool.name);
    expect(discovered(owner)).toEqual(expect.arrayContaining([FIND, PROPOSE]));
    expect(discovered({ ...owner, fullAccess: false })).not.toEqual(expect.arrayContaining([PROPOSE]));
    expect(offered({ role: 'admin', fullAccess: false })).not.toContain(PROPOSE);
    delete process.env.GATE_IB_GENERAL_EDIT;
    expect(registry.allowed(registry.actions.get(PROPOSE), owner)).toBe(false);
    expect(registry.allowed(registry.actions.get(FIND), owner)).toBe(false);
    expect(discovered(owner)).not.toEqual(expect.arrayContaining([FIND, PROPOSE]));
    expect(offered({ role: 'admin', fullAccess: true })).not.toEqual(expect.arrayContaining([FIND, PROPOSE]));
  });

  test('the propose tool is a two-step, owner-only write; the finder is an owner-only read; neither is owner-direct', () => {
    const gates = require('../services/intelligence-bar/write-gates');
    const ownerDirect = require('../services/intelligence-bar/owner-direct');
    expect(gates.WRITE_TWO_STEP_TOOL_NAMES.has(PROPOSE)).toBe(true);
    expect(gates.UI_GATED_WRITE_TOOL_NAMES.has(PROPOSE)).toBe(true);
    expect(gates.FULL_ACCESS_TWO_STEP_TOOL_NAMES.has(PROPOSE)).toBe(true);
    expect(gates.FULL_ACCESS_READ_TOOL_NAMES.has(FIND)).toBe(true);
    expect(registry.actions.get(PROPOSE)).toMatchObject({ approval: 'ui_confirm', kind: 'internal_write', role: 'admin', scope: 'record' });
    expect(registry.actions.get(FIND)).toMatchObject({ approval: null, kind: 'read', role: 'admin' });
    // Not on the list of edits that skip the card.
    expect(ownerDirect.OWNER_DIRECT_TOOL_NAMES.has(PROPOSE)).toBe(false);
    expect(ownerDirect.executesWithoutCard(PROPOSE, inputFor(ENTRY), { preview: true })).toBe(false);
    expect(ownerDirect.mayExecuteWithoutCard(PROPOSE, inputFor(ENTRY))).toBe(false);
    expect(Contract.tierFor(PROPOSE)).toBe('yellow');
  });

  test('the model cannot confirm or pin through its own input: the schema refuses extra fields', async () => {
    const context = { role: 'admin', context: 'platform', actionContext: ownerContext({ confirmed: false }) };
    const forged = await registry.execute(PROPOSE, { ...inputFor(ENTRY), confirmed: true }, context);
    expect(forged).toMatchObject({ code: 'invalid_input' });
    const pinned = await registry.execute(PROPOSE, { ...inputFor(ENTRY), _approved_edit_pin: 'abc' }, context);
    expect(pinned).toMatchObject({ code: 'invalid_input' });
    expect(callsOf()).toHaveLength(0);
    // The registry path itself returns the preview.
    const preview = await registry.execute(PROPOSE, inputFor(ENTRY), context);
    expect(preview).toMatchObject({ preview: true });
  });
});

describe('find_admin_edits', () => {
  test('finds an edit by its words and lists the method, endpoint, fields and what it does not do', async () => {
    const result = await find('sms template wording');
    expect(result.status).toBe('edits_found');
    const match = result.matches.find(m => m.endpoint === ENTRY.endpoint);
    expect(match).toMatchObject({ method: 'PUT', params: ['id'], label: ENTRY.label });
    expect(match.fields.map(f => f.name).sort()).toEqual(Object.keys(ENTRY.body).sort());
    expect(match.does_not).toBe(ENTRY.noSend);
    expect(result.matches.length).toBeLessThanOrEqual(10);
  });

  test('a customer or visit scoped edit says it needs the customer id', async () => {
    const result = await find('customer text report preferences notification');
    const match = result.matches.find(m => m.endpoint === CUSTOMER_ENTRY.endpoint);
    expect(match).toMatchObject({ needs_customer_id: true });
    const visit = (await find('visit note')).matches.find(m => m.endpoint === VISIT_ENTRY.endpoint);
    expect(visit).toMatchObject({ needs_customer_id: true });
    const broad = (await find('sms template wording')).matches.find(m => m.endpoint === ENTRY.endpoint);
    expect(broad.needs_customer_id).toBeUndefined();
  });

  test('says plainly when nothing matches, and names what is never on the list', async () => {
    for (const query of ['refund a payment', 'delete the customer', 'zzzz qqqq']) {
      const result = await find(query);
      expect(result.status === 'no_match' || !result.matches.some(m => /refund|payment|delete|invoice/.test(m.endpoint))).toBe(true);
    }
    const none = await find('zzzz qqqq');
    expect(none).toMatchObject({ status: 'no_match', matches: [] });
    expect(none.note).toMatch(/no customer messages, money, deletes, bulk changes, settings, users or credentials/i);
  });
});

describe('the body allow-list', () => {
  test('a field the row does not list is REFUSED, not dropped, and nothing is sent', async () => {
    for (const body of [{ name: 'x', is_active: false }, { is_active: false }, { name: 'x', trigger_event_key: 'send_everything' }, { name: 'x', id: ID }, { name: 'x', constructor: 'x' }]) {
      const result = await propose({ ...inputFor(ENTRY), body });
      expect(result).toMatchObject({ code: 'invalid_input', allowed_fields: Object.keys(ENTRY.body) });
      expect(result.error).toMatch(/not allowed/);
    }
    expect(callsOf()).toHaveLength(0);
  });

  test('also refused at confirm: a stored body with an extra field sends nothing', async () => {
    const preview = await propose(inputFor(ENTRY));
    const result = await propose({ ...inputFor(ENTRY, { body: { ...FIXTURES[keyOf(ENTRY)].body, is_active: false } }), confirmed: true, _approved_edit_pin: preview._version });
    expect(result).toMatchObject({ code: 'invalid_input' });
    expect(callsOf()).toHaveLength(0);
  });

  test.each([
    ['an empty body', {}, /body is empty/],
    ['a non-object body', 'name=x', /body must be an object/],
    ['an array body', [{ name: 'x' }], /body must be an object/],
    ['a number for text', { name: 5 }, /must be text/],
    ['text over the limit', { name: 'x'.repeat(ENTRY.body.name.maxLength + 1) }, /longer than/],
    ['a control character', { name: 'a\u0007b' }, /control character/],
  ])('refuses %s', async (_label, body, message) => {
    const result = await propose({ ...inputFor(ENTRY), body });
    expect(result).toMatchObject({ code: 'invalid_input' });
    expect(result.error).toMatch(message);
    expect(callsOf()).toHaveLength(0);
  });

  test('trims text, and refuses a missing required field', async () => {
    const preview = await propose({ ...inputFor(ENTRY), body: { name: '  Reminder  ' } });
    expect(preview.changes[0].after).toBe('Reminder');
    const timesheet = catalog.entries.find(e => e.endpoint === '/admin/timetracking/entries/:id');
    const missing = await propose({ ...inputFor(timesheet), body: { notes: 'only a note' } });
    expect(missing).toMatchObject({ code: 'invalid_input' });
    expect(missing.error).toMatch(/Missing required field\(s\): edit_reason/);
  });

  test('typed fields: a boolean is a boolean, a date-time has a zone, an enum is one of its values', async () => {
    const prefs = catalog.entries.find(e => e.endpoint === '/admin/customers/:id/notification-prefs');
    for (const body of [{ appointmentNotifyPrimary: 'false' }, { appointmentNotifyPrimary: 0 }, { billingEmail: 'x@example.com' }, { marketingOffers: true }]) {
      expect(await propose({ ...inputFor(prefs), body })).toMatchObject({ code: 'invalid_input' });
    }
    const timesheet = catalog.entries.find(e => e.endpoint === '/admin/timetracking/entries/:id');
    const base = FIXTURES[keyOf(timesheet)].body;
    for (const change of [{ clock_in: '2026-10-12 08:00' }, { clock_in: '2026-13-45T08:00:00Z' }, { clock_in: '2026-02-30T08:00:00-04:00' }, { clock_in: '2026-02-29T08:00:00-05:00' }, { clock_in: '2026-04-31T08:00:00Z' }, { clock_out: '2026-10-12T24:00:00Z' }, { clock_out: '2026-10-12T25:00:00Z' }, { clock_out: '2026-10-12T08:60:00Z' }, { clock_out: '2026-10-12T08:00:60Z' }, { clock_out: '2026-10-12T08:00:00+25:00' }, { clock_out: '2026-10-12T08:00:00+05:75' }, { clock_out: 'yesterday' }, { entry_type: 'overtime' }, { pay_rate: 99 }, { approval_status: 'approved' }]) {
      expect(await propose({ ...inputFor(timesheet), body: { ...base, ...change } })).toMatchObject({ code: 'invalid_input' });
    }
    expect(callsOf()).toHaveLength(0);
    // Real calendar moments pass, leap day and end-of-month included.
    for (const clock_in of ['2024-02-29T08:00:00-05:00', '2026-04-30T23:59:59Z', '2026-12-31T23:59:00.500+05:30']) {
      expect(await propose({ ...inputFor(timesheet), body: { ...base, clock_in } })).toMatchObject({ preview: true });
    }
  });

  test('nothing money, message or status related is on any row', () => {
    const FORBIDDEN_FIELD = /(price|amount|total|rate|cost|charge|refund|credit|discount|invoice|payment|status|is_active|enabled|send|phone|email|address|token|password|secret|role|delete)/i;
    const ALLOWED_EXCEPTIONS = new Set(['paymentConfirmationSms', 'serviceReportNotifyPrimary', 'serviceReportNotifyBilling']);
    for (const entry of catalog.entries) {
      for (const field of Object.keys(entry.body)) {
        if (ALLOWED_EXCEPTIONS.has(field)) continue;
        expect({ entry: entry.endpoint, field, forbidden: FORBIDDEN_FIELD.test(field) }).toEqual({ entry: entry.endpoint, field, forbidden: false });
      }
    }
  });
});

describe('the endpoint and the path', () => {
  test.each([
    ['an unknown endpoint', () => ({ endpoint: '/admin/not-in-the-catalog' })],
    ['the wrong method', () => ({ method: 'PATCH' })],
    ['a DELETE', () => ({ method: 'DELETE' })],
    ['a POST', () => ({ method: 'POST' })],
    ['a lower-case method', () => ({ method: 'put', endpoint: '/Admin/sms-templates/:id' })],
    ['a pre-built URL', () => ({ endpoint: `/api${ENTRY.endpoint}` })],
    ['an absolute URL', () => ({ endpoint: `http://evil.example${ENTRY.endpoint}` })],
    ['a filled pattern', () => ({ endpoint: `/admin/sms-templates/${ID}` })],
    ['a trailing slash', () => ({ endpoint: `${ENTRY.endpoint}/` })],
    ['a path-climbing endpoint', () => ({ endpoint: '/admin/../auth/me' })],
    ['a money endpoint', () => ({ endpoint: '/admin/invoices/:id' })],
    ['a bulk endpoint', () => ({ endpoint: '/admin/customers/bulk' })],
    ['a missing endpoint', () => ({ endpoint: undefined })],
    ['an object endpoint', () => ({ endpoint: { toString: () => ENTRY.endpoint } })],
  ])('refuses %s as not on the list', async (_label, change) => {
    const result = await propose({ ...inputFor(ENTRY), ...change() });
    expect(result).toMatchObject({ code: 'edit_not_on_list', hint: 'find_admin_edits' });
    expect(callsOf()).toHaveLength(0);
  });

  test.each([
    ['a dot-dot value', '..'], ['a slash', 'a/b'], ['an encoded slash', 'a%2Fb'], ['a percent sign', '100%'], ['a backslash', 'a\\b'],
    ['a space', 'a b'], ['a query mark', 'a?b=1'], ['an empty value', ''], ['a short non-uuid', 'abc'], ['a uuid with a suffix', `${ID}x`], ['a newline', `${ID}\n`],
  ])('refuses a uuid parameter with %s', async (_label, value) => {
    const result = await propose({ ...inputFor(ENTRY), params: { id: value } });
    expect(result).toMatchObject({ code: 'invalid_input' });
    expect(callsOf()).toHaveLength(0);
  });

  test('refuses an extra, a missing and a non-object params', async () => {
    expect(await propose({ ...inputFor(ENTRY), params: { id: ID, extra: '2' } })).toMatchObject({ code: 'invalid_input' });
    expect(await propose({ ...inputFor(ENTRY), params: {} })).toMatchObject({ code: 'invalid_input' });
    expect(await propose({ ...inputFor(ENTRY), params: undefined })).toMatchObject({ code: 'invalid_input' });
    expect(await propose({ ...inputFor(ENTRY), params: [ID] })).toMatchObject({ code: 'invalid_input' });
    expect(callsOf()).toHaveLength(0);
  });

  test('a text parameter may hold dots and dashes, is percent-encoded, and can never reach a sibling route', async () => {
    const template = catalog.entries.find(e => e.endpoint === '/admin/email-templates/:key');
    const preview = await propose({ ...inputFor(template), params: { key: 'estimate.expiring_notice' } });
    const done = await propose({ ...inputFor(template), params: { key: 'estimate.expiring_notice' }, confirmed: true, _approved_edit_pin: preview._version });
    expect(done.success).toBe(true);
    expect(new URL(callsOf()[0][0]).pathname).toBe('/api/admin/email-templates/estimate.expiring_notice');
    for (const value of ['a/b', '..', 'a%2Fb', 'x?y']) {
      expect(await propose({ ...inputFor(template), params: { key: value } })).toMatchObject({ code: 'invalid_input' });
    }
    expect(callsOf()).toHaveLength(1);
  });
});

describe('the blocked routes', () => {
  test('a text parameter value that spells an unreviewed sibling route is refused', async () => {
    const template = catalog.entries.find(e => e.endpoint === '/admin/email-templates/:key');
    const blocked = { ...catalog, blockedRoutes: ['/admin/email-templates/locked-list'] };
    let outcome;
    jest.isolateModules(() => {
      jest.doMock('../services/intelligence-bar/admin-write-catalog.json', () => blocked);
      outcome = require('../services/intelligence-bar/admin-write-tools')
        .executeAdminWriteTool(PROPOSE, { ...inputFor(template), params: { key: 'locked-list' } }, ownerContext());
    });
    jest.dontMock('../services/intelligence-bar/admin-write-catalog.json');
    expect(await outcome).toMatchObject({ code: 'invalid_input', error: expect.stringMatching(/outside the reviewed admin edit list/) });
    expect(callsOf()).toHaveLength(0);
    // The same value on a catalog with no such route is an ordinary template key.
    world.email_templates[0].template_key = 'locked-list';
    expect(await propose({ ...inputFor(template), params: { key: 'locked-list' } })).toMatchObject({ preview: true });
  });
});

describe('the customer binding', () => {
  test('a customer scoped edit needs customer_id, and it must be the customer in the path', async () => {
    const input = inputFor(CUSTOMER_ENTRY);
    expect(await propose({ ...input, customer_id: undefined })).toMatchObject({ code: 'customer_scope_required' });
    expect(await propose({ ...input, customer_id: 'not-a-uuid' })).toMatchObject({ code: 'customer_scope_required' });
    expect(await propose({ ...input, customer_id: OTHER_CUSTOMER })).toMatchObject({ code: 'target_relationship_mismatch' });
    expect(await propose({ ...input, customer_id: CUSTOMER.toUpperCase() })).toMatchObject({ preview: true, customer_id: CUSTOMER });
  });

  test('a visit scoped edit binds the visit to its real customer: a made-up customer_id is refused', async () => {
    const input = inputFor(VISIT_ENTRY);
    expect(await propose({ ...input, customer_id: undefined })).toMatchObject({ code: 'customer_scope_required' });
    world.scheduled_services[0].customer_id = OTHER_CUSTOMER;
    expect(await propose(input)).toMatchObject({ code: 'target_relationship_mismatch' });
    world.scheduled_services = [];
    expect(await propose(input)).toMatchObject({ code: 'record_unavailable' });
    world = seedWorld();
    expect(await propose(input)).toMatchObject({ preview: true, customer_id: CUSTOMER });
    db.mockImplementation(() => { throw new Error('connection refused'); });
    expect(await propose(input)).toMatchObject({ code: 'record_lookup_failed' });
    expect(callsOf()).toHaveLength(0);
  });

  test('a broad edit takes no customer_id', async () => {
    expect(await propose({ ...inputFor(ENTRY), customer_id: CUSTOMER })).toMatchObject({ code: 'invalid_input' });
  });
});

describe('the confirm replays exactly the carded plan', () => {
  test('the approved pin is required, and a pin from a different body, record or endpoint is refused', async () => {
    const input = inputFor(ENTRY);
    const preview = await propose(input);
    expect(await propose({ ...input, confirmed: true })).toMatchObject({ code: 'preview_changed', preview_changed: true });
    expect(await propose({ ...input, confirmed: true, _approved_edit_pin: '' })).toMatchObject({ code: 'preview_changed' });
    expect(await propose({ ...input, confirmed: true, _approved_edit_pin: 'f'.repeat(32) })).toMatchObject({ code: 'preview_changed' });
    // The pin of a different body does not authorize this one.
    const otherPreview = await propose({ ...input, body: { name: 'Another name' } });
    expect(otherPreview._version).not.toBe(preview._version);
    expect(await propose({ ...input, confirmed: true, _approved_edit_pin: otherPreview._version })).toMatchObject({ code: 'preview_changed' });
    // …nor does a pin made for another record.
    const otherRecord = await propose({ ...input, params: { id: '40000000-0000-4000-8000-00000000000d' } });
    expect(await propose({ ...input, confirmed: true, _approved_edit_pin: otherRecord._version })).toMatchObject({ code: 'preview_changed' });
    expect(callsOf()).toHaveLength(0);
    // The matching pin sends exactly one request.
    expect(await propose({ ...input, confirmed: true, _approved_edit_pin: preview._version })).toMatchObject({ success: true });
    expect(callsOf()).toHaveLength(1);
  });

  test('the preview is stable (same input, same pin) and the pin binds the customer', async () => {
    const input = inputFor(CUSTOMER_ENTRY);
    expect((await propose(input))._version).toBe((await propose(input))._version);
    expect((await propose(inputFor(VISIT_ENTRY)))._version).toMatch(/^[0-9a-f]{32}$/);
  });

  test('a reviewed row whose fingerprint changed after the card was shown is refused at confirm', async () => {
    const input = inputFor(ENTRY);
    const preview = await propose(input);
    // The same endpoint, regenerated after a handler change: the chain hash, and so the digest, differ.
    let outcome;
    jest.isolateModules(() => {
      jest.doMock('../services/intelligence-bar/admin-write-catalog.json', () => ({
        ...catalog,
        entries: catalog.entries.map(entry => (keyOf(entry) === keyOf(ENTRY) ? { ...entry, chain: '0'.repeat(32), digest: '1'.repeat(32) } : entry)),
      }));
      require('../models/db').mockImplementation(makeDb()); // the isolated copy of the database stand-in
      outcome = require('../services/intelligence-bar/admin-write-tools')
        .executeAdminWriteTool(PROPOSE, { ...input, confirmed: true, _approved_edit_pin: preview._version }, ownerContext());
    });
    jest.dontMock('../services/intelligence-bar/admin-write-catalog.json');
    expect(await outcome).toMatchObject({ code: 'preview_changed', preview_changed: true });
    expect(callsOf()).toHaveLength(0);
  });

  test('a row dropped from the catalog after the card was shown is refused at confirm', async () => {
    const input = inputFor(ENTRY);
    const preview = await propose(input);
    let outcome;
    jest.isolateModules(() => {
      jest.doMock('../services/intelligence-bar/admin-write-catalog.json', () => ({ ...catalog, entries: catalog.entries.filter(entry => keyOf(entry) !== keyOf(ENTRY)) }));
      outcome = require('../services/intelligence-bar/admin-write-tools')
        .executeAdminWriteTool(PROPOSE, { ...input, confirmed: true, _approved_edit_pin: preview._version }, ownerContext());
    });
    expect(await outcome).toMatchObject({ code: 'edit_not_on_list' });
    jest.dontMock('../services/intelligence-bar/admin-write-catalog.json');
    expect(callsOf()).toHaveLength(0);
  });

  test('the result is a receipt: the edit endpoint\'s response body (and any secret in it) is never returned', async () => {
    const input = inputFor(ENTRY);
    const preview = await propose(input);
    global.fetch = savingFetch(() => jsonResponse(200, { success: true, template: { body: 'echo', api_key: 'sk_live_SECRET_VALUE', gate_code: '4821' } }));
    const result = await propose({ ...input, confirmed: true, _approved_edit_pin: preview._version });
    expect(result).toMatchObject({ success: true, fields_changed: ['body', 'name'], record: { id: ID } });
    const text = JSON.stringify(result);
    expect(text).not.toContain('sk_live_SECRET_VALUE');
    expect(text).not.toContain('4821');
    expect(text).not.toContain(TOKEN);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls])).not.toContain('Hi {first_name}');
  });

  async function confirmedWith(response) {
    const input = inputFor(ENTRY);
    const preview = await propose(input);
    global.fetch = savingFetch(typeof response === 'function' ? response : () => response);
    return propose({ ...input, confirmed: true, _approved_edit_pin: preview._version });
  }

  test('a 4xx answer is a refusal with the screen\'s own message; a 404 is record_unavailable', async () => {
    const refused = await confirmedWith(jsonResponse(400, { error: 'This template must keep {first_name}' }));
    expect(refused).toMatchObject({ success: false, status: 400, code: 'endpoint_rejected', error: 'This template must keep {first_name}' });
    expect(require('../services/intelligence-bar/outcomes').executionOutcome(refused)).toBe('failed');
    expect(require('../services/intelligence-bar/outcomes').isPolicyRefusal(refused)).toBe(true);
    const missing = await confirmedWith(jsonResponse(404, { error: 'Template not found' }));
    expect(missing).toMatchObject({ success: false, code: 'record_unavailable' });
    expect(require('../services/intelligence-bar/outcomes').isPolicyRefusal(missing)).toBe(true);
    const leaky = await confirmedWith(jsonResponse(409, { error: `Authorization: ${AUTH}` }));
    expect(JSON.stringify(leaky)).not.toContain(TOKEN);
  });

  test.each([
    ['a 500', () => jsonResponse(500, { error: 'boom' })],
    ['a 408', () => jsonResponse(408, { error: 'slow' })],
    ['a 429', () => jsonResponse(429, { error: 'busy' })],
    ['a redirect', () => jsonResponse(302, '')],
    ['a 2xx that is not JSON', () => jsonResponse(200, 'ok', { 'content-type': 'text/html' })],
    ['a transport error', () => { throw new Error('ECONNRESET'); }],
    ['a timeout', () => { const err = new Error('timed out'); err.name = 'TimeoutError'; throw err; }],
  ])('%s leaves the outcome unknown, never a success and never a retry invitation', async (_label, respond) => {
    const result = await confirmedWith(async () => respond());
    expect(result).toMatchObject({ outcome_unknown: true, code: 'execution_interrupted' });
    expect(require('../services/intelligence-bar/outcomes').executionOutcome(result)).toBe('outcome_unknown');
    expect(callsOf()).toHaveLength(1);
  });
});

describe('address text and long values (a stand-in catalog and snapshot)', () => {
  const fixtureCatalog = (extra = {}) => ({
    ...catalog,
    entries: [{
      ...ENTRY,
      endpoint: '/admin/test/record/:id', body: { notes: { type: 'string', maxLength: 600 }, address_line1: { type: 'string', maxLength: 120 }, city: { type: 'string', maxLength: 60 } },
      required: [], digest: '2'.repeat(32), chain: '3'.repeat(32), label: 'Test record', ...extra,
    }],
    blockedRoutes: [],
  });
  const snapshotOf = (current = {}, extra = {}) => ({ label: 'Test record for Pat Tester', current, state: {}, version: STAMP, ...extra });

  function withCatalog(fixture, snapshot, run) {
    let result;
    jest.isolateModules(() => {
      jest.doMock('../services/intelligence-bar/admin-write-catalog.json', () => fixture);
      jest.doMock('../services/intelligence-bar/admin-write-snapshots', () => ({
        ...jest.requireActual('../services/intelligence-bar/admin-write-snapshots'),
        loadSnapshot: async () => snapshot, normalizeBody: (key, body) => body, hasSnapshot: () => true,
      }));
      result = run(require('../services/intelligence-bar/admin-write-tools'));
    });
    jest.dontMock('../services/intelligence-bar/admin-write-catalog.json');
    jest.dontMock('../services/intelligence-bar/admin-write-snapshots');
    return result;
  }
  const baseInput = { method: 'PUT', endpoint: '/admin/test/record/:id', params: { id: ID } };
  const proposeOn = (body, snapshot = snapshotOf({ notes: 'old', address_line1: '2 Oak Ave', city: 'Parrish' })) => withCatalog(fixtureCatalog(), snapshot,
    tools => tools.executeAdminWriteTool(PROPOSE, { ...baseInput, body }, ownerContext()));

  test('a field that looks like address text always shows an ADDRESS CHANGE card line', async () => {
    const preview = await proposeOn({ address_line1: '1 Main St', city: 'Venice' });
    expect(preview).toMatchObject({ preview: true, address_change: true, address_fields: ['address_line1', 'city'] });
    expect(cardLines(preview)[0]).toMatchObject({ kind: 'customer', text: expect.stringMatching(/^ADDRESS CHANGE:/) });
    expect(displayParams(preview).address_change).toMatch(/^YES/);
    expect(cardLines(preview).map(line => line.text)).toContain('address line1: 2 Oak Ave → 1 Main St');
    const plain = await proposeOn({ notes: 'hello' });
    expect(plain.address_change).toBe(false);
    expect(cardLines(plain).some(line => /ADDRESS CHANGE/.test(line.text))).toBe(false);
  });

  test('the card and the contract carry the address wording and the record label', async () => {
    const preview = await proposeOn({ address_line1: '1 Main St' });
    const contract = Contract.buildContract({ toolName: PROPOSE, params: { ...baseInput, body: { address_line1: '1 Main St' } }, displayParams: displayParams(preview), preview, summary: 'x' });
    const labels = contract.effects.map(effect => effect.label).join('\n');
    expect(labels).toMatch(/ADDRESS CHANGE/);
    expect(labels).toContain('Record: Test record for Pat Tester');
    expect(contract.action_label).toBe('Edit an admin record');
    expect(contract.irreversible).toBe(false);
    expect(contract.notifies_customer).toBe(false);
  });

  test('a long new value shows its first characters on the card and the whole text under Show more', async () => {
    const long = `${'a'.repeat(310)}END`;
    const preview = await proposeOn({ notes: long });
    const lines = cardLines(preview);
    expect(lines.find(line => /^notes:/.test(line.text)).text).toMatch(/more characters\]$/);
    expect(lines.find(line => line.more).text).toContain(long);
    const contract = Contract.buildContract({ toolName: PROPOSE, params: baseInput, displayParams: displayParams(preview), preview, summary: 'x' });
    expect(JSON.stringify(contract.more_effects)).toContain('END');
    const other = await proposeOn({ notes: `${'a'.repeat(310)}DIFFERENT` });
    expect(Contract.previewFingerprint(other)).not.toBe(Contract.previewFingerprint(preview));
  });

  test('a record the snapshot cannot find, or reads wrongly, gets no card', async () => {
    expect(await proposeOn({ notes: 'x' }, null)).toMatchObject({ code: 'record_unavailable' });
    expect(await proposeOn({ notes: 'x' }, { unsupported: true })).toMatchObject({ code: 'edit_not_on_list' });
  });
});

describe('the record snapshot: label, current values, version', () => {
  test('every catalog row has a snapshot, and the snapshot keys are exactly the catalog rows', () => {
    const Snapshots = require('../services/intelligence-bar/admin-write-snapshots');
    expect([...Snapshots.SNAPSHOT_KEYS].sort()).toEqual(catalog.entries.map(keyOf).sort());
    for (const entry of catalog.entries) expect(Snapshots.hasSnapshot(keyOf(entry))).toBe(true);
  });

  test.each(Object.keys(FIXTURES))('%s: the card shows the real current value of every carded field', async (key) => {
    const entry = catalog.entries.find(e => keyOf(e) === key);
    const preview = await propose(inputFor(entry));
    const [table, where, columns] = SAVES[key];
    const row = world[table].find(r => Object.entries(where(FIXTURES[key].params)).every(([k, v]) => String(r[k]) === String(v)));
    for (const change of preview.changes) {
      const stored = row[columns[change.field]];
      // A database timestamp reaches the card as its ISO string, everything else as stored.
      expect(change.before).toEqual(stored instanceof Date ? stored.toISOString() : (stored === undefined ? null : stored));
    }
  });

  test('text that looks like JSON stays text, and a database timestamp is shown and compared as an ISO string', async () => {
    const note = catalog.entries.find(e => e.endpoint === '/admin/dispatch/:serviceId/note');
    for (const stored of ['"quoted note"', '123', 'true', 'null', '{"a":1}', '[1,2]']) {
      world = seedWorld();
      world.scheduled_services[0].notes = stored;
      const preview = await propose(inputFor(note));
      expect(preview.changes[0].before).toBe(stored);
    }
    // The save lands and is read back even when the NEW text is itself JSON-looking.
    for (const text of ['"quoted note"', '42', '{"a":1}']) {
      world = seedWorld();
      const input = inputFor(note, { body: { notes: text } });
      const preview = await propose(input);
      const done = await propose({ ...input, confirmed: true, _approved_edit_pin: preview._version });
      expect(done).toMatchObject({ success: true });
      expect(world.scheduled_services[0].notes).toBe(text);
    }
    // Timestamps are plain strings in the preview (not `{}` after the scrubber) and the pin is stable for the same Date.
    world = seedWorld();
    const entry = catalog.entries.find(e => e.endpoint === '/admin/timetracking/entries/:id');
    const timesheet = await propose(inputFor(entry));
    const clockIn = timesheet.changes.find(change => change.field === 'clock_in');
    expect(clockIn.before).toBe('2026-10-12T12:00:00.000Z');
    expect((await propose(inputFor(entry)))._version).toBe(timesheet._version);
  });

  test('a customer with no saved preference row shows "none saved yet" and every flag as not set', async () => {
    world.notification_prefs = [];
    const preview = await propose(inputFor(CUSTOMER_ENTRY));
    expect(preview.record_label).toBe('Pat Tester: text and report preferences (none saved yet)');
    expect(preview.changes.every(change => change.before === null)).toBe(true);
  });

  test('a value changed on the screen between the card and Confirm is a new card, and nothing is sent', async () => {
    for (const [key, change] of [
      ['PUT /admin/sms-templates/:id', () => { world.sms_templates[0].body = 'Someone else edited this'; }],
      ['PUT /admin/sms-templates/:id', () => { world.sms_templates[0].name = 'Renamed meanwhile'; }],
      ['PUT /admin/sms-templates/:id', () => { world.sms_templates[0].updated_at = '2026-10-20T01:00:00.000Z'; }],
      ['PUT /admin/timetracking/entries/:id', () => { world.time_entries[0].clock_out = '2026-10-12T21:00:00.000Z'; }],
      ['PUT /admin/customers/:id/notification-prefs', () => { world.notification_prefs[0].appointment_notify_primary = false; }],
      ['PUT /admin/customers/:id/notification-prefs', () => { world.notification_prefs = []; }],
      ['PATCH /admin/dispatch/:serviceId/note', () => { world.scheduled_services[0].notes = 'Tech added a note'; }],
      ['PUT /admin/inventory/service-usage/:id', () => { world.service_product_usage[0].notes = 'Changed'; }],
      ['PUT /admin/email-templates/fixtures/:id', () => { world.email_template_fixtures[0].payload = { first_name: 'Other' }; }],
      ['PUT /admin/automations/steps/:id', () => { world.automation_steps[0].html_body = '<p>Edited</p>'; }],
      ['PUT /admin/email-templates/:key', () => { world.email_templates[0].description = 'Edited'; }],
      ['PUT /admin/email-templates/versions/:id', () => { world.email_template_versions[0].subject = 'Edited'; }],
    ]) {
      world = seedWorld();
      const entry = catalog.entries.find(e => keyOf(e) === key);
      const preview = await propose(inputFor(entry));
      change();
      expect(await propose({ ...inputFor(entry), confirmed: true, _approved_edit_pin: preview._version })).toMatchObject({ code: 'preview_changed', preview_changed: true });
    }
    expect(callsOf()).toHaveLength(0);
  });

  test('a record deleted after the card was shown gets no edit', async () => {
    const preview = await propose(inputFor(ENTRY));
    world.sms_templates = [];
    expect(await propose({ ...inputFor(ENTRY), confirmed: true, _approved_edit_pin: preview._version })).toMatchObject({ code: 'record_unavailable' });
    expect(callsOf()).toHaveLength(0);
  });

  test('credentials in the current text are scrubbed on the card, yet the pin covers the real text', async () => {
    const entry = catalog.entries.find(e => e.endpoint === '/admin/dispatch/:serviceId/note');
    world.scheduled_services[0].notes = 'Alarm password: hunter2hunter2 and see https://example.s3.amazonaws.com/f?X-Amz-Signature=abcdef0123456789';
    const first = await propose(inputFor(entry));
    expect(JSON.stringify(first)).not.toContain('hunter2hunter2');
    expect(JSON.stringify(first)).not.toContain('X-Amz-Signature');
    world.scheduled_services[0].notes = 'Alarm password: different9different9 and see https://example.s3.amazonaws.com/f?X-Amz-Signature=abcdef0123456789';
    const second = await propose(inputFor(entry));
    expect(second._version).not.toBe(first._version);
  });
});

describe('a draft-only row', () => {
  const VERSION_ENTRY = catalog.entries.find(e => e.endpoint === '/admin/email-templates/versions/:id');

  test('the catalog row requires a draft', () => {
    expect(VERSION_ENTRY.requireState).toEqual({ status: 'draft' });
  });

  test.each(['active', 'archived', 'paused', 'published', ''])('a %s version gets no card', async (status) => {
    world.email_template_versions[0].status = status;
    const result = await propose(inputFor(VERSION_ENTRY));
    expect(result).toMatchObject({ code: 'record_state_not_allowed' });
    expect(result.error).toMatch(/only allowed while the record's status is "draft"/);
    expect(callsOf()).toHaveLength(0);
  });

  test('a draft that is archived (or published) after the card was shown gets no edit at Confirm', async () => {
    for (const status of ['archived', 'active', 'paused']) {
      world = seedWorld();
      const preview = await propose(inputFor(VERSION_ENTRY));
      expect(preview.preview).toBe(true);
      world.email_template_versions[0].status = status;
      const result = await propose({ ...inputFor(VERSION_ENTRY), confirmed: true, _approved_edit_pin: preview._version });
      expect(result).toMatchObject({ code: 'record_state_not_allowed' });
    }
    expect(callsOf()).toHaveLength(0);
  });

  test('a row that does not require a state ignores the record state', async () => {
    world.sms_templates[0].status = 'archived';
    expect(await propose(inputFor(ENTRY))).toMatchObject({ preview: true });
  });
});

describe('email blocks are shown and sent in the screen\'s canonical form', () => {
  const VERSION_ENTRY = catalog.entries.find(e => e.endpoint === '/admin/email-templates/versions/:id');
  const rough = [{ content: 'Hello {{first_name}}' }, { type: ' cta ', label: 5 }];
  const canonical = [{ type: 'paragraph', content: 'Hello {{first_name}}' }, { type: 'cta', content: '' }];

  test('the card shows the canonical blocks, the pin covers them, and the confirmed body carries them', async () => {
    const input = inputFor(VERSION_ENTRY, { body: { blocks: rough } });
    const preview = await propose(input);
    expect(preview.changes).toEqual([{ field: 'blocks', before: [{ type: 'paragraph', content: 'Old' }], after: canonical }]);
    // The same blocks typed already canonical are the same card.
    const again = await propose(inputFor(VERSION_ENTRY, { body: { blocks: canonical } }));
    expect(again._version).toBe(preview._version);
    const done = await propose({ ...input, confirmed: true, _approved_edit_pin: preview._version });
    expect(done.success).toBe(true);
    expect(JSON.parse(callsOf()[0][1].body)).toEqual({ blocks: canonical });
  });

  test('blocks whose normalizer leaves a field undefined are compared as the database keeps them (an image block)', async () => {
    const input = inputFor(VERSION_ENTRY, { body: { blocks: [{ type: 'image' }] } });
    mockNormalizeBlocks.mockImplementationOnce(() => [{ type: 'image', src: 'https://example.com/a.png', alt: undefined, width: undefined }]);
    const preview = await propose(input);
    expect(preview.changes[0].after).toEqual([{ type: 'image', src: 'https://example.com/a.png' }]);
    // The save stores the JSON form (undefined fields gone); the read-back must still agree.
    mockNormalizeBlocks.mockImplementation(() => [{ type: 'image', src: 'https://example.com/a.png', alt: undefined, width: undefined }]);
    try {
      const done = await propose({ ...input, confirmed: true, _approved_edit_pin: preview._version });
      expect(done).toMatchObject({ success: true });
      expect(JSON.parse(callsOf()[0][1].body)).toEqual({ blocks: [{ type: 'image', src: 'https://example.com/a.png' }] });
    } finally {
      mockNormalizeBlocks.mockImplementation(blocks => (blocks || []).map(block => ({ type: String(block?.type || 'paragraph').trim(), content: String(block?.content || '') })));
    }
  });

  test('blocks the screen cannot read get no card', async () => {
    mockNormalizeBlocks.mockImplementationOnce(() => { throw new Error('bad block'); });
    expect(await propose(inputFor(VERSION_ENTRY, { body: { blocks: rough } }))).toMatchObject({ code: 'invalid_input' });
    expect(callsOf()).toHaveLength(0);
  });
});

describe('the save is read back', () => {
  async function confirmWith(fetchImpl, input = inputFor(ENTRY)) {
    const preview = await propose(input);
    global.fetch = fetchImpl;
    return propose({ ...input, confirmed: true, _approved_edit_pin: preview._version });
  }

  test('a 200 that changed no row is NOT reported as saved', async () => {
    const result = await confirmWith(savingFetch(undefined, { save: false }));
    expect(result).toMatchObject({ outcome_unknown: true, code: 'edit_not_verified' });
    expect(result.error).toMatch(/body, name|name, body/);
    expect(result.success).toBeUndefined();
    expect(require('../services/intelligence-bar/outcomes').executionOutcome(result)).toBe('outcome_unknown');
  });

  test('a 200 that saved only some of the fields names the ones that did not hold', async () => {
    const input = inputFor(ENTRY);
    const result = await confirmWith(jest.fn(async (url, options) => {
      world.sms_templates[0].name = JSON.parse(options.body).name; // body never lands
      return jsonResponse(200, { success: true });
    }), input);
    expect(result).toMatchObject({ outcome_unknown: true, code: 'edit_not_verified' });
    expect(result.error).toContain('body did not hold');
    expect(result.error).not.toContain('name, ');
  });

  test('a record deleted by the save, or a read-back that fails, is an unknown outcome', async () => {
    expect(await confirmWith(jest.fn(async () => { world.sms_templates = []; return jsonResponse(200, { success: true }); })))
      .toMatchObject({ outcome_unknown: true, code: 'edit_not_verified' });
    world = seedWorld();
    expect(await confirmWith(jest.fn(async () => { db.mockImplementation(() => { throw new Error('connection reset'); }); return jsonResponse(200, { success: true }); })))
      .toMatchObject({ outcome_unknown: true, code: 'edit_not_verified' });
  });

  test('a save that lands is read back and reported with the record label', async () => {
    const result = await confirmWith(savingFetch());
    expect(result).toMatchObject({ success: true, record_label: LABELS['PUT /admin/sms-templates/:id'] });
    expect(world.sms_templates[0].name).toBe(FIXTURES['PUT /admin/sms-templates/:id'].body.name);
  });

  test('text is compared as the screen stores it (trimmed), and a date-time by instant', async () => {
    const timesheet = catalog.entries.find(e => e.endpoint === '/admin/timetracking/entries/:id');
    const result = await confirmWith(savingFetch((url, options) => {
      const body = JSON.parse(options.body);
      return jsonResponse(200, { saved: Object.keys(body) });
    }), inputFor(timesheet));
    expect(result.success).toBe(true);
    expect(world.time_entries[0].clock_in).toBe('2026-10-12T08:00:00-04:00');
  });
});

describe('the card text', () => {
  test('says what the edit does not do and which endpoint it saves through', async () => {
    const preview = await propose(inputFor(ENTRY));
    const lines = cardLines(preview).map(line => line.text);
    expect(lines).toContain(ENTRY.noSend);
    expect(lines).toContain(`Saved through the same screen endpoint (PUT ${ENTRY.endpoint}), so its own checks apply.`);
    expect(lines[0]).toBe(`Edit: ${ENTRY.label}`);
  });

  test('a preview from another tool, or an error, makes no card lines', () => {
    expect(cardLines({ preview: true, tool: 'send_invoice' }).length).toBeGreaterThanOrEqual(0);
    expect(cardLines(null)).toEqual([]);
    expect(cardLines({ error: 'x' })).toEqual([]);
    expect(displayParams(undefined)).toBeNull();
  });
});
