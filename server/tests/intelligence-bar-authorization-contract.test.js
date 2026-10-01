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

test('customer estimate approval discloses and binds every offered cadence price', () => {
  const preview = { customer: { name: 'Synthetic account' }, property: { address: '100 Example Court',
    treatable_lawn_sqft: 5000, grass_type: 'st_augustine' }, quote_tier: 'Bronze',
    lines: [{ service: 'Lawn care', applications: 9, per_application: 100 }],
    offered_cadences: [{ key: 'standard', applications: 6, per_application: 110, selected: false },
      { key: 'enhanced', applications: 9, per_application: 100, selected: true },
      { key: 'premium', applications: 12, per_application: 90, selected: false }], effect: 'Saves a draft.' };
  const make = () => buildContract({ toolName: 'save_customer_estimate', params: {}, displayParams: {}, preview });
  const contract = make(), hash = contractHash(contract);
  expect(contract.effects.filter(effect => effect.label.startsWith('Customer option'))).toEqual([
    { kind: 'billing', label: 'Customer option (selected): 9 applications per year at $100.00 per application' },
    { kind: 'billing', label: 'Customer option: 12 applications per year at $90.00 per application' },
    { kind: 'billing', label: 'Customer option: 6 applications per year at $110.00 per application' },
  ]);
  preview.offered_cadences[0].per_application = 111;
  expect(contractHash(make())).not.toBe(hash);
});

test('tier mirrors write-gates: two-step/legacy-bare = yellow, confirmed-endpoint = red, reads = green', () => {
  for (const n of gates.WRITE_TWO_STEP_TOOL_NAMES) expect(tierFor(n)).toBe('yellow');
  for (const n of gates.LEGACY_BARE_WRITE_TOOL_NAMES) expect(tierFor(n)).toBe('yellow');
  for (const n of gates.CONFIRMED_ENDPOINT_WRITE_TOOL_NAMES) expect(tierFor(n)).toBe('red');
  expect(tierFor('query_customers')).toBe('green');
});

