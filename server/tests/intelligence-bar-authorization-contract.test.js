/**
 * W0B authorization contract — unit invariants:
 *  1. Tier mirrors the write-gate taxonomy (never a second taxonomy).
 *  2. Effects are built ONLY from curated display params + proposal pins;
 *     `_`-prefixed internals never surface; before/after rides the pins.
 *  3. Customer-contact and irreversibility flags are deterministic per tool
 *     (move_stops_to_day depends on notify_customers).
 *  4. The hash is stable across key order and changes with any effect.
 */

const {
  buildContract, contractHash, tierFor, CONTRACT_VERSION,
} = require('../services/intelligence-bar/authorization-contract');
const gates = require('../services/intelligence-bar/write-gates');

test('tier mirrors write-gates: two-step/legacy-bare = yellow, confirmed-endpoint = red, reads = green', () => {
  for (const n of gates.WRITE_TWO_STEP_TOOL_NAMES) expect(tierFor(n)).toBe('yellow');
  for (const n of gates.LEGACY_BARE_WRITE_TOOL_NAMES) expect(tierFor(n)).toBe('yellow');
  for (const n of gates.CONFIRMED_ENDPOINT_WRITE_TOOL_NAMES) expect(tierFor(n)).toBe('red');
  expect(tierFor('query_customers')).toBe('green');
});

test('send_sms: pinned recipient becomes a comms effect, internals hidden, irreversible + notifies', () => {
  const c = buildContract({
    toolName: 'send_sms',
    params: { customer_id: 'c1', customer_name: 'acct-1042', phone: '+19415550000', message: 'On my way', _require_phone_match: true },
    displayParams: { customer_id: 'c1', customer_name: 'acct-1042', message: 'On my way', recipient: 'acct-1042 (…0000)', _require_phone_match: true },
    preview: { pinned_recipient: { customer_id: 'c1', name: 'acct-1042', phone_last4: '0000' } },
    summary: 'send_sms — message: On my way',
  });
  expect(c.version).toBe(CONTRACT_VERSION);
  expect(c.tier).toBe('yellow');
  expect(c.action_label).toBe('Send a text message');
  expect(c.irreversible).toBe(true);
  expect(c.notifies_customer).toBe(true);
  expect(c.effects).toContainEqual({ kind: 'comms', label: 'Text acct-1042 (…0000)' });
  expect(c.effects.some((e) => e.label.includes('require phone match'))).toBe(false);
  expect(c.effects.some((e) => e.label === 'Customer will be contacted')).toBe(true);
});

test('update_lead_status: before/after from the pinned lead', () => {
  const c = buildContract({
    toolName: 'update_lead_status',
    params: { lead_id: 'l1', new_status: 'won', _expected_status: 'contacted' },
    displayParams: { lead_id: 'l1', new_status: 'won', lead: 'acct-2077 — contacted → won' },
    preview: { pinned_lead: { id: 'l1', name: 'acct-2077', current_status: 'contacted' } },
  });
  expect(c.effects).toContainEqual({
    kind: 'customer', label: 'Lead acct-2077: status contacted → won', before: 'contacted', after: 'won',
  });
  expect(c.irreversible).toBe(false);
  expect(c.notifies_customer).toBe(false);
});

test('move_stops_to_day: customer contact only when notify_customers is true', () => {
  const silent = buildContract({ toolName: 'move_stops_to_day', params: { target_date: '2026-09-02' }, displayParams: { target_date: '2026-09-02', notify_customers: false } });
  const loud = buildContract({ toolName: 'move_stops_to_day', params: { target_date: '2026-09-02', notify_customers: true }, displayParams: { target_date: '2026-09-02', notify_customers: true } });
  expect(silent.notifies_customer).toBe(false);
  expect(silent.effects.some((e) => e.label === 'Customer will be contacted')).toBe(false);
  expect(loud.notifies_customer).toBe(true);
  expect(loud.effects.some((e) => e.label === 'Customer will be contacted')).toBe(true);
});

