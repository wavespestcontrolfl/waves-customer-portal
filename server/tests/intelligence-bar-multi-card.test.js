/**
 * GATE_IB_MULTI_CARD admission rules (services/intelligence-bar/multi-card.js)
 * and the gate reader. The route and the real card store are exercised in
 * intelligence-bar-multi-card-db.test.js.
 */
const MultiCard = require('../services/intelligence-bar/multi-card');
const Gates = require('../config/feature-gates');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const note = (customer_id, notes = 'x') => ({ name: 'update_customer', input: { customer_id, updates: { notes } } });
const open = (...uses) => uses.map(use => MultiCard.record(use.name, use.input));

describe('GATE_IB_MULTI_CARD reader', () => {
  const saved = { m: process.env.GATE_IB_MULTI_CARD, p: process.env.GATE_IB_PLATFORM };
  afterEach(() => { process.env.GATE_IB_MULTI_CARD = saved.m; process.env.GATE_IB_PLATFORM = saved.p; if (saved.m === undefined) delete process.env.GATE_IB_MULTI_CARD; if (saved.p === undefined) delete process.env.GATE_IB_PLATFORM; });
  test('dark by default, strict true, and needs the platform', () => {
    delete process.env.GATE_IB_MULTI_CARD; process.env.GATE_IB_PLATFORM = 'true';
    expect(Gates.ibMultiCardLive()).toBe(false);
    process.env.GATE_IB_MULTI_CARD = '1';
    expect(Gates.ibMultiCardLive()).toBe(false);
    process.env.GATE_IB_MULTI_CARD = 'true';
    expect(Gates.ibMultiCardLive()).toBe(true);
    process.env.GATE_IB_PLATFORM = 'false';
    expect(Gates.ibMultiCardLive()).toBe(false);
  });
});

