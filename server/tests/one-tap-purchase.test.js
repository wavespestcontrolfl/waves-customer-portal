// One-tap purchase (portal roadmap bet 3, owner rulings 2026-08-13):
// init synthesizes a NEW-SERVICE-ONLY draft priced by the same machinery
// that rendered the offer (strict drift 409, P0 per-application parity
// assert, membership snapshot required); reserve/release ride the slot
// reservation service; confirm fails closed (terms, card, owned-in-the-
// meantime) and converts in-transaction with NO SMS anywhere in the flow.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// ── Collaborator mocks ────────────────────────────────────────────────────
// Real surfaces are kept wherever the test exercises them (requireActual
// spreads); full mocks are confined to modules the service only CALLS
// (converter, engine, notifiers) — the assertions are about the calls.

jest.mock('../models/db', () => {
  const state = { tables: {} };
  const clone = (r) => ({ ...r });
  const builder = (table) => {
    const filters = [];
    const q = {
      where(arg) {
        if (arg && typeof arg === 'object') {
          filters.push((r) => Object.entries(arg).every(([k, v]) => r[k] === v || String(r[k]) === String(v)));
        }
        return q;
      },
      whereIn(col, vals) {
        filters.push((r) => (vals || []).map(String).includes(String(r[col])));
        return q;
      },
      whereNull(col) { filters.push((r) => r[col] == null); return q; },
      whereNotNull(col) { filters.push((r) => r[col] != null); return q; },
      orderBy() { return q; },
      forUpdate() { return q; },
      _rows() { return (state.tables[table] || []).filter((r) => filters.every((f) => f(r))); },
      async first() { const r = q._rows()[0]; return r ? clone(r) : undefined; },
      update(patch) {
        const apply = () => {
          const rows = q._rows();
          rows.forEach((r) => Object.assign(r, patch));
          return rows;
        };
        // Thenable (resolves to affected count, knex-style) that also
        // supports .returning(cols) resolving to the updated rows.
        return {
          returning: async () => apply().map(clone),
          then(resolve, reject) { return Promise.resolve(apply().length).then(resolve, reject); },
          catch(reject) { return this.then(undefined, reject); },
        };
      },
      insert(row) {
        return {
          returning: async () => {
            state.tables[table] = state.tables[table] || [];
            const stored = { id: row.id || `${table}-${state.tables[table].length + 1}`, ...row };
            state.tables[table].push(stored);
            return [clone(stored)];
          },
        };
      },
      then(resolve, reject) { return Promise.resolve(q._rows().map(clone)).then(resolve, reject); },
    };
    return q;
  };
  const dbFn = (table) => builder(table);
  dbFn.fn = { now: () => new Date() };
  dbFn.transaction = async (fn) => {
    const trx = (table) => builder(table);
    trx.fn = dbFn.fn;
    trx.isTransaction = true;
    trx.raw = async () => {};
    return fn(trx);
  };
  dbFn.__state = state;
  return dbFn;
});

jest.mock('../services/service-report/cross-sell', () => ({
  ...jest.requireActual('../services/service-report/cross-sell'),
  buildPortalPurchaseBasis: jest.fn(async () => null),
}));
jest.mock('../services/customer-pricing-ai', () => ({
  ...jest.requireActual('../services/customer-pricing-ai'),
  resolvePropertyContext: jest.fn(),
  loadTurfProfile: jest.fn(async () => null),
}));
jest.mock('../services/pricing-engine', () => ({
  needsSync: () => false,
  syncConstantsFromDB: jest.fn(),
  generateEstimate: jest.fn(),
}));
jest.mock('../services/estimate-membership-context', () => ({
  computeMembershipContext: jest.fn(),
}));
jest.mock('../services/estimate-converter', () => ({
  convertEstimate: jest.fn(),
}));
jest.mock('../services/slot-reservation', () => ({
  reserveSlot: jest.fn(),
  releaseReservation: jest.fn(async () => ({ released: true })),
  commitReservation: jest.fn(),
}));
jest.mock('../services/estimate-slot-availability', () => ({
  getAvailableSlots: jest.fn(),
}));
jest.mock('../services/scheduling/occupancy', () => ({
  acquireOccupancyLock: jest.fn(async () => {}),
}));
jest.mock('../utils/customer-comms-lock', () => ({
  lockCustomerComms: jest.fn(async () => {}),
}));
jest.mock('../services/payment-method-consents', () => ({
  findConsentedChargeableCard: jest.fn(async () => null),
}));
jest.mock('../services/waveguard-existing-services', () => ({
  ...jest.requireActual('../services/waveguard-existing-services'),
  loadOwnedRecurringServiceKeys: jest.fn(async () => []),
}));
jest.mock('../services/estimate-accepted-email', () => ({
  sendEstimateAcceptedOnboarding: jest.fn(async () => ({})),
}));
jest.mock('../services/account-membership-email', () => ({
  sendMembershipStarted: jest.fn(async () => ({})),
}));
jest.mock('../services/appointment-reminders', () => ({
  registerAppointment: jest.fn(async () => ({})),
}));
jest.mock('../services/notification-service', () => ({
  notifyCustomer: jest.fn(async () => ({ id: 'n-1' })),
  notifyAdmin: jest.fn(async () => ({})),
}));
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: jest.fn(async () => ({})),
}));
// The no-SMS pin: this module must never be touched by the one-tap flow.
jest.mock('../services/new-recurring-welcome-sms', () => ({
  sendNewRecurringWelcome: jest.fn(),
}));