test('nested display params flatten one level; arrays join; undefined dropped; null in updates renders as a clear', () => {
  const c = buildContract({
    toolName: 'update_customer',
    params: {},
    displayParams: { customer_id: 'c9', updates: { email: 'x@example.test', notes: null }, tags: ['a', 'b'], skip: undefined },
  });
  const labels = c.effects.map((e) => e.label);
  // Canonical order: comms → billing → customer → operational, then label.
  expect(labels).toEqual(['email: x@example.test', 'customer id: c9', 'notes: (cleared)', 'tags: a, b']);
  expect(c.effects.find((e) => e.label.startsWith('email'))?.kind).toBe('comms');
});

test('nested structures are described in full, never dropped (estimate draft services)', () => {
  const c = buildContract({
    toolName: 'create_pending_estimate',
    params: {},
    displayParams: {
      customerName: 'acct-3001',
      engineInputs: { services: { pest_quarterly: { tier: 'silver' }, lawn: { sqft: 4200 } }, _internal: 'x' },
      lineItems: [{ name: 'Setup', amount: 99 }, { name: 'Mosquito', amount: 60 }],
    },
  });
  const labels = c.effects.map((e) => e.label);
  expect(labels).toContainEqual('services: { pest quarterly: { tier: silver }; lawn: { sqft: 4200 } }');
  expect(labels).toContainEqual('line items: { name: Setup; amount: 99 }, { name: Mosquito; amount: 60 }');
  expect(labels.some((l) => l.includes('internal'))).toBe(false);
  expect(c.tier).toBe('yellow');
});

test('update_customer email/name/phone changes carry the mandatory fan-out disclosures as effects', () => {
  const { EMAIL_FANOUT_DISCLOSURE } = require('../services/customer-email-fanout');
  const { CONTACT_FANOUT_DISCLOSURE } = require('../services/customer-contact-fanout');
  const c = buildContract({
    toolName: 'update_customer',
    params: { customer_id: 'c9', updates: { email: 'x@example.test', phone: '9415550000' } },
    displayParams: { customer_id: 'c9', updates: { email: 'x@example.test', phone: '9415550000' } },
  });
  const labels = c.effects.map((e) => e.label);
  expect(labels).toContainEqual(EMAIL_FANOUT_DISCLOSURE);
  expect(labels).toContainEqual(CONTACT_FANOUT_DISCLOSURE);
  const only = buildContract({ toolName: 'update_customer', params: { updates: { notes: 'gate code 1234' } }, displayParams: { updates: { notes: 'gate code 1234' } } });
  expect(only.effects.map((e) => e.label)).not.toContainEqual(EMAIL_FANOUT_DISCLOSURE);
});

test('bulk_update_customers with an email change discloses the per-customer email fan-out (email only)', () => {
  const { EMAIL_FANOUT_DISCLOSURE } = require('../services/customer-email-fanout');
  const { CONTACT_FANOUT_DISCLOSURE } = require('../services/customer-contact-fanout');
  const c = buildContract({
    toolName: 'bulk_update_customers',
    params: { customer_ids: ['a', 'b', 'c'], updates: { email: 'x@example.test', phone: '9415550000' } },
    displayParams: { customer_ids: ['a', 'b', 'c'], updates: { email: 'x@example.test', phone: '9415550000' } },
  });
  const labels = c.effects.map((e) => e.label);
  expect(labels).toContainEqual(`For each of 3 customers: ${EMAIL_FANOUT_DISCLOSURE}`);
  expect(labels.some((l) => l.includes(CONTACT_FANOUT_DISCLOSURE))).toBe(false);
});

