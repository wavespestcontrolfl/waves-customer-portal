/**
 * Codex round 9 (P1): a reviewed row's `freeText` key must be the key the
 * endpoint RETURNS, not the table column. `/admin/customers/:id/autopay-state`
 * declared `autopay_pause_reason` (the column) while its handler returns
 * `pause_reason`, so the note passed through. Each fixture below is the
 * response shape verified by reading the handler (and the service or query it
 * calls); the line that proves each key is cited. Values are synthetic and the
 * fake secrets are built by concatenation so a scanner does not flag the repo.
 *
 * Round 10: EVERY catalog endpoint has a fixture (the run-time read also withholds
 * any key whose name looks like free text unless the row declares it content), so
 * a test fails when a fixture holds a note value that the read does not withhold,
 * when a withheld key is not a declared note or a name-matched key, and when an
 * endpoint has no verified fixture.
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
    // Label text columns (products_catalog migrations 20260430000009, 20260527000006, 20260401000026) are business reference text.
    body: { products: [{
      id: 1, name: 'Synthetic Product', compatibility_notes: 'Do not tank-mix.', mixing_instructions: 'Fill the tank halfway.', ppe_text: 'Gloves and goggles.',
      pollinator_precautions: 'Avoid blooming weeds.', reentry_text: 'Keep off until dry.', irrigation_notes: 'Do not irrigate for 24 hours.',
      service_report_summary: 'Applied by hand.', reentry_summary: 'Dry in one hour.', customer_safety_summary: 'Keep pets off.',
      pet_kid_guidance_text: 'Wait until dry.', customer_precaution_summary: 'Stay indoors.', label_source_note: 'Label read.', rate_notes: ['Half rate in shade.'],
      public_summary: 'A lawn product.', portal_summary: 'Used on lawns.', post_application_watering: { mode: 'hold', hold_hours: 24, label_note: 'Wait one day.' },
    }] },
    content: {
      'products.0.compatibility_notes': 'Do not tank-mix.', 'products.0.mixing_instructions': 'Fill the tank halfway.',
      'products.0.ppe_text': 'Gloves and goggles.', 'products.0.pollinator_precautions': 'Avoid blooming weeds.',
      'products.0.reentry_text': 'Keep off until dry.', 'products.0.irrigation_notes': 'Do not irrigate for 24 hours.',
      'products.0.service_report_summary': 'Applied by hand.', 'products.0.reentry_summary': 'Dry in one hour.',
      'products.0.customer_safety_summary': 'Keep pets off.', 'products.0.pet_kid_guidance_text': 'Wait until dry.', 'products.0.customer_precaution_summary': 'Stay indoors.',
      'products.0.label_source_note': 'Label read.', 'products.0.public_summary': 'A lawn product.', 'products.0.portal_summary': 'Used on lawns.', 'products.0.post_application_watering.label_note': 'Wait one day.',
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
  // admin-protocols.js:783-784 `{ scripts }` = communication_scripts rows (`script`, `tone_notes`). The wrapper key `scripts`
  // is a name-match (the default would withhold the whole list), so it is declared content too.
  '/admin/protocols/scripts': {
    body: { scripts: [{ id: 1, title: 'Greeting', script: 'Say hello first.', tone_notes: 'Warm and brief.' }] },
    content: { 'scripts.0.script': 'Say hello first.', 'scripts.0.tone_notes': 'Warm and brief.' },
  },
  // ---- Round 10: the 20 rows that declared nothing. Each response was read end to end. ----
  // call-recording-processor.js:24897-24919 getStats returns counts and sourceBreakdown [{ number, count }].
  '/admin/call-recordings/stats': {
    body: { totalRecordings: 40, processed: 30, pending: 2, failed: 1, oldestUnfinishedMinutes: null, sourceBreakdown: [{ number: '+15555550101', count: 12 }] },
    kept: { totalRecordings: 40, 'sourceBreakdown.0.count': 12 },
  },
  // admin-communications.js:3766 `{ enabled }` (system_config boolean).
  '/admin/communications/ai-auto-reply-status': { body: { enabled: true }, kept: { enabled: true } },
  // csr-coach.js:685-698: csrStats[] (names and counts), lossReasons[{ reason, count, pct }] where `reason` is the
  // csrEnum loss_reason (csr-coach.js:224, a closed set), so it is system text. The wrapper key `lossReasons`
  // (csr-coach.js:692) is a name-match for the same reason, so both are declared content.
  '/admin/csr/overview': {
    body: { csrStats: [{ name: 'Office A', calls: 9, booked: 4, bookingRate: 44 }], teamTotals: { calls: 9, booked: 4 }, lossReasons: [{ reason: 'pricing', count: 3, pct: 60 }], period: '30d' },
    kept: { 'csrStats.0.name': 'Office A', 'teamTotals.calls': 9 },
    content: { 'lossReasons.0.reason': 'pricing' },
  },
  // admin-discounts.js:36 `{ enabled }`.
  '/admin/discounts/stacking': { body: { enabled: false }, kept: { enabled: false } },
  // admin-discounts.js:190-195 selects id, name, discount_key, times_applied, total_discount_given, is_active.
  '/admin/discounts/stats': {
    body: { discounts: [{ id: 1, name: 'Spring offer', discount_key: 'spring', times_applied: 3, total_discount_given: '30.00', is_active: true }], totalApplied: 3, totalGiven: 30 },
    kept: { 'discounts.0.name': 'Spring offer', totalGiven: 30 },
  },
  // admin-dispatch.js:7133 selects technicians.id, name, role; returned as { technicians }.
  '/admin/dispatch/technicians': {
    body: { technicians: [{ id: UUID, name: 'Tech A', role: 'technician' }] },
    kept: { 'technicians.0.name': 'Tech A', 'technicians.0.role': 'technician' },
  },
  // estimate-source-performance.js:255-262 `{ days, drafted, resolved, sources[] }`; buckets hold counts and source keys only.
  '/admin/estimates/source-performance': {
    body: { days: 90, drafted: 4, resolved: 2, sources: [{ source: 'web', drafted: 4, sent: 3, won: 1, winRatePct: 50, edits: { events: 2, sentUnedited: 1 } }] },
    kept: { drafted: 4, 'sources.0.source': 'web', 'sources.0.edits.events': 2 },
  },
  // invoice-attachments.js:156-160 selects id, invoice_id, file_name, mime_type, file_size_bytes, created_at.
  '/admin/invoices/:id/attachments': {
    params: { id: UUID },
    body: { attachments: [{ id: UUID, invoice_id: UUID, file_name: 'photo.jpg', mime_type: 'image/jpeg', file_size_bytes: 1200, created_at: '2026-10-01T00:00:00Z' }] },
    kept: { 'attachments.0.file_name': 'photo.jpg', 'attachments.0.mime_type': 'image/jpeg' },
  },
  // admin-invoices.js:2696-2703 customer_id, invoice_number, total, credit_applied, amount_due, balance.
  '/admin/invoices/:id/credit-context': {
    params: { id: UUID },
    body: { customer_id: UUID, invoice_number: 'INV-1001', total: 100, credit_applied: 0, amount_due: 100, balance: 25 },
    kept: { invoice_number: 'INV-1001', balance: 25 },
  },
  // invoice-address.js:5,67-70 ADDRESS_FIELDS only, returned as { address }.
  '/admin/invoices/:id/receipt-address': {
    params: { id: UUID },
    body: { address: { address_line1: '1 Example Way', address_line2: null, city: 'Sampletown', state: 'FL', zip: '34200' } },
    kept: { 'address.address_line1': '1 Example Way', 'address.city': 'Sampletown' },
  },
  // admin-invoices.js:592 selects id, first_name, last_name, phone, email, waveguard_tier, address_line1, city, property_type.
  '/admin/invoices/customers/search': {
    query: { q: 'sample' },
    body: { customers: [{ id: UUID, first_name: 'Sample', last_name: 'Person', phone: '+15555550102', email: 'sample@example.test', waveguard_tier: 'Gold', address_line1: '2 Example Way', city: 'Sampletown', property_type: 'single_family' }] },
    kept: { 'customers.0.first_name': 'Sample', 'customers.0.waveguard_tier': 'Gold' },
  },
  // admin-invoices.js:604-607 selects id, service_date, service_type, status, technicians.name as tech_name.
  '/admin/invoices/service-records/:customerId': {
    params: { customerId: UUID },
    body: { records: [{ id: UUID, service_date: '2026-10-01', service_type: 'Pest Control', status: 'completed', tech_name: 'Tech A' }] },
    kept: { 'records.0.service_type': 'Pest Control', 'records.0.status': 'completed' },
  },
  // invoice.js:13732-13740 getStats: counts, amounts and deposits { onHand, onHandCount, collected }.
  '/admin/invoices/stats': {
    body: { total: 10, paid: 6, outstanding: 4, overdue: 1, totalCollected: 600, totalOutstanding: 400, deposits: { onHand: 50, onHandCount: 1, collected: 0 } },
    kept: { total: 10, 'deposits.onHand': 50 },
  },
  // payer-ar.js:154-168 as_of, totals, buckets, by_terms { terms: { count, total } }, payers[{ payer_name, ... }].
  '/admin/payers/ar-aging': {
    body: { as_of: '2026-10-01', outstanding_total: 300, statement_count: 2, by_terms: { net_30: { count: 2, total: 300 } }, payers: [{ payer_id: 3, payer_name: 'Synthetic Payer LLC', outstanding_total: 300 }] },
    kept: { outstanding_total: 300, 'by_terms.net_30.count': 2, 'payers.0.payer_name': 'Synthetic Payer LLC' },
  },
  // admin-pricing-config.js:988-989 `{ rules }` = service_discount_rules rows (migration 20260414000011 line 177: text `notes`).
  // The Codex round 10 reproduction: the PUT (line 999) accepts arbitrary `notes`, so it can hold a pasted phrase.
  '/admin/pricing-config/discount-rules': {
    body: { rules: [{ id: 1, service_key: 'pest_control', tier_qualifier: true, max_discount_pct: null, flat_credit: null, exclude_from_pct_discount: false, notes: 'Vendor recovery phrase correct horse battery staple' }] },
    withheld: ['rules.0.notes'],
    kept: { 'rules.0.service_key': 'pest_control', 'rules.0.tier_qualifier': true },
  },
  // admin-pricing-config.js:892-898 `{ tracks: { track: [rows] } }`; columns are grass_track, sqft_bracket, tier, monthly_price.
  '/admin/pricing-config/lawn-brackets': {
    body: { tracks: { st_augustine: [{ id: 1, grass_track: 'st_augustine', sqft_bracket: 3000, tier: 'bronze', monthly_price: '35.00' }] } },
    kept: { 'tracks.st_augustine.0.tier': 'bronze', 'tracks.st_augustine.0.monthly_price': '35.00' },
  },
  // admin-protocols.js:771-772 `{ month, pests }` = seasonal_pest_index rows; description and treatment_if_found are business reference text.
  '/admin/protocols/seasonal-index': {
    query: { month: '10' },
    body: { month: 10, pests: [{ id: UUID, month: 10, service_line: 'pest', pest_name: 'Ants', pressure_level: 'high', description: 'Ants move indoors.', treatment_if_found: 'Bait and spot treat.', sort_order: 1 }] },
    kept: { 'pests.0.pest_name': 'Ants', 'pests.0.pressure_level': 'high' },
    content: { 'pests.0.description': 'Ants move indoors.', 'pests.0.treatment_if_found': 'Bait and spot treat.' },
  },
  // admin-route-scorecard.js:23 `{ enabled }`.
  '/admin/route-scorecard/status': { body: { enabled: true }, kept: { enabled: true } },
  // admin-schedule.js:23995-23998 `{ enabled, switchEnabled }`.
  '/admin/schedule/annual-prepay-availability': { body: { enabled: true, switchEnabled: false }, kept: { enabled: true, switchEnabled: false } },
  // admin-schedule.js:28489 `{ nextVisit: { id, date, serviceType } }`.
  '/admin/schedule/next-visit': {
    query: { customerId: UUID },
    body: { nextVisit: { id: UUID, date: '2026-10-20', serviceType: 'Pest Control' } },
    kept: { 'nextVisit.date': '2026-10-20', 'nextVisit.serviceType': 'Pest Control' },
  },
};

const getAt = (value, path) => path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), value);
const keyOf = path => path.split('.').pop();
const { isFreeTextName, FREE_TEXT_WORDS } = require('../utils/signed-link-redaction');
const MARKER = /^\[note withheld: \d+ characters\]$/;

// Every path in `value` whose string is a withheld marker.
function markerPaths(value, prefix = '') {
  if (typeof value === 'string') return MARKER.test(value) ? [prefix] : [];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => markerPaths(item, prefix ? `${prefix}.${key}` : key));
}

const READER = { fullAccess: true, isAdmin: true, staffAuthorization: AUTH };
const readOf = (endpoint, shape) => executeAdminReadTool('read_admin_data', {
  endpoint, ...(shape.params ? { params: shape.params } : {}), ...(shape.query ? { query: shape.query } : {}),
}, READER);

beforeEach(() => {
  process.env.GATE_IB_GENERAL_READ = 'true';
  process.env.GATE_IB_PLATFORM = 'true';
});

describe('every catalog endpoint has a verified response fixture', () => {
  // A fixture may stay for an endpoint the generator has dropped as stale (the documented
  // "regenerate and commit" repair must leave CI green), but it must still name a reviewed row.
  test('each admitted endpoint has a fixture and each fixture names a reviewed row', () => {
    const reviewedRows = new Set(require('../services/intelligence-bar/admin-read-reviewed.json').reviewed.map(row => row.endpoint));
    for (const entry of catalog.entries) expect(Object.keys(SHAPES)).toContain(entry.endpoint);
    for (const endpoint of Object.keys(SHAPES)) expect(reviewedRows.has(endpoint)).toBe(true);
  });

  test.each(catalog.entries.map(entry => [entry.endpoint, entry]))('%s: declared keys are in the fixture, and the fixture agrees with the kinds', (endpoint, entry) => {
    const shape = SHAPES[endpoint];
    const freeText = entry.freeText || {};
    const noteKeys = Object.keys(freeText).filter(key => freeText[key] === 'note');
    const contentKeys = Object.keys(freeText).filter(key => freeText[key] === 'content');
    // Every declared key must appear somewhere in the response fixture (a key that is not a response key withholds nothing).
    for (const key of Object.keys(freeText)) expect(JSON.stringify(shape.body)).toContain(`"${key}"`);
    // Every withheld key is a declared note or a key the default catches, and is not declared content.
    for (const path of shape.withheld || []) {
      const key = keyOf(path);
      expect(noteKeys.includes(key) || isFreeTextName(key)).toBe(true);
      expect(contentKeys).not.toContain(key);
    }
    // Every declared note key is withheld in the fixture.
    for (const key of noteKeys) expect((shape.withheld || []).map(keyOf)).toContain(key);
    // Every returned content path names a declared content key.
    for (const path of Object.keys(shape.content || {})) expect(contentKeys).toContain(keyOf(path));
    // A name-matched key that the fixture returns must be a declared content key.
    for (const path of [...Object.keys(shape.content || {}), ...Object.keys(shape.kept || {})]) {
      const key = keyOf(path);
      if (isFreeTextName(key)) expect(contentKeys).toContain(key);
    }
  });

  test.each(catalog.entries.map(entry => [entry.endpoint]))('%s: exactly the expected keys are withheld, the rest come back', async (endpoint) => {
    const shape = SHAPES[endpoint];
    global.fetch = jest.fn(async () => jsonResponse(shape.body));
    const result = await readOf(endpoint, shape);
    expect(result.status).toBe(200);
    const text = JSON.stringify(result);
    // The withheld set is exact: nothing else in the answer is a withheld marker.
    expect(markerPaths(result.data).sort()).toEqual([...(shape.withheld || [])].sort());
    for (const path of shape.withheld || []) {
      const original = getAt(shape.body, path);
      const length = typeof original === 'string' ? original.length : JSON.stringify(original).length;
      expect(getAt(result.data, path)).toBe(`[note withheld: ${length} characters]`);
    }
    for (const piece of FAKE_PIECES) expect(text).not.toContain(piece);
    for (const [path, value] of Object.entries(shape.kept || {})) expect(getAt(result.data, path)).toEqual(value);
    for (const [path, value] of Object.entries(shape.content || {})) expect(getAt(result.data, path)).toBe(value);
    if (shape.withheld && shape.withheld.length) expect(result.notes_withheld).toBe(shape.withheld.length);
    else expect(result).not.toHaveProperty('notes_withheld');
  });

  test('Codex round 10 reproduction: a recovery phrase in discount-rules notes never reaches the model', async () => {
    const shape = SHAPES['/admin/pricing-config/discount-rules'];
    global.fetch = jest.fn(async () => jsonResponse(shape.body));
    const result = await readOf('/admin/pricing-config/discount-rules', shape);
    const text = JSON.stringify(result);
    for (const piece of ['recovery phrase', 'correct horse', 'battery staple']) expect(text).not.toContain(piece);
    expect(result.data.rules[0].notes).toBe(`[note withheld: ${'Vendor recovery phrase correct horse battery staple'.length} characters]`);
    expect(result.notes_withheld).toBe(1);
  });
});

describe('the default withholds a name-matched key that no row declared', () => {
  const PHRASE = 'Vendor recovery phrase correct horse battery staple';
  const NO_DECLARATION = catalog.entries.find(entry => !entry.freeText && entry.params.length === 0 && entry.query.length === 0);
  const CONTENT_ENTRY = catalog.entries.find(entry => entry.params.length === 0 && entry.query.length === 0 && Object.values(entry.freeText || {}).includes('content'));
  const contentKey = Object.keys(CONTENT_ENTRY.freeText).find(key => CONTENT_ENTRY.freeText[key] === 'content');
  const run = async (entry, body) => {
    global.fetch = jest.fn(async () => jsonResponse(body));
    return executeAdminReadTool('read_admin_data', { endpoint: entry.endpoint }, READER);
  };

  test.each(['notes', 'adminNotes', 'special_instructions', 'Reason', 'details', 'message', 'description', 'body', 'summary', 'textColor'])('an undeclared "%s" on a row with no freeText is withheld', async (key) => {
    const result = await run(NO_DECLARATION, { id: 1, count: 4, nested: [{ [key]: PHRASE }] });
    expect(result.data.nested[0][key]).toBe(`[note withheld: ${PHRASE.length} characters]`);
    expect(result.notes_withheld).toBe(1);
    expect(JSON.stringify(result)).not.toContain('correct horse');
    expect(result.data.count).toBe(4);
    expect(result.note).toMatch(/Free-text notes are not read through this tool/);
  });

  test('objects and arrays under such a key are withheld whole; numbers, booleans, null and empty text are not counted', async () => {
    const result = await run(NO_DECLARATION, { details: { a: PHRASE }, notes: [PHRASE], reason: 3, comment: true, memo: null, remark: '', text: '   ', feedback: {} });
    expect(result.data.details).toBe(`[note withheld: ${JSON.stringify({ a: PHRASE }).length} characters]`);
    expect(result.data.notes).toBe(`[note withheld: ${JSON.stringify([PHRASE]).length} characters]`);
    expect(result.data).toMatchObject({ reason: 3, comment: true, memo: null, remark: '', text: '   ', feedback: {} });
    expect(result.notes_withheld).toBe(2);
  });

  test('a key outside the name list is not withheld by the default (it depends on review)', async () => {
    const result = await run(NO_DECLARATION, { label: 'Front gate', status: 'open', direction: 'north' });
    expect(result.data).toEqual({ label: 'Front gate', status: 'open', direction: 'north' });
    expect(result).not.toHaveProperty('notes_withheld');
  });

  test('a declared content key with a name-matched name is returned, and still scrubbed', async () => {
    const withLink = `Rinse the sprayer. See https://portal.example.test/p?session=${'abc' + '123'} and the ${'portal pass' + 'word is swords' + 'fish'}.`;
    const result = await run(CONTENT_ENTRY, { [contentKey]: withLink, other_notes: PHRASE });
    expect(isFreeTextName(contentKey) || contentKey).toBeTruthy();
    expect(result.data[contentKey]).toContain('Rinse the sprayer.');
    expect(result.data[contentKey]).not.toContain('abc' + '123');
    expect(result.data[contentKey]).not.toContain('swords' + 'fish');
    // a different name-matched key on the same row, not declared content, is still withheld
    expect(result.data.other_notes).toBe(`[note withheld: ${PHRASE.length} characters]`);
  });

  test('the name list is one exported constant and covers the owner list', () => {
    for (const word of ['note', 'notes', 'comment', 'comments', 'reason', 'instruction', 'instructions', 'detail', 'details', 'memo', 'remark', 'remarks', 'message', 'description', 'text', 'body', 'summary', 'script', 'feedback', 'explanation', 'directions', 'special']) {
      expect(FREE_TEXT_WORDS).toContain(word);
    }
    expect(Object.isFrozen(FREE_TEXT_WORDS)).toBe(true);
  });
});