const db = require('../models/db');
const { buildPortalPurchaseBasis } = require('../services/service-report/cross-sell');
const pricingAi = require('../services/customer-pricing-ai');
const pricingEngine = require('../services/pricing-engine');
const { computeMembershipContext } = require('../services/estimate-membership-context');
const EstimateConverter = require('../services/estimate-converter');
const slotReservation = require('../services/slot-reservation');
const { getAvailableSlots } = require('../services/estimate-slot-availability');
const { findConsentedChargeableCard } = require('../services/payment-method-consents');
const { loadOwnedRecurringServiceKeys } = require('../services/waveguard-existing-services');
const { sendEstimateAcceptedOnboarding } = require('../services/estimate-accepted-email');
const { sendMembershipStarted } = require('../services/account-membership-email');
const NotificationService = require('../services/notification-service');
const { triggerNotification } = require('../services/notification-triggers');
const { sendNewRecurringWelcome } = require('../services/new-recurring-welcome-sms');

const oneTap = require('../services/one-tap-purchase');

// ── Fixtures ─────────────────────────────────────────────────────────────
const CUSTOMER = {
  id: 'cust-1', active: true, deleted_at: null,
  first_name: 'Pat', last_name: 'Customer',
  address_line1: '123 Ocean Ave', address_line2: null,
  city: 'Bradenton', state: 'FL', zip: '34205',
};

const LAWN_LINE = {
  service: 'lawn_care',
  name: 'Lawn Care — 9x applications/yr',
  frequency: 9,
  visitsPerYear: 9,
  monthlyAfterDiscount: 63,
  annualAfterDiscount: 756,
  annual: 756,
};

const ENGINE_RESULT = {
  lineItems: [LAWN_LINE],
  summary: {
    recurringAnnualBeforeDiscount: 800,
    recurringAnnualAfterDiscount: 756,
    recurringMonthlyAfterDiscount: 63,
  },
};

const OFFER_PAYLOAD = {
  serviceKey: 'lawn_care',
  label: 'Lawn Care',
  mode: 'priced',
  relationship: 'add',
  option: {
    id: 'lawn-enhanced', label: 'Lawn care — 9x applications/yr',
    cadence: '9 applications/yr', perVisit: 84, waveguardTier: 'Silver', confidence: 'high',
  },
  fingerprint: 'fp-1',
};

const BASIS = {
  payload: OFFER_PAYLOAD,
  option: { ...OFFER_PAYLOAD.option, serviceKey: 'lawn_care', monthly: 63, annual: 756 },
  result: { currentServiceKeys: ['pest_control'] },
  customer: CUSTOMER,
  ownedKeys: ['pest_control'],
  propertySeed: null,
  primaryStreet: 'street-key',
};

const CLICKED = {
  fingerprint: 'fp-1', serviceKey: 'lawn_care', optionId: 'lawn-enhanced', perApplication: 84,
};

const SLOT = {
  slotId: '2026-08-20_08-00_tech-1.1799999999999.sig',
  date: '2026-08-20', windowStart: '08:00', windowEnd: '10:00',
  techFirstName: 'Adam', techId: 'tech-1',
  routeOptimal: true, nearbyJob: { detourMinutes: 4 },
  durationMinutes: 60,
};

const futureIso = () => new Date(Date.now() + 12 * 3600 * 1000).toISOString();

