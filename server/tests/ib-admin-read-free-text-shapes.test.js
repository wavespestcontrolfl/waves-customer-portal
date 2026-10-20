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
  },  // ---- Core screens and leads. Free text stays withheld exactly as on every other row: a note-like key name by the
  // default, and the keys a name would not catch (leadSourceDetail, preview, service_interest, extracted_data ...) by a
  // reviewed "note" declaration. Projected (omit) keys never reach the model. ----
  // admin-customers.js:2483 (handler), 1249 mapCustomerListRow: an explicit field list per customer, plus counts and filter lists.
  '/admin/customers': {
    body: {
      customers: [{
        id: UUID, firstName: 'Sample', lastName: 'Person', accountId: UUID, profileLabel: 'Home', isPrimaryProfile: true, email: 'sample@example.test',
        phone: '+15555550103', city: 'Sampletown', address: '2 Example Way, Sampletown, FL 34200', tier: 'Gold', monthlyRate: 89, pipelineStage: 'active_customer',
        leadSource: 'google', leadSourceDetail: PASSWORD_NOTE, balanceOwed: 0, tags: ['vip'], cardsOnFile: 1, propertyCount: 1,
      }],
      total: 1, page: 1, limit: 100, totalPages: 1, pipelineCounts: { active_customer: 1 }, filters: { tags: ['vip'], sources: ['google'], areas: ['Sampletown'] },
    },
    withheld: ['customers.0.leadSourceDetail'],
    kept: { 'customers.0.firstName': 'Sample', 'customers.0.tier': 'Gold', 'customers.0.balanceOwed': 0, total: 1, 'filters.areas': ['Sampletown'] },
  },
  // admin-customers.js:2887 -> customer-history.js:321 listCustomerTimeline: { timeline[{ id, type, title, description, date, metadata }], ... }.
  '/admin/customers/:id/timeline': {
    params: { id: UUID },
    body: { timeline: [{ id: 'sms:1', type: 'sms', title: 'SMS received', description: PASSWORD_NOTE, date: '2026-10-01T12:00:00Z', metadata: { direction: 'inbound' } }], missingSources: [], limit: 50, type: 'all', search: '', hasMore: false, nextCursor: null },
    withheld: ['timeline.0.description'],
    kept: { 'timeline.0.title': 'SMS received', limit: 50, hasMore: false },
  },
  // admin-customers.js:2925 -> customer-history.js:403 listCustomerComms; mapCommsMessage (:358) builds each message.
  // readScope and composerComms (:519) are omitted by the row.
  '/admin/customers/:id/comms': {
    params: { id: UUID },
    body: {
      comms: [{ id: UUID, channel: 'sms', direction: 'inbound', body: PASSWORD_NOTE, aiSummary: LINK_NOTE, media: [], deliveryStatus: 'received', createdAt: '2026-10-01T12:00:00Z', contactPhone: '+15555550103' }],
      composerComms: [{ id: UUID, channel: 'sms', direction: 'inbound', body: 'DUPLICATE-ROW-BODY' }],
      total: 1, limit: 100, channel: 'all', hasMore: false, nextCursor: null, readScope: { conversationIds: [UUID], readBefore: '2026-10-01T12:00:00Z' },
    },
    withheld: ['comms.0.body', 'comms.0.aiSummary'],
    omitted: ['composerComms', 'readScope'],
    kept: { 'comms.0.direction': 'inbound', total: 1, channel: 'all' },
  },
  // admin-customers.js:3119-3191: { customer (explicit columns), estimates (id, status, token, ...), stats, lastContact }.
  '/admin/customers/:id/estimates-summary': {
    params: { id: UUID },
    body: {
      customer: { id: UUID, first_name: 'Sample', last_name: 'Person', waveguard_tier: 'Gold' },
      estimates: [{ id: UUID, status: 'sent', token: 'TOKEN-PLACEHOLDER-0001', service_interest: 'Pest control', decline_reason: PASSWORD_NOTE, monthly_total: '59.00' }],
      stats: { total: 1, accepted: 0, declined: 0, open: 1, conversionRate: null }, lastContact: { channel: 'sms', direction: 'inbound', at: '2026-10-01T12:00:00Z', preview: LINK_NOTE },
    },
    withheld: ['estimates.0.decline_reason', 'lastContact.preview'],
    omitted: ['estimates.0.token'],
    kept: { 'estimates.0.status': 'sent', 'stats.open': 1, 'customer.waveguard_tier': 'Gold' },
  },
  // admin-customers.js:2652-2677: { cards[{ id, method_type, brand, last_four, exp_month, exp_year, bank_name, is_default }] }; no Stripe id is mapped.
  '/admin/customers/:id/cards': {
    params: { id: UUID },
    body: { cards: [{ id: UUID, method_type: 'card', brand: 'visa', last_four: '4242', exp_month: 12, exp_year: 2030, bank_name: null, is_default: true }] },
    kept: { 'cards.0.brand': 'visa', 'cards.0.last_four': '4242', 'cards.0.is_default': true },
  },
  // admin-customers.js:3215-3222: { service: { id, serviceType, scheduledDate, status } | null }.
  '/admin/customers/:id/latest-scheduled-service': {
    params: { id: UUID },
    body: { service: { id: UUID, serviceType: 'Pest Control', scheduledDate: '2026-10-20', status: 'confirmed' } },
    kept: { 'service.serviceType': 'Pest Control', 'service.status': 'confirmed' },
  },
  // admin-customers.js:2742 -> collection-hold-admin.js:17 listCollectionHolds: { holds[{ id, flag, reason, created_by, created_at, stops_charges }] }.
  '/admin/customers/:id/collection-holds': {
    params: { id: UUID },
    body: { holds: [{ id: UUID, flag: 'collection_hold', reason: PASSWORD_NOTE, created_by: 'Office', created_at: '2026-10-01T00:00:00Z', stops_charges: false }] },
    withheld: ['holds.0.reason'],
    kept: { 'holds.0.flag': 'collection_hold', 'holds.0.stops_charges': false },
  },
  // admin-customers.js:5440-5470: { credit: { amount, estimateId, estimateSlug, payerBilled } | null }.
  '/admin/customers/:id/deposit-credit': {
    params: { id: UUID },
    body: { credit: { amount: 50, estimateId: UUID, estimateSlug: 'sample-estimate', payerBilled: false } },
    kept: { 'credit.amount': 50, 'credit.payerBilled': false },
  },
  // admin-schedule.js:10338 (handler), :10470-10530 map: { services[], total, page, pageSize, totalPages }; explicit fields, no notes column.
  '/admin/schedule/list': {
    query: { from: '2026-10-14', to: '2026-10-14' },
    body: {
      services: [{ id: UUID, customerId: UUID, customerName: 'Sample Person', scheduledDate: '2026-10-14', serviceType: 'Pest Control', status: 'confirmed', windowStart: '09:00', windowEnd: '11:00', technicianName: 'Tech A', address: '2 Example Way', city: 'Sampletown', prepaidAmount: null, isRecurring: true }],
      total: 1, page: 1, pageSize: 25, totalPages: 1,
    },
    kept: { 'services.0.serviceType': 'Pest Control', 'services.0.technicianName': 'Tech A', total: 1, pageSize: 25 },
  },
  // admin-dispatch.js:6548-6660: { techs[{ id, name, avatar_url (presigned S3), role, status, lat, lng, ... }], jobs[{ id, customer_name, address, ... }] }.
  '/admin/dispatch/board': {
    body: {
      techs: [{ id: UUID, name: 'Tech A', avatar_url: 'https://bucket.s3.amazonaws.com/tech.jpg?X-Amz-Signature=PLACEHOLDERSIG0001', role: 'technician', status: 'idle', lat: 27.5, lng: -82.5, today_total: 3, today_completed: 1, out_today: false }],
      jobs: [{ id: UUID, technician_id: UUID, customer_id: UUID, customer_name: 'Sample P.', address: '2 Example Way, Sampletown, FL 34200', status: 'confirmed', service_type: 'Pest Control', window_start: '09:00', window_end: '11:00' }],
    },
    omitted: ['techs.0.avatar_url'],
    kept: { 'techs.0.name': 'Tech A', 'techs.0.today_total': 3, 'jobs.0.customer_name': 'Sample P.' },
  },
  // admin-dispatch.js:6721-6800: one job, explicit fields; notes and internal_notes are free text.
  '/admin/dispatch/jobs/:id': {
    params: { id: UUID },
    body: { id: UUID, customer_id: UUID, customer_first_name: 'Sample', customer_last_name: 'Person', customer_phone: '+15555550103', address: '2 Example Way, Sampletown, FL 34200', status: 'confirmed', service_type: 'Pest Control', scheduled_date: '2026-10-14', window_start: '09:00', window_end: '11:00', notes: PASSWORD_NOTE, internal_notes: LINK_NOTE },
    withheld: ['notes', 'internal_notes'],
    kept: { status: 'confirmed', service_type: 'Pest Control', customer_last_name: 'Person' },
  },
  // admin-dispatch.js:6817-6900: one technician and today's route.
  '/admin/dispatch/techs/:id': {
    params: { id: UUID },
    body: { id: UUID, name: 'Tech A', role: 'technician', phone: '+15555550104', status: 'idle', current_job_id: null, today: { scheduled_date: '2026-10-14', completed: 1, total: 3, late_count: 0 }, route: [{ job_id: UUID, customer_first_name: 'Sample', customer_last_name: 'Person', address: '2 Example Way', service_type: 'Pest Control', status: 'confirmed' }] },
    kept: { name: 'Tech A', 'today.total': 3, 'route.0.status': 'confirmed' },
  },
  // admin-dispatch.js:6935-7010: { alerts[{ id, type, severity, tech_name, job_id, address, payload, ... }] }; payload is system-written.
  '/admin/dispatch/alerts': {
    body: { alerts: [{ id: UUID, type: 'tech_late', severity: 'warning', tech_id: UUID, tech_name: 'Tech A', job_id: UUID, address: '2 Example Way', payload: { minutes_late: 12 }, created_at: '2026-10-14T13:00:00Z', resolved_at: null }] },
    kept: { 'alerts.0.type': 'tech_late', 'alerts.0.payload.minutes_late': 12 },
  },
  // admin-estimates.js:3791 (handler), :4000-4130 map: { estimates[{ id, status, customerName, ..., notes, declineReason, dispositionNote, token, agentDraftReview }], truncated }.
  '/admin/estimates': {
    body: {
      estimates: [{
        id: UUID, status: 'sent', customerName: 'Sample Person', customerId: UUID, monthlyTotal: 59, onetimeTotal: 0, tier: 'Gold', sentAt: '2026-10-01T00:00:00Z', viewCount: 2, source: 'manual',
        leadSourceDetail: PASSWORD_NOTE, description: LINK_NOTE, notes: PASSWORD_NOTE, declineReason: LINK_NOTE, dispositionNote: PASSWORD_NOTE, token: 'TOKEN-PLACEHOLDER-0002',
        estimatorEngine: { lane: 'review', laneReasons: ['new customer'], reviewNotes: LINK_NOTE, marginWarnings: [] },
        agentDraftReview: { reasoning: PASSWORD_NOTE, assumptions: [LINK_NOTE], uncertainty: [PASSWORD_NOTE], sqftSource: 'measured', unverifiedLineCount: 0 },
      }],
      truncated: false,
    },
    withheld: [
      'estimates.0.leadSourceDetail', 'estimates.0.description', 'estimates.0.notes', 'estimates.0.declineReason', 'estimates.0.dispositionNote',
      'estimates.0.estimatorEngine.laneReasons', 'estimates.0.estimatorEngine.reviewNotes', 'estimates.0.agentDraftReview.reasoning', 'estimates.0.agentDraftReview.assumptions', 'estimates.0.agentDraftReview.uncertainty',
    ],
    omitted: ['estimates.0.token'],
    kept: { 'estimates.0.status': 'sent', 'estimates.0.monthlyTotal': 59, 'estimates.0.estimatorEngine.lane': 'review', truncated: false },
  },
  // admin-invoices.js:540 -> invoice.js:10029 list: invoices.* plus customer fields, card_on_file, active_payment_plan.
  '/admin/invoices': {
    query: { customer_id: UUID },
    body: {
      invoices: [{
        id: UUID, invoice_number: 'INV-2001', customer_id: UUID, status: 'sent', total: '120.00', notes: PASSWORD_NOTE, title: 'Quarterly service',
        token: 'TOKEN-PLACEHOLDER-0003', send_claim_token: 'CLAIM-PLACEHOLDER-0001', stripe_payment_intent_id: 'pi_PLACEHOLDER0001', stripe_charge_id: 'ch_PLACEHOLDER0001',
        receipt_url: 'https://pay.example.test/receipts/PLACEHOLDER', first_name: 'Sample', card_on_file: { brand: 'visa', last_four: '4242' }, review_hold: false,
      }],
      total: 1, page: 1,
    },
    withheld: ['invoices.0.notes'],
    omitted: ['invoices.0.token', 'invoices.0.send_claim_token', 'invoices.0.stripe_payment_intent_id', 'invoices.0.stripe_charge_id', 'invoices.0.receipt_url'],
    kept: { 'invoices.0.invoice_number': 'INV-2001', 'invoices.0.status': 'sent', 'invoices.0.card_on_file.last_four': '4242', total: 1 },
  },
  // admin-invoices.js:874 -> invoice.js:9973 getById: invoices.* + customer + active_payment_plan + annual_prepay(_term).
  '/admin/invoices/:id': {
    params: { id: UUID },
    body: {
      id: UUID, invoice_number: 'INV-2001', customer_id: UUID, status: 'sent', total: '120.00', notes: PASSWORD_NOTE, line_items: [{ description: LINK_NOTE, amount: 120 }],
      token: 'TOKEN-PLACEHOLDER-0004', send_claim_token: 'CLAIM-PLACEHOLDER-0002', stripe_payment_intent_id: 'pi_PLACEHOLDER0002', stripe_charge_id: 'ch_PLACEHOLDER0002',
      receipt_url: 'https://pay.example.test/receipts/PLACEHOLDER2', customer: { first_name: 'Sample', last_name: 'Person', card_on_file: { brand: 'visa', last_four: '4242' } }, active_payment_plan: null, suggested_coverage: null,
    },
    withheld: ['notes', 'line_items.0.description'],
    omitted: ['token', 'send_claim_token', 'stripe_payment_intent_id', 'stripe_charge_id', 'receipt_url'],
    kept: { invoice_number: 'INV-2001', status: 'sent', 'line_items.0.amount': 120, 'customer.card_on_file.last_four': '4242' },
  },
  // admin-invoices.js:429-480 getInvoiceDeliveryRecipients: explicit fields.
  '/admin/invoices/:id/recipients': {
    params: { id: UUID },
    body: { invoiceId: UUID, invoiceNumber: 'INV-2001', customerId: UUID, customerName: 'Sample Person', primaryContact: { name: 'Sample Person', email: 'sample@example.test', phone: '+15555550103', role: 'primary' }, smsRecipient: { name: 'Sample Person', phone: '+15555550103', role: 'primary' }, emailRecipient: { email: 'sample@example.test', name: 'Sample Person', role: 'primary' }, billingPreference: { name: '', email: '' } },
    kept: { invoiceNumber: 'INV-2001', 'primaryContact.role': 'primary' },
  },
  // admin-leads.js:727 (handler): { leads[leads.* + source_name, source_type, source_channel, estimate_status, assigned_name], total, page, limit, consultationLinksEnabled }.
  '/admin/leads': {
    query: { status: 'open', limit: 25 },
    body: {
      leads: [{
        id: UUID, first_name: 'Sample', last_name: 'Person', phone: '+15555550105', email: 'lead@example.test', status: 'new', lead_type: 'call',
        service_interest: PASSWORD_NOTE, transcript_summary: LINK_NOTE, extracted_data: { wants: 'quarterly pest control' }, source_name: 'Website', source_channel: 'organic', estimate_status: null, assigned_name: 'Tech A',
        call_recording_url: 'https://api.example.test/recordings/PLACEHOLDERREC1', anon_id: 'ANON-PLACEHOLDER-1', gclid: 'GCLID-PLACEHOLDER-1',
      }],
      total: 1, page: 1, limit: 25, consultationLinksEnabled: false,
    },
    withheld: ['leads.0.service_interest', 'leads.0.transcript_summary', 'leads.0.extracted_data'],
    omitted: ['leads.0.call_recording_url', 'leads.0.anon_id', 'leads.0.gclid'],
    kept: { 'leads.0.status': 'new', 'leads.0.source_name': 'Website', total: 1, limit: 25 },
  },
  // admin-leads.js:929-1100: { lead (leads.* + source and assigned name), activities[], calls[] }; the raw recording URL stays server-side in calls.
  '/admin/leads/:id': {
    params: { id: UUID },
    body: {
      lead: { id: UUID, first_name: 'Sample', status: 'contacted', service_interest: PASSWORD_NOTE, transcript_summary: LINK_NOTE, extracted_data: { wants: 'quarterly pest control' }, source_name: 'Website', assigned_name: 'Tech A', call_recording_url: 'https://api.example.test/recordings/PLACEHOLDERREC2', anon_id: 'ANON-PLACEHOLDER-2', gclid: 'GCLID-PLACEHOLDER-2' },
      activities: [{ id: 1, lead_id: UUID, activity_type: 'created', description: PASSWORD_NOTE, performed_by: 'Office', metadata: { from: 'web form' }, created_at: '2026-10-01T00:00:00Z' }],
      calls: [{ id: UUID, direction: 'inbound', duration_seconds: 120, recording_sid: 'RE00000000000000000000000000000001', has_recording: true, transcription: LINK_NOTE, transcription_status: 'completed', created_at: '2026-10-01T00:00:00Z' }],
    },
    withheld: ['lead.service_interest', 'lead.transcript_summary', 'lead.extracted_data', 'activities.0.description', 'activities.0.metadata', 'calls.0.transcription', 'calls.0.transcription_status'],
    omitted: ['lead.call_recording_url', 'lead.anon_id', 'lead.gclid'],
    kept: { 'lead.status': 'contacted', 'activities.0.activity_type': 'created', 'calls.0.has_recording': true, 'calls.0.duration_seconds': 120 },
  },
  // admin-leads.js:168-262: one object of counts, times and totals; no lead row.
  '/admin/leads/analytics/overview': {
    query: { start_date: '2026-10-01', end_date: '2026-10-13' },
    body: { total: 12, won: 3, lost: 2, active: 7, conversionRate: 25, medianResponseTime: 14, avgSpeedToLead: null, openUnansweredCount: 0, costTotal: 300, revenue: 900, cpa: 100, roi: 200, startDate: '2026-10-01T04:00:00Z', endDate: '2026-10-13T03:59:59Z' },
    kept: { total: 12, won: 3, conversionRate: 25, roi: 200 },
  },
  // admin-leads.js:288-301 -> lead-attribution.js:594-607: { sources[{ source (lead_sources row), totalLeads, conversions, ... }] }.
  '/admin/leads/analytics/by-source': {
    query: { start_date: '2026-10-01', end_date: '2026-10-13' },
    body: { sources: [{ source: { id: UUID, name: 'Website', source_type: 'organic', channel: 'organic', is_active: true, notes: PASSWORD_NOTE }, totalLeads: 12, conversions: 3, conversionRate: 25, totalCost: 300, totalRevenue: 900, costPerLead: 25, roi: 200 }] },
    withheld: ['sources.0.source.notes'],
    kept: { 'sources.0.source.name': 'Website', 'sources.0.totalLeads': 12, 'sources.0.roi': 200 },
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
    // A projected (omit) key is gone with its value, and the reader is told it is left out by design.
    for (const path of shape.omitted || []) {
      expect(getAt(result.data, path)).toBeUndefined();
      expect(getAt(shape.body, path)).toBeDefined();
    }
    expect(text).not.toMatch(/PLACEHOLDER|DUPLICATE-ROW-BODY/);
    if (shape.omitted) expect(result.note).toMatch(/Left out of this read by design/);
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