test('two-step previews surface their resolved facts as effects (capped) and fingerprint exactly', () => {
  const { previewFingerprint } = require('../services/intelligence-bar/authorization-contract');
  const preview = {
    preview: true, product: 'Termidor SC 20oz', current_stock: 4, new_stock: 2, would_adjust: -2,
    generated_at: '2026-08-31T03:00:00Z', _internal: 'x',
  };
  const c = buildContract({ toolName: 'adjust_stock', params: { sku: 'T-20', delta: -2 }, displayParams: { sku: 'T-20', delta: -2 }, preview });
  const labels = c.effects.map((e) => e.label);
  expect(labels).toContainEqual('product: Termidor SC 20oz');
  expect(labels).toContainEqual('current stock: 4');
  expect(labels).toContainEqual('new stock: 2');
  expect(labels.some((l) => /generated at|internal/.test(l))).toBe(false);

  const fp = previewFingerprint(preview);
  expect(previewFingerprint({ ...preview, generated_at: 'later', _internal: 'y' })).toBe(fp); // volatile/internal ignored
  expect(previewFingerprint({ ...preview, new_stock: 1 })).not.toBe(fp); // real drift moves it
  expect(previewFingerprint({ ...preview, product: 'Termidor SC 78oz' })).not.toBe(fp);

  // Many-field previews are capped on the card but still pinned exactly.
  const big = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`stop_${i}`, `addr ${i}`]));
  const c2 = buildContract({ toolName: 'optimize_all_routes', params: {}, displayParams: {}, preview: big });
  expect(c2.effects.filter((e) => e.label.startsWith('stop ')).length).toBe(12);
  expect(c2.effects.map((e) => e.label)).toContainEqual(expect.stringMatching(/^\(\+8 more — see "Show more"/));
  // Nothing is concealed: the overflow rides in full under more_effects.
  expect(c2.more_effects.map((e) => e.label)).toEqual(Array.from({ length: 8 }, (_, i) => `stop ${i + 12}: addr ${i + 12}`));
  // The cap is presentation only: a plan differing ONLY beyond the visible
  // lines still yields a different contract hash.
  const c3 = buildContract({ toolName: 'optimize_all_routes', params: {}, displayParams: {}, preview: { ...big, stop_19: 'addr 99' } });
  expect(c3.effects.map((e) => e.label)).toEqual(c2.effects.map((e) => e.label));
  expect(contractHash(c3)).not.toBe(contractHash(c2));
  expect(c2.preview_fingerprint).toBe(previewFingerprint(big));
});

test('schedule moves/cancels are NOT marked as contacting the customer; sends and bookings are', () => {
  expect(buildContract({ toolName: 'reschedule_appointment', params: {}, displayParams: {} }).notifies_customer).toBe(false);
  expect(buildContract({ toolName: 'cancel_appointment', params: {}, displayParams: {} }).notifies_customer).toBe(false);
  expect(buildContract({ toolName: 'trigger_review_request', params: {}, displayParams: {} }).notifies_customer).toBe(true);
  expect(buildContract({ toolName: 'create_appointment', params: {}, displayParams: {} }).notifies_customer).toBe(false);
});

test('create_appointment: card bookings are credit-free by construction; reminders register for later (no text now)', () => {
  const c = buildContract({ toolName: 'create_appointment', params: { customer_id: 'c1' }, displayParams: { customer_id: 'c1', date: '2026-09-02' }, preview: { proposal: true, inspection_credit: { amount: 0 } } });
  const labels = c.effects.map((e) => e.label);
  expect(labels).toContainEqual(expect.stringMatching(/^No inspection credit is redeemed by this booking/));
  expect(labels).toContainEqual(expect.stringMatching(/reminder rows .*no confirmation text is sent now/));
  expect(c.notifies_customer).toBe(false);
});

test('dynamic legacy jobs disclose launch, spend, variable writes, and internal comms explicitly', () => {
  const price = buildContract({ toolName: 'run_price_lookup', params: { product: 'Termidor' }, displayParams: { product: 'Termidor' } });
  expect(price.effects.map((e) => e.label)).toContainEqual(expect.stringMatching(/paid web-search/));
  expect(price.effects.map((e) => e.label)).toContainEqual(expect.stringMatching(/price_approvals/));
  const tax = buildContract({ toolName: 'run_tax_advisor', params: {}, displayParams: {} });
  expect(tax.effects.length).toBeGreaterThanOrEqual(2);
  expect(tax.effects.find((e) => e.kind === 'comms').label).toMatch(/internal alert, not a customer message/);
});