beforeEach(() => {
  jest.clearAllMocks();
  db.__state.tables = {
    customers: [{ ...CUSTOMER }],
    estimates: [],
    one_tap_purchases: [],
    scheduled_services: [],
  };
  buildPortalPurchaseBasis.mockResolvedValue({
    ...BASIS,
    customer: db.__state.tables.customers[0],
  });
  pricingAi.resolvePropertyContext.mockResolvedValue({
    propertyInput: { homeSqFt: 2000, lawnSqFt: 5000 },
    grassType: 'A', palmCount: null, address: '123 Ocean Ave', source: 'profile', lookup: null,
  });
  pricingEngine.generateEstimate.mockReturnValue(ENGINE_RESULT);
  computeMembershipContext.mockResolvedValue({ tierLabel: 'Silver', existingServiceKeys: ['pest_control'] });
  getAvailableSlots.mockResolvedValue({ primary: [SLOT], expander: [], nearby: true });
  findConsentedChargeableCard.mockResolvedValue({ id: 'pm-1' });
  loadOwnedRecurringServiceKeys.mockResolvedValue(['pest_control']);
});

// ── drift guard ──────────────────────────────────────────────────────────
describe('assertNoDrift (strict client comparison — amounts are never trusted)', () => {
  const { assertNoDrift } = oneTap._private;

  test('an exact match passes', () => {
    expect(() => assertNoDrift(OFFER_PAYLOAD, CLICKED)).not.toThrow();
  });

  test.each([
    ['fingerprint drift', { ...CLICKED, fingerprint: 'fp-old' }],
    ['service key drift', { ...CLICKED, serviceKey: 'tree_shrub' }],
    ['option drift', { ...CLICKED, optionId: 'lawn-standard' }],
    ['price drift', { ...CLICKED, perApplication: 79 }],
    ['string price (Number-coercion trap)', { ...CLICKED, perApplication: '84' }],
    ['missing price', { ...CLICKED, perApplication: null }],
  ])('%s → 409', (_label, clicked) => {
    expect(() => assertNoDrift(OFFER_PAYLOAD, clicked)).toThrow(expect.objectContaining({ status: 409 }));
  });

  test('a non-priced offer can never be purchased', () => {
    expect(() => assertNoDrift({ ...OFFER_PAYLOAD, mode: 'quote_cta' }, CLICKED))
      .toThrow(expect.objectContaining({ status: 409 }));
  });
});

