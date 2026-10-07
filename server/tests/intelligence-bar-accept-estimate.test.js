/**
 * accept_estimate (owner ruling 2026-10-07, Q5): the Intelligence Bar accepts
 * an estimate exactly as the estimate page's "Mark accepted" does, behind one
 * irreversible confirm card that shows what it bills, books and sends.
 *
 * The scenario: a lawn customer (Lawn $55.00 a month on the bill) says yes to
 * a pest + mosquito add-on estimate. The card must list both new services, the
 * whole bill before and after, the lane and tier, that no visit is booked, and
 * the membership-started email. Synthetic names only.
 */
process.env.GATE_PLAN_RATE_LEDGER = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const tables = {};
const reads = [];
const writes = [];

// Table-aware fake: where/first/select return the seeded rows for that table;
// any write is recorded so the suite can prove the preview never writes.
jest.mock('../models/db', () => {
  const builder = (table) => {
    const q = {};
    for (const m of ['where', 'whereNull', 'whereNotNull', 'whereNotIn', 'whereIn', 'orderBy', 'orWhereNot', 'limit', 'whereRaw']) q[m] = () => q;
    q.first = () => { reads.push(table); return Promise.resolve((tables[table] || [])[0]); };
    q.select = () => Promise.resolve(tables[table] || []);
    q.then = (resolve, reject) => Promise.resolve(tables[table] || []).then(resolve, reject);
    for (const m of ['insert', 'update', 'del', 'delete']) q[m] = (...args) => { writes.push({ table, op: m, args }); return q; };
    return q;
  };
  const db = jest.fn((table) => builder(table));
  db.schema = { hasTable: async () => true };
  db.raw = jest.fn();
  db.transaction = jest.fn(async (cb) => cb(db));
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/admin-estimates', () => ({ markEstimateAcceptedAsStaff: jest.fn() }));

const Converter = require('../services/estimate-converter');
const { markEstimateAcceptedAsStaff } = require('../routes/admin-estimates');
const { executeEstimateAcceptTool, ESTIMATE_ACCEPT_TOOLS } = require('../services/intelligence-bar/estimate-accept-tools');
const AuthorizationContract = require('../services/intelligence-bar/authorization-contract');
const { WRITE_TWO_STEP_TOOL_NAMES } = require('../services/intelligence-bar/write-gates');
const ActionRegistry = require('../services/intelligence-bar/action-registry');

const ESTIMATE_ID = '00000000-0000-0000-0000-0000000ac001';
const CUSTOMER_ID = '00000000-0000-0000-0000-0000000ac002';
const OTHER_CUSTOMER_ID = '00000000-0000-0000-0000-0000000ac003';
const INPUT = { estimate_id: ESTIMATE_ID, customer_id: CUSTOMER_ID };

function seed(overrides = {}) {
  tables.estimates = [{
    id: ESTIMATE_ID, token: 'addonquote42', status: 'sent', customer_id: CUSTOMER_ID,
    monthly_total: 90, onetime_total: 0, waveguard_tier: 'Gold', updated_at: '2026-10-06T12:00:00.000Z',
    estimate_data: {
      recurring: {
        services: [
          { name: 'Quarterly Pest Control', service: 'pest_control', visitsPerYear: 4, monthly: 49 },
          { name: 'Mosquito Barrier', service: 'mosquito', visitsPerYear: 17, monthly: 41 },
        ],
      },
    },
    ...overrides.estimate,
  }];
  tables.customers = [{
    id: CUSTOMER_ID, first_name: 'Lena', last_name: 'Synthetic', email: 'lena.synthetic@example.com',
    pipeline_stage: 'active_customer', monthly_rate: 55, billing_mode: 'per_application', waveguard_tier: 'Bronze',
    updated_at: '2026-10-05T09:00:00.000Z', ...overrides.customer,
  }];
  tables.customer_plan_rates = overrides.ledger || [{ family_key: 'lawn_care', monthly_rate: 55 }];
  tables.notification_prefs = overrides.prefs || [];
  tables.scheduled_services = overrides.booked || [];
}

let classify;
let priorKeys;
beforeEach(() => {
  process.env.GATE_IB_ACCEPT_ESTIMATE = 'true';
  delete process.env.GATE_TERMITE_PROGRAM_AGREEMENT_AUTOSEND;
  reads.length = 0;
  writes.length = 0;
  seed();
  markEstimateAcceptedAsStaff.mockReset();
  // A proven-disjoint add-on: the lawn plan stays and the new services add on.
  classify = jest.spyOn(Converter, 'classifyAddOnAcceptContext')
    .mockResolvedValue({ addOnBase: 55, hadOtherLiveFamilies: false, sameFamilyAtOtherProperty: false });
  // The customer's live qualifying services (no frozen snapshot on this quote).
  priorKeys = jest.spyOn(require('../services/waveguard-existing-services'), 'loadExistingQualifyingServiceKeys')
    .mockResolvedValue(['lawn_care']);
});
afterEach(() => { classify.mockRestore(); priorKeys.mockRestore(); });
afterAll(() => { delete process.env.GATE_IB_ACCEPT_ESTIMATE; });

const card = (preview) => AuthorizationContract.buildContract({
  toolName: 'accept_estimate', params: INPUT, displayParams: {}, preview,
});
const labels = (contract) => contract.effects.map((e) => e.label);

describe('the card for a lawn customer saying yes to a pest + mosquito add-on', () => {
  test('lists each new service, the whole bill before and after, lane, tier, visits and the email', async () => {
    const preview = await executeEstimateAcceptTool('accept_estimate', INPUT);
    expect(preview.error).toBeUndefined();
    expect(preview.preview).toBe(true);
    const lines = labels(card(preview));
    expect(lines).toEqual(expect.arrayContaining([
      'Accepts estimate addonquo for Lena Synthetic: $90.00 a month',
      expect.stringMatching(/^Starts Pest control \(Quarterly Pest Control\): 4 visits a year, \$49\.00 a month$/),
      expect.stringMatching(/^Starts Mosquito \(Mosquito Barrier\): 17 visits a year, \$41\.00 a month$/),
      'Bill line Lawn care: $55.00 → $55.00 a month',
      'Bill line Pest control: $0.00 → $49.00 a month',
      'Bill line Mosquito: $0.00 → $41.00 a month',
      'Bill total: $55.00 → $145.00 a month (added to the existing plan)',
      'Billing lane: billed per application (each visit) → billed per application (each visit) (unchanged)',
      'Tier: Bronze → Gold',
      'No setup invoice, no charge and no receipt now',
      'Visits: books none — book the first visit on the calendar after',
      'Message: Email "membership started" to l***@example.com right after Confirm: plan, tier, rate and services (sent once per estimate)',
      'Message: No welcome text now (Mark accepted skips it). Booking the first visit later on the calendar may send it',
    ]));
    expect(writes).toEqual([]);
  });

  test('a one-time estimate does not promise a plan, a bill change or customer activation', async () => {
    seed({ estimate: { monthly_total: 0, onetime_total: 350, estimate_data: { result: { oneTime: { items: [{ service: 'german_roach', name: 'German Roach Cleanout', price: 350 }] } } } } });
    const preview = await executeEstimateAcceptTool('accept_estimate', INPUT);
    const lines = labels(card(preview));
    expect(lines).toEqual(expect.arrayContaining([
      'Accepts estimate addonquo for Lena Synthetic: $0.00 a month, $350.00 one-time',
      'Bill: unchanged — a one-time estimate only changes status here. Schedule and invoice the work by hand',
      "Marks the estimate accepted and locks its price; a linked lead is marked won; the customer's status and plan stay as they are",
      'Message: No email or text: a one-time estimate only changes status here',
    ]));
    expect(lines.some((l) => /becomes an active customer|^Starts |^Bill line/.test(l))).toBe(false);
    expect(card(preview).notifies_customer).toBe(false);
  });

  test('a commercial one-time estimate discloses the commercial property stamp', async () => {
    seed({
      estimate: {
        monthly_total: 0, onetime_total: 640,
        estimate_data: { result: { oneTime: { items: [{ service: 'commercial_trenching', name: 'Commercial Trenching', price: 640, isCommercial: true, commercialPricingMode: 'auto_estimate' }] } } },
      },
      customer: { property_type: 'residential' },
    });
    const lines = labels(card(await executeEstimateAcceptTool('accept_estimate', INPUT)));
    expect(lines).toContain('Property type: residential → commercial (later invoices charge sales tax on taxable commercial services)');
  });

  test('a pinned legacy rodent-only plan goes on monthly dues, as the converter stamps it', async () => {
    seed({
      estimate: {
        monthly_total: 49,
        estimate_data: { recurring: { services: [{ name: 'Rodent Bait Stations', service: 'rodent_bait', legacyPinnedReplay: true, monthly: 49 }] } },
      },
      customer: { pipeline_stage: 'lead', monthly_rate: 0, billing_mode: null, waveguard_tier: null },
      ledger: [],
    });
    const lines = labels(card(await executeEstimateAcceptTool('accept_estimate', INPUT)));
    expect(lines).toContain('Billing lane: none → monthly membership dues');
  });

  test('the tier is the one the accept activates, not only what the quote says', async () => {
    // A legacy quote still says Silver, but with the live lawn plan the accept
    // counts three services and activates Gold; the card says Gold.
    seed({ estimate: { waveguard_tier: 'Silver' } });
    expect(labels(card(await executeEstimateAcceptTool('accept_estimate', INPUT)))).toContain('Tier: Bronze → Gold');
    // A frozen snapshot on the quote wins over the live lookup, as in the converter.
    seed({ estimate: { estimate_data: { ...tables.estimates[0].estimate_data, membershipSnapshot: { existingServiceKeys: [] } } } });
    expect(labels(card(await executeEstimateAcceptTool('accept_estimate', INPUT)))).toContain('Tier: Bronze → Silver');
  });

  test('is irreversible and tells the operator the customer will be emailed', async () => {
    const contract = card(await executeEstimateAcceptTool('accept_estimate', INPUT));
    expect(contract.irreversible).toBe(true);
    expect(contract.notifies_customer).toBe(true);
    expect(contract.action_label).toBe('Mark an estimate accepted (starts the plan)');
  });

  test('a customer with email turned off is not emailed, and the card says so', async () => {
    seed({ prefs: [{ customer_id: CUSTOMER_ID, email_enabled: false }] });
    const preview = await executeEstimateAcceptTool('accept_estimate', INPUT);
    const contract = card(preview);
    expect(contract.notifies_customer).toBe(false);
    expect(labels(contract)).toContain('Message: No "membership started" email: this customer turned email messages off');
  });

  test('an estimate with visits already booked from it is refused (the reservation path can add and change visits)', async () => {
    // A cancelled linked visit counts too: the converter's reservation lookup
    // does not filter by status.
    seed({ booked: [{ id: 'svc-1', scheduled_date: '2026-10-14', status: 'cancelled' }] });
    const result = await executeEstimateAcceptTool('accept_estimate', INPUT);
    expect(result.code).toBe('booked_from_estimate');
    expect(result.error).toMatch(/1 visit\(s\) are already linked to this estimate \(first 2026-10-14\)/);
  });

  test('a termite program estimate says whether the agreement goes to the customer', async () => {
    seed({
      estimate: {
        estimate_data: { recurring: { services: [{ name: 'Termite Bait Monitoring', service: 'termite_bait', visitsPerYear: 4, monthly: 35 }] } },
        monthly_total: 35,
      },
    });
    const drafted = await executeEstimateAcceptTool('accept_estimate', INPUT);
    expect(drafted.customer_messages).toContainEqual(expect.objectContaining({
      will_send: false, text: 'Termite program agreement drafted for the office to send; the customer is not sent it',
    }));
    process.env.GATE_TERMITE_PROGRAM_AGREEMENT_AUTOSEND = 'true';
    const sent = await executeEstimateAcceptTool('accept_estimate', INPUT);
    expect(sent.customer_messages).toContainEqual(expect.objectContaining({
      will_send: true, text: 'Termite program agreement emailed to the customer to sign, after Confirm (agreement autosend is on)',
    }));
  });
});

describe('refusals before any card', () => {
  test.each([
    ['already accepted', { status: 'accepted', accepted_at: '2026-10-02T10:00:00.000Z' }, /already accepted on 2026-10-02/],
    ['declined', { status: 'declined', decline_reason: 'went with another company' }, /was declined \(went with another company\)/],
    ['archived', { archived_at: '2026-10-03T00:00:00.000Z' }, /is archived/],
    ['still a draft (the page refuses)', { status: 'draft' }, /Only sent or viewed estimates can be manually marked accepted\. Current status: draft\./],
    ['expired (the page refuses)', { expires_at: '2020-01-01T00:00:00.000Z' }, /Estimate is no longer active\./],
    ['a one-time option (the page refuses)', { show_one_time_option: true }, /must be accepted through the customer link/],
    ['invoice mode (the page refuses)', { bill_by_invoice: true }, /Invoice-mode estimates must be accepted through the customer link/],
    ['a commercial proposal', { estimate_data: { proposal: { enabled: true } } }, /commercial proposal/],
  ])('%s', async (_name, estimate, message) => {
    seed({ estimate });
    const result = await executeEstimateAcceptTool('accept_estimate', INPUT);
    expect(result.preview).toBeUndefined();
    expect(result.error).toMatch(message);
    expect(writes).toEqual([]);
  });

  test('a termite annual plan is sent to the annual prepay accept (the converter refuses it on a standard accept)', async () => {
    seed({ estimate: { monthly_total: 25, estimate_data: { engineResult: { lineItems: [{ service: 'termite_bait', plan: 'annual_protection', annual: 300 }] } } } });
    const result = await executeEstimateAcceptTool('accept_estimate', INPUT);
    expect(result.code).toBe('termite_annual_requires_prepay');
    expect(result.error).toMatch(/can only be accepted with annual prepay/);
  });

  test("a quote that also re-prices the customer's existing services is refused while the extension is live", async () => {
    const gates = require('../config/feature-gates');
    const isEnabled = jest.spyOn(gates, 'isEnabled').mockImplementation((key) => key === 'waveguardExtendExisting');
    try {
      seed({
        estimate: {
          estimate_data: {
            ...tables.estimates[0].estimate_data,
            membershipSnapshot: { tierLabel: 'Gold', existingServices: [{ key: 'lawn_care', keys: ['lawn_care'], currentPerVisit: 60, newPerVisit: 54, perVisitSavings: 6 }] },
          },
        },
      });
      const result = await executeEstimateAcceptTool('accept_estimate', INPUT);
      expect(result.code).toBe('existing_service_extension');
    } finally {
      isEnabled.mockRestore();
    }
  });

  test('an estimate that belongs to another customer names its real owner', async () => {
    seed({ estimate: { customer_id: OTHER_CUSTOMER_ID } });
    const result = await executeEstimateAcceptTool('accept_estimate', INPUT);
    expect(result.code).toBe('estimate_customer_mismatch');
    expect(result.error).toMatch(/belongs to Lena Synthetic, not the customer you named/);
  });

  test('with the gate off nothing is offered and a forced call refuses', async () => {
    delete process.env.GATE_IB_ACCEPT_ESTIMATE;
    const result = await executeEstimateAcceptTool('accept_estimate', INPUT);
    expect(result.code).toBe('accept_estimate_not_enabled');
    expect(reads).toEqual([]);
    expect(ActionRegistry.allowed(ActionRegistry.actions.get('accept_estimate'), { role: 'admin', context: 'customers' })).toBe(false);
  });
});

describe('Confirm', () => {
  const confirmWith = async (approved) => executeEstimateAcceptTool('accept_estimate', INPUT, {
    confirmed: true, technicianId: 'tech-owner', executionPins: { _verified_accept_plan: approved },
  });

  test('runs the estimate page handler with the page\'s own verbal-yes body', async () => {
    const approved = await executeEstimateAcceptTool('accept_estimate', INPUT);
    markEstimateAcceptedAsStaff.mockResolvedValue({ status: 200, json: { success: true, alreadyAccepted: false, conversion: { monthlyRate: 145, tier: 'Silver' }, warnings: [] } });
    const result = await confirmWith(approved);
    expect(markEstimateAcceptedAsStaff).toHaveBeenCalledWith({
      estimateId: ESTIMATE_ID,
      body: {
        source: 'verbal_yes',
        // The card's pins, re-checked under the accept's own locks.
        expected: {
          estimateVersion: '2026-10-06T12:00:00.000Z', estimateStatus: 'sent', customerId: CUSTOMER_ID,
          customerVersion: '2026-10-05T09:00:00.000Z', ledgerPin: approved.pins.ledger,
        },
      },
      actor: { technicianId: 'tech-owner' },
    });
    expect(approved.pins.ledger).toBe('55.00|lawn_care=55.00');
    expect(result).toMatchObject({ success: true, monthly_rate_now: 145, tier_now: 'Silver' });
    expect(result.message).toMatch(/No visits were booked/);
  });

  test.each([
    ['the estimate was edited', { estimate: { updated_at: '2026-10-06T12:05:00.000Z' } }],
    ['the customer row changed', { customer: { updated_at: '2026-10-06T13:00:00.000Z' } }],
    ['the bill changed', { ledger: [{ family_key: 'lawn_care', monthly_rate: 60 }] }],
  ])('refuses as preview_changed when %s after the card', async (_name, drift) => {
    const approved = await executeEstimateAcceptTool('accept_estimate', INPUT);
    seed(drift);
    const result = await confirmWith(approved);
    expect(result.preview_changed).toBe(true);
    expect(markEstimateAcceptedAsStaff).not.toHaveBeenCalled();
  });

  test('a change caught under the accept locks comes back as preview_changed', async () => {
    const approved = await executeEstimateAcceptTool('accept_estimate', INPUT);
    markEstimateAcceptedAsStaff.mockResolvedValue({ status: 409, json: { error: 'The estimate, the customer or the bill changed after the card was shown. Nothing was changed.', code: 'preview_changed' } });
    const result = await confirmWith(approved);
    expect(result).toMatchObject({ preview_changed: true });
    expect(result.success).toBeUndefined();
  });

  test('refuses without a verified card', async () => {
    const result = await confirmWith(undefined);
    expect(result.preview_changed).toBe(true);
    expect(markEstimateAcceptedAsStaff).not.toHaveBeenCalled();
  });

  test('a refusal from the page reaches the operator with its words', async () => {
    const approved = await executeEstimateAcceptTool('accept_estimate', INPUT);
    markEstimateAcceptedAsStaff.mockResolvedValue({ status: 409, json: { error: 'Estimate is no longer active.' } });
    const result = await confirmWith(approved);
    expect(result.error).toBe('Estimate is no longer active. Nothing was changed.');
    expect(result.success).toBeUndefined();
  });
});

describe('registration', () => {
  test('is a two-step write, admin-only, carded, and loads on the estimates, customers and dashboard pages', () => {
    expect(WRITE_TWO_STEP_TOOL_NAMES.has('accept_estimate')).toBe(true);
    expect(ESTIMATE_ACCEPT_TOOLS[0].input_schema.properties).not.toHaveProperty('confirmed');
    const action = ActionRegistry.actions.get('accept_estimate');
    expect(action).toMatchObject({ role: 'admin', approval: 'ui_confirm' });
    for (const context of ['estimates', 'customers', 'dashboard']) {
      expect(ActionRegistry.initialTools(context, { role: 'admin' }).map((t) => t.name)).toContain('accept_estimate');
    }
    expect(ActionRegistry.initialTools('seo', { role: 'admin' }).map((t) => t.name)).not.toContain('accept_estimate');
  });

  test('is never an owner-direct edit', () => {
    const OwnerDirect = require('../services/intelligence-bar/owner-direct');
    expect([...OwnerDirect.OWNER_DIRECT_TOOL_NAMES]).not.toContain('accept_estimate');
  });
});
