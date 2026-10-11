/**
 * accept_estimate (owner ruling 2026-10-07, Q5): the Intelligence Bar accepts
 * an estimate exactly as the estimate page's "Mark accepted" does, behind one
 * irreversible confirm card that shows what it bills, books and sends.
 *
 * The card is rendered from the accept's own effect list: the preview runs the
 * real accept as a dry run (markEstimateAcceptedAsStaff({ dryRun: true })) and
 * words what comes back. These tests feed that route realistic effect lists
 * (the list itself is produced and tested in estimate-manual-acceptance-
 * effects.test.js) and check the words, the refusals and the pinning.
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
    for (const m of ['whereNull', 'whereNotNull', 'whereNotIn', 'whereNot', 'whereIn', 'orderBy', 'orWhereNot', 'limit', 'whereRaw', 'leftJoin']) q[m] = () => q;
    q.where = (cond) => { q.cond = cond; return q; };
    // A sibling lookup (estimate_group_id) reads its own seeded rows.
    q.first = () => {
      reads.push(table);
      if (table === 'estimates' && q.cond?.estimate_group_id) return Promise.resolve((tables.siblings || [])[0]);
      return Promise.resolve((tables[table] || [])[0]);
    };
    q.select = () => q;
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
  tables.siblings = overrides.siblings || [];
}

// ── The dry run's effect list, as estimate-accept-effects.js produces it ──
const customerFields = (o = {}) => ({
  monthly_rate: null, billing_mode: null, waveguard_tier: null, pipeline_stage: null, property_type: null, per_application_fee: null, ...o,
});
const noLawn = { grass_type: null, turf_lawn_sqft: null, primary_property_sqft: null, customer_property_sqft: null };
const emailStep = (o = {}) => ({ step: 'membership_email', attempt: true, will_send: true, reason: null, to: 'l***@example.com', ...o });
const postCommit = (steps = [emailStep()]) => ({
  kind: 'post_commit',
  plan: [{ step: 'group_followup_transfer', grouped: false }, { step: 'property_link' }, { step: 'lead_won' }, ...steps, { step: 'termite_agreement', applies: false }],
});

// The default: Lawn $55 -> Lawn $55 + Pest $49 + Mosquito $41, Bronze -> Gold.
function addOnEffects(o = {}) {
  return [
    { kind: 'estimate', action: 'mark_accepted', from_status: 'sent', locks_price: true },
    { kind: 'add_on_classification', add_on_base: 55, had_other_live_families: false, same_family_at_other_property: false, split_by_service: true },
    {
      kind: 'customer',
      before: customerFields({ monthly_rate: '55.00', billing_mode: 'per_application', waveguard_tier: 'Bronze', pipeline_stage: 'active_customer' }),
      after: customerFields({ monthly_rate: '145.00', billing_mode: 'per_application', waveguard_tier: 'Gold', pipeline_stage: 'active_customer', ...o.customerAfter }),
    },
    { kind: 'plan_rate_ledger', before: { lawn_care: 55 }, after: { lawn_care: 55, pest_control: 49, mosquito: 41 }, total_before: 55, total_after: 145 },
    { kind: 'lawn_profile', before: noLawn, after: noLawn },
    { kind: 'conversion', recurring: true, service_count: 2, billing_lane: 'per_application', per_application_amount: null, manual_recurring_scheduling: false, ...o.conversion },
    ...(o.extra || []),
    o.postCommit || postCommit(),
  ];
}

let dryEffects;
let realReply;
beforeEach(() => {
  process.env.GATE_IB_ACCEPT_ESTIMATE = 'true';
  delete process.env.GATE_TERMITE_PROGRAM_AGREEMENT_AUTOSEND;
  reads.length = 0;
  writes.length = 0;
  seed();
  dryEffects = () => addOnEffects();
  realReply = async () => ({ status: 200, json: { success: true, alreadyAccepted: false, conversion: { monthlyRate: 145, tier: 'Gold' }, warnings: [] } });
  markEstimateAcceptedAsStaff.mockReset();
  markEstimateAcceptedAsStaff.mockImplementation(async (args) => (args.dryRun
    ? { status: 200, json: { success: true, dryRun: true, alreadyAccepted: false, effects: dryEffects() } }
    : realReply(args)));
});
// The customer's live qualifying services (no frozen snapshot on this quote).
let priorKeys;
beforeEach(() => {
  priorKeys = jest.spyOn(require('../services/waveguard-existing-services'), 'loadExistingQualifyingServiceKeys')
    .mockResolvedValue(['lawn_care']);
});
afterEach(() => { priorKeys.mockRestore(); });
afterAll(() => { delete process.env.GATE_IB_ACCEPT_ESTIMATE; });

const card = (preview) => AuthorizationContract.buildContract({
  toolName: 'accept_estimate', params: INPUT, displayParams: {}, preview,
});
const labels = (contract) => contract.effects.map((e) => e.label);
const cardFor = async () => labels(card(await executeEstimateAcceptTool('accept_estimate', INPUT)));

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
      'Bills each service per application at its own visit price (no single account fee)',
      'No setup invoice, no charge and no receipt now',
      'Visits: books none — book the first visit on the calendar after',
      'Message: Email "membership started" to l***@example.com right after Confirm: plan, tier, rate and services (sent once per estimate). Not sent if the customer opts out first or the address on file changes',
      'Message: No welcome text now (Mark accepted skips it). Booking the first visit later on the calendar may send it',
    ]));
    expect(writes).toEqual([]);
  });

  test('the card comes from the accept run as a dry run, through the page handler, and nothing real is run', async () => {
    await executeEstimateAcceptTool('accept_estimate', INPUT, { technicianId: 'tech-owner' });
    expect(markEstimateAcceptedAsStaff).toHaveBeenCalledTimes(1);
    expect(markEstimateAcceptedAsStaff).toHaveBeenCalledWith({
      estimateId: ESTIMATE_ID, body: { source: 'verbal_yes' }, actor: { technicianId: 'tech-owner' }, dryRun: true,
    });
  });

  test('a one-time estimate does not promise a plan, a bill change or customer activation, and lists each one-time line', async () => {
    seed({ estimate: { monthly_total: 0, onetime_total: 350, estimate_data: { result: { oneTime: { items: [{ service: 'german_roach', name: 'German Roach Cleanout', price: 350 }] } } } } });
    dryEffects = () => [
      { kind: 'estimate', action: 'mark_accepted', from_status: 'sent', locks_price: true },
      { kind: 'customer', before: customerFields({ monthly_rate: '55.00', billing_mode: 'per_application', waveguard_tier: 'Bronze' }), after: customerFields({ monthly_rate: '55.00', billing_mode: 'per_application', waveguard_tier: 'Bronze' }) },
      { kind: 'one_time_line', name: 'German Roach Cleanout', amount: 350, consequence: 'schedule_and_invoice_by_hand' },
      postCommit([]),
    ];
    const preview = await executeEstimateAcceptTool('accept_estimate', INPUT);
    const lines = labels(card(preview));
    expect(lines).toEqual(expect.arrayContaining([
      'Accepts estimate addonquo for Lena Synthetic: $0.00 a month, $350.00 one-time',
      'Bill: unchanged — a one-time estimate only changes status here. Schedule and invoice the work by hand',
      'One-time German Roach Cleanout ($350.00): this accept does not schedule or invoice it — schedule it and invoice it by hand',
      "Marks the estimate accepted and locks its price; the customer's status and plan stay as they are",
      'Message: No email or text: a one-time estimate only changes status here',
    ]));
    expect(lines.some((l) => /becomes an active customer|^Starts |^Bill line/.test(l))).toBe(false);
    expect(card(preview).notifies_customer).toBe(false);
  });

  test('every accepted one-time line rides a recurring accept too, each with what the accept does about it', async () => {
    dryEffects = () => addOnEffects({
      extra: [
        { kind: 'one_time_line', name: 'Initial Cleanout', amount: 125, consequence: 'schedule_and_invoice_by_hand' },
        { kind: 'one_time_line', name: 'Gutter Spray', amount: 60.5, consequence: 'schedule_and_invoice_by_hand' },
      ],
    });
    const lines = await cardFor();
    expect(lines).toEqual(expect.arrayContaining([
      'One-time Initial Cleanout ($125.00): this accept does not schedule or invoice it — schedule it and invoice it by hand',
      'One-time Gutter Spray ($60.50): this accept does not schedule or invoice it — schedule it and invoice it by hand',
    ]));
  });

  test('a commercial one-time estimate discloses the commercial property stamp', async () => {
    seed({ estimate: { monthly_total: 0, onetime_total: 640, estimate_data: {} }, customer: { property_type: 'residential' } });
    dryEffects = () => [
      { kind: 'estimate', action: 'mark_accepted', from_status: 'sent', locks_price: true },
      { kind: 'customer', before: customerFields({ property_type: 'residential' }), after: customerFields({ property_type: 'commercial' }) },
      postCommit([]),
    ];
    expect(await cardFor()).toContain('Property type: residential → commercial (later invoices charge sales tax on taxable commercial services)');
  });

  test('a pinned legacy rodent-only plan goes on monthly dues, as the converter stamps it', async () => {
    seed({ customer: { pipeline_stage: 'lead', monthly_rate: 0, billing_mode: null, waveguard_tier: null }, ledger: [] });
    dryEffects = () => addOnEffects({ customerAfter: { monthly_rate: '49.00', billing_mode: 'monthly_membership' } }).map((e) => (e.kind === 'customer'
      ? { ...e, before: customerFields({ pipeline_stage: 'lead', monthly_rate: '0' }) } : e));
    expect(await cardFor()).toContain('Billing lane: none → monthly membership dues');
  });

  test('an address the email sender would skip is not promised an email', async () => {
    dryEffects = () => addOnEffects({ postCommit: postCommit([emailStep({ will_send: false, reason: 'invalid_address', to: null })]) });
    const preview = await executeEstimateAcceptTool('accept_estimate', INPUT);
    expect(labels(card(preview))).toContain('Message: No "membership started" email: no email (the address on file is not a valid email)');
    expect(card(preview).notifies_customer).toBe(false);
  });

  test('a customer with email turned off is not emailed, and the card says so', async () => {
    dryEffects = () => addOnEffects({ postCommit: postCommit([emailStep({ will_send: false, reason: 'email_off', to: null })]) });
    const contract = card(await executeEstimateAcceptTool('accept_estimate', INPUT));
    expect(contract.notifies_customer).toBe(false);
    expect(labels(contract)).toContain('Message: No "membership started" email: this customer turned email messages off');
  });

  test('a single-service plan shows the exact per-application charge the converter stamps', async () => {
    seed({
      estimate: {
        monthly_total: 49, annual_total: 588,
        estimate_data: { customerSelection: { frequency: 'quarterly' }, recurring: { services: [{ name: 'Quarterly Pest Control', service: 'pest_control', visitsPerYear: 4, monthly: 49 }] } },
      },
      customer: { pipeline_stage: 'lead', monthly_rate: 0, billing_mode: null, waveguard_tier: null },
      ledger: [],
    });
    dryEffects = () => addOnEffects({ conversion: { per_application_amount: 147 } });
    expect(await cardFor()).toContain('Bills $147.00 per application (about $49.00 a month)');
  });

  test('a multi-service accept by a per-application customer discloses the account fee it keeps', async () => {
    dryEffects = () => addOnEffects({ customerAfter: { per_application_fee: '62' } });
    expect(await cardFor()).toContain('Bills each service per application at its own visit price; the account fee stays $62.00 for any visit with no price');
  });

  test('a pest line accepted monthly shows the accepted 12 visits a year, not its stale quote-time 4', async () => {
    seed({
      estimate: {
        monthly_total: 49, annual_total: 588,
        estimate_data: { customerSelection: { frequency: 'monthly' }, recurring: { services: [{ name: 'Pest Control', service: 'pest_control', visitsPerYear: 4, monthly: 49 }] } },
      },
    });
    const lines = await cardFor();
    expect(lines.find((l) => l.startsWith('Starts Pest control'))).toMatch(/: 12 visits a year,/);
  });

  test('a single-service plan whose per-visit charge the converter cannot resolve is refused, not carded', async () => {
    // The converter parks a fee bell for the office when it cannot resolve the charge.
    dryEffects = () => addOnEffects({ postCommit: postCommit([emailStep(), { step: 'admin_bell', bell: 'per_application_fee', title: 'Per-application fee not set on a new per-application customer' }]) });
    const result = await executeEstimateAcceptTool('accept_estimate', INPUT);
    expect(result.code).toBe('per_application_unresolved');
    expect(result.error).toBe('Accept this on the estimate page; the per-visit charge needs a manual review. Nothing was changed.');
  });

  test('an unpriced per-application add-on, which the converter refuses outright, reaches the operator with the page\'s words', async () => {
    markEstimateAcceptedAsStaff.mockResolvedValue({ status: 409, json: { error: 'This add-on has no per-visit price. Re-quote it.', code: 'PER_APPLICATION_ADD_ON_UNPRICED' } });
    const result = await executeEstimateAcceptTool('accept_estimate', INPUT);
    expect(result).toMatchObject({ code: 'PER_APPLICATION_ADD_ON_UNPRICED', error: 'This add-on has no per-visit price. Re-quote it. Nothing was changed.' });
  });

  test('every office bell the accept rings is on the card, including the grouped plan-rate review the bypassed accept parks', async () => {
    dryEffects = () => addOnEffects({
      postCommit: postCommit([
        emailStep(),
        { step: 'admin_bell', bell: 'tier_upgrade', title: 'WaveGuard Gold activated: review existing plan rates' },
        { step: 'admin_bell', bell: 'plan_rate_review', title: 'Multi-plan rate needs review after re-quote' },
      ]),
    });
    const lines = await cardFor();
    expect(lines).toEqual(expect.arrayContaining([
      'Admin bell: WaveGuard Gold activated: review existing plan rates',
      'Admin bell: Multi-plan rate needs review after re-quote',
    ]));
    dryEffects = () => addOnEffects();
    expect((await cardFor()).some((l) => l.startsWith('Admin bell:'))).toBe(false);
  });

  test('the card names the lead it marks won (masked) and the multi-home flip, both pinned in the plan', async () => {
    dryEffects = () => addOnEffects({
      postCommit: postCommit([
        emailStep(),
      ]),
    }).map((e) => (e.kind === 'post_commit'
      ? { ...e, plan: e.plan.map((s) => (s.step === 'lead_won' ? { ...s, target: { estimate_id: 'e', lead_ids: ['0f0f0f0f-aaaa-bbbb-cccc-123456abcdef'] } }
        : s.step === 'property_link' ? { ...s, target: { customer_id: 'c', property_id: 'p' } } : s)).concat([{ step: 'multi_home', target: { customer_id: 'c', flips: true } }]) }
      : e));
    const lines = await cardFor();
    expect(lines).toContain('Marks lead #abcdef won');
    expect(lines).toContain('Marks the customer as multi-home (two active properties)');
    dryEffects = () => addOnEffects();
    const plain = await cardFor();
    expect(plain).toContain('No lead is marked won');
    expect(plain.some((l) => l.includes('multi-home'))).toBe(false);
  });

  test('the bill note says when the accept is not split by service', async () => {
    dryEffects = () => addOnEffects().map((e) => (e.kind === 'add_on_classification' ? { ...e, split_by_service: false } : e));
    expect(await cardFor()).toContain('Bill note: this accept is not split by service (grouped or other-property estimate)');
  });

  describe('lawn profile writes', () => {
    const lawnEstimate = {
      property_id: 'prop-1', monthly_total: 55, annual_total: 495,
      estimate_data: {
        grassType: 'st_augustine',
        customerSelection: { frequency: 'monthly' },
        engineResult: { lineItems: [{ service: 'lawn_care', name: 'Lawn Care', lawnSqFt: 6500, turfBasis: 'measuredTurfSf', visitsPerYear: 9, monthly: 55, annual: 495 }] },
      },
    };
    const lawnEffects = (before, after) => addOnEffects().map((e) => (e.kind === 'lawn_profile' ? { ...e, before: { ...noLawn, ...before }, after: { ...noLawn, ...after } } : e));
    afterEach(() => { tables.customer_turf_profiles = []; tables.customer_properties = []; });

    test('an empty lawn profile is filled, and the card says from what to what', async () => {
      seed({ estimate: lawnEstimate, ledger: [] });
      tables.customer_turf_profiles = [];
      tables.customer_properties = [{ id: 'prop-1', customer_id: CUSTOMER_ID, active: true, is_primary: true, property_sqft: null }];
      dryEffects = () => lawnEffects({}, { grass_type: 'st_augustine', turf_lawn_sqft: 6500 });
      const preview = await executeEstimateAcceptTool('accept_estimate', INPUT);
      expect(preview.error).toBeUndefined();
      expect(labels(card(preview))).toContain('Lawn profile: grass type none → st_augustine; lawn size none → 6,500 sq ft');
      expect(preview.pins.lawn_profile).toBe('||prop-1|');
    });

    test('a mirror-only rewrite (the turf profile already right, the property and customer sizes stale) is on the card', async () => {
      seed({ estimate: lawnEstimate, ledger: [] });
      tables.customer_turf_profiles = [{ customer_id: CUSTOMER_ID, grass_type: 'st_augustine', lawn_sqft: 6500 }];
      tables.customer_properties = [{ id: 'prop-1', customer_id: CUSTOMER_ID, active: true, is_primary: true, property_sqft: 5000 }];
      dryEffects = () => lawnEffects(
        { grass_type: 'st_augustine', turf_lawn_sqft: 6500, primary_property_sqft: 5000, customer_property_sqft: 5000 },
        { grass_type: 'st_augustine', turf_lawn_sqft: 6500, primary_property_sqft: 6500, customer_property_sqft: 6500 },
      );
      const lines = await cardFor();
      expect(lines).toContain('Lawn profile: primary property size 5,000 sq ft → 6,500 sq ft; customer record size 5,000 sq ft → 6,500 sq ft');
    });

    test('a profile that already holds these values shows no lawn line, but is still pinned', async () => {
      seed({ estimate: lawnEstimate, ledger: [] });
      tables.customer_turf_profiles = [{ customer_id: CUSTOMER_ID, grass_type: 'st_augustine', lawn_sqft: 6500 }];
      tables.customer_properties = [{ id: 'prop-1', customer_id: CUSTOMER_ID, active: true, is_primary: true, property_sqft: 6500 }];
      const same = { grass_type: 'st_augustine', turf_lawn_sqft: 6500, primary_property_sqft: 6500, customer_property_sqft: 6500 };
      dryEffects = () => lawnEffects(same, same);
      const preview = await executeEstimateAcceptTool('accept_estimate', INPUT);
      expect(preview.error).toBeUndefined();
      expect(labels(card(preview)).some((l) => l.startsWith('Lawn profile'))).toBe(false);
      expect(preview.pins.lawn_profile).toBe('st_augustine|6500|prop-1|6500');
    });
  });

  test('the tier is the one the accept leaves stored, not what the quote says', async () => {
    seed({ estimate: { waveguard_tier: 'Silver' } });
    expect(await cardFor()).toContain('Tier: Bronze → Gold');
    dryEffects = () => addOnEffects({ customerAfter: { waveguard_tier: 'Silver' } });
    expect(await cardFor()).toContain('Tier: Bronze → Silver');
  });

  test('is irreversible and tells the operator the customer will be emailed', async () => {
    const contract = card(await executeEstimateAcceptTool('accept_estimate', INPUT));
    expect(contract.irreversible).toBe(true);
    expect(contract.notifies_customer).toBe(true);
    expect(contract.action_label).toBe('Mark an estimate accepted (starts the plan)');
  });

  test('a one-time estimate with a visit already linked is refused too (it takes the same reservation path)', async () => {
    seed({ estimate: { monthly_total: 0, onetime_total: 350, estimate_data: { result: { oneTime: { items: [{ service: 'german_roach', name: 'German Roach Cleanout', price: 350 }] } } } }, booked: [{ id: 'svc-1', scheduled_date: '2026-10-14', status: 'confirmed' }] });
    const result = await executeEstimateAcceptTool('accept_estimate', INPUT);
    expect(result.code).toBe('booked_from_estimate');
    expect(markEstimateAcceptedAsStaff).not.toHaveBeenCalled();
  });

  test('the linked-visit pin binds a one-time card as well', async () => {
    seed({ estimate: { monthly_total: 0, onetime_total: 350, estimate_data: { result: { oneTime: { items: [{ service: 'german_roach', name: 'German Roach Cleanout', price: 350 }] } } } } });
    dryEffects = () => [
      { kind: 'estimate', action: 'mark_accepted', from_status: 'sent', locks_price: true },
      { kind: 'one_time_line', name: 'German Roach Cleanout', amount: 350, consequence: 'schedule_and_invoice_by_hand' },
      postCommit(),
    ];
    const card = await executeEstimateAcceptTool('accept_estimate', INPUT);
    // expectedFrom() sends this as noLinkedVisits, which the accept re-checks under its locks.
    expect(card.pins.no_linked_visits).toBe(true);
  });

  test('an estimate with visits already booked from it is refused (the reservation path can add and change visits)', async () => {
    // A cancelled linked visit counts too: the converter's reservation lookup
    // does not filter by status.
    seed({ booked: [{ id: 'svc-1', scheduled_date: '2026-10-14', status: 'cancelled' }] });
    const result = await executeEstimateAcceptTool('accept_estimate', INPUT);
    expect(result.code).toBe('booked_from_estimate');
    expect(result.error).toMatch(/1 visit\(s\) are already linked to this estimate \(first 2026-10-14\)/);
    expect(markEstimateAcceptedAsStaff).not.toHaveBeenCalled();
  });
});

describe('fail closed', () => {
  test('a bill classifier that cannot read its evidence refuses the card (no silent fall back to replace semantics)', async () => {
    markEstimateAcceptedAsStaff.mockResolvedValue({
      status: 409,
      json: { error: "Could not read the customer's other plans to price this accept. Nothing was changed.", code: 'add_on_classification_unavailable' },
    });
    const result = await executeEstimateAcceptTool('accept_estimate', INPUT);
    expect(result.preview).toBeUndefined();
    expect(result.code).toBe('add_on_classification_unavailable');
  });

  test('email settings the accept could not read refuse instead of guessing the email', async () => {
    dryEffects = () => addOnEffects({ postCommit: postCommit([emailStep({ will_send: false, reason: 'prefs_unreadable', to: null })]) });
    const result = await executeEstimateAcceptTool('accept_estimate', INPUT);
    expect(result.code).toBe('prefs_unavailable');
    expect(result.error).toBe("Could not verify the customer's email settings — try again. Nothing was changed.");
  });

  test('a side effect the conversion would do outside the post-commit plan is not hidden: the card refuses', async () => {
    // The converter's side-effect gate listed an email the plan does not carry.
    dryEffects = () => [
      ...addOnEffects({ postCommit: postCommit([emailStep()]) }),
      { kind: 'side_effect', type: 'customer_sms', target: 'new_recurring_welcome', recipient: '***42', detail: null },
      { kind: 'side_effect', type: 'admin_bell', target: 'tier_upgrade', recipient: null, detail: 'x' },
    ];
    const result = await executeEstimateAcceptTool('accept_estimate', INPUT);
    expect(result.code).toBe('side_effect_outside_plan');
    expect(result.error).toBe('This accept would also text the customer and ring an admin bell, and the bar cannot show that yet. Accept it from the estimate page. Nothing was changed.');
  });

  test('rows the accept changes outside the bill are worded on the card: a consultation closed as won, credit entries, repriced visits', async () => {
    dryEffects = () => addOnEffects({
      extra: [
        { kind: 'table_changes', table: 'consultation_outcomes', changed: [{ key: 'co-1', columns: { outcome: { before: 'warm', after: 'won' } } }], added: [], removed: [] },
        { kind: 'table_changes', table: 'customer_credit_ledger', changed: [], removed: [], added: [{ delta: '12.50', source: 'waveguard_extension' }] },
        { kind: 'table_changes', table: 'scheduled_services', changed: [{ key: 'v1', columns: { estimated_price: { before: '49.00', after: '45.00' } } }, { key: 'v2', columns: { estimated_price: { before: '49.00', after: '45.00' } } }], added: [], removed: [] },
        { kind: 'table_changes', table: 'customers', changed: [{ key: 'c', columns: { monthly_rate: { before: '55.00', after: '145.00' } } }], added: [], removed: [] },
        { kind: 'table_changes', table: 'some_future_table', changed: [], added: [{ a: 1 }], removed: [] },
      ],
    });
    const lines = (await executeEstimateAcceptTool('accept_estimate', INPUT)).card_lines.map((l) => l.label);
    expect(lines).toContain('Closes the open consultation as won');
    expect(lines).toContain('Posts 1 account credit entry ($12.50 in all)');
    expect(lines).toContain("Reprices 2 existing visits on the customer's plan");
    expect(lines).toContain('Also changes 1 row in some future table');
    // Tables another line already words add nothing.
    expect(lines.filter((l) => /customers|monthly_rate/.test(l))).toEqual([]);
  });

  test('commercial recurring work the converter would schedule by hand refuses even if the quote looked residential', async () => {
    dryEffects = () => addOnEffects({ conversion: { manual_recurring_scheduling: true } });
    expect((await executeEstimateAcceptTool('accept_estimate', INPUT)).code).toBe('commercial_recurring');
  });

  test('an estimate the page says is already accepted by the time of the dry run is refused', async () => {
    markEstimateAcceptedAsStaff.mockResolvedValue({ status: 200, json: { success: true, dryRun: true, alreadyAccepted: true, effects: [] } });
    expect((await executeEstimateAcceptTool('accept_estimate', INPUT)).code).toBe('already_accepted');
  });
});

describe('refusals before any card', () => {
  test.each([
    ['already accepted', { status: 'accepted', accepted_at: '2026-10-02T10:00:00.000Z' }, /already accepted on 2026-10-02/],
    // 9:30 pm on Oct 2 in Eastern time is already Oct 3 in UTC: the office's day wins.
    ['already accepted late in the evening, Eastern', { status: 'accepted', accepted_at: '2026-10-03T01:30:00.000Z' }, /already accepted on 2026-10-02\./],
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
    // A mapped annual-plan envelope the agreement walker does not read as a
    // bait program still reaches the converter's annual-prepay-only guard.
    seed({ estimate: { monthly_total: 25, estimate_data: { result: { results: { tmBait: { plan: 'annual_protection', monMonthly: 25 } } } } } });
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

  test.each([
    ['a bait monitoring plan', { recurring: { services: [{ name: 'Termite Bait Monitoring', service: 'termite_bait', visitsPerYear: 4, monthly: 35 }] } }],
    ['a commercial termite program', { recurring: { services: [{ name: 'Commercial Termite Bait', service: 'commercial_termite_bait', visitsPerYear: 4, monthly: 60 }] } }],
  ])('%s is refused: termite programs are accepted on the estimate page, where the agreement is handled', async (_name, estimateData) => {
    seed({ estimate: { estimate_data: estimateData, monthly_total: 35 } });
    const result = await executeEstimateAcceptTool('accept_estimate', INPUT);
    expect(result.code).toBe('termite_program');
    expect(result.error).toBe('Accept termite programs on the estimate page, where the agreement is handled. Nothing was changed.');
    expect(writes).toEqual([]);
  });

  test('commercial recurring work is refused (the converter schedules it by hand and rings the office)', async () => {
    seed({ estimate: { estimate_data: { recurring: { services: [{ name: 'Commercial Pest Control', service: 'commercial_pest', visitsPerYear: 12, monthly: 120 }] } }, monthly_total: 120 } });
    const result = await executeEstimateAcceptTool('accept_estimate', INPUT);
    expect(result.code).toBe('commercial_recurring');
    expect(result.error).toBe('Accept commercial work on the estimate page. Nothing was changed.');
  });

  test('a grouped estimate is refused before any card or dry run', async () => {
    seed({ estimate: { estimate_group_id: 'group-1' }, siblings: [{ id: 'sibling-1' }] });
    const result = await executeEstimateAcceptTool('accept_estimate', INPUT);
    expect(result.code).toBe('grouped_estimate');
    expect(result.error).toBe('This estimate is part of a group. Accept it from the estimate page, where the group is shown. Nothing was changed.');
    expect(markEstimateAcceptedAsStaff).not.toHaveBeenCalled();
  });

  test('a grouped estimate is refused even when every other estimate in its group is closed', async () => {
    seed({ estimate: { estimate_group_id: 'group-1' }, siblings: [] });
    const result = await executeEstimateAcceptTool('accept_estimate', INPUT);
    expect(result.code).toBe('grouped_estimate');
    expect(markEstimateAcceptedAsStaff).not.toHaveBeenCalled();
  });

  test('an ungrouped estimate carries the `grouped: false` pin, and Confirm sends it for the lock check', async () => {
    const card = await executeEstimateAcceptTool('accept_estimate', INPUT);
    expect(card.pins.grouped).toBe(false);
  });

  describe('with customer properties on', () => {
    beforeEach(() => { process.env.GATE_CUSTOMER_PROPERTIES = 'true'; });
    afterEach(() => { delete process.env.GATE_CUSTOMER_PROPERTIES; tables.customer_properties = []; });

    test('an estimate not linked to an existing property of the customer is refused', async () => {
      tables.customer_properties = [];
      const result = await executeEstimateAcceptTool('accept_estimate', INPUT);
      expect(result.code).toBe('property_not_linked');
      expect(result.error).toBe('Add or link the service address on the customer page first. Nothing was changed.');
    });

    test('an estimate linked to the customer\'s property, with a primary on file, gets its card', async () => {
      seed({ estimate: { property_id: 'prop-1' } });
      tables.customer_properties = [{ id: 'prop-1', customer_id: CUSTOMER_ID, active: true, is_primary: true }];
      const result = await executeEstimateAcceptTool('accept_estimate', INPUT);
      expect(result.preview).toBe(true);
    });
  });

  test('with customer properties off an unlinked estimate is carded as before', async () => {
    delete process.env.GATE_CUSTOMER_PROPERTIES;
    expect((await executeEstimateAcceptTool('accept_estimate', INPUT)).preview).toBe(true);
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
  const realCalls = () => markEstimateAcceptedAsStaff.mock.calls.filter(([args]) => !args.dryRun);

  test('runs the estimate page handler with the page\'s own verbal-yes body, the pins, the pinned effect list and the approved email decision', async () => {
    const approved = await executeEstimateAcceptTool('accept_estimate', INPUT);
    realReply = async () => {
      tables.customers[0].waveguard_tier = 'Gold';
      return { status: 200, json: { success: true, alreadyAccepted: false, conversion: { monthlyRate: 145, tier: 'Gold' }, warnings: [] } };
    };
    const result = await confirmWith(approved);
    expect(realCalls()).toEqual([[{
      estimateId: ESTIMATE_ID,
      // The page's own body: the pins are NOT part of it.
      body: { source: 'verbal_yes' },
      // The card's pins, an internal argument re-checked under the accept's
      // own locks.
      expected: {
        estimateVersion: '2026-10-06T12:00:00.000Z', estimateStatus: 'sent', customerId: CUSTOMER_ID,
        customerVersion: '2026-10-05T09:00:00.000Z', ledgerPin: approved.pins.ledger,
        customerBilling: 'per_application||Bronze|active_customer|',
        planRows: '',
        lawnProfile: '|||',
        noLinkedVisits: true,
        ungrouped: true,
        effectsKey: approved.effects_key,
        membershipEmail: 'send',
      },
      actor: { technicianId: 'tech-owner' },
    }]]);
    expect(approved.pins.ledger).toBe('55.00|lawn_care=55.00');
    expect(approved.effects_key).toMatch(/^[0-9a-f]{64}$/);
    expect(result).toMatchObject({ success: true, monthly_rate_now: 145, tier_now: 'Gold' });
    expect(result.message).toMatch(/No visits were booked/);
  });

  test('a card that said "no email" sends that decision along, so the email is skipped at delivery', async () => {
    dryEffects = () => addOnEffects({ postCommit: postCommit([emailStep({ will_send: false, reason: 'email_off', to: null })]) });
    const approved = await executeEstimateAcceptTool('accept_estimate', INPUT);
    expect(approved.membership_email).toBe('skip');
    await confirmWith(approved);
    expect(realCalls()[0][0].expected.membershipEmail).toBe('skip');
    expect(realCalls()[0][0].body).toEqual({ source: 'verbal_yes' });
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
    expect(realCalls()).toEqual([]);
  });

  test.each([
    ['the bill classification differs', () => addOnEffects().map((e) => (e.kind === 'add_on_classification' ? { ...e, add_on_base: 0 } : e))],
    ['the email decision flips (the customer opted out)', () => addOnEffects({ postCommit: postCommit([emailStep({ will_send: false, reason: 'email_off', to: null })]) })],
    ['a bell appears', () => addOnEffects({ postCommit: postCommit([emailStep(), { step: 'admin_bell', bell: 'plan_rate_review', title: 'Multi-plan rate needs review after re-quote' }]) })],
    ['a lawn mirror would now be rewritten', () => addOnEffects().map((e) => (e.kind === 'lawn_profile' ? { ...e, after: { ...noLawn, customer_property_sqft: 6500 } } : e))],
    ['a one-time line appears', () => addOnEffects({ extra: [{ kind: 'one_time_line', name: 'Initial Cleanout', amount: 125, consequence: 'schedule_and_invoice_by_hand' }] })],
  ])('refuses as preview_changed, and runs nothing, when %s since the card', async (_name, changed) => {
    const approved = await executeEstimateAcceptTool('accept_estimate', INPUT);
    dryEffects = changed;
    const result = await confirmWith(approved);
    expect(result.preview_changed).toBe(true);
    expect(realCalls()).toEqual([]);
  });

  test('a change caught under the accept locks comes back as preview_changed', async () => {
    const approved = await executeEstimateAcceptTool('accept_estimate', INPUT);
    realReply = async () => ({ status: 409, json: { error: 'The estimate, the customer or the bill changed after the card was shown. Nothing was changed.', code: 'preview_changed' } });
    const result = await confirmWith(approved);
    expect(result).toMatchObject({ preview_changed: true });
    expect(result.success).toBeUndefined();
  });

  test('tier_now is the tier as stored after the commit, not the converter\'s internal value', async () => {
    const approved = await executeEstimateAcceptTool('accept_estimate', INPUT);
    realReply = async () => {
      tables.customers[0].waveguard_tier = 'Commercial'; // what the converter stores
      return { status: 200, json: { success: true, alreadyAccepted: false, conversion: { monthlyRate: 145, tier: 'none' }, warnings: [] } };
    };
    const result = await confirmWith(approved);
    expect(result.tier_now).toBe('Commercial');
  });

  test('a one-time-only accept still reports the member\'s unchanged monthly rate and tier (55 a month)', async () => {
    seed({ estimate: { monthly_total: 0, onetime_total: 350, estimate_data: { result: { oneTime: { items: [{ service: 'german_roach', name: 'German Roach Cleanout', price: 350 }] } } } } });
    dryEffects = () => [
      { kind: 'estimate', action: 'mark_accepted', from_status: 'sent', locks_price: true },
      { kind: 'one_time_line', name: 'German Roach Cleanout', amount: 350, consequence: 'schedule_and_invoice_by_hand' },
      postCommit([]),
    ];
    const approved = await executeEstimateAcceptTool('accept_estimate', INPUT);
    realReply = async () => ({ status: 200, json: { success: true, alreadyAccepted: false, conversion: null, warnings: [] } });
    const result = await confirmWith(approved);
    expect(result).toMatchObject({ success: true, monthly_rate_now: 55, tier_now: 'Bronze' });
  });

  test('refuses without a verified card', async () => {
    const result = await confirmWith(undefined);
    expect(result.preview_changed).toBe(true);
    expect(realCalls()).toEqual([]);
  });

  test('a refusal from the page reaches the operator with its words', async () => {
    const approved = await executeEstimateAcceptTool('accept_estimate', INPUT);
    realReply = async () => ({ status: 409, json: { error: 'Estimate is no longer active.' } });
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

describe('the add-on evidence pin (otherPlanRowsPin)', () => {
  const pinFor = (rows, sources = []) => {
    const conn = (table) => {
      const q = {};
      for (const m of ['leftJoin', 'where', 'whereNotIn', 'whereIn', 'select']) q[m] = () => q;
      q.then = (resolve, reject) => Promise.resolve(table === 'estimates' ? sources : rows).then(resolve, reject);
      return q;
    };
    return Converter.otherPlanRowsPin(conn, { customerId: CUSTOMER_ID, estimateId: ESTIMATE_ID });
  };
  const lawn = { id: 'plan-1', service_type: 'Lawn Care', is_callback: false, source_estimate_id: 'est-old' };

  test('the same rows moved to another property change the pin', async () => {
    const here = await pinFor([{ ...lawn, property_id: 'prop-a', service_address_line1: '1 Synthetic Way' }]);
    const moved = await pinFor([{ ...lawn, property_id: 'prop-b', service_address_line1: '9 Other Road' }]);
    expect(moved).not.toBe(here);
  });

  test("a change to the source estimate's address changes the pin", async () => {
    const before = await pinFor([lawn], [{ id: 'est-old', address: '1 Synthetic Way, Bradenton, FL', property_id: null }]);
    const after = await pinFor([lawn], [{ id: 'est-old', address: '9 Other Road, Sarasota, FL', property_id: null }]);
    expect(after).not.toBe(before);
  });

  test('inserted and cancelled rows change the pin; callbacks do not count', async () => {
    const one = await pinFor([lawn]);
    expect(await pinFor([lawn, { ...lawn, id: 'plan-2', service_type: 'Pest Control' }])).not.toBe(one);
    expect(await pinFor([])).not.toBe(one);
    expect(await pinFor([lawn, { ...lawn, id: 'cb-1', is_callback: true }])).toBe(one);
  });
});