// ── init ─────────────────────────────────────────────────────────────────
describe('initPurchase', () => {
  test('synthesizes the NEW-SERVICE-ONLY draft with the frozen account context', async () => {
    const out = await oneTap.initPurchase({ customerId: 'cust-1', clicked: CLICKED, ip: '1.2.3.4', userAgent: 'jest' });

    expect(out.perVisit).toBe(84);
    expect(out.visitsPerYear).toBe(9);
    expect(out.label).toBe('Lawn Care');
    expect(out.hasCardOnFile).toBe(true);
    expect(out.terms.version).toBe(oneTap.TERMS_VERSION);
    expect(out.terms.text).toBe(oneTap.TERMS_TEXT);
    // detourMinutes is a routing internal — it must never leave the server.
    expect(out.slots.primary[0].routeOptimal).toBe(true);
    expect(out.slots.primary[0].nearbyJob).toBeUndefined();
    expect(JSON.stringify(out.slots)).not.toContain('detourMinutes');

    const estimate = db.__state.tables.estimates[0];
    expect(estimate.status).toBe('draft');
    expect(estimate.source).toBe('one_tap_purchase');
    expect(Number(estimate.annual_total)).toBe(756);
    expect(Number(estimate.onetime_total)).toBe(0);
    expect(estimate.waveguard_tier).toBe('Silver');
    expect(estimate.address).toContain('123 Ocean Ave');
    // Cent-exact annual/monthly correspondence (billing-cadence fallback
    // loses exactness past $0.50).
    expect(Math.abs(Number(estimate.annual_total) - Number(estimate.monthly_total) * 12)).toBeLessThanOrEqual(0.5);

    const estData = JSON.parse(estimate.estimate_data);
    expect(estData.result.recurring.services).toHaveLength(1);
    expect(estData.result.recurring.services[0]).toMatchObject({
      service: 'lawn_care', visitsPerYear: 9, annualAfterDiscount: 756, selected: true, isSelected: true,
    });
    expect(estData.priorQualifyingServices).toEqual(['pest_control']);
    expect(estData.engineInputs.priorQualifyingServices).toEqual(['pest_control']);
    expect(estData.engineInputs.recurringCustomer).toBe(true);
    expect(estData.membershipSnapshot.existingServiceKeys).toEqual(['pest_control']);
    // Converter priority trap: customerSelection.frequency must never be set.
    expect(estData.customerSelection).toBeUndefined();
    expect(estData.oneTapPurchase.fingerprint).toBe('fp-1');

    const purchase = db.__state.tables.one_tap_purchases[0];
    expect(purchase.status).toBe('initiated');
    expect(purchase.fingerprint).toBe('fp-1');
    expect(Number(purchase.per_visit)).toBe(84);
    expect(purchase.terms_snapshot).toBe(oneTap.TERMS_TEXT);

    // The engine run priced ONLY the new option, as a recurring customer.
    const engineInput = pricingEngine.generateEstimate.mock.calls[0][0];
    expect(Object.keys(engineInput.services)).toEqual(['lawn']);
    expect(engineInput.recurringCustomer).toBe(true);
    expect(engineInput.priorQualifyingServices).toEqual(['pest_control']);
  });

  test('drift between the click and the recomputed offer → 409, nothing persists', async () => {
    await expect(oneTap.initPurchase({
      customerId: 'cust-1', clicked: { ...CLICKED, perApplication: 79 },
    })).rejects.toMatchObject({ status: 409 });
    expect(db.__state.tables.estimates).toHaveLength(0);
    expect(db.__state.tables.one_tap_purchases).toHaveLength(0);
  });

  test('no purchasable basis (unpriced/suppressed offer) → 409', async () => {
    buildPortalPurchaseBasis.mockResolvedValue(null);
    await expect(oneTap.initPurchase({ customerId: 'cust-1', clicked: CLICKED }))
      .rejects.toMatchObject({ status: 409 });
  });

  test('P0 parity assert: a synthesized price that diverges from the offer fails closed', async () => {
    pricingEngine.generateEstimate.mockReturnValue({
      ...ENGINE_RESULT,
      lineItems: [{ ...LAWN_LINE, annualAfterDiscount: 720, annual: 720 }],
    });
    await expect(oneTap.initPurchase({ customerId: 'cust-1', clicked: CLICKED }))
      .rejects.toMatchObject({ status: 409 });
    expect(db.__state.tables.estimates).toHaveLength(0);
  });

  test('a proven member whose membership snapshot fails to load is refused', async () => {
    computeMembershipContext.mockResolvedValue(null);
    await expect(oneTap.initPurchase({ customerId: 'cust-1', clicked: CLICKED }))
      .rejects.toMatchObject({ status: 503 });
    expect(db.__state.tables.estimates).toHaveLength(0);
  });

  test('archives the prior open draft and releases its live hold before re-initing', async () => {
    db.__state.tables.one_tap_purchases.push({
      id: 'p-old', customer_id: 'cust-1', estimate_id: 'est-old',
      status: 'reserved', scheduled_service_id: 'ss-old', service_key: 'lawn_care',
    });
    db.__state.tables.estimates.push({
      id: 'est-old', customer_id: 'cust-1', status: 'draft', source: 'one_tap_purchase', archived_at: null,
    });

    await oneTap.initPurchase({ customerId: 'cust-1', clicked: CLICKED });

    expect(slotReservation.releaseReservation).toHaveBeenCalledWith({
      scheduledServiceId: 'ss-old', estimateId: 'est-old',
    });
    const oldPurchase = db.__state.tables.one_tap_purchases.find((p) => p.id === 'p-old');
    expect(oldPurchase.status).toBe('voided');
    const oldEstimate = db.__state.tables.estimates.find((e) => e.id === 'est-old');
    expect(oldEstimate.archived_at).toBeTruthy();
  });

  test('re-init can NEVER void a completed purchase (P0 CAS: status filter inside the update)', async () => {
    db.__state.tables.one_tap_purchases.push({
      id: 'p-done', customer_id: 'cust-1', estimate_id: 'est-done',
      status: 'completed', scheduled_service_id: 'ss-done', service_key: 'lawn_care',
    });

    await oneTap.initPurchase({ customerId: 'cust-1', clicked: CLICKED });

    const done = db.__state.tables.one_tap_purchases.find((p) => p.id === 'p-done');
    expect(done.status).toBe('completed');
    // Its committed visit's hold is never touched either.
    expect(slotReservation.releaseReservation).not.toHaveBeenCalledWith(
      expect.objectContaining({ scheduledServiceId: 'ss-done' }),
    );
  });

  test('customer-facing slot windowEnd is the ARRIVAL window (start + 2h), never the scheduling window_end', async () => {
    getAvailableSlots.mockResolvedValueOnce({
      primary: [{ slotId: 's1', date: '2026-08-20', windowStart: '09:00', windowEnd: '09:30', routeOptimal: true }],
      expander: [],
      nearby: true,
    });
    const out = await oneTap.initPurchase({ customerId: 'cust-1', clicked: CLICKED });
    expect(out.slots.primary[0].windowEnd).toBe('11:00');
  });
});