test('every outside-write tool (Sentry/Cloudflare/Railway/GitHub/GSC/GrowthBook) is irreversible — none has a portal-side undo', () => {
  for (const n of gates.OUTSIDE_WRITE_TOOL_NAMES) {
    expect(buildContract({ toolName: n, params: {}, displayParams: {} }).irreversible).toBe(true);
  }
  expect(gates.OUTSIDE_WRITE_TOOL_NAMES.size).toBe(13);
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

test('clearing a saved property label is an explicit approved effect', () => {
  const contract = buildContract({ toolName: 'update_customer_property', params: { label: null },
    displayParams: { label: null }, preview: { before: { label: 'Family home' }, changes: { label: null } } });
  expect(contract.effects).toContainEqual(expect.objectContaining({ label: 'label: (cleared)', before: 'Family home', after: null }));
});

test.each([['family_home', 'relationship: family home'], [null, 'relationship: (cleared)']])(
  'property relationship %s is visible in the approval effects', (relationship, label) => {
    const params = { relationship };
    const contract = buildContract({ toolName: 'update_customer_property', params, displayParams: params,
      preview: { before: { relationship: 'own_home' }, changes: params } });
    expect(contract.effects).toContainEqual(expect.objectContaining({ label, before: 'own_home', after: relationship }));
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
  const { CONTACT_FANOUT_DISCLOSURE, CONTACT_FANOUT_PHONE_HOLD_CLAUSE } = require('../services/customer-contact-fanout');
  const c = buildContract({
    toolName: 'update_customer',
    params: { customer_id: 'c9', updates: { email: 'x@example.test', phone: '9415550000' } },
    displayParams: { customer_id: 'c9', updates: { email: 'x@example.test', phone: '9415550000' } },
  });
  const labels = c.effects.map((e) => e.label);
  expect(labels).toContainEqual(EMAIL_FANOUT_DISCLOSURE);
  // A phone change appends the hold-clear clause (codex round-5 P2).
  expect(labels).toContainEqual(`${CONTACT_FANOUT_DISCLOSURE} ${CONTACT_FANOUT_PHONE_HOLD_CLAUSE}`);
  const only = buildContract({ toolName: 'update_customer', params: { updates: { notes: 'gate code 1234' } }, displayParams: { updates: { notes: 'gate code 1234' } } });
  expect(only.effects.map((e) => e.label)).not.toContainEqual(EMAIL_FANOUT_DISCLOSURE);
});

test('codex round-5 P2: a name-only update_customer edit discloses the fan-out WITHOUT promising a hold lift it never does', () => {
  const { CONTACT_FANOUT_DISCLOSURE, CONTACT_FANOUT_PHONE_HOLD_CLAUSE } = require('../services/customer-contact-fanout');
  const c = buildContract({
    toolName: 'update_customer',
    params: { customer_id: 'c9', updates: { first_name: 'Ada' } },
    displayParams: { customer_id: 'c9', updates: { first_name: 'Ada' } },
  });
  const labels = c.effects.map((e) => e.label);
  expect(labels).toContainEqual(CONTACT_FANOUT_DISCLOSURE);
  expect(labels.some((l) => l.includes(CONTACT_FANOUT_PHONE_HOLD_CLAUSE))).toBe(false);
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
  // cancel_appointment with no cancellation impact pinned (or customer_notice
  // 'none') is genuinely NOT contacting the customer — see the next test for
  // the customer_notice: 'may_send' case, which flips this on (Codex
  // round-1 P1: the real GATE_CANCEL_NOTICE_HOOK can still text one, and
  // this card must disclose it, never silently claim otherwise).
  expect(buildContract({ toolName: 'cancel_appointment', params: {}, displayParams: {} }).notifies_customer).toBe(false);
  expect(buildContract({ toolName: 'trigger_review_request', params: {}, displayParams: {} }).notifies_customer).toBe(true);
  expect(buildContract({ toolName: 'create_appointment', params: {}, displayParams: {} }).notifies_customer).toBe(false);
});

// Codex round-1 P1/P2 on the ib-cancel-appointment-live lane: cancel_appointment's
// SHARED status-writer hook (job-status.js#previewCancellationNoticeVerdict,
// mirrored into the pinned impact as customer_notice) may text the
// customer a cancellation notice — a real effect the card must disclose
// and hash, never silently claim away. cancel_appointment is also always
// irreversible now (money moves no portal path undoes, whether or not it
// notifies).
test('cancel_appointment: customer_notice may_send discloses the notice, marks notifies_customer, and binds the hash', () => {
  const maySend = buildContract({
    toolName: 'cancel_appointment', params: {}, displayParams: {},
    preview: { cancellation: { ...synthCancellationBase(), customer_notice: 'may_send' } },
  });
  const none = buildContract({
    toolName: 'cancel_appointment', params: {}, displayParams: {},
    preview: { cancellation: { ...synthCancellationBase(), customer_notice: 'none' } },
  });
  expect(maySend.notifies_customer).toBe(true);
  expect(maySend.effects.some((e) => e.kind === 'comms' && /cancellation notice/.test(e.label))).toBe(true);
  // Wording never claims to know WHEN — only that the existing hook may
  // still text (evidence-independent, per previewCancellationNoticeVerdict).
  expect(maySend.effects.find((e) => e.kind === 'comms').label).toMatch(/MAY be texted/);
  expect(none.notifies_customer).toBe(false);
  expect(none.effects.some((e) => e.kind === 'comms')).toBe(false);
  expect(contractHash(maySend)).not.toBe(contractHash(none));
});

// Codex round-5 P2: the assigned technician's cancel notice
// (tech-visit-notifications.js#notifyVisitCancelled, wired unconditionally
// into every transitionJobStatus cancel) is a real staff-comms effect the
// card must disclose, separately from the customer notice above.
test('cancel_appointment: technician_notice may_notify discloses the notice, marks notifies_technician, and binds the hash', () => {
  const mayNotify = buildContract({
    toolName: 'cancel_appointment', params: {}, displayParams: {},
    preview: { cancellation: { ...synthCancellationBase(), technician_notice: 'may_notify' } },
  });
  const none = buildContract({
    toolName: 'cancel_appointment', params: {}, displayParams: {},
    preview: { cancellation: { ...synthCancellationBase(), technician_notice: 'none' } },
  });
  expect(mayNotify.notifies_technician).toBe(true);
  expect(mayNotify.effects.some((e) => e.kind === 'comms' && /technician/i.test(e.label))).toBe(true);
  expect(mayNotify.effects.find((e) => e.kind === 'comms' && /technician/i.test(e.label)).label).toMatch(/MAY get a cancelled-visit notice/);
  expect(none.notifies_technician).toBe(false);
  expect(none.effects.some((e) => e.kind === 'comms' && /technician/i.test(e.label))).toBe(false);
  expect(contractHash(mayNotify)).not.toBe(contractHash(none));
  // Absent entirely (no cancellation preview at all) reads as 'none', same
  // safe default as customer_notice.
  expect(buildContract({ toolName: 'cancel_appointment', params: {}, displayParams: {} }).notifies_technician).toBe(false);
});

test('cancel_appointment is irreversible unconditionally — money moves no portal path undoes, notice or not', () => {
  const notified = buildContract({
    toolName: 'cancel_appointment', params: {}, displayParams: {},
    preview: { cancellation: { ...synthCancellationBase(), customer_notice: 'may_send' } },
  });
  const silent = buildContract({
    toolName: 'cancel_appointment', params: {}, displayParams: {},
    preview: { cancellation: { ...synthCancellationBase(), customer_notice: 'none' } },
  });
  expect(notified.irreversible).toBe(true);
  expect(silent.irreversible).toBe(true);
});

test('create_appointment: card bookings are credit-free by construction; a windowless one never sends a booking confirmation', () => {
  const c = buildContract({ toolName: 'create_appointment', params: { customer_id: 'c1' }, displayParams: { customer_id: 'c1', date: '2026-09-02' }, preview: { proposal: true, inspection_credit: { amount: 0 } } });
  const labels = c.effects.map((e) => e.label);
  expect(labels).toContainEqual(expect.stringMatching(/^No inspection credit is redeemed by this booking/));
  expect(labels).toContainEqual(expect.stringMatching(/placeholder reminder rows: no booking confirmation is sent for a booking with no time, even after a time is set later; setting a time re-arms only the 72h\/24h reminders/));
  expect(c.notifies_customer).toBe(false);
});

test('create_appointment with a time texts the booking confirmation, as on the Schedule screen (owner 2026-09-27)', () => {
  const c = buildContract({ toolName: 'create_appointment', params: { customer_id: 'c1', time_window: '9:00 AM' }, displayParams: { customer_id: 'c1', date: '2026-09-02' }, preview: { proposal: true, inspection_credit: { amount: 0 } } });
  const labels = c.effects.map((e) => e.label);
  expect(labels).toContainEqual(expect.stringMatching(/^Customer is sent a booking confirmation unless their appointment-confirmation setting is off or they were already confirmed for another visit at the same time, as on the Schedule screen: by text, email or both/));
  expect(labels).toContainEqual(expect.stringMatching(/^Registers the 72h\/24h reminder rows/));
  expect(c.notifies_customer).toBe(true);
});

// Codex r2 on #5093 (P1): only the SMS leg holds for the 8AM-8PM send window
// (appointment-reminders.js reminderSendWindowHold — 'email' is never held,
// and 'both' sends its email leg right away and defers only the text). The
// card must say so — not that the WHOLE confirmation waits until 8 AM,
// which is false for an email-only or email+text customer.
test('the after-8PM hold is disclosed as a TEXT-only hold — an email confirmation still goes right away', () => {
  const c = buildContract({ toolName: 'create_appointment', params: { customer_id: 'c1', time_window: '9:00 AM' }, displayParams: { customer_id: 'c1', date: '2026-09-02' }, preview: { proposal: true, inspection_credit: { amount: 0 } } });
  const labels = c.effects.map((e) => e.label);
  const confirmationLabel = labels.find((l) => l.startsWith('Customer is sent a booking confirmation'));
  expect(confirmationLabel).toMatch(/a text after 8 PM waits until 8 AM, but an email goes right away/);
  expect(confirmationLabel).not.toMatch(/after 8 PM it waits for 8 AM/);
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
  // The owner notification is best-effort fire-and-forget — the card says
  // "attempted", never promised (GH r16 P2).
  expect(c.effects.map((e) => e.label)).toContainEqual(expect.stringMatching(/billing_mode stamped 'monthly_membership'.*owner notification to verify the lane is attempted/));
  const plain = buildContract({ toolName: 'update_customer', params: { updates: { city: 'Venice' } }, displayParams: { updates: { city: 'Venice' } } });
  expect(plain.effects.some((e) => /billing_mode stamped/.test(e.label))).toBe(false);
});

test('live reschedule discloses the field-workflow reset; scheduled one does not', () => {
  const mk = (status) => buildContract({ toolName: 'reschedule_appointment', params: { appointment_id: 'ap1', new_date: '2026-09-04' }, displayParams: {}, preview: { pinned_appointment: { id: 'ap1', status, scheduled_date: '2026-09-02', service_type: 'Pest' } } });
  expect(mk('en_route').effects.map((e) => e.label)).toContainEqual(expect.stringMatching(/^Ends the active field workflow: status en_route → confirmed/));
  expect(mk('scheduled').effects.some((e) => /field workflow/.test(e.label))).toBe(false);
});

test('email change on update_customer discloses the DOI re-send as a conditional ATTEMPT and marks contact/irreversible (GH r12)', () => {
  const c = buildContract({ toolName: 'update_customer', params: { customer_id: 'c9', updates: { email: 'x@example.test' } }, displayParams: { customer_id: 'c9', updates: { email: 'x@example.test' } } });
  // The executor's re-send is post-commit fire-and-forget and can be vetoed
  // (do-not-contact, suppression, superseded, delivery failure) — the card
  // must say "attempted"/"may", never promise the send happened.
  expect(c.effects.map((e) => e.label)).toContainEqual(expect.stringMatching(/double-opt-in email to the NEW address is attempted/));
  expect(c.effects.some((e) => /is re-sent .* immediately/.test(e.label))).toBe(false);
  expect(c.effects.some((e) => e.label === 'Customer may be contacted (conditional double-opt-in re-send only)')).toBe(true);
  expect(c.effects.some((e) => e.label === 'Customer will be contacted')).toBe(false);
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

test('a churn stage move discloses the billing disarm (GitHub Codex #4684 r4); other stages do not', () => {
  const single = buildContract({ toolName: 'update_customer', params: { customer_id: 'c1', updates: { pipeline_stage: 'churned' } }, displayParams: { updates: { pipeline_stage: 'churned' } } });
  const billingLine = single.effects.find((e) => e.kind === 'billing' && /Auto Pay/.test(e.label));
  expect(billingLine).toBeDefined();
  expect(billingLine.label).toBe('Turns off Auto Pay on the customer and on every saved payment method, clears the next charge date and any armed failed-payment retry, and sets active to false (any active in this request is ignored) — REFUSED at commit if a future or in-progress visit or an ongoing recurring plan, an active prepay term, or an unpaid annual-prepay invoice is still on file; an already-churned customer whose billing is already off is not re-checked — only saved-method Auto Pay and armed retries are repaired');
  // The generic lifecycle-stamps line stays alongside the new billing line.
  expect(single.effects.map((e) => e.label)).toContainEqual(expect.stringMatching(/^Stage → churned also stamps lifecycle fields/));

  // A non-churned stage never gets the billing disarm disclosure.
  const won = buildContract({ toolName: 'update_customer', params: { updates: { pipeline_stage: 'won' } }, displayParams: { updates: { pipeline_stage: 'won' } } });
  expect(won.effects.some((e) => /Auto Pay/.test(e.label))).toBe(false);
  const plain = buildContract({ toolName: 'update_customer', params: { updates: { city: 'Venice' } }, displayParams: { updates: { city: 'Venice' } } });
  expect(plain.effects.some((e) => /Auto Pay/.test(e.label))).toBe(false);
});

test('bulk churn stage move discloses the per-customer billing disarm with the "For each of N" prefix, and reports blocks as skipped', () => {
  const bulk = buildContract({
    toolName: 'bulk_update_customers',
    params: { customer_ids: ['a', 'b', 'c'], updates: { pipeline_stage: 'churned' } },
    displayParams: { customer_ids: ['a', 'b', 'c'], updates: { pipeline_stage: 'churned' } },
  });
  const billingLine = bulk.effects.find((e) => e.kind === 'billing' && /Auto Pay/.test(e.label));
  expect(billingLine).toBeDefined();
  expect(billingLine.label).toBe('For each of 3 customers: Turns off Auto Pay on the customer and on every saved payment method, clears the next charge date and any armed failed-payment retry, and sets active to false (any active in this request is ignored) — skipped at commit and reported back (not updated), never silently if a future or in-progress visit or an ongoing recurring plan, an active prepay term, or an unpaid annual-prepay invoice is still on file; an already-churned customer whose billing is already off is not re-checked — only saved-method Auto Pay and armed retries are repaired');

  // A single-id bulk call gets no "For each of N" prefix (n === 1).
  const bulkOne = buildContract({
    toolName: 'bulk_update_customers',
    params: { customer_ids: ['a'], updates: { pipeline_stage: 'churned' } },
    displayParams: { customer_ids: ['a'], updates: { pipeline_stage: 'churned' } },
  });
  const oneLine = bulkOne.effects.find((e) => e.kind === 'billing' && /Auto Pay/.test(e.label));
  expect(oneLine.label.startsWith('For each of')).toBe(false);
  expect(oneLine.label.startsWith('Turns off Auto Pay')).toBe(true);

  // A non-churned bulk stage move never gets the billing disarm disclosure.
  const bulkWon = buildContract({
    toolName: 'bulk_update_customers',
    params: { customer_ids: ['a', 'b'], updates: { pipeline_stage: 'won' } },
    displayParams: { customer_ids: ['a', 'b'], updates: { pipeline_stage: 'won' } },
  });
  expect(bulkWon.effects.some((e) => /Auto Pay/.test(e.label))).toBe(false);
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

// cancel_appointment "cancellation" effects (PR A of the cancel-pinned-
// effects lane) — the exact fee/invoice/inspection-credit set
// appointment-cancel-impact.js computes, frozen into the contract so the
// hash covers fee amount, invoice ids, and credit ids, not just their
// rendered text (pinned_cancellation) — synthetic ids/amounts throughout.
const synthCancellationBase = () => ({
  appointment: { service_type: 'pest_control', scheduled_date: '2026-10-02', customer_name: 'Synthia Tester', status: 'confirmed' },
  fee: { applies: false, amount: null, unresolved: false, rail: 'none', hold_disposition: null },
  invoices: [],
  inspection_credit_reversal: null,
});

// Codex round-3 P1: two same-day visits for the same customer are
// otherwise indistinguishable on the card — the window (pinned
// automatically as part of preview.cancellation.appointment) makes the
// "Cancel <service> on <date>, <window> for <customer>" line unambiguous.
test('cancel_appointment: the appointment window is rendered in the cancel line when present', () => {
  const c = buildContract({
    toolName: 'cancel_appointment', params: {}, displayParams: {},
    preview: { cancellation: { ...synthCancellationBase(), appointment: { ...synthCancellationBase().appointment, window: '1:00 PM–3:00 PM' } } },
  });
  expect(c.effects).toContainEqual(expect.objectContaining({
    kind: 'operational',
    label: 'Cancel pest_control on 2026-10-02, 1:00 PM–3:00 PM for Synthia Tester',
  }));
});

test('cancel_appointment: no window on the row omits the clause — byte-identical to before this lane', () => {
  const c = buildContract({
    toolName: 'cancel_appointment', params: {}, displayParams: {},
    preview: { cancellation: synthCancellationBase() },
  });
  expect(c.effects).toContainEqual(expect.objectContaining({
    kind: 'operational',
    label: 'Cancel pest_control on 2026-10-02 for Synthia Tester',
  }));
});

// Codex round-4 P1: switch_appointment_property can move a visit to a
// DIFFERENT saved property than the customer's primary one — the address
// (pinned automatically as part of preview.cancellation.appointment) tells
// the operator which house this cancels, not just which customer.
test('cancel_appointment: the effective service address is rendered when present', () => {
  const c = buildContract({
    toolName: 'cancel_appointment', params: {}, displayParams: {},
    preview: { cancellation: { ...synthCancellationBase(), appointment: { ...synthCancellationBase().appointment, address: '123 Main St, Bradenton, FL, 34209' } } },
  });
  expect(c.effects).toContainEqual(expect.objectContaining({
    kind: 'operational',
    label: 'Cancel pest_control on 2026-10-02 for Synthia Tester at 123 Main St, Bradenton, FL, 34209',
  }));
});

test('cancel_appointment: no address on the row omits the clause', () => {
  const c = buildContract({
    toolName: 'cancel_appointment', params: {}, displayParams: {},
    preview: { cancellation: synthCancellationBase() },
  });
  expect(c.effects).toContainEqual(expect.objectContaining({
    kind: 'operational',
    label: 'Cancel pest_control on 2026-10-02 for Synthia Tester',
  }));
});

// Two visits, same date, same customer, different window: the hash must
// never collide (mirrors the identity_fingerprint drift guarantee — the
// CARD itself must show operators the difference, not just refuse silently
// later).
test('cancel_appointment: two same-day visits with different windows render different lines and hash differently', () => {
  const morning = buildContract({
    toolName: 'cancel_appointment', params: {}, displayParams: {},
    preview: { cancellation: { ...synthCancellationBase(), appointment: { ...synthCancellationBase().appointment, window: '8:00 AM–11:00 AM' } } },
  });
  const afternoon = buildContract({
    toolName: 'cancel_appointment', params: {}, displayParams: {},
    preview: { cancellation: { ...synthCancellationBase(), appointment: { ...synthCancellationBase().appointment, window: '1:00 PM–3:00 PM' } } },
  });
  expect(morning.effects.some((e) => e.label.includes('8:00 AM'))).toBe(true);
  expect(afternoon.effects.some((e) => e.label.includes('1:00 PM'))).toBe(true);
  expect(contractHash(morning)).not.toBe(contractHash(afternoon));
});

test('cancel_appointment: a late-cancel fee that applies is disclosed with its exact amount', () => {
  const c = buildContract({
    toolName: 'cancel_appointment',
    params: { appointment_id: 'ap-1' },
    displayParams: { appointment_id: 'ap-1' },
    preview: { cancellation: { ...synthCancellationBase(), fee: { applies: true, amount: 49, unresolved: false, rail: 'card_hold', hold_disposition: null } } },
  });
  expect(c.effects).toContainEqual({ kind: 'billing', label: 'Late-cancel fee of $49.00 will be charged to the card on file (a failed charge goes to office review, never silently dropped)' });
});

test('cancel_appointment: fee does not apply — a parked hold and a released hold read differently', () => {
  const parked = buildContract({
    toolName: 'cancel_appointment', params: {}, displayParams: {},
    preview: { cancellation: { ...synthCancellationBase(), fee: { applies: false, amount: 49, unresolved: false, rail: 'card_hold', hold_disposition: 'parked' } } },
  });
  const released = buildContract({
    toolName: 'cancel_appointment', params: {}, displayParams: {},
    preview: { cancellation: { ...synthCancellationBase(), fee: { applies: false, amount: 49, unresolved: false, rail: 'card_hold', hold_disposition: 'released' } } },
  });
  expect(parked.effects).toContainEqual({ kind: 'billing', label: 'No late-cancel fee (outside the fee window) — the card hold is PARKED for the rebooked visit' });
  expect(released.effects).toContainEqual({ kind: 'billing', label: 'No late-cancel fee (outside the fee window) — the card hold is RELEASED' });
  expect(contractHash(parked)).not.toBe(contractHash(released));
});

test('cancel_appointment: invoice void is listed with number, status, total and restored credit', () => {
  const c = buildContract({
    toolName: 'cancel_appointment',
    params: {},
    displayParams: {},
    preview: {
      cancellation: {
        ...synthCancellationBase(),
        invoices: [{ id: 'inv-1', invoice_number: 'WPC-2026-9001', status: 'sent', total: 89, credit_applied: 20 }],
      },
    },
  });
  expect(c.effects).toContainEqual({
    kind: 'billing',
    label: 'Void invoice WPC-2026-9001 (sent, $89.00); $20.00 account credit restored — skipped for office review if a payment is in flight, it sits on a finalized statement, or its amounts change first',
  });
  expect(c.effects).toContainEqual({ kind: 'billing', label: 'Only the invoices listed above are voided — anything created after this card is left for office review' });
});

test('cancel_appointment: a restored deposit credit is stated with its amount and binds the hash', () => {
  const make = (deposit) => buildContract({
    toolName: 'cancel_appointment', params: {}, displayParams: {},
    preview: { cancellation: { ...synthCancellationBase(), invoices: [{ id: 'inv-1', invoice_number: 'WPC-2026-9001', status: 'sent', total: 50, credit_applied: 10, deposit_credit: deposit }] } },
  });
  expect(make(75).effects).toContainEqual({
    kind: 'billing',
    label: 'Void invoice WPC-2026-9001 (sent, $50.00); $10.00 account credit and $75.00 deposit credit restored — skipped for office review if a payment is in flight, it sits on a finalized statement, or its amounts change first',
  });
  expect(contractHash(make(75))).not.toBe(contractHash(make(60)));
});

test('cancel_appointment: the simple-visit refusals are part of the pinned structure (a refused card can never hash like an eligible one)', () => {
  const make = (refusals) => buildContract({
    toolName: 'cancel_appointment', params: {}, displayParams: {},
    preview: { cancellation: { ...synthCancellationBase(), card_cancel_refusals: refusals } },
  });
  expect(make(['card_fee_agreement']).pinned_cancellation.card_cancel_refusals).toEqual(['card_fee_agreement']);
  expect(contractHash(make([]))).not.toBe(contractHash(make(['card_fee_agreement'])));
});

test('cancel_appointment: no invoices means no void disclosure at all', () => {
  const c = buildContract({
    toolName: 'cancel_appointment', params: {}, displayParams: {},
    preview: { cancellation: synthCancellationBase() },
  });
  expect(c.effects.some((e) => /Void invoice|voided/.test(e.label))).toBe(false);
});

test('cancel_appointment: inspection-credit reversal — reverses vs deferred to office review', () => {
  const reversed = buildContract({
    toolName: 'cancel_appointment', params: {}, displayParams: {},
    preview: { cancellation: { ...synthCancellationBase(), inspection_credit_reversal: [{ id: 'offer-1', amount: 75, would_reverse: true, deferred: false }] } },
  });
  const deferred = buildContract({
    toolName: 'cancel_appointment', params: {}, displayParams: {},
    preview: { cancellation: { ...synthCancellationBase(), inspection_credit_reversal: [{ id: 'offer-1', amount: 75, would_reverse: false, deferred: true }] } },
  });
  expect(reversed.effects).toContainEqual({ kind: 'billing', label: "The $75.00 inspection credit this booking earned is taken back out of the customer's account balance (if it was already spent, the office is alerted to collect or write it off)" });
  expect(deferred.effects).toContainEqual({ kind: 'billing', label: 'A $75.00 inspection credit tied to this booking is NOT reversed at cancel — an invoice for this visit still holds money, so the office is alerted' });
  expect(contractHash(reversed)).not.toBe(contractHash(deferred));
});

test('cancel_appointment: a rebound credit (another live booking still earns it) says nothing about the credit, but still binds the hash', () => {
  const rebound = buildContract({
    toolName: 'cancel_appointment', params: {}, displayParams: {},
    preview: { cancellation: { ...synthCancellationBase(), inspection_credit_reversal: [{ id: 'offer-1', amount: 75, would_reverse: false, deferred: false }] } },
  });
  const none = buildContract({
    toolName: 'cancel_appointment', params: {}, displayParams: {},
    preview: { cancellation: synthCancellationBase() },
  });
  expect(rebound.effects.some((e) => /inspection credit/.test(e.label))).toBe(false);
  expect(contractHash(rebound)).not.toBe(contractHash(none));
});

test('cancel_appointment: an invoice left holding money after the void blocks the fee step — the card never promises the charge', () => {
  const c = buildContract({
    toolName: 'cancel_appointment', params: {}, displayParams: {},
    preview: { cancellation: { ...synthCancellationBase(), fee: { applies: true, amount: 49, unresolved: false, rail: 'card_hold', hold_disposition: null, blocked_by_invoice: true } } },
  });
  expect(c.effects).toContainEqual({ kind: 'billing', label: 'No late-cancel fee is charged and no card hold is released automatically — an invoice for this visit still holds money after the void, so the office is alerted to review the fee' });
  expect(c.effects.some((e) => /will be charged|MAY be charged|RELEASED|PARKED/.test(e.label))).toBe(false);
});

test('cancel_appointment: the hash covers fee amount, invoice ids and credit ids — not just their formatted text', () => {
  const make = (cancellation) => buildContract({ toolName: 'cancel_appointment', params: {}, displayParams: {}, preview: { cancellation } });
  const a = make({ ...synthCancellationBase(), invoices: [{ id: 'inv-1', invoice_number: 'WPC-2026-9001', status: 'draft', total: 50, credit_applied: 0 }] });
  // Same rendered dollar figure, DIFFERENT invoice id — must still hash differently.
  const b = make({ ...synthCancellationBase(), invoices: [{ id: 'inv-2', invoice_number: 'WPC-2026-9002', status: 'draft', total: 50, credit_applied: 0 }] });
  expect(a.pinned_cancellation.invoices[0].id).toBe('inv-1');
  expect(contractHash(a)).not.toBe(contractHash(b));

  const c1 = make({ ...synthCancellationBase(), inspection_credit_reversal: [{ id: 'offer-1', amount: 75, would_reverse: true, deferred: false }] });
  const c2 = make({ ...synthCancellationBase(), inspection_credit_reversal: [{ id: 'offer-2', amount: 75, would_reverse: true, deferred: false }] });
  expect(contractHash(c1)).not.toBe(contractHash(c2));
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

test('update_restock_request: stock actions no longer advertise retired readiness side effects', () => {
  const receive = buildContract({
    toolName: 'update_restock_request',
    params: { request_id: 'r1', action: 'receive' },
    displayParams: { request_id: 'r1', action: 'receive' },
    preview: { preview: true, action: 'receive', new_status: 'received', stock_before: 2, adds: 3, stock_after: 5 },
  });
  expect(receive.effects.some(e => e.label.includes('lawn-protocol readiness'))).toBe(false);
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

// ── GH r8 disclosures ──────────────────────────────────────────────────

test('block_sender: address blocks ONE sender; bare domain blocks the WHOLE domain — scope rendered exactly (GH r8)', () => {
  const addr = buildContract({ toolName: 'block_sender', params: { email_address: 'Sender@Example.test' }, displayParams: { email_address: 'Sender@Example.test' } });
  expect(addr.effects.map((e) => e.label)).toContainEqual(expect.stringMatching(/^Auto-trash every future email from sender@example\.test .*other senders at that domain are unaffected/));
  expect(addr.effects.some((e) => /ENTIRE domain/.test(e.label))).toBe(false);
  const dom = buildContract({ toolName: 'block_sender', params: { domain: '@example.test' }, displayParams: { domain: '@example.test' } });
  expect(dom.effects.map((e) => e.label)).toContainEqual(expect.stringMatching(/ANY sender at @example\.test — the ENTIRE domain is blocked/));
  // email_address wins when both ride the params (executor precedence).
  const both = buildContract({ toolName: 'block_sender', params: { email_address: 'a@b.test', domain: 'b.test' }, displayParams: {} });
  expect(both.effects.some((e) => /ENTIRE domain/.test(e.label))).toBe(false);
});

test('reply_via_sms with email_id discloses the inbox state change; without one it does not (GH r8)', () => {
  const withEmail = buildContract({ toolName: 'reply_via_sms', params: { email_id: 'em1', message: 'On my way' }, displayParams: { message: 'On my way' } });
  expect(withEmail.effects.map((e) => e.label)).toContainEqual(expect.stringMatching(/source email is marked read and tagged replied-via-SMS/));
  const without = buildContract({ toolName: 'reply_via_sms', params: { message: 'On my way' }, displayParams: { message: 'On my way' } });
  expect(without.effects.some((e) => /marked read/.test(e.label))).toBe(false);
});

test('clearing an email (null) still discloses the email fan-out — presence, not truthiness (GH r8)', () => {
  const c = buildContract({ toolName: 'update_customer', params: { customer_id: 'c9', updates: { email: null } }, displayParams: { customer_id: 'c9', updates: { email: null } } });
  const { EMAIL_FANOUT_DISCLOSURE } = require('../services/customer-email-fanout');
  expect(c.effects.map((e) => e.label)).toContainEqual(expect.stringContaining(EMAIL_FANOUT_DISCLOSURE));
  // No DOI re-send claim for a clear — there is no new address to confirm.
  expect(c.effects.some((e) => /double-opt-in/.test(e.label))).toBe(false);
});

test('pinned_customer names the target on single-target mutations and binds the hash (GH r8)', () => {
  const mk = (name) => buildContract({
    toolName: 'update_customer',
    params: { customer_id: 'c9', updates: { city: 'Venice' } },
    displayParams: { customer_id: 'c9', updates: { city: 'Venice' } },
    preview: { pinned_customer: { id: 'c9', name } },
  });
  const c = mk('acct-9001');
  expect(c.effects.map((e) => e.label)).toContainEqual('Customer: acct-9001');
  expect(c.pinned_customer).toEqual({ id: 'c9', name: 'acct-9001' });
  expect(contractHash(mk('acct-9002'))).not.toBe(contractHash(c));
  const booking = buildContract({
    toolName: 'create_appointment',
    params: { customer_id: 'c9' },
    displayParams: { customer_id: 'c9', date: '2026-09-02' },
    preview: { proposal: true, pinned_customer: { id: 'c9', name: 'acct-9001' } },
  });
  expect(booking.effects.map((e) => e.label)).toContainEqual('Booked for: acct-9001');
});

test('move_stops_to_day: an evidence-only tracker rewind is disclosed and binds via the stop flag (GH r8)', () => {
  const mk = (rewind) => buildContract({
    toolName: 'move_stops_to_day',
    params: { service_ids: ['s1'], new_date: '2026-09-04' },
    displayParams: { new_date: '2026-09-04' },
    preview: { proposal: true, stops: [{ id: 's1', customer: 'acct-7001', status: 'scheduled', ...(rewind ? { track_rewind: true } : {}) }] },
  });
  const c = mk(true);
  expect(c.effects.map((e) => e.label)).toContainEqual(expect.stringMatching(/^Clears stale tracker evidence on 1 stop\(s\) — acct-7001/));
  expect(mk(false).effects.some((e) => /stale tracker evidence/.test(e.label))).toBe(false);
});

test('reschedule_appointment: evidence-only rewind disclosed on a DATE move of a non-live pinned visit (GH r8)', () => {
  const mk = (over) => buildContract({
    toolName: 'reschedule_appointment',
    params: { appointment_id: 'ap1', new_date: over.new_date || '2026-09-04' },
    displayParams: {},
    preview: { pinned_appointment: { id: 'ap1', status: 'scheduled', scheduled_date: '2026-09-02', service_type: 'Pest', track_rewind: true, ...over.pin } },
  });
  expect(mk({}).effects.map((e) => e.label)).toContainEqual(expect.stringMatching(/^Clears stale tracker evidence on this visit/));
  // Same-day (window-only) change: the executor's rewind is date-gated.
  expect(mk({ new_date: '2026-09-02' }).effects.some((e) => /stale tracker evidence/.test(e.label))).toBe(false);
  // Live rows keep the stronger field-workflow disclosure instead.
  expect(mk({ pin: { status: 'en_route' } }).effects.some((e) => /stale tracker evidence/.test(e.label))).toBe(false);
});

test('reschedule_appointment: sole-open-member grouped visit discloses detach/dissolve on DATE moves; visit_id binds the pin (GH r12 P1, r13 P2)', () => {
  const mk = (visitId, newDate = '2026-09-04') => buildContract({
    toolName: 'reschedule_appointment',
    params: { appointment_id: 'ap1', new_date: newDate },
    displayParams: {},
    preview: { pinned_appointment: { id: 'ap1', status: 'scheduled', scheduled_date: '2026-09-02', service_type: 'Pest', visit_id: visitId } },
  });
  // A pinned visit_id only reaches a card as the visit's sole open member
  // (multi-member/frozen visits are refused at proposal) — the executor's
  // post-move seam detaches the row and dissolves the empty group, so the
  // card must say so.
  expect(mk('v1').effects.map((e) => e.label)).toContainEqual(expect.stringMatching(/sole open member of a grouped visit/));
  expect(mk(null).effects.some((e) => /grouped visit/.test(e.label))).toBe(false);
  // Same-day window edit (GH r13/r17 P2): the seam keeps a date-matching
  // sole member grouped — no detach/dissolve claim, but the parent visit's
  // window recompute is still disclosed.
  const sameDay = mk('v1', '2026-09-02').effects.map((e) => e.label);
  expect(sameDay.some((l) => /detaches|dissolves/.test(l))).toBe(false);
  expect(sameDay).toContainEqual(expect.stringMatching(/recomputes the parent visit's time window/));
  // Joining/leaving a group during the pending window must drift the
  // appointment fingerprint (preview_changed), never execute undisclosed.
  const { appointmentPinFingerprint } = require('../services/intelligence-bar/proposal-pins');
  const pin = { id: 'ap1', status: 'scheduled', scheduled_date: '2026-09-02', service_type: 'Pest', track_rewind: false };
  expect(appointmentPinFingerprint({ ...pin, visit_id: 'v1' })).not.toBe(appointmentPinFingerprint(pin));
});

test('assign_technician: grouped stops disclose the visit-membership seam effect (GH r14 P1)', () => {
  const mk = (grouped) => buildContract({
    toolName: 'assign_technician',
    params: { service_ids: ['s1'], technician_name: 'Adam' },
    displayParams: { technician_name: 'Adam' },
    preview: { proposal: true, stops: [{ id: 's1', customer: 'acct-7001', current_tech: 'Unassigned', ...(grouped ? { grouped_visit_id: 'v1' } : {}) }] },
  });
  expect(mk(true).effects.map((e) => e.label)).toContainEqual(expect.stringMatching(/belong to grouped visits/));
  expect(mk(false).effects.some((e) => /grouped visit/.test(e.label))).toBe(false);
});

test('assign_technician: terminal exclusions are disclosed on the exact-effects card (Codex round 1 P1)', () => {
  const withSkips = buildContract({
    toolName: 'assign_technician',
    params: { service_ids: ['s1', 's2'], technician_name: 'Luis' },
    displayParams: { technician_name: 'Luis' },
    preview: {
      proposal: true,
      stops: [{ id: 's1', customer: 'acct-7002', current_tech: 'Unassigned' }],
      skipped_terminal: [{ id: 's2', status: 'completed', customer: 'acct-7003' }],
    },
  });
  const withoutSkips = buildContract({
    toolName: 'assign_technician',
    params: { service_ids: ['s1'], technician_name: 'Luis' },
    displayParams: { technician_name: 'Luis' },
    preview: { proposal: true, stops: [{ id: 's1', customer: 'acct-7002', current_tech: 'Unassigned' }] },
  });
  const label = withSkips.effects.map((e) => e.label).find((l) => /will NOT be reassigned/.test(l));
  expect(label).toMatch(/1 stop\(s\) are in a terminal status/);
  // Codex round 3 P1: the card names WHICH stops stay behind (customer, id,
  // status), never just how many.
  expect(label).toMatch(/acct-7003 #s2 \(completed\)/);
  expect(withoutSkips.effects.some((e) => /terminal status/.test(e.label))).toBe(false);
});

test('swap_tech_assignments: terminal exclusions are disclosed on the exact-effects card (Codex round 1 P1)', () => {
  const withSkips = buildContract({
    toolName: 'swap_tech_assignments',
    params: { date: '2026-09-21', tech_a_name: 'Adam', tech_b_name: 'Luis' },
    displayParams: { date: '2026-09-21', tech_a_name: 'Adam', tech_b_name: 'Luis' },
    preview: {
      proposal: true,
      stops: { Adam: [], Luis: [{ id: 'b1', service_type: 'Lawn' }] },
      skipped_terminal: [{ id: 'a1', status: 'no_show' }, { id: 'a2', status: 'skipped' }],
    },
  });
  const withoutSkips = buildContract({
    toolName: 'swap_tech_assignments',
    params: { date: '2026-09-21', tech_a_name: 'Adam', tech_b_name: 'Luis' },
    displayParams: { date: '2026-09-21', tech_a_name: 'Adam', tech_b_name: 'Luis' },
    preview: { proposal: true, stops: { Adam: [{ id: 'a1', service_type: 'Lawn' }], Luis: [] } },
  });
  const label = withSkips.effects.map((e) => e.label).find((l) => /will NOT be swapped/.test(l));
  expect(label).toMatch(/2 stop\(s\) are in a terminal status/);
  // Codex round 3 P1: each excluded stop is listed by id and status.
  expect(label).toMatch(/#a1 \(no_show\), #a2 \(skipped\)/);
  expect(withoutSkips.effects.some((e) => /terminal status/.test(e.label))).toBe(false);
});

test('unit-only address edit (address_line2) carries the address fan-out disclosure (GH r14 P2)', () => {
  const c = buildContract({ toolName: 'update_customer', params: { customer_id: 'c9', updates: { address_line2: 'Unit 4B' } }, displayParams: { customer_id: 'c9', updates: { address_line2: 'Unit 4B' } } });
  expect(c.effects.map((e) => e.label)).toContainEqual(expect.stringMatching(/^Address change also clears saved coordinates/));
});

test('lead status derived effects: the funnel advance is conditional, never promised (GH r13 P2)', () => {
  const c = buildContract({
    toolName: 'update_lead_status',
    params: { lead_id: 'l1', new_status: 'won' },
    displayParams: { lead_id: 'l1', new_status: 'won' },
    preview: { pinned_lead: { id: 'l1', name: 'acct-2077', current_status: 'contacted' } },
  });
  // The bridge is update-only and best-effort: no linked
  // ad_service_attribution row is a no-op, and a failure surfaces as a
  // result warning — the card must not report the advance as a done deal.
  expect(c.effects.map((e) => e.label)).toContainEqual(expect.stringMatching(/^If the lead has a linked ad-attribution row, its funnel stage advances/));
  expect(c.effects.some((e) => /^Advances/.test(e.label))).toBe(false);
});

// Codex rounds 9-10 on #5244: the cancel auto-resolves the visit's open
// overdue dispatch alerts; alert creation doesn't lock the visit, so the card
// discloses it as a standing conditional effect rather than a frozen count.
test('cancel_appointment always discloses that it closes any open overdue dispatch alert', () => {
  const { buildContract } = require('../services/intelligence-bar/authorization-contract');
  const preview = { cancellation: { appointment: { id: 'svc-1' }, customer_notice: 'none', technician_notice: 'none' } };
  const contract = buildContract({ toolName: 'cancel_appointment', params: { appointment_id: 'svc-1' }, preview });
  expect(contract.effects.some((e) => e.kind === 'operational' && /running-late \/ unassigned-overdue dispatch alert/.test(e.label))).toBe(true);
});