describe('multi-card admission', () => {
  test('a second edit on a different customer is admitted', () => {
    expect(MultiCard.admit(note(B), open(note(A)))).toBeNull();
  });

  test('different tools on different records are admitted together', () => {
    const first = open(note(A));
    expect(MultiCard.admit({ name: 'reschedule_appointment', input: { appointment_id: B, new_date: '2026-11-02' } }, first)).toBeNull();
    expect(MultiCard.admit({ name: 'update_lead_status', input: { lead_id: C, new_status: 'contacted' } }, first)).toBeNull();
  });

  test('the same customer is refused, even through another tool, any id case, or the camelCase alias', () => {
    const first = open(note(A));
    for (const use of [
      note(A, 'other'),
      { name: 'send_sms', input: { customer_id: A.toUpperCase(), message: 'hi' } },
      { name: 'update_property_access', input: { customerId: A, access_notes: 'x' } },
    ]) {
      expect(MultiCard.admit(use, first)).toMatchObject({ code: 'same_record_card_open' });
    }
  });

  test('the same visit or lead is refused', () => {
    const visit = { name: 'reschedule_appointment', input: { appointment_id: A, new_date: '2026-11-02' } };
    expect(MultiCard.admit({ name: 'assign_technician', input: { service_ids: [B, A], technician_name: 'T' } }, open(visit)))
      .toMatchObject({ code: 'same_record_card_open' });
    const lead = { name: 'update_lead_status', input: { lead_id: A, new_status: 'lost' } };
    expect(MultiCard.admit({ name: 'update_lead_contact', input: { lead_id: A, phone: '5551230000' } }, open(lead)))
      .toMatchObject({ code: 'same_record_card_open' });
  });

  test('a target named only by name or phone is not independent', () => {
    const first = open(note(A));
    expect(MultiCard.admit({ name: 'send_sms', input: { customer_name: 'Jones', message: 'hi' } }, first)).toMatchObject({ code: 'dependency_unresolved' });
    expect(MultiCard.admit({ name: 'send_sms', input: { phone: '9415550000', message: 'hi' } }, first)).toMatchObject({ code: 'dependency_unresolved' });
    expect(MultiCard.admit({ name: 'update_lead_contact', input: { lead_name: 'Jones', phone: '5551230000' } }, first)).toMatchObject({ code: 'dependency_unresolved' });
  });

  test('a proposal that carries an earlier card\'s record id is dependent', () => {
    expect(MultiCard.admit(note(B, `copy of ${A.toUpperCase()}`), open(note(A)))).toMatchObject({ code: 'dependency_unresolved' });
    expect(MultiCard.admit(note(B, 'plain text'), open(note(A)))).toBeNull();
    expect(MultiCard.admit({ name: 'update_customer', input: { customer_id: B, updates: { notes: A } } }, open(note(A))))
      .toMatchObject({ code: 'dependency_unresolved' });
    expect(MultiCard.admit({ name: 'send_sms', input: { customer_id: B, message: 'x', extra: { ref: [A] } } }, open(note(A))))
      .toMatchObject({ code: 'dependency_unresolved' });
  });

  test('closed actions never join a set: refunds, charges, prices, settings, deletes, bulk, creators', () => {
    const first = open(note(A));
    const closed = [
      { name: 'update_customer', input: { customer_id: B, updates: { monthly_rate: 99 } } },
      { name: 'update_customer', input: { customer_id: B, updates: { waveguard_tier: 'Gold' } } },
      { name: 'update_customer', input: { customer_id: B, updates: { active: false } } },
      { name: 'update_customer', input: { customer_id: B, updates: { notes: 'ok', pipeline_stage: 'churned' } } },
      { name: 'update_customer', input: { customer_id: B, updates: {} } },
      { name: 'bulk_update_customers', input: { customer_ids: [B], updates: { lead_source: 'x' } } },
      { name: 'reprice_future_visits', input: { customer_id: B, price: 50 } },
      { name: 'cancel_plan', input: { customer_id: B } },
      { name: 'cancel_appointment', input: { appointment_id: B } },
      { name: 'delete_duplicate_customer', input: { customer_id: B } },
      { name: 'merge_customers', input: { winner_customer_id: B, loser_customer_id: C } },
      { name: 'send_invoice', input: { invoice_id: B } },
      { name: 'remove_saved_payment_method', input: { customer_id: B } },
      { name: 'correct_invoice_address', input: { invoice_id: B } },
      { name: 'create_customer', input: { first_name: 'N', phone: '9415550000' } },
      { name: 'create_pending_estimate', input: { customer_id: B } },
      { name: 'set_railway_gate', input: {} },
      { name: 'create_appointment', input: { customer_id: B, scheduled_date: '2026-11-02', service_type: 'pest', price: 80 } },
    ];
    for (const use of closed) expect(MultiCard.admit(use, first)).toMatchObject({ code: 'dependency_unresolved' });
  });

  test('a closed card never opens a set; an eligible one does', () => {
    expect(MultiCard.record('bulk_update_customers', { customer_ids: [A], updates: { lead_source: 'x' } })).toBeNull();
    expect(MultiCard.record('update_customer', { customer_id: A, updates: { monthly_rate: 80 } })).toBeNull();
    expect(MultiCard.record('create_customer', { first_name: 'N', phone: '1' })).toBeNull();
    expect(MultiCard.record('send_sms', { customer_name: 'Smith', message: 'hi' })).toBeNull();
    expect(MultiCard.record('update_customer', { customer_id: A, updates: { address_line1: '1 Main St' } }))
      .toEqual({ tool: 'update_customer', keys: [`customer:${A}`] });
  });

  test('a stated-price booking is closed; a catalog-price booking joins', () => {
    expect(MultiCard.record('create_appointment', { customer_id: A, scheduled_date: '2026-11-02', service_type: 'pest' }))
      .toEqual({ tool: 'create_appointment', keys: [`customer:${A}`] });
    expect(MultiCard.record('create_appointment', { customer_id: A, scheduled_date: '2026-11-02', service_type: 'pest', price: 0 })).toBeNull();
  });

  test('the cap is five cards per request', () => {
    const ids = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
    const five = open(...ids.slice(0, 5).map(id => note(id)));
    expect(five).toHaveLength(5);
    expect(MultiCard.admit(note(ids[5]), five.slice(0, 4))).toBeNull();
    expect(MultiCard.admit(note(ids[5]), five)).toMatchObject({ code: 'card_limit_reached' });
  });

  test('refusal text tells the model what to do and never mentions confirmation ids', () => {
    const same = MultiCard.admit(note(A, 'z'), open(note(A)));
    expect(same.error).toMatch(/confirm or cancel that card, then ask/);
    expect(JSON.stringify(same)).not.toMatch(/contract_hash|pending_action/);
  });
});