// ── reserve / release ────────────────────────────────────────────────────
describe('reserve / release', () => {
  beforeEach(() => {
    db.__state.tables.one_tap_purchases.push({
      id: 'p-1', customer_id: 'cust-1', estimate_id: 'est-1', status: 'initiated',
      service_key: 'lawn_care', per_visit: 84, scheduled_service_id: null,
    });
    db.__state.tables.estimates.push({
      id: 'est-1', customer_id: 'cust-1', status: 'draft', expires_at: futureIso(),
      annual_total: 756, price_locked_at: null,
    });
  });

  test('reserve holds the slot and moves the purchase to reserved', async () => {
    slotReservation.reserveSlot.mockResolvedValue({ scheduledServiceId: 'ss-1', expiresAt: futureIso() });
    const out = await oneTap.reserve({ customerId: 'cust-1', purchaseId: 'p-1', slotId: SLOT.slotId });
    expect(out.scheduledServiceId).toBe('ss-1');
    expect(out.holdMinutes).toBe(15);
    expect(slotReservation.reserveSlot).toHaveBeenCalledWith({ estimateId: 'est-1', slotId: SLOT.slotId });
    const purchase = db.__state.tables.one_tap_purchases[0];
    expect(purchase.status).toBe('reserved');
    expect(purchase.scheduled_service_id).toBe('ss-1');
  });

  test('a taken slot maps to 409 SLOT_UNAVAILABLE (client re-picks)', async () => {
    const err = new Error('slot no longer available');
    err.code = 'SLOT_UNAVAILABLE';
    slotReservation.reserveSlot.mockRejectedValue(err);
    await expect(oneTap.reserve({ customerId: 'cust-1', purchaseId: 'p-1', slotId: SLOT.slotId }))
      .rejects.toMatchObject({ status: 409, code: 'SLOT_UNAVAILABLE' });
  });

  test("another customer's purchase id answers 404, never 403", async () => {
    await expect(oneTap.reserve({ customerId: 'cust-2', purchaseId: 'p-1', slotId: SLOT.slotId }))
      .rejects.toMatchObject({ status: 404 });
  });

  test('release frees the hold and returns the purchase to initiated', async () => {
    db.__state.tables.one_tap_purchases[0].status = 'reserved';
    db.__state.tables.one_tap_purchases[0].scheduled_service_id = 'ss-1';
    await oneTap.release({ customerId: 'cust-1', purchaseId: 'p-1' });
    expect(slotReservation.releaseReservation).toHaveBeenCalledWith({
      scheduledServiceId: 'ss-1', estimateId: 'est-1',
    });
    expect(db.__state.tables.one_tap_purchases[0].status).toBe('initiated');
    expect(db.__state.tables.one_tap_purchases[0].scheduled_service_id).toBeNull();
  });
});

