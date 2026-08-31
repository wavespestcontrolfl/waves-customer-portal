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

test('hash is order-independent and sensitive to any effect change', () => {
  const a = buildContract({ toolName: 'cancel_appointment', params: {}, displayParams: { appointment_id: 'ap1', reason: 'rain' } });
  const b = buildContract({ toolName: 'cancel_appointment', params: {}, displayParams: { reason: 'rain', appointment_id: 'ap1' } });
  const c = buildContract({ toolName: 'cancel_appointment', params: {}, displayParams: { appointment_id: 'ap2', reason: 'rain' } });
  expect(contractHash(a)).toBe(contractHash(b));
  expect(contractHash(a)).not.toBe(contractHash(c));
  expect(contractHash(a)).toMatch(/^[0-9a-f]{64}$/);
});
