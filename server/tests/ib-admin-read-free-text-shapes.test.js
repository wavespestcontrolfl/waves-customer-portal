/**
 * Codex round 9 (P1): a reviewed row's `freeText` key must be the key the
 * endpoint RETURNS, not the table column. `/admin/customers/:id/autopay-state`
 * declared `autopay_pause_reason` (the column) while its handler returns
 * `pause_reason`, so the note passed through. Each fixture below is the
 * response shape verified by reading the handler (and the service or query it
 * calls); the line that proves each key is cited. Values are synthetic and the
 * fake secrets are built by concatenation so a scanner does not flag the repo.
 *
 * A test fails when the catalog declares a note or content key that no fixture
 * returns, and when a fixture holds a note value that the read does not withhold.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const catalog = require('../services/intelligence-bar/admin-read-catalog.json');
const { executeAdminReadTool } = require('../services/intelligence-bar/admin-read-tools');

const AUTH = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJ0ZXN0IjoidG9rZW4ifQ.c2lnbmF0dXJl';
const UUID = '10000000-0000-4000-8000-00000000000a';
const PASSWORD_NOTE = 'portal pass' + 'word is swords' + 'fish';
const LINK_NOTE = 'Pay at https://portal.example.test/pay/home' + '?session=' + 'abc' + '123';
const FAKE_PIECES = ['swords' + 'fish', 'abc' + '123', 'session='];

const jsonResponse = body => ({
  status: 200,
  headers: { get: key => ({ 'content-type': 'application/json; charset=utf-8' })[String(key).toLowerCase()] ?? null },
  text: async () => JSON.stringify(body),
});

// endpoint -> { params, body, withheld: dotted paths, kept: { path: value }, content: { path: value } }
const SHAPES = {
  // admin-communications.js:4343-4349 maps r.reason to `reason` inside `numbers[]`.
  '/admin/communications/blocked-numbers': {
    body: { numbers: [{ number: '+15555550100', blockType: 'spam', reason: PASSWORD_NOTE, autoBlocked: false, blockedAt: '2026-10-01T00:00:00Z' }] },
    withheld: ['numbers.0.reason'],
    kept: { 'numbers.0.number': '+15555550100', 'numbers.0.blockType': 'spam' },
  },
  // admin-billing-health.js:55 `pause_reason: customer.autopay_pause_reason` (the column is aliased);
  // :59 `recent_events` = autopay_log rows (select *), whose `details` jsonb is free text (migration 20260414000031 line 38).
  '/admin/customers/:id/autopay-state': {
    params: { id: UUID },
    body: {
      state: 'paused', autopay_enabled: true, paused_until: '2026-11-01', pause_reason: PASSWORD_NOTE, billing_day: 1,
      recent_events: [{ id: UUID, event_type: 'autopay_paused', details: { reason: LINK_NOTE }, created_at: '2026-10-01T00:00:00Z' }],
    },
    withheld: ['pause_reason', 'recent_events.0.details'],
    kept: { state: 'paused', billing_day: 1, 'recent_events.0.event_type': 'autopay_paused' },
  },
  // admin-customers.js:6511 `{ balance, ledger }`; ledger = customer_credit_ledger rows (customer-credit.js:52-56), column `note`.
  '/admin/customers/:id/credits': {
    params: { id: UUID },
    body: { balance: 25, ledger: [{ id: 1, source: 'goodwill', note: LINK_NOTE, created_by: 'Office', created_at: '2026-10-01T00:00:00Z' }] },
    withheld: ['ledger.0.note'],
    kept: { balance: 25, 'ledger.0.source': 'goodwill' },
  },
  // admin-neighborhood-access.js:507 `instructions: e.instructions || null` inside properties[].entries[].
  '/admin/neighborhood-access/customers/:customerId/properties': {
    params: { customerId: UUID },
    body: { properties: [{ id: UUID, label: 'Home', entries: [{ id: UUID, gateLabel: 'Main', accessType: 'instructions', code: null, instructions: PASSWORD_NOTE, status: 'live' }] }] },
    withheld: ['properties.0.entries.0.instructions'],
    kept: { 'properties.0.label': 'Home', 'properties.0.entries.0.gateLabel': 'Main' },
  },
  // admin-payers.js:44-48 `{ payers }`; services/payer.js:93 select * (column `notes`).
  '/admin/payers': {
    body: { payers: [{ id: 3, display_name: 'Synthetic Payer LLC', ap_email: 'ap@example.test', notes: LINK_NOTE }] },
    withheld: ['payers.0.notes'],
    kept: { 'payers.0.display_name': 'Synthetic Payer LLC' },
  },
  // admin-payers.js:69 `{ payer }`; services/payer.js:107-111 first() (column `notes`).
  '/admin/payers/:id': {
    params: { id: '3' },
    body: { payer: { id: 3, display_name: 'Synthetic Payer LLC', notes: PASSWORD_NOTE } },
    withheld: ['payer.notes'],
    kept: { 'payer.display_name': 'Synthetic Payer LLC' },
  },
  // admin-referrals-v2.js:209-221 `{ payouts }` = referral_payouts.* joined to promoters (column `admin_notes`).
  '/admin/referrals/payouts': {
    body: { payouts: [{ id: 5, status: 'pending', amount_cents: 2500, admin_notes: LINK_NOTE, first_name: 'Sam', last_name: 'Sample' }] },
    withheld: ['payouts.0.admin_notes'],
    kept: { 'payouts.0.status': 'pending', 'payouts.0.first_name': 'Sam' },
  },
  // admin-revenue.js:188,199 `{ settings }` = latest company_financials row (column `notes`).
  '/admin/revenue/settings': {
    body: { settings: { id: 1, effective_date: '2026-10-01', notes: PASSWORD_NOTE } },
    withheld: ['settings.notes'],
    kept: { 'settings.effective_date': '2026-10-01' },
  },

  // ---- content endpoints: the text is returned ----
  // admin-discounts.js:42-43 returns the array of discounts rows (column `description`).
  '/admin/discounts': {
    body: [{ id: 1, name: 'Spring offer', description: 'Ten percent off the first visit.' }],
    content: { '0.description': 'Ten percent off the first visit.' },
  },
  // admin-dispatch.js:3821-3823 `{ products }` = products_catalog rows (select *).
  '/admin/dispatch/products/catalog': {
    body: { products: [{ id: 1, name: 'Synthetic Product', compatibility_notes: 'Do not tank-mix.', mixing_instructions: 'Fill the tank halfway.', ppe_text: 'Gloves and goggles.', pollinator_precautions: 'Avoid blooming weeds.' }] },
    content: {
      'products.0.compatibility_notes': 'Do not tank-mix.', 'products.0.mixing_instructions': 'Fill the tank halfway.',
      'products.0.ppe_text': 'Gloves and goggles.', 'products.0.pollinator_precautions': 'Avoid blooming weeds.',
    },
  },
  // admin-job-forms.js:33 `{ template: tpl }` (select first(): description, sections).
  '/admin/job-forms/templates/by-service/:serviceType': {
    params: { serviceType: 'General Pest Control' },
    body: { template: { id: 1, name: 'Pest visit', description: 'Standard checklist.', sections: [{ title: 'Exterior', items: ['Check eaves'] }] } },
    content: { 'template.description': 'Standard checklist.' },
  },
  // admin-pricing-strategy.js:84-85 `{ offers }` = offer_packages rows.
  '/admin/pricing/offers': {
    body: { offers: [{ id: 1, name: 'Starter', description: 'Intro bundle.', guarantee_text: 'Money back.', scarcity_text: 'Ten spots.', urgency_text: 'Ends Friday.' }] },
    content: {
      'offers.0.description': 'Intro bundle.', 'offers.0.guarantee_text': 'Money back.',
      'offers.0.scarcity_text': 'Ten spots.', 'offers.0.urgency_text': 'Ends Friday.',
    },
  },
  // admin-pricing-strategy.js:151-152 `{ rules }` = upsell_rules rows.
  '/admin/pricing/upsell-rules': {
    body: { rules: [{ id: 1, name: 'After pest visit', message_template: 'Ask about lawn care.' }] },
    content: { 'rules.0.message_template': 'Ask about lawn care.' },
  },
  // admin-protocols.js:795-798 `{ checklists }` = equipment_checklists rows (`notes`, `checklist_items`).
  '/admin/protocols/equipment': {
    body: { checklists: [{ id: 1, service_type: 'pest', notes: 'Rinse the sprayer.', checklist_items: ['Sprayer', 'Gloves'] }] },
    content: { 'checklists.0.notes': 'Rinse the sprayer.' },
  },
  // admin-protocols.js:783-784 `{ scripts }` = communication_scripts rows (`script`, `tone_notes`).
  '/admin/protocols/scripts': {
    body: { scripts: [{ id: 1, title: 'Greeting', script: 'Say hello first.', tone_notes: 'Warm and brief.' }] },
    content: { 'scripts.0.script': 'Say hello first.', 'scripts.0.tone_notes': 'Warm and brief.' },
  },
};

const getAt = (value, path) => path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), value);
const keyOf = path => path.split('.').pop();
const declared = catalog.entries.filter(entry => entry.freeText);

beforeEach(() => {
  process.env.GATE_IB_GENERAL_READ = 'true';
  process.env.GATE_IB_PLATFORM = 'true';
});

describe('every reviewed free-text key is a key its endpoint returns', () => {
  // Every ADMITTED free-text endpoint needs a fixture. A fixture may stay for an
  // endpoint the generator has dropped as stale (the documented "regenerate and
  // commit" repair must leave CI green), but it must still name a reviewed row.
  test('each admitted endpoint with freeText has a verified response fixture', () => {
    const reviewedRows = new Set(require('../services/intelligence-bar/admin-read-reviewed.json').reviewed.map(row => row.endpoint));
    for (const entry of declared) expect(Object.keys(SHAPES)).toContain(entry.endpoint);
    for (const endpoint of Object.keys(SHAPES)) expect(reviewedRows.has(endpoint)).toBe(true);
  });

  test.each(declared.map(entry => [entry.endpoint, entry]))('%s: declared note keys are exactly the withheld keys, content keys are all returned', (endpoint, entry) => {
    const shape = SHAPES[endpoint];
    const noteKeys = Object.keys(entry.freeText).filter(key => entry.freeText[key] === 'note').sort();
    const contentKeys = Object.keys(entry.freeText).filter(key => entry.freeText[key] === 'content').sort();
    expect([...new Set((shape.withheld || []).map(keyOf))].sort()).toEqual(noteKeys);
    for (const path of Object.keys(shape.content || {})) expect(contentKeys).toContain(keyOf(path));
    // Every declared key must appear somewhere in the response fixture.
    for (const key of Object.keys(entry.freeText)) expect(JSON.stringify(shape.body)).toContain(`"${key}"`);
  });

  test.each(declared.map(entry => [entry.endpoint]))('%s: notes are withheld, other fields come back', async (endpoint) => {
    const shape = SHAPES[endpoint];
    global.fetch = jest.fn(async () => jsonResponse(shape.body));
    const result = await executeAdminReadTool('read_admin_data', { endpoint, ...(shape.params ? { params: shape.params } : {}) }, { fullAccess: true, isAdmin: true, staffAuthorization: AUTH });
    expect(result.status).toBe(200);
    const text = JSON.stringify(result);
    for (const path of shape.withheld || []) {
      const original = getAt(shape.body, path);
      const length = typeof original === 'string' ? original.length : JSON.stringify(original).length;
      expect(getAt(result.data, path)).toBe(`[note withheld: ${length} characters]`);
    }
    for (const piece of FAKE_PIECES) expect(text).not.toContain(piece);
    for (const [path, value] of Object.entries(shape.kept || {})) expect(getAt(result.data, path)).toEqual(value);
    for (const [path, value] of Object.entries(shape.content || {})) expect(getAt(result.data, path)).toBe(value);
    if (shape.withheld) expect(result.notes_withheld).toBe(shape.withheld.length);
    else expect(result).not.toHaveProperty('notes_withheld');
  });
});