// ── confirm ──────────────────────────────────────────────────────────────
describe('confirm', () => {
  const seedReserved = () => {
    db.__state.tables.one_tap_purchases.push({
      id: 'p-1', customer_id: 'cust-1', estimate_id: 'est-1', status: 'reserved',
      service_key: 'lawn_care', option_id: 'lawn-enhanced', per_visit: 84,
      scheduled_service_id: 'ss-1', fingerprint: 'fp-1',
    });
    db.__state.tables.estimates.push({
      id: 'est-1', customer_id: 'cust-1', status: 'draft', expires_at: futureIso(),
      annual_total: 756, monthly_total: 63, price_locked_at: null,
    });
    db.__state.tables.scheduled_services.push({ id: 'ss-1', scheduled_date: '2026-08-20' });
  };

  const COMMITTED_ROW = {
    id: 'ss-1', scheduled_date: '2026-08-20', window_start: '08:00:00',
    window_end: '10:00:00', service_type: 'Lawn Care',
  };

  beforeEach(() => {
    seedReserved();
    slotReservation.commitReservation.mockResolvedValue(COMMITTED_ROW);
    EstimateConverter.convertEstimate.mockResolvedValue({
      membershipEmail: { customerId: 'cust-1' },
      recurringConversionSkipped: false,
      deferredFollowUpReminderRows: [COMMITTED_ROW],
    });
  });

  test('termsAccepted must be exactly true', async () => {
    await expect(oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: 'yes' }))
      .rejects.toMatchObject({ status: 400 });
    await expect(oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1' }))
      .rejects.toMatchObject({ status: 400 });
  });

  test('no consented chargeable card → 402 needsCard, nothing accepted', async () => {
    findConsentedChargeableCard.mockResolvedValue(null);
    await expect(oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: true }))
      .rejects.toMatchObject({ status: 402, needsCard: true });
    expect(db.__state.tables.estimates[0].status).toBe('draft');
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
  });

  test('target family owned in the meantime → 409, purchase voided, hold released', async () => {
    loadOwnedRecurringServiceKeys.mockResolvedValue(['pest_control', 'lawn_care']);
    await expect(oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: true }))
      .rejects.toMatchObject({ status: 409 });
    expect(db.__state.tables.one_tap_purchases[0].status).toBe('voided');
    expect(slotReservation.releaseReservation).toHaveBeenCalledWith({
      scheduledServiceId: 'ss-1', estimateId: 'est-1',
    });
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
  });

  test('an unknowable ownership picture also voids (fail closed)', async () => {
    loadOwnedRecurringServiceKeys.mockRejectedValue(new Error('catalog down'));
    await expect(oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: true }))
      .rejects.toMatchObject({ status: 409 });
    expect(db.__state.tables.one_tap_purchases[0].status).toBe('voided');
  });

  test('happy path: accept + commit + convert in one transaction, then email + bell + push (NO SMS)', async () => {
    const out = await oneTap.confirm({
      customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: true, ip: '1.2.3.4', userAgent: 'jest',
    });

    expect(out.success).toBe(true);
    expect(out.perVisit).toBe(84);
    expect(out.label).toBe('Lawn Care');
    expect(out.firstVisit).toEqual({ date: '2026-08-20', windowStart: '08:00', windowEnd: '10:00' });

    // Acceptance is where money commits — locked in the same update.
    const estimate = db.__state.tables.estimates[0];
    expect(estimate.status).toBe('accepted');
    expect(estimate.price_locked_by).toBe('customer_accept');
    expect(estimate.pricing_authority).toBe('LOCKED');
    expect(Number(estimate.server_computed_price)).toBe(756);

    // Reservation committed with the pre-acquired rung-1 date key, on the txn.
    const commitArgs = slotReservation.commitReservation.mock.calls[0][0];
    expect(commitArgs.scheduledServiceId).toBe('ss-1');
    expect(commitArgs.preLockedDate).toBe('2026-08-20');
    expect(commitArgs.trx).toBeTruthy();
    expect(Number(commitArgs.estimatedPrice)).toBe(84);

    // Converter ran on the SAME transaction with the ruled option set.
    const [, convertOpts] = EstimateConverter.convertEstimate.mock.calls[0];
    expect(convertOpts.database).toBe(commitArgs.trx);
    expect(convertOpts).toMatchObject({
      billingTerm: 'standard',
      skipSetupInvoice: true,
      autoSendInvoice: false,
      skipWelcomeSms: true,
      skipMembershipEmail: true,
      deferFollowUpReminderRegistration: true,
    });

    expect(db.__state.tables.one_tap_purchases[0].status).toBe('completed');
    expect(db.__state.tables.one_tap_purchases[0].consent_ip).toBe('1.2.3.4');

    // Post-commit sends: standard accept emails + deduped customer bell/push
    // + staff bell. And the SMS pin: nothing in this flow touches SMS.
    expect(sendEstimateAcceptedOnboarding).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1', estimateId: 'est-1',
    }));
    expect(sendMembershipStarted).toHaveBeenCalled();
    expect(NotificationService.notifyCustomer).toHaveBeenCalledWith(
      'cust-1', 'service', expect.any(String), expect.any(String),
      expect.objectContaining({ dedupeKey: 'one_tap_purchase:p-1', link: '/' }),
    );
    // No preferenceKey: a marketing pref must not suppress a purchase receipt.
    expect(NotificationService.notifyCustomer.mock.calls[0][4].preferenceKey).toBeUndefined();
    expect(triggerNotification).toHaveBeenCalledWith('one_tap_purchase_completed', expect.objectContaining({
      customerId: 'cust-1',
    }));
    expect(sendNewRecurringWelcome).not.toHaveBeenCalled();
  });

  test('an expired hold mid-confirm 409s and returns the purchase to pick-a-time', async () => {
    const err = new Error('reservation expired');
    err.code = 'RESERVATION_EXPIRED';
    slotReservation.commitReservation.mockRejectedValue(err);
    await expect(oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: true }))
      .rejects.toMatchObject({ status: 409, code: 'RESERVATION_EXPIRED' });
    expect(db.__state.tables.one_tap_purchases[0].status).toBe('initiated');
    expect(db.__state.tables.one_tap_purchases[0].scheduled_service_id).toBeNull();
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
  });

  test('a second confirm on a completed purchase cannot double-accept', async () => {
    await oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: true });
    await expect(oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: true }))
      .rejects.toMatchObject({ status: 409 });
    expect(EstimateConverter.convertEstimate).toHaveBeenCalledTimes(1);
  });
});

