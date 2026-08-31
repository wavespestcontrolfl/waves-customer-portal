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

test('nested display params flatten one level; arrays join; nulls dropped', () => {
  const c = buildContract({
    toolName: 'update_customer',
    params: {},
    displayParams: { customer_id: 'c9', updates: { email: 'x@example.test', notes: null }, tags: ['a', 'b'], skip: undefined },
  });
  const labels = c.effects.map((e) => e.label);
  // Canonical order: comms → billing → customer → operational, then label.
  expect(labels).toEqual(['email: x@example.test', 'customer id: c9', 'tags: a, b']);
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

test('cancel_appointment discloses the late-cancel fee and invoice voids from the cancellation preview', () => {
  const c = buildContract({
    toolName: 'cancel_appointment',
    params: { appointment_id: 'ap1', reason: 'rain', _cancellation_fingerprint: 'x' },
    displayParams: { appointment_id: 'ap1', reason: 'rain', _cancellation_fingerprint: 'x' },
    preview: {
      cancellation: {
        appointment: { id: 'ap1', scheduled_date: '2026-09-02', service_type: 'Quarterly Pest', status: 'scheduled', customer_name: 'acct-3001' },
        fee: { rail: 'card_hold', applies: true, amount: 49, unresolved: false },
        invoices: [{ id: 'inv1', invoice_number: 'INV-1001', status: 'sent', total: 120, credit_applied: 0 }],
      },
    },
  });
  const labels = c.effects.map((e) => e.label);
  expect(labels).toContainEqual(expect.stringMatching(/^Late-cancel fee of \$49\.00 will be charged to the card on file/));
  expect(labels).toContainEqual(expect.stringMatching(/^Void invoice INV-1001 \(sent, \$120\.00\) — applied credits\/deposits restored; skipped for office review/));
  expect(labels).toContainEqual(expect.stringMatching(/^Only the invoices listed above are voided/));
  expect(c.effects.find((e) => e.label.startsWith('Cancel Quarterly Pest'))).toMatchObject({ kind: 'operational', before: 'scheduled', after: 'cancelled' });
  expect(labels.some((l) => l.includes('fingerprint'))).toBe(false);
  expect(c.effects.filter((e) => e.kind === 'billing').length).toBe(3);

  const unresolved = buildContract({
    toolName: 'cancel_appointment', params: {}, displayParams: {},
    preview: { cancellation: { appointment: {}, fee: { rail: 'appointment_card', applies: true, amount: null, unresolved: true }, invoices: [] } },
  });
  expect(unresolved.effects.map((e) => e.label)).toContainEqual(expect.stringMatching(/MAY be charged/));

  const free = buildContract({
    toolName: 'cancel_appointment', params: {}, displayParams: {},
    preview: { cancellation: { appointment: {}, fee: { rail: 'card_hold', applies: false, amount: null, unresolved: false }, invoices: [] } },
  });
  expect(free.effects.map((e) => e.label)).toContainEqual(expect.stringMatching(/No late-cancel fee/));
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

test('hash is order-independent and sensitive to any effect change', () => {
  const a = buildContract({ toolName: 'cancel_appointment', params: {}, displayParams: { appointment_id: 'ap1', reason: 'rain' } });
  const b = buildContract({ toolName: 'cancel_appointment', params: {}, displayParams: { reason: 'rain', appointment_id: 'ap1' } });
  const c = buildContract({ toolName: 'cancel_appointment', params: {}, displayParams: { appointment_id: 'ap2', reason: 'rain' } });
  expect(contractHash(a)).toBe(contractHash(b));
  expect(contractHash(a)).not.toBe(contractHash(c));
  expect(contractHash(a)).toMatch(/^[0-9a-f]{64}$/);
});
