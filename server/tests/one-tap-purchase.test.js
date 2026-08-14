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
      where(arg, op, value) {
        if (arg && typeof arg === 'object') {
          filters.push((r) => Object.entries(arg).every(([k, v]) => r[k] === v || String(r[k]) === String(v)));
        } else if (typeof arg === 'string' && op === '<') {
          filters.push((r) => r[arg] != null && new Date(r[arg]) < new Date(value));
        }
        return q;
      },
      select() { return q; },
      whereIn(col, vals) {
        filters.push((r) => (vals || []).map(String).includes(String(r[col])));
        return q;
      },
      whereNull(col) { filters.push((r) => r[col] == null); return q; },
      // Live-hold existence CAS (reserve): evaluate the subquery builder
      // against the same in-memory state.
      whereExists(subFn) {
        filters.push(() => {
          let captured = null;
          const fake = { select: () => fake, from: (t) => { captured = builder(t); return captured; } };
          try {
            subFn.call(fake, fake);
            return captured ? captured._rows().length > 0 : false;
          } catch { return false; }
        });
        return q;
      },
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
  loadExistingQualifyingServiceKeys: jest.fn(async () => ['pest_control']),
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
jest.mock('../services/autopay-enrollment', () => ({
  enrollConsentedMethod: jest.fn(async () => ({ enrolled: true })),
}));
jest.mock('../services/payer', () => ({
  resolveForInvoice: jest.fn(async () => ({ payerId: null })),
}));
jest.mock('../services/appointment-tagger', () => ({
  onServiceScheduled: jest.fn(async () => ({})),
}));
jest.mock('../services/termite-program-agreement', () => ({
  maybeCreateTermiteProgramAgreement: jest.fn(async () => ({})),
}));
// Only the tier-stamp helper is consumed from the (huge) route module —
// never load the real router in this suite.
jest.mock('../routes/estimate-public', () => ({
  treeShrubTierCatalogStamp: jest.fn(async () => null),
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

const { enrollConsentedMethod } = require('../services/autopay-enrollment');
const PayerService = require('../services/payer');
const AppointmentTagger = require('../services/appointment-tagger');
const { maybeCreateTermiteProgramAgreement } = require('../services/termite-program-agreement');
const { treeShrubTierCatalogStamp } = require('../routes/estimate-public');
const AppointmentReminders = require('../services/appointment-reminders');

const oneTap = require('../services/one-tap-purchase');

// ── Fixtures ─────────────────────────────────────────────────────────────
const CUSTOMER = {
  id: 'cust-1', active: true, deleted_at: null,
  first_name: 'Pat', last_name: 'Customer',
  phone: '9415551234', email: 'pat@example.com',
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
    // The confirm transaction forUpdate-locks the consented card's row.
    payment_methods: [{ id: 'pm-1', customer_id: 'cust-1' }],
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
  computeMembershipContext.mockResolvedValue({ tierLabel: 'Silver', existingServiceKeys: ['pest_control'], isExistingCustomer: true });
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

  test('P1 fence: a non-member (snapshot isExistingCustomer false) is refused — their setup fee would be silently waived', async () => {
    computeMembershipContext.mockResolvedValue({
      tierLabel: 'Bronze', existingServiceKeys: [], isExistingCustomer: false,
    });
    await expect(oneTap.initPurchase({ customerId: 'cust-1', clicked: CLICKED }))
      .rejects.toMatchObject({ status: 409 });
    expect(db.__state.tables.estimates).toHaveLength(0);
  });

  test('the synthesized estimate carries the denormalized customer identity the admin list renders/searches', async () => {
    await oneTap.initPurchase({ customerId: 'cust-1', clicked: CLICKED });
    const est = db.__state.tables.estimates[0];
    expect(est.customer_name).toBeTruthy();
    expect(est.customer_phone).toBe(db.__state.tables.customers[0].phone);
    expect(est.customer_email).toBe(db.__state.tables.customers[0].email);
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
describe('initPurchase — GH r5 hardening', () => {
  test('a payer-billed account is refused at init — nothing persists (GH r6 P0)', async () => {
    PayerService.resolveForInvoice.mockResolvedValueOnce({ payerId: 'payer-1' });
    await expect(oneTap.initPurchase({ customerId: 'cust-1', clicked: CLICKED }))
      .rejects.toMatchObject({ status: 409 });
    expect(db.__state.tables.one_tap_purchases).toHaveLength(0);
    expect(db.__state.tables.estimates).toHaveLength(0);
  });

  test('init records NO consent metadata — the customer has not agreed to anything yet', async () => {
    await oneTap.initPurchase({ customerId: 'cust-1', clicked: CLICKED });
    const purchase = db.__state.tables.one_tap_purchases[0];
    expect(purchase.consent_ip == null).toBe(true);
    expect(purchase.consent_user_agent == null).toBe(true);
  });

  test('a slot-load failure after the insert voids + archives the fresh purchase (GH r10 P2)', async () => {
    getAvailableSlots.mockRejectedValue(new Error('availability down'));
    await expect(oneTap.initPurchase({ customerId: 'cust-1', clicked: CLICKED }))
      .rejects.toMatchObject({ status: 503 });
    // The client never learned purchaseId — nothing can release it, so init
    // must clean up its own litter instead of leaving it for the 24h sweep.
    expect(db.__state.tables.one_tap_purchases[0].status).toBe('voided');
    expect(db.__state.tables.estimates[0].archived_at).toBeTruthy();
    getAvailableSlots.mockResolvedValue({ primary: [SLOT], expander: [], nearby: true });
  });

  test('an engine run that produces a due-at-start/one-time component refuses (belt to the offer demotion)', async () => {
    pricingEngine.generateEstimate.mockReturnValue({
      ...ENGINE_RESULT,
      lineItems: [{ ...LAWN_LINE, installation: { price: 300 } }],
    });
    await expect(oneTap.initPurchase({ customerId: 'cust-1', clicked: CLICKED }))
      .rejects.toMatchObject({ status: 409 });
    expect(db.__state.tables.one_tap_purchases).toHaveLength(0);
    expect(db.__state.tables.estimates).toHaveLength(0);
  });
});

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
    // The live hold row the reserve CAS's whereExists checks.
    db.__state.tables.scheduled_services = [{
      id: 'ss-1', reservation_expires_at: futureIso(),
    }];
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

  test('release is TERMINAL: frees the hold, voids the purchase, archives the draft (no admin-pipeline litter)', async () => {
    db.__state.tables.one_tap_purchases[0].status = 'reserved';
    db.__state.tables.one_tap_purchases[0].scheduled_service_id = 'ss-1';
    db.__state.tables.estimates[0].source = 'one_tap_purchase';
    db.__state.tables.estimates[0].archived_at = null;
    await oneTap.release({ customerId: 'cust-1', purchaseId: 'p-1' });
    expect(slotReservation.releaseReservation).toHaveBeenCalledWith({
      scheduledServiceId: 'ss-1', estimateId: 'est-1',
    });
    expect(db.__state.tables.one_tap_purchases[0].status).toBe('voided');
    expect(db.__state.tables.one_tap_purchases[0].scheduled_service_id).toBeNull();
    expect(db.__state.tables.estimates[0].archived_at).toBeTruthy();
  });
});

// ── confirm ──────────────────────────────────────────────────────────────
describe('confirm', () => {
  // The frozen one-tap snapshot the confirm-time revalidation reasserts
  // against the ledger row (fingerprint/option/per-visit + single recurring
  // line + totals that divide back to the accepted per-application amount).
  const SNAPSHOT_EST_DATA = () => JSON.stringify({
    result: { recurring: { services: [{ ...LAWN_LINE, selected: true, isSelected: true }] } },
    priorQualifyingServices: ['pest_control'],
    oneTapPurchase: { fingerprint: 'fp-1', optionId: 'lawn-enhanced', perVisit: 84 },
  });

  const seedReserved = () => {
    db.__state.tables.one_tap_purchases.push({
      id: 'p-1', customer_id: 'cust-1', estimate_id: 'est-1', status: 'reserved',
      service_key: 'lawn_care', option_id: 'lawn-enhanced', per_visit: 84,
      scheduled_service_id: 'ss-1', fingerprint: 'fp-1',
    });
    db.__state.tables.estimates.push({
      id: 'est-1', customer_id: 'cust-1', status: 'draft', expires_at: futureIso(),
      annual_total: 756, monthly_total: 63, price_locked_at: null,
      estimate_data: SNAPSHOT_EST_DATA(),
    });
    db.__state.tables.scheduled_services.push({
      id: 'ss-1', scheduled_date: '2026-08-20', window_start: '08:00:00', service_type: 'Lawn Care',
    });
  };

  const COMMITTED_ROW = {
    id: 'ss-1', scheduled_date: '2026-08-20', window_start: '08:00:00',
    window_end: '10:00:00', service_type: 'Lawn Care',
  };
  // A seeded follow-up — deferredFollowUpReminderRows carries ONLY these in
  // production (the committed parent is excluded by the converter contract).
  const FOLLOW_UP_ROW = {
    id: 'ss-2', scheduled_date: '2026-10-01', window_start: '08:00:00',
    window_end: '10:00:00', service_type: 'Lawn Care',
  };

  beforeEach(() => {
    seedReserved();
    slotReservation.commitReservation.mockResolvedValue(COMMITTED_ROW);
    EstimateConverter.convertEstimate.mockResolvedValue({
      membershipEmail: { customerId: 'cust-1' },
      recurringConversionSkipped: false,
      deferredFollowUpReminderRows: [FOLLOW_UP_ROW],
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
    expect(out.emailQueued).toBe(true);

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

  test('a retry on a completed purchase is IDEMPOTENT: canonical success back, no second conversion', async () => {
    const first = await oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: true });
    const retry = await oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: true });
    expect(retry.success).toBe(true);
    expect(retry.perVisit).toBe(first.perVisit);
    expect(retry.firstVisit).toEqual(first.firstVisit);
    // The purchase happened exactly once — a lost HTTP response must never
    // become a double-accept OR a "nothing was purchased" screen.
    expect(EstimateConverter.convertEstimate).toHaveBeenCalledTimes(1);
  });

  test('qualifying membership cancelled between init and confirm → 409 + void (setup-fee waiver no longer applies)', async () => {
    const { loadExistingQualifyingServiceKeys } = require('../services/waveguard-existing-services');
    loadExistingQualifyingServiceKeys.mockResolvedValue([]);
    await expect(oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: true }))
      .rejects.toMatchObject({ status: 409 });
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
    expect(db.__state.tables.one_tap_purchases[0].status).toBe('voided');
    loadExistingQualifyingServiceKeys.mockResolvedValue(['pest_control']);
  });

  test('no email on file: emailQueued false and the notification never promises an email', async () => {
    db.__state.tables.customers[0].email = null;
    const out = await oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: true });
    expect(out.emailQueued).toBe(false);
    const body = NotificationService.notifyCustomer.mock.calls[0][3];
    expect(body).not.toMatch(/confirmation email/i);
  });

  // ── In-transaction card revalidation (GH r10 P1): a card removed after
  // the advisory pre-check must fail the confirm, never book an
  // unprotected series.
  test('a card removed mid-confirm 402s inside the transaction — nothing accepted', async () => {
    findConsentedChargeableCard
      .mockResolvedValueOnce({ id: 'pm-1' }) // advisory pre-check
      .mockResolvedValueOnce(null); // in-transaction authority
    await expect(oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: true }))
      .rejects.toMatchObject({ status: 402, needsCard: true });
    expect(db.__state.tables.estimates[0].status).toBe('draft');
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
  });

  // ── Opt-out preservation (GH r10 P1): enrollment carries the
  // confirmation moment so a disable committed after it wins.
  test('post-commit enrollment passes the confirmation moment as authorizedAt', async () => {
    const before = new Date();
    await oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: true });
    const args = enrollConsentedMethod.mock.calls[0][0];
    expect(args.authorizedAt).toBeInstanceOf(Date);
    expect(args.authorizedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 5);
    expect(args.authorizedAt.getTime()).toBeLessThanOrEqual(Date.now() + 5);
  });

  // ── Per-property membership scoping (pre-push P0): the qualifying
  // re-check must use the SAME street scope as the ownership check — an
  // account-wide lookup lets a qualifying service on ANOTHER property
  // replay the member discount + setup-fee waiver for a primary property
  // whose own membership lapsed mid-flight.
  test('the qualifying membership re-check is street-scoped exactly like the ownership check', async () => {
    const { loadExistingQualifyingServiceKeys } = require('../services/waveguard-existing-services');
    await oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: true });
    const ownScope = loadOwnedRecurringServiceKeys.mock.calls[0][2].streetScope;
    expect(ownScope).toBeTruthy();
    expect(loadExistingQualifyingServiceKeys.mock.calls.length).toBeGreaterThan(0);
    for (const call of loadExistingQualifyingServiceKeys.mock.calls) {
      expect(call[2]).toEqual({ streetScope: ownScope });
    }
  });

  // ── Frozen-offer revalidation (GH r5 P1): the open draft is an ordinary
  // editable draft — an operator PUT can rewrite totals/estimate_data while
  // the ledger stays frozen at the original offer. Any divergence refuses.
  test('an operator-revised draft (snapshot stripped by PUT) can never convert', async () => {
    db.__state.tables.estimates[0].estimate_data = JSON.stringify({
      result: { recurring: { services: [{ ...LAWN_LINE, name: 'Different Plan' }] } },
    });
    await expect(oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: true }))
      .rejects.toMatchObject({ status: 409 });
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
    expect(db.__state.tables.estimates[0].status).toBe('draft');
  });

  test('an operator-revised annual total that no longer divides to the accepted per-application amount refuses', async () => {
    db.__state.tables.estimates[0].annual_total = 999;
    await expect(oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: true }))
      .rejects.toMatchObject({ status: 409 });
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
  });

  // ── Auto Pay enrollment (GH r5 P1): consent-row presence alone is not
  // charging protection — the accept-path enrollment semantics must run.
  test('confirm enrolls the consented card into Auto Pay post-commit', async () => {
    await oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: true });
    expect(enrollConsentedMethod).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1', paymentMethodId: 'pm-1', source: 'one_tap_purchase',
    }));
  });

  // ── Payer fence (GH r6 P0): payer-billed accounts are refused OUTRIGHT —
  // the flow's card-collection step (/api/billing/cards) enrolls Auto Pay
  // the moment a card saves, before any confirm-time guard could run.
  test('a payer-billed account is refused at confirm: 409 + void, no conversion, no enrollment', async () => {
    PayerService.resolveForInvoice.mockResolvedValue({ payerId: 'payer-1' });
    await expect(oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: true }))
      .rejects.toMatchObject({ status: 409 });
    expect(db.__state.tables.one_tap_purchases[0].status).toBe('voided');
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
    expect(enrollConsentedMethod).not.toHaveBeenCalled();
    PayerService.resolveForInvoice.mockResolvedValue({ payerId: null });
  });

  test('an unknowable payer picture fails CLOSED at confirm (409 + void)', async () => {
    PayerService.resolveForInvoice.mockRejectedValue(new Error('payer lookup down'));
    await expect(oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: true }))
      .rejects.toMatchObject({ status: 409 });
    expect(db.__state.tables.one_tap_purchases[0].status).toBe('voided');
    expect(enrollConsentedMethod).not.toHaveBeenCalled();
    PayerService.resolveForInvoice.mockResolvedValue({ payerId: null });
  });

  test('a refused enrollment parks a billing office exception — the purchase stands', async () => {
    enrollConsentedMethod.mockResolvedValueOnce({ enrolled: false, reason: 'method_removed' });
    const out = await oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: true });
    expect(out.success).toBe(true);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(
      'billing', expect.stringMatching(/Auto Pay enrollment refused/),
      expect.stringMatching(/method_removed/), expect.any(Object),
    );
  });

  // ── Committed-visit automations (GH r5 P2 ×2): the parent row gets its
  // own reminder registration and the standard appointment-type tagger —
  // deferred rows carry only the seeded follow-ups.
  test('the committed first visit is reminder-registered and tagged; follow-ups keep theirs', async () => {
    await oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: true });
    const registeredIds = AppointmentReminders.registerAppointment.mock.calls.map((c) => c[0]);
    expect(registeredIds).toEqual(expect.arrayContaining(['ss-1', 'ss-2']));
    expect(AppointmentTagger.onServiceScheduled).toHaveBeenCalledWith('ss-1', { suppressWelcome: true });
  });

  // ── T&S tier stamp (GH r5 P1): the committed row gets the purchased
  // tier's catalog identity before the converter seeds follow-ups.
  test('a tree & shrub purchase stamps the committed row with the tier catalog identity inside the trx', async () => {
    db.__state.tables.one_tap_purchases[0].service_key = 'tree_shrub';
    db.__state.tables.one_tap_purchases[0].option_id = 'tree-standard';
    // Keep the frozen snapshot in lock-step with the ledger (the
    // revalidation reasserts fingerprint/option/per-visit).
    db.__state.tables.estimates[0].estimate_data = JSON.stringify({
      result: { recurring: { services: [{ ...LAWN_LINE, name: 'Standard tree & shrub care' }] } },
      oneTapPurchase: { fingerprint: 'fp-1', optionId: 'tree-standard', perVisit: 84 },
    });
    treeShrubTierCatalogStamp.mockResolvedValueOnce({
      service_id: 'svc-ts', service_type: 'Bi-Monthly Tree & Shrub Care Service',
    });
    await oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: true });
    // Standard variant → selectedFrequency source-1 key 'standard'.
    expect(treeShrubTierCatalogStamp).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      selectedFrequency: { serviceCategory: 'tree_shrub', key: 'standard' },
      rowServiceType: 'Lawn Care',
    }));
    expect(db.__state.tables.scheduled_services[0].service_id).toBe('svc-ts');
    expect(db.__state.tables.scheduled_services[0].service_type).toBe('Bi-Monthly Tree & Shrub Care Service');
  });

  test('non-T&S purchases never call the tier stamp', async () => {
    await oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: true });
    expect(treeShrubTierCatalogStamp).not.toHaveBeenCalled();
  });

  // ── Termite agreement hook (GH r5 P2): same post-commit prep the public
  // and manual acceptance paths run; non-termite skips entirely.
  test('a termite purchase preps the program agreement from the ACCEPTED row', async () => {
    db.__state.tables.one_tap_purchases[0].service_key = 'termite';
    await oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: true });
    expect(maybeCreateTermiteProgramAgreement).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1',
      billingTerm: 'standard',
      estimate: expect.objectContaining({ id: 'est-1', status: 'accepted' }),
    }));
  });

  test('non-termite purchases never touch the agreement service', async () => {
    await oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: true });
    expect(maybeCreateTermiteProgramAgreement).not.toHaveBeenCalled();
  });

  // ── Concurrent-confirm idempotency (GH r7 P2): a confirm that started
  // while the row was reserved but loses the row-lock race to a completing
  // confirm must get the canonical success back, never the generic 409.
  test('a confirm that finds the row completed under the lock answers canonically', async () => {
    const { acquireOccupancyLock } = require('../services/scheduling/occupancy');
    acquireOccupancyLock.mockImplementationOnce(async () => {
      // Simulate the other tab's confirm committing while this one waits.
      db.__state.tables.one_tap_purchases[0].status = 'completed';
    });
    const out = await oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: true });
    expect(out.success).toBe(true);
    expect(out.perVisit).toBe(84);
    expect(out.firstVisit).toEqual({ date: '2026-08-20', windowStart: '08:00', windowEnd: '10:00' });
    // The loser converts nothing and re-sends nothing.
    expect(EstimateConverter.convertEstimate).not.toHaveBeenCalled();
    expect(NotificationService.notifyCustomer).not.toHaveBeenCalled();
  });

  // ── Re-pick recovery is hold-identity-aware (GH r5 P2): a concurrent
  // re-reserve that already replaced the pointer must not be erased by the
  // failed confirm's reset.
  test('the expired-hold reset never clobbers a hold reserved after this confirm started', async () => {
    const err = new Error('reservation expired');
    err.code = 'RESERVATION_EXPIRED';
    slotReservation.commitReservation.mockImplementation(async () => {
      // Simulate the customer re-picking mid-confirm: the row now points at
      // a NEW hold before the old one's failure surfaces.
      db.__state.tables.one_tap_purchases[0].scheduled_service_id = 'ss-9';
      throw err;
    });
    await expect(oneTap.confirm({ customerId: 'cust-1', purchaseId: 'p-1', termsAccepted: true }))
      .rejects.toMatchObject({ status: 409, code: 'RESERVATION_EXPIRED' });
    expect(db.__state.tables.one_tap_purchases[0].scheduled_service_id).toBe('ss-9');
    expect(db.__state.tables.one_tap_purchases[0].status).toBe('reserved');
  });
});