// ── route contracts (gate + status mapping) ──────────────────────────────
describe('route contracts', () => {
  const express = require('express');

  let server = null;
  const listen = (app) => new Promise((resolve) => {
    server = app.listen(0, () => resolve(`http://127.0.0.1:${server.address().port}`));
  });

  const serviceMock = {
    initPurchase: jest.fn(),
    reserve: jest.fn(),
    release: jest.fn(),
    slots: jest.fn(),
    confirm: jest.fn(),
  };

  function appWithGate(gateOn) {
    jest.resetModules();
    jest.doMock('../middleware/auth', () => ({
      authenticate: (req, _res, nextFn) => { req.customerId = 'cust-1'; nextFn(); },
    }));
    jest.doMock('../services/one-tap-purchase', () => serviceMock);
    let router;
    jest.isolateModules(() => {
      router = require('../routes/one-tap-purchase');
    });
    const app = express();
    app.use(express.json());
    // The gate reads the env at REQUEST time, so set it per request.
    app.use((req, _res, nextFn) => {
      process.env.GATE_ONE_TAP_PURCHASE = gateOn ? 'true' : '';
      nextFn();
    });
    app.use('/api/one-tap', router);
    return app;
  }

  afterEach(async () => {
    delete process.env.GATE_ONE_TAP_PURCHASE;
    jest.dontMock('../middleware/auth');
    jest.dontMock('../services/one-tap-purchase');
    Object.values(serviceMock).forEach((fn) => fn.mockReset());
    if (server) { await new Promise((resolve) => server.close(resolve)); server = null; }
  });

  const PURCHASE_ID = '11111111-2222-4333-8444-555555555555';

  test('gate off: every endpoint answers 404 Not available', async () => {
    const base = await listen(appWithGate(false));
    const init = await fetch(`${base}/api/one-tap/init`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(init.status).toBe(404);
    expect(await init.json()).toEqual({ error: 'Not available' });
    const slots = await fetch(`${base}/api/one-tap/${PURCHASE_ID}/slots`);
    expect(slots.status).toBe(404);
    const confirm = await fetch(`${base}/api/one-tap/${PURCHASE_ID}/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(confirm.status).toBe(404);
    expect(serviceMock.initPurchase).not.toHaveBeenCalled();
    expect(serviceMock.confirm).not.toHaveBeenCalled();
  });

  test('gate on: init passes the click through and returns the service payload', async () => {
    serviceMock.initPurchase.mockResolvedValue({ purchaseId: PURCHASE_ID, perVisit: 84 });
    const base = await listen(appWithGate(true));
    const r = await fetch(`${base}/api/one-tap/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fingerprint: 'fp-1', serviceKey: 'lawn_care', optionId: 'lawn-enhanced', perApplication: 84 }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ purchaseId: PURCHASE_ID, perVisit: 84 });
    expect(serviceMock.initPurchase).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1',
      clicked: expect.objectContaining({ fingerprint: 'fp-1', perApplication: 84 }),
    }));
  });

  test('gate on: a malformed purchase id 404s before the service runs', async () => {
    const base = await listen(appWithGate(true));
    const r = await fetch(`${base}/api/one-tap/not-a-uuid/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(r.status).toBe(404);
    expect(serviceMock.confirm).not.toHaveBeenCalled();
  });

  test('gate on: service statuses pass through (409 drift, 402 needsCard)', async () => {
    const drift = Object.assign(new Error('offer changed'), { status: 409 });
    serviceMock.initPurchase.mockRejectedValue(drift);
    const needsCard = Object.assign(new Error('card required'), { status: 402, needsCard: true });
    serviceMock.confirm.mockRejectedValue(needsCard);
    const base = await listen(appWithGate(true));
    const init = await fetch(`${base}/api/one-tap/init`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(init.status).toBe(409);
    const confirm = await fetch(`${base}/api/one-tap/${PURCHASE_ID}/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ termsAccepted: true }),
    });
    expect(confirm.status).toBe(402);
    expect(await confirm.json()).toMatchObject({ needsCard: true });
  });
});