test('reschedule_appointment: pinned visit identity/state becomes a before/after effect and binds the hash', () => {
  const pinned = { id: 'ap1', status: 'scheduled', scheduled_date: '2026-09-02', time_window: '8-10', technician_id: 't1', service_type: 'Quarterly Pest', customer_name: 'acct-3001' };
  const c = buildContract({
    toolName: 'reschedule_appointment',
    params: { appointment_id: 'ap1', new_date: '2026-09-04', new_time_window: '10-12', _appointment_fingerprint: 'x' },
    displayParams: { appointment_id: 'ap1', new_date: '2026-09-04', new_time_window: '10-12', appointment: 'Quarterly Pest — acct-3001 on 2026-09-02 8-10 (scheduled)' },
    preview: { pinned_appointment: pinned },
  });
  expect(c.effects).toContainEqual({
    kind: 'operational', label: 'Move Quarterly Pest for acct-3001 (scheduled) from 2026-09-02 8-10 → 2026-09-04 10-12', before: '2026-09-02 8-10', after: '2026-09-04 10-12',
  });
  expect(c.pinned_appointment).toEqual(pinned);
  const moved = buildContract({ toolName: 'reschedule_appointment', params: { appointment_id: 'ap1', new_date: '2026-09-04' }, displayParams: {}, preview: { pinned_appointment: { ...pinned, scheduled_date: '2026-09-03' } } });
  expect(contractHash(moved)).not.toBe(contractHash(c));
});