// ── purchase state (resume) + stale-draft sweep ──────────────────────────
describe('getPurchaseState / sweepStaleOneTapDrafts', () => {
  test('returns the resume snapshot with the live hold and arrival window', async () => {
    db.__state.tables.customers.push({ ...CUSTOMER });
    db.__state.tables.one_tap_purchases.push({
      id: 'p-1', customer_id: 'cust-1', estimate_id: 'est-1', status: 'reserved',
      service_key: 'lawn_care', per_visit: 84, scheduled_service_id: 'ss-1',
      terms_version: 'v1', terms_snapshot: 'Terms.',
    });
    db.__state.tables.estimates.push({
      id: 'est-1', customer_id: 'cust-1', status: 'draft', expires_at: futureIso(),
      estimate_data: JSON.stringify({ result: { recurring: { services: [LAWN_LINE] } } }),
    });
    db.__state.tables.scheduled_services = [{
      id: 'ss-1', scheduled_date: '2026-08-20', window_start: '09:00',
      reservation_expires_at: futureIso(),
    }];
    findConsentedChargeableCard.mockResolvedValue({ id: 'pm-row' });

    const state = await oneTap.getPurchaseState({ customerId: 'cust-1', purchaseId: 'p-1' });
    expect(state).toMatchObject({
      purchaseId: 'p-1', status: 'reserved', open: true, holdLive: true,
      perVisit: 84, hasCardOnFile: true,
      terms: { version: 'v1', text: 'Terms.' },
    });
    expect(state.slot).toMatchObject({ date: '2026-08-20', windowStart: '09:00', windowEnd: '11:00' });
  });

  test('another customer 404s; sweep voids open purchases on expired drafts and archives them', async () => {
    db.__state.tables.one_tap_purchases.push({
      id: 'p-x', customer_id: 'cust-2', estimate_id: 'est-x', status: 'initiated',
      service_key: 'lawn_care', per_visit: 84,
    });
    await expect(oneTap.getPurchaseState({ customerId: 'cust-1', purchaseId: 'p-x' }))
      .rejects.toMatchObject({ status: 404 });

    db.__state.tables.estimates.push({
      id: 'est-x', customer_id: 'cust-2', status: 'draft', source: 'one_tap_purchase',
      archived_at: null, expires_at: new Date(Date.now() - 60000).toISOString(),
    });
    const swept = await oneTap.sweepStaleOneTapDrafts();
    expect(swept.voided).toBe(1);
    expect(db.__state.tables.one_tap_purchases.find((p) => p.id === 'p-x').status).toBe('voided');
    expect(db.__state.tables.estimates.find((e) => e.id === 'est-x').archived_at).toBeTruthy();
  });

  test('the sweep also retires one-tap estimates ALREADY flipped to expired (GH r9 P1)', async () => {
    // The generic 06:00 expiration sweep used to flip past-due one-tap
    // drafts to 'expired' before this sweep ran — a draft-only predicate
    // excluded them permanently (open ledger, unarchived estimate).
    db.__state.tables.one_tap_purchases.push({
      id: 'p-y', customer_id: 'cust-1', estimate_id: 'est-y', status: 'reserved',
      service_key: 'lawn_care', per_visit: 84,
    });
    db.__state.tables.estimates.push({
      id: 'est-y', customer_id: 'cust-1', status: 'expired', source: 'one_tap_purchase',
      archived_at: null, expires_at: new Date(Date.now() - 60000).toISOString(),
    });
    const swept = await oneTap.sweepStaleOneTapDrafts();
    expect(swept.voided).toBe(1);
    expect(db.__state.tables.one_tap_purchases.find((p) => p.id === 'p-y').status).toBe('voided');
    expect(db.__state.tables.estimates.find((e) => e.id === 'est-y').archived_at).toBeTruthy();
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

  test('confirm keeps its OWN rate allowance — reserve churn can never 429 the required confirmation (GH r11 P2)', async () => {
    serviceMock.reserve.mockResolvedValue({ scheduledServiceId: 'ss-1', expiresAt: new Date().toISOString(), holdMinutes: 15 });
    serviceMock.confirm.mockResolvedValue({ success: true, perVisit: 84, label: 'Lawn Care', emailQueued: true, firstVisit: null });
    const base = await listen(appWithGate(true));
    // Exhaust the init/reserve limiter (max 10/hr, shared instance).
    for (let i = 0; i < 10; i += 1) {
      const r = await fetch(`${base}/api/one-tap/${PURCHASE_ID}/reserve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slotId: `slot-${i}` }),
      });
      expect(r.status).toBe(200);
    }
    const eleventh = await fetch(`${base}/api/one-tap/${PURCHASE_ID}/reserve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slotId: 'slot-x' }),
    });
    expect(eleventh.status).toBe(429);
    // The confirmation that completes the purchase must still get through.
    const confirm = await fetch(`${base}/api/one-tap/${PURCHASE_ID}/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ termsAccepted: true }),
    });
    expect(confirm.status).toBe(200);
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

  function recsApp({ recsGate, oneTapGate, customerRow = ELIGIBLE_CUSTOMER, qualifyingKeys = ['pest_control'], payer = { payerId: null } }) {
    jest.resetModules();
    jest.doMock('../middleware/auth', () => ({
      authenticate: (req, _res, nextFn) => { req.customerId = 'cust-1'; nextFn(); },
    }));
    jest.doMock('../services/payer', () => ({
      resolveForInvoice: jest.fn(async () => {
        if (payer instanceof Error) throw payer;
        return payer;
      }),
    }));
    jest.doMock('../services/waveguard-existing-services', () => ({
      loadExistingQualifyingServiceKeys: jest.fn(async () => qualifyingKeys),
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
    jest.dontMock('../services/payer');
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

  test('a non-member (no qualifying recurring services) is fenced out of oneTap — init would refuse them', async () => {
    const url = await listen(recsApp({ recsGate: true, oneTapGate: true, qualifyingKeys: [] }));
    const got = await (await fetch(`${url}/api/property-recommendations/`)).json();
    expect(got).toMatchObject({ available: true, oneTap: false });
  });

  test('a payer-billed account is fenced out of oneTap — the card-collection step would enroll the wrong party (GH r6 P0)', async () => {
    const url = await listen(recsApp({ recsGate: true, oneTapGate: true, payer: { payerId: 'payer-1' } }));
    const got = await (await fetch(`${url}/api/property-recommendations/`)).json();
    expect(got).toMatchObject({ available: true, oneTap: false });
  });

  test('an unknowable payer picture fails closed to oneTap:false', async () => {
    const url = await listen(recsApp({ recsGate: true, oneTapGate: true, payer: new Error('payer lookup down') }));
    const got = await (await fetch(`${url}/api/property-recommendations/`)).json();
    expect(got).toMatchObject({ available: true, oneTap: false });
  });
});