// ── recommendations GET carries the oneTap flag ──────────────────────────
describe('GET /api/property-recommendations oneTap flag', () => {
  const express = require('express');
  let server = null;
  const listen = (app) => new Promise((resolve) => {
    server = app.listen(0, () => resolve(`http://127.0.0.1:${server.address().port}`));
  });

  // Default: a per-application account — one-tap eligible. The monthly-
  // membership fence case overrides billing_mode (null = legacy monthly).
  const ELIGIBLE_CUSTOMER = {
    id: 'cust-1', pipeline_stage: 'active_customer', monthly_rate: 89, billing_mode: 'per_application',
  };

  function recsApp({ recsGate, oneTapGate, customerRow = ELIGIBLE_CUSTOMER }) {
    jest.resetModules();
    jest.doMock('../middleware/auth', () => ({
      authenticate: (req, _res, nextFn) => { req.customerId = 'cust-1'; nextFn(); },
    }));
    jest.doMock('../services/property-recommendations', () => ({
      buildPropertyRecommendations: async () => ({ cards: [] }),
      mosquitoNoteCard: async () => null,
    }));
    let router;
    jest.isolateModules(() => {
      router = require('../routes/property-recommendations');
      // Seed the customer row the oneTap fence reads — into the SAME mock-db
      // instance this isolated router resolved (resetModules re-ran the
      // factory, so the file-level db handle is a different instance).
      const isolatedDb = require('../models/db');
      isolatedDb.__state.tables.customers = customerRow ? [{ ...customerRow }] : [];
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, nextFn) => {
      process.env.GATE_PROPERTY_RECOMMENDATIONS = recsGate ? 'true' : '';
      process.env.GATE_ONE_TAP_PURCHASE = oneTapGate ? 'true' : '';
      nextFn();
    });
    app.use('/api/property-recommendations', router);
    return app;
  }

  afterEach(async () => {
    delete process.env.GATE_PROPERTY_RECOMMENDATIONS;
    delete process.env.GATE_ONE_TAP_PURCHASE;
    jest.dontMock('../middleware/auth');
    jest.dontMock('../services/property-recommendations');
    if (server) { await new Promise((resolve) => server.close(resolve)); server = null; }
  });

  test('oneTap mirrors GATE_ONE_TAP_PURCHASE (server-computed, additive)', async () => {
    const on = await listen(recsApp({ recsGate: true, oneTapGate: true }));
    const gotOn = await (await fetch(`${on}/api/property-recommendations/`)).json();
    expect(gotOn).toMatchObject({ available: true, oneTap: true, cards: [] });
    await new Promise((resolve) => server.close(resolve)); server = null;

    const off = await listen(recsApp({ recsGate: true, oneTapGate: false }));
    const gotOff = await (await fetch(`${off}/api/property-recommendations/`)).json();
    expect(gotOff).toMatchObject({ available: true, oneTap: false });
  });

  test('monthly-membership accounts are fenced out of oneTap even with the gate on (P0)', async () => {
    // billing_mode null + monthly_rate > 0 + active = the converter's
    // membership-preserving lane, which would bill the add-on monthly.
    const url = await listen(recsApp({
      recsGate: true,
      oneTapGate: true,
      customerRow: { id: 'cust-1', pipeline_stage: 'active_customer', monthly_rate: 89, billing_mode: null },
    }));
    const got = await (await fetch(`${url}/api/property-recommendations/`)).json();
    expect(got).toMatchObject({ available: true, oneTap: false });
  });

  test('a missing customer row fails closed to oneTap:false', async () => {
    const url = await listen(recsApp({ recsGate: true, oneTapGate: true, customerRow: null }));
    const got = await (await fetch(`${url}/api/property-recommendations/`)).json();
    expect(got).toMatchObject({ available: true, oneTap: false });
  });
});