test('bulk_update_leads: full name list under more_effects and a fingerprint of every pinned id', () => {
  const ids = ['l3', 'l1', 'l2'];
  const c = buildContract({
    toolName: 'bulk_update_leads',
    params: { lead_ids: ids, current_status: 'new', new_status: 'lost' },
    displayParams: { current_status: 'new', new_status: 'lost', leads_to_update: 3, sample: 'A, B, C' },
    preview: { all_names: ['acct-1', 'acct-2', 'acct-3'] },
  });
  expect(c.more_effects.map((e) => e.label)).toEqual(['acct-1', 'acct-2', 'acct-3']);
  expect(c.targets_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  const same = buildContract({ toolName: 'bulk_update_leads', params: { lead_ids: ['l1', 'l2', 'l3'], current_status: 'new', new_status: 'lost' }, displayParams: {}, preview: { all_names: ['acct-1', 'acct-2', 'acct-3'] } });
  expect(same.targets_fingerprint).toBe(c.targets_fingerprint); // order-independent
  const other = buildContract({ toolName: 'bulk_update_leads', params: { lead_ids: ['l1', 'l2', 'l9'], current_status: 'new', new_status: 'lost' }, displayParams: {}, preview: { all_names: ['acct-1', 'acct-2', 'acct-3'] } });
  expect(other.targets_fingerprint).not.toBe(c.targets_fingerprint);
  expect(contractHash(other)).not.toBe(contractHash(c));
});

test('tier/rate customer updates disclose the billing-lane stamp + owner notification', () => {
  const c = buildContract({
    toolName: 'update_customer',
    params: { customer_id: 'c9', updates: { waveguard_tier: 'gold', monthly_rate: 129 } },
    displayParams: { customer_id: 'c9', updates: { waveguard_tier: 'gold', monthly_rate: 129 } },
  });
  expect(c.effects.map((e) => e.label)).toContainEqual(expect.stringMatching(/billing_mode stamped 'monthly_membership'.*owner is notified/));
  const plain = buildContract({ toolName: 'update_customer', params: { updates: { city: 'Venice' } }, displayParams: { updates: { city: 'Venice' } } });
  expect(plain.effects.some((e) => /billing_mode stamped/.test(e.label))).toBe(false);
});

test('live reschedule discloses the field-workflow reset; scheduled one does not', () => {
  const mk = (status) => buildContract({ toolName: 'reschedule_appointment', params: { appointment_id: 'ap1', new_date: '2026-09-04' }, displayParams: {}, preview: { pinned_appointment: { id: 'ap1', status, scheduled_date: '2026-09-02', service_type: 'Pest' } } });
  expect(mk('en_route').effects.map((e) => e.label)).toContainEqual(expect.stringMatching(/^Ends the active field workflow: status en_route → confirmed/));
  expect(mk('scheduled').effects.some((e) => /field workflow/.test(e.label))).toBe(false);
});

test('email change on update_customer discloses the DOI re-send and marks contact/irreversible', () => {
  const c = buildContract({ toolName: 'update_customer', params: { customer_id: 'c9', updates: { email: 'x@example.test' } }, displayParams: { customer_id: 'c9', updates: { email: 'x@example.test' } } });
  expect(c.effects.map((e) => e.label)).toContainEqual(expect.stringMatching(/double-opt-in email is re-sent/));
  expect(c.notifies_customer).toBe(true);
  expect(c.irreversible).toBe(true);
  const noEmail = buildContract({ toolName: 'update_customer', params: { updates: { city: 'Venice' } }, displayParams: { updates: { city: 'Venice' } } });
  expect(noEmail.notifies_customer).toBe(false);
});

test('bulk_update_customers card states skipped customers surface as a warning', () => {
  const c = buildContract({ toolName: 'bulk_update_customers', params: { customer_ids: ['a', 'b'], updates: { city: 'Venice' } }, displayParams: { customer_ids: ['a', 'b'], updates: { city: 'Venice' } } });
  expect(c.effects.map((e) => e.label)).toContainEqual(expect.stringMatching(/skipped customer is reported as a warning/));
});

test('customer updates disclose address ripples and stage lifecycle stamps; bulk email change is customer contact', () => {
  const addr = buildContract({ toolName: 'update_customer', params: { updates: { city: 'Venice' } }, displayParams: { updates: { city: 'Venice' } } });
  expect(addr.effects.map((e) => e.label)).toContainEqual(expect.stringMatching(/^Address change also clears saved coordinates/));
  const stage = buildContract({ toolName: 'bulk_update_customers', params: { customer_ids: ['a'], updates: { pipeline_stage: 'won' } }, displayParams: { customer_ids: ['a'], updates: { pipeline_stage: 'won' } } });
  expect(stage.effects.map((e) => e.label)).toContainEqual(expect.stringMatching(/^Stage → won also stamps lifecycle fields/));
  const bulkEmail = buildContract({ toolName: 'bulk_update_customers', params: { customer_ids: ['a', 'b'], updates: { email: 'x@example.test' } }, displayParams: { customer_ids: ['a', 'b'], updates: { email: 'x@example.test' } } });
  expect(bulkEmail.notifies_customer).toBe(true);
  expect(bulkEmail.irreversible).toBe(true);
  const plain = buildContract({ toolName: 'update_customer', params: { updates: { notes: 'x' } }, displayParams: { updates: { notes: 'x' } } });
  expect(plain.effects.some((e) => /Address change|lifecycle fields/.test(e.label))).toBe(false);
});

test('preview fingerprint hashes arrays as sets (SQL row order) but ordered plans still bind via position', () => {
  const { previewFingerprint } = require('../services/intelligence-bar/authorization-contract');
  const a = previewFingerprint({ stops: [{ id: 's1', service: 'Pest' }, { id: 's2', service: 'Lawn' }] });
  const b = previewFingerprint({ stops: [{ id: 's2', service: 'Lawn' }, { id: 's1', service: 'Pest' }] });
  expect(a).toBe(b);
  const p1 = previewFingerprint({ ordered_stops: [{ position: 1, id: 's1' }, { position: 2, id: 's2' }] });
  const p2 = previewFingerprint({ ordered_stops: [{ position: 1, id: 's2' }, { position: 2, id: 's1' }] });
  expect(p1).not.toBe(p2);
});

test('irreversibility is derived from outbound effects, not only the allowlist', () => {
  expect(buildContract({ toolName: 'move_stops_to_day', params: { notify_customers: true }, displayParams: { notify_customers: true } }).irreversible).toBe(true);
  expect(buildContract({ toolName: 'move_stops_to_day', params: {}, displayParams: { notify_customers: false } }).irreversible).toBe(false);
  expect(buildContract({ toolName: 'run_tax_advisor', params: {}, displayParams: {} }).irreversible).toBe(true);
  expect(buildContract({ toolName: 'run_price_lookup', params: {}, displayParams: {} }).irreversible).toBe(true);
  expect(buildContract({ toolName: 'update_customer', params: {}, displayParams: {} }).irreversible).toBe(false);
});

test('approve_price: pinned approval names product/vendor/price and the approve vs reject effect', () => {
  const pinned = { id: 'pa1', status: 'pending', product_id: 'p1', vendor_name: 'VendorCo', product_name: 'Termidor SC 20oz', new_price: 89.5, new_quantity: '20 oz' };
  const approve = buildContract({ toolName: 'approve_price', params: { approval_id: 'pa1', action: 'approve' }, displayParams: { approval_id: 'pa1', action: 'approve' }, preview: { pinned_approval: pinned } });
  expect(approve.effects.map((e) => e.label)).toContainEqual('Approve $89.50 / 20 oz for Termidor SC 20oz from VendorCo — applies vendor pricing, records price history, and recalculates the product\'s best price');
  expect(approve.effects.find((e) => e.label.startsWith('Approve')).kind).toBe('billing');
  const reject = buildContract({ toolName: 'approve_price', params: { approval_id: 'pa1', action: 'reject' }, displayParams: { approval_id: 'pa1', action: 'reject' }, preview: { pinned_approval: pinned } });
  expect(reject.effects.map((e) => e.label)).toContainEqual(expect.stringMatching(/^Reject the \$89\.50 price .* no pricing changes$/));
  expect(approve.pinned_approval).toEqual(pinned);
  expect(contractHash(approve)).not.toBe(contractHash(buildContract({ toolName: 'approve_price', params: { approval_id: 'pa1', action: 'approve' }, displayParams: { approval_id: 'pa1', action: 'approve' }, preview: { pinned_approval: { ...pinned, new_price: 79.5 } } })));
});

test('estimate toggles: pinned estimate + frozen before/after flag', () => {
  const c = buildContract({
    toolName: 'toggle_show_one_time_option',
    params: { estimate_identifier: 'e1', enabled: true, _estimate_fingerprint: 'x' },
    displayParams: { estimate_identifier: 'e1', enabled: true, estimate: 'acct-3001 — tok-1', change: 'show_one_time_option: false → true' },
    preview: { pinned_estimate: { id: 'e1', token: 'tok-1', customer_name: 'acct-3001', flag: 'show_one_time_option', current: false, next: true } },
  });
  expect(c.effects).toContainEqual({ kind: 'customer', label: 'Estimate tok-1 (acct-3001): one-time option off → on (customer-facing)', before: 'off', after: 'on' });
  expect(c.pinned_estimate.next).toBe(true);
});

test('hash is order-independent and sensitive to any effect change', () => {
  const a = buildContract({ toolName: 'cancel_appointment', params: {}, displayParams: { appointment_id: 'ap1', reason: 'rain' } });
  const b = buildContract({ toolName: 'cancel_appointment', params: {}, displayParams: { reason: 'rain', appointment_id: 'ap1' } });
  const c = buildContract({ toolName: 'cancel_appointment', params: {}, displayParams: { appointment_id: 'ap2', reason: 'rain' } });
  expect(contractHash(a)).toBe(contractHash(b));
  expect(contractHash(a)).not.toBe(contractHash(c));
  expect(contractHash(a)).toMatch(/^[0-9a-f]{64}$/);
});

test('move_stops_to_day: a live stop discloses the field-workflow reset, and its status binds the fingerprint (codex r7)', () => {
  const mk = (status) => buildContract({
    toolName: 'move_stops_to_day',
    params: { new_date: '2026-09-03' },
    displayParams: { new_date: '2026-09-03', notify_customers: false },
    preview: {
      proposal: true,
      stop_count: 2,
      stops: [
        { id: 's1', customer: 'acct-9001', city: 'Venice', service_type: 'pest_control', status: 'confirmed', old_date: '2026-09-01', new_date: '2026-09-03' },
        { id: 's2', customer: 'acct-9002', city: 'Venice', service_type: 'pest_control', status, old_date: '2026-09-01', new_date: '2026-09-03' },
      ],
    },
  });
  const live = mk('on_site');
  expect(live.effects.map((e) => e.label)).toContainEqual(expect.stringContaining('Ends the active field workflow for 1 live stop(s) — acct-9002 (on_site)'));
  const calm = mk('confirmed');
  expect(calm.effects.some((e) => e.label.includes('Ends the active field workflow'))).toBe(false);
  // The stop status rides the preview, so going live during the pending
  // window is fingerprint drift — confirm refuses, never a silent reset.
  expect(live.preview_fingerprint).toBeDefined();
  expect(live.preview_fingerprint).not.toBe(calm.preview_fingerprint);
});

test('update_restock_request: receive discloses the readiness-alert recheck; cancel does not (codex r7)', () => {
  const receive = buildContract({
    toolName: 'update_restock_request',
    params: { request_id: 'r1', action: 'receive' },
    displayParams: { request_id: 'r1', action: 'receive' },
    preview: { preview: true, action: 'receive', new_status: 'received', stock_before: 2, adds: 3, stock_after: 5 },
  });
  expect(receive.effects.map((e) => e.label)).toContainEqual(expect.stringContaining('re-checks WaveGuard lawn-protocol readiness'));
  const cancel = buildContract({
    toolName: 'update_restock_request',
    params: { request_id: 'r1', action: 'cancel' },
    displayParams: { request_id: 'r1', action: 'cancel' },
    preview: { preview: true, action: 'cancel', new_status: 'cancelled' },
  });
  expect(cancel.effects.some((e) => e.label.includes('lawn-protocol readiness'))).toBe(false);
});

test('bulk_update_customers: every pinned customer name rides Show more and the id list is fingerprinted order-independently (codex r7)', () => {
  const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
  const c = buildContract({
    toolName: 'bulk_update_customers',
    params: { customer_ids: ids, updates: { city: 'Venice' } },
    displayParams: { customer_ids: ids, updates: { city: 'Venice' } },
    preview: { all_customer_names: ['acct-9001', 'acct-9002'] },
  });
  expect(c.effects.map((e) => e.label)).toContainEqual('All 2 customer names are listed under "Show more"');
  expect((c.more_effects || []).map((e) => e.label)).toEqual(expect.arrayContaining(['acct-9001', 'acct-9002']));
  expect(c.targets_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  const swapped = buildContract({
    toolName: 'bulk_update_customers',
    params: { customer_ids: [...ids].reverse(), updates: { city: 'Venice' } },
    displayParams: { customer_ids: [...ids].reverse(), updates: { city: 'Venice' } },
    preview: { all_customer_names: ['acct-9002', 'acct-9001'] },
  });
  expect(swapped.targets_fingerprint).toBe(c.targets_fingerprint);
});

test('the proposal terminal set matches the executor: rescheduled visits stay movable (codex r7)', () => {
  const { TERMINAL_APPOINTMENT_STATUSES } = require('../services/intelligence-bar/proposal-pins');
  expect(TERMINAL_APPOINTMENT_STATUSES).toEqual(['completed', 'cancelled', 'skipped', 'no_show']);
  expect(TERMINAL_APPOINTMENT_STATUSES).not.toContain('rescheduled');
});
