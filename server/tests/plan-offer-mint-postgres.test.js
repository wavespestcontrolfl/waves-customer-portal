// The plan offer's quote against real PostgreSQL (one rolled-back transaction per test): mintPlanStartEstimate with
// `offer` (the one-time job to plan offer, owner 2026-11-19 "build"). The unit suite (plan-start.test.js) fakes the
// recompute, the snapshot and the database. This one runs the REAL mint end to end: the real server recompute, the real
// frozen page snapshot (buildEstimateSendSnapshot), the real "does the page sell what the card showed" check
// (planStartQuoteMismatch + sentSnapshotServesAsIs), and the real accept re-check, so what the quote stores for the setup
// fee is read where the page and the accept read it. Only the property lookup is a stub (no network, no spend).
// All names and addresses are synthetic.
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
// The app's own connection answers from the test's transaction (every table), so the mint, the snapshot builder and the
// price settings all read the rows the test wrote, and a test rolls them back.
let mockHandle = null;
jest.mock('../models/db', () => new Proxy(function appConnection() {}, {
  apply: (_target, _this, args) => mockHandle(...args),
  get: (_target, key) => {
    if (typeof key === 'symbol' || key === 'then' || key === '__esModule') return undefined;
    const member = mockHandle[key];
    return typeof member === 'function' ? member.bind(mockHandle) : member;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const crypto = require('crypto');
const { etDateString, addETDays } = require('../utils/datetime-et');

const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');
const day = (n) => etDateString(addETDays(new Date(), n));
const DAY_MS = 86400000;
const SAVED_LOOKUP = { enriched: { homeSqFt: 2400, lotSqFt: 8000, stories: 1 }, propertyRecord: {} };
const parse = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

postgres('plan offer quote (live Postgres)', () => {
  // The first test loads the pricing engine.
  jest.setTimeout(120000);
  let database;
  let trx;
  // What the shared offer pricer takes as `database`: a handle that is none, reading through the test's transaction.
  let handle;

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    // This worktree's OWN QA database, never another checkout's, or CI's database (plan-start-offer-postgres.test.js).
    const worktreeId = String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '');
    const privateQa = process.env.WAVES_LOCAL_DEV === '1' && /^[a-f0-9]{32}$/.test(worktreeId) && target.pathname === `/waves_qa_${worktreeId}`;
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error("Use this worktree's private QA database or the isolated CI database");
    if (target.search) throw new Error('DATABASE_URL must not carry query parameters');
    database = require('knex')({
      client: 'pg',
      connection: {
        host: target.hostname,
        port: target.port ? Number(target.port) : undefined,
        user: decodeURIComponent(target.username) || undefined,
        password: decodeURIComponent(target.password) || undefined,
        database: target.pathname.slice(1),
      },
      pool: { min: 0, max: 2 },
    });
  });

  afterAll(async () => {
    await database?.destroy();
  });

  beforeEach(async () => {
    trx = await database.transaction();
    mockHandle = trx;
    handle = new Proxy(trx, { get: (target, key, receiver) => (key === 'isTransaction' ? false : Reflect.get(target, key, receiver)) });
  });

  afterEach(async () => {
    mockHandle = null;
    await trx.rollback();
  });

  const restart = () => require('../services/cancellation-resolution/restart');

  // A one-time customer: live, residential, no tier, no plan rate, with the completed one-time job the offer follows.
  async function seedCustomerWithJob() {
    const tag = hex(4);
    const [customer] = await trx('customers').insert({
      first_name: 'Jordan', last_name: 'Example', email: `jordan.${tag}@example.test`,
      phone: `+1941${String(parseInt(tag, 16) % 10000000).padStart(7, '0')}`,
      address_line1: `${(parseInt(tag, 16) % 9000) + 100} Example Test Ln`, city: 'Parrish', state: 'FL', zip: '34219',
      active: true, pipeline_stage: 'won',
    }).returning('*');
    const [job] = await trx('scheduled_services').insert({
      customer_id: customer.id, scheduled_date: day(-5), service_type: 'One-Time Pest Control', status: 'completed', is_recurring: false,
    }).returning('id');
    return { customer, job };
  }

  // The card's option for the customer, through the shared offer pricer (the amounts the portal card shows).
  async function cardOption(customer, job) {
    const { option } = await require('../services/service-report/cross-sell').buildStartOffer(customer.id, handle, 'pest_control', {
      visitId: job.id, propertyLookup: async () => SAVED_LOOKUP,
    });
    return option;
  }
  const shownOf = (option, setupFee) => ({
    monthly: option.monthly, perVisit: option.perVisit, dueAtStart: option.dueAtStart, oneTime: option.oneTime, setupFee,
  });

  // The offer's own mint and the plain portal tap, on the same customer.
  const mintFor = ({ customer, option, shown, offer }) => restart().mintPlanStartEstimate({
    customer, serviceKey: 'pest_control', optionId: option.id, shown, ...(offer ? { offer } : {}),
    deps: { db: trx, propertyLookup: async () => SAVED_LOOKUP },
  });
  const offerOf = (job, change = {}) => ({
    jobId: String(job.id), endsAt: new Date(Date.now() + 30 * DAY_MS), firstVisitFrom: day(85), ...change,
  });
  const rowOf = (id) => trx('estimates').where({ id }).first();

  test('the offer quote: stamp, fee waiver, own end date, and a setup fee of $0 wherever the page and the accept read it', async () => {
    const { customer, job } = await seedCustomerWithJob();
    const option = await cardOption(customer, job);
    expect(option.setupFee).toBeGreaterThan(0);
    const offer = offerOf(job);
    const minted = await mintFor({ customer, option, shown: shownOf(option, 0), offer });
    expect(minted).toMatchObject({ reused: false, url: `/estimate/${minted.token}` });

    const row = await rowOf(minted.estimateId);
    const data = parse(row.estimate_data);
    // The stamp, the waiver and the end date.
    expect(data.planStart.offer).toEqual({ jobId: String(job.id), endsAt: offer.endsAt.toISOString(), firstVisitFrom: offer.firstVisitFrom });
    expect(require('../services/plan-offer-estimate').planOfferOf(row.estimate_data)).toEqual(data.planStart.offer);
    expect(data.operatorPriceAdjustment).toEqual({
      type: null, value: 0, label: null, internalReason: require('../services/plan-offer-estimate').PLAN_OFFER_WAIVER_REASON,
      floorBreachAcknowledged: false, waiveSetupFee: true,
    });
    expect(new Date(row.expires_at).getTime()).toBe(offer.endsAt.getTime());
    expect(row).toMatchObject({ source: 'plan_start', status: 'sent', pricing_authority: 'SERVER' });
    // The fee is $0 everywhere it is read: the row, the stored result, the frozen fee, the page bundle and its itemized money.
    expect(Number(row.monthly_total)).toBe(Number(option.monthly));
    expect(Number(row.onetime_total)).toBe(0);
    expect(data.result.oneTime.membershipFee).toBe(0);
    expect(data.result.oneTime.total).toBe(0);
    expect(data.setupFeeQuote).toEqual({ kind: 'waveguard_membership', amount: 0 });
    const bundle = data.sendSnapshot.pricingBundle;
    expect(bundle.setupFee).toBeNull();
    expect(bundle.oneTimeBreakdown).toMatchObject({ items: [], total: 0, quoteRequired: false });
    // The accept's own reads: the converter sees a waived fee and bills none (every caller of frozenSetupFeeAmount, which
    // falls back to the code constant on a zero freeze, asks this first).
    const converter = require('../services/estimate-converter');
    expect(converter.estimateOperatorSetupFeeWaived(data)).toBe(true);
    expect(converter.shouldIncludeWaveGuardSetupFeeForRecurring({ recurringServices: converter.recurringServicesFromEstimateData(data), estimateData: data })).toBe(false);
    // The accept re-check passes on it (the account is still a plan-free home).
    await expect(restart().assertPlanStartAcceptEligible(trx, { id: row.id, customer_id: customer.id })).resolves.toBeUndefined();
    // Its timeline note.
    const [note] = await trx('customer_interactions').where({ customer_id: customer.id, interaction_type: 'note' });
    expect(note.subject).toBe('Plan offer estimate made after a one-time job — Pest Control');
    expect(note.body).toBe(`A plan estimate (${row.id}) was made for the offer after the one-time job: no setup fee, open until ${etDateString(offer.endsAt)}. Accepting it books the next plan visit.`);

    // The same card tapped plain carries the fee and no stamp: the offer is the only difference.
    const plainCustomer = await seedCustomerWithJob();
    const plain = await mintFor({ customer: plainCustomer.customer, option, shown: shownOf(option, option.setupFee) });
    const plainRow = await rowOf(plain.estimateId);
    expect(Number(plainRow.onetime_total)).toBe(Number(option.setupFee));
    expect(parse(plainRow.estimate_data).planStart.offer).toBeUndefined();
    expect(parse(plainRow.estimate_data).operatorPriceAdjustment).toBeUndefined();
  });

  test('a second offer mint for the same job hands the quote back; an offer for another job retires it and mints again', async () => {
    const { customer, job } = await seedCustomerWithJob();
    const option = await cardOption(customer, job);
    const first = await mintFor({ customer, option, shown: shownOf(option, 0), offer: offerOf(job) });
    const again = await mintFor({ customer, option, shown: shownOf(option, 0), offer: offerOf(job) });
    expect(again).toMatchObject({ estimateId: first.estimateId, token: first.token, reused: true });

    const [otherJob] = await trx('scheduled_services').insert({
      customer_id: customer.id, scheduled_date: day(-2), service_type: 'One-Time Pest Control', status: 'completed', is_recurring: false,
    }).returning('id');
    const next = await mintFor({ customer, option, shown: shownOf(option, 0), offer: offerOf(otherJob) });
    expect(next.reused).toBe(false);
    expect(next.estimateId).not.toBe(first.estimateId);
    expect((await rowOf(first.estimateId)).archived_at).not.toBeNull();
    expect(parse((await rowOf(next.estimateId)).estimate_data).planStart.offer.jobId).toBe(String(otherJob.id));
  });

  describe('a plain portal tap on the card', () => {
    async function withLiveOffer() {
      const { customer, job } = await seedCustomerWithJob();
      const option = await cardOption(customer, job);
      const offerQuote = await mintFor({ customer, option, shown: shownOf(option, 0), offer: offerOf(job) });
      return { customer, option, offerQuote, plainTap: () => mintFor({ customer, option, shown: shownOf(option, option.setupFee) }) };
    }

    // The tap re-opens the offer through the core: the home, today's price against the card (the card's fee taken as 0),
    // the frozen page and the accept's checks run on the real recompute and snapshot, and the quote is handed back only
    // when they all hold. A refusal leaves the emailed quote as it was.
    const intact = async (customer, offerQuote) => {
      expect((await rowOf(offerQuote.estimateId)).archived_at).toBeNull();
      expect(await trx('estimates').where({ customer_id: customer.id, source: 'plan_start' })).toHaveLength(1);
    };

    test('of the same option at the same price hands back the live offer quote and archives nothing', async () => {
      const { customer, offerQuote, plainTap } = await withLiveOffer();
      expect(await plainTap()).toEqual({ estimateId: offerQuote.estimateId, token: offerQuote.token, url: offerQuote.url, reused: true });
      await intact(customer, offerQuote);
    });

    test.each([
      // The plan's price moved since the offer was minted: today's recompute no longer lands on the quote's frozen dollars.
      ['the price changed since the offer was minted', (offerQuote) => trx('estimates').where({ id: offerQuote.estimateId }).update({ monthly_total: 41 })],
      ['the page snapshot was cleared', async (offerQuote) => {
        const data = parse((await rowOf(offerQuote.estimateId)).estimate_data);
        delete data.sendSnapshot.pricingBundle;
        await trx('estimates').where({ id: offerQuote.estimateId }).update({ estimate_data: JSON.stringify(data) });
      }],
      ['the account\'s home changed', (offerQuote, customer) => trx('customers').where({ id: customer.id }).update({ address_line1: '9 Other Example Ct' })],
    ])('is refused pricing_unavailable, the offer quote untouched, when %s', async (_label, change) => {
      const { customer, offerQuote, plainTap } = await withLiveOffer();
      await change(offerQuote, customer);
      await expect(plainTap()).rejects.toMatchObject({ code: 'pricing_unavailable', restartUnavailable: true });
      await intact(customer, offerQuote);
    });

    test.each([
      ['expired', { expires_at: new Date(Date.now() - DAY_MS) }],
      ['archived', { archived_at: new Date() }],
      ['accepted', { status: 'accepted' }],
      ['changed by staff (the one-time option on)', { show_one_time_option: true }],
    ])('an offer quote that is %s takes the standard flow: a plain quote with the fee', async (_label, change) => {
      const { offerQuote, plainTap } = await withLiveOffer();
      await trx('estimates').where({ id: offerQuote.estimateId }).update(change);
      // An accepted plan quote is history; the account then owns no plan row here, so the tap mints again.
      const tap = await plainTap();
      expect(tap.reused).toBe(false);
      expect(tap.estimateId).not.toBe(offerQuote.estimateId);
      const tapRow = await rowOf(tap.estimateId);
      expect(parse(tapRow.estimate_data).planStart.offer).toBeUndefined();
      expect(Number(tapRow.onetime_total)).toBeGreaterThan(0);
    });
  });
});
