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
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

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
    return { customer, job: await seedJob(customer) };
  }

  // A completed one-time pest job with the record that its service was performed, as the job module reads one
  // (onetime-plan-offer.js qualifyingJobs). `record: false` saves no record.
  async function seedJob(customer, { daysAgo = 5, record = true, ...visit } = {}) {
    const [job] = await trx('scheduled_services').insert({
      customer_id: customer.id, scheduled_date: day(-daysAgo), service_type: 'One-Time Pest Control', status: 'completed',
      is_recurring: false, service_key_snapshot: 'one_time_pest_control', ...visit,
    }).returning('*');
    if (record) {
      await trx('service_records').insert({
        customer_id: customer.id, scheduled_service_id: job.id, service_type: job.service_type, status: 'completed',
        service_date: day(-daysAgo), structured_notes: { visitOutcome: 'completed' },
      });
    }
    return job;
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
  // The caller names the job, nothing else: the job module proves it and gives the dates (dueOfferOfJob).
  const offerOf = (job) => ({ jobId: String(job.id) });
  // The dates the offer must carry for a job whose service was performed `daysAgo` ET days ago, counted here by
  // hand: good through day 30 (it ends when the next ET day starts), the next visit from day 77.
  const termsFor = (daysAgo) => ({
    endsAt: parseETDateTime(`${day(31 - daysAgo)}T00:00:00`),
    firstVisitFrom: day(77 - daysAgo),
  });
  // A date some tests set as a quote's expiry by hand.
  const ENDS = new Date(Date.now() + 30 * DAY_MS);
  const rowOf = (id) => trx('estimates').where({ id }).first();

  test('the offer quote: stamp, fee waiver, own end date, and a setup fee of $0 wherever the page and the accept read it', async () => {
    const { customer, job } = await seedCustomerWithJob();
    const option = await cardOption(customer, job);
    expect(option.setupFee).toBeGreaterThan(0);
    // The seeded job's service was performed 5 days ago.
    const offer = termsFor(5);
    const minted = await mintFor({ customer, option, shown: shownOf(option, 0), offer: offerOf(job) });
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
    expect(note.body).toBe(`A plan estimate (${row.id}) was made for the offer after the one-time job: no setup fee, good through ${day(25)}. Accepting it books the next plan visit.`);

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

    const otherJob = await seedJob(customer, { daysAgo: 4 });
    const next = await mintFor({ customer, option, shown: shownOf(option, 0), offer: offerOf(otherJob) });
    expect(next.reused).toBe(false);
    expect(next.estimateId).not.toBe(first.estimateId);
    expect((await rowOf(first.estimateId)).archived_at).not.toBeNull();
    expect(parse((await rowOf(next.estimateId)).estimate_data).planStart.offer.jobId).toBe(String(otherJob.id));
  });

  // The offer day of one job can move: its included follow-up visit is done later. The mint's fingerprint holds no
  // date, and the picker, the reservation and the accept read the STORED first visit date, so the old quote is
  // never handed back: the same job is minted again with the dates counted from the follow-up's day.
  test('the same job after its included follow-up was done is a new quote: the old one is retired and the new one stores the later dates', async () => {
    const { customer, job } = await seedCustomerWithJob();
    const option = await cardOption(customer, job);
    const first = await mintFor({ customer, option, shown: shownOf(option, 0), offer: offerOf(job) });
    expect(parse((await rowOf(first.estimateId)).estimate_data).planStart.offer.firstVisitFrom).toBe(termsFor(5).firstVisitFrom);

    // The follow-up of that job, performed 3 days ago.
    await seedJob(customer, { daysAgo: 3, followup_included: true, followup_source_service_id: job.id, parent_service_id: job.id });
    const moved = await mintFor({ customer, option, shown: shownOf(option, 0), offer: offerOf(job) });
    expect(moved.reused).toBe(false);
    expect(moved.estimateId).not.toBe(first.estimateId);
    expect((await rowOf(first.estimateId)).archived_at).not.toBeNull();
    const movedRow = await rowOf(moved.estimateId);
    const later = termsFor(3);
    expect(parse(movedRow.estimate_data).planStart.offer).toEqual({
      jobId: String(job.id), endsAt: later.endsAt.toISOString(), firstVisitFrom: later.firstVisitFrom,
    });
    expect(new Date(movedRow.expires_at).getTime()).toBe(later.endsAt.getTime());
    // What the picker and the 07:05 fill list read as the first day they may offer.
    expect(await require('../services/estimate-slot-availability').estimateMoveInDate(movedRow)).toBe(later.firstVisitFrom);
  });

  // The waiver stands on "that one-time job was plan visit one". The mint proves the job under the customer's
  // locks with the job module's own rule: only a completed one-time pest job of THIS customer, with the record
  // that its service was performed, whose offer window is open today (day 3 to day 14 after that service). The
  // dates are counted from that day by the job module, never taken from the caller. Anything else is a caller
  // bug: a plain Error, and the customer's live quote stays as it was.
  describe('the job the offer follows', () => {
    async function withPlainQuote() {
      const { customer, job } = await seedCustomerWithJob();
      const option = await cardOption(customer, job);
      const plain = await mintFor({ customer, option, shown: shownOf(option, option.setupFee) });
      return { customer, option, plain };
    }
    const refused = async ({ customer, option, plain }, job) => {
      await expect(mintFor({ customer, option, shown: shownOf(option, 0), offer: offerOf(job) }))
        .rejects.toThrow(/offer needs a completed one-time pest job of this customer that is due its offer/);
      const rows = await trx('estimates').where({ customer_id: customer.id, source: 'plan_start' });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(plain.estimateId);
      expect(rows[0].archived_at).toBeNull();
      expect(parse(rows[0].estimate_data).operatorPriceAdjustment).toBeUndefined();
    };

    test('a job of another customer grants no waiver', async () => {
      const mine = await withPlainQuote();
      const { job: theirs } = await seedCustomerWithJob();
      await refused(mine, theirs);
    });

    test.each([
      ['a cancelled job', { status: 'cancelled' }],
      ['a job with no record that the service was performed', { record: false }],
      ['a plan visit', { is_recurring: true, recurring_pattern: 'quarterly' }],
      ['a free re-service', { is_callback: true }],
      ['another kind of one-time visit', { service_key_snapshot: 'rodent_exclusion', service_type: 'Rodent Exclusion' }],
    ])('%s grants no waiver', async (_label, visit) => {
      const mine = await withPlainQuote();
      await refused(mine, await seedJob(mine.customer, { daysAgo: 4, ...visit }));
    });

    // The offer window: the service was performed 3 to 14 ET days ago. Outside it the job is not due, so a late
    // or an early mint grants no waiver.
    test.each([[2, 'not yet open'], [15, 'over'], [40, 'long over']])('a job whose service was %i days ago (the window is %s) grants no waiver', async (daysAgo) => {
      const mine = await withPlainQuote();
      await refused(mine, await seedJob(mine.customer, { daysAgo }));
    });

    test.each([3, 14])('the customer\'s own job on day %i of the window grants it, with the dates counted from that day', async (daysAgo) => {
      const mine = await withPlainQuote();
      const job = await seedJob(mine.customer, { daysAgo });
      const offered = await mintFor({ customer: mine.customer, option: mine.option, shown: shownOf(mine.option, 0), offer: offerOf(job) });
      expect(offered.reused).toBe(false);
      expect((await rowOf(mine.plain.estimateId)).archived_at).not.toBeNull();
      const row = await rowOf(offered.estimateId);
      const terms = termsFor(daysAgo);
      expect(parse(row.estimate_data).planStart.offer).toEqual({
        jobId: String(job.id), endsAt: terms.endsAt.toISOString(), firstVisitFrom: terms.firstVisitFrom,
      });
      expect(new Date(row.expires_at).getTime()).toBe(terms.endsAt.getTime());
    });

    test('dates in the caller\'s offer are ignored: the estimate stores the dates counted from the job', async () => {
      const { customer, job } = await seedCustomerWithJob();
      const option = await cardOption(customer, job);
      const minted = await mintFor({
        customer, option, shown: shownOf(option, 0),
        offer: { jobId: String(job.id), endsAt: new Date(Date.now() + 29 * DAY_MS), firstVisitFrom: day(1) },
      });
      const terms = termsFor(5);
      const row = await rowOf(minted.estimateId);
      expect(parse(row.estimate_data).planStart.offer).toEqual({
        jobId: String(job.id), endsAt: terms.endsAt.toISOString(), firstVisitFrom: terms.firstVisitFrom,
      });
      expect(new Date(row.expires_at).getTime()).toBe(terms.endsAt.getTime());
    });
  });

  // The end date is read again after the new quote is published. One that passed during the publication rolls
  // the whole mint back: the prior quote is live again and no new row stays.
  test('an end date that passes while the quote is published rolls the mint back: the prior quote stays live', async () => {
    const { customer, job } = await seedCustomerWithJob();
    const option = await cardOption(customer, job);
    const plain = await mintFor({ customer, option, shown: shownOf(option, option.setupFee) });
    let published = false;
    const attempt = restart().mintPlanStartEstimate({
      customer, serviceKey: 'pest_control', optionId: option.id, shown: shownOf(option, 0), offer: offerOf(job),
      now: () => (published ? new Date(Date.now() + 40 * DAY_MS) : new Date()),
      deps: {
        db: trx,
        propertyLookup: async () => SAVED_LOOKUP,
        buildEstimateSendSnapshot: async (...args) => {
          published = true;
          return require('../routes/admin-estimates').buildEstimateSendSnapshot(...args);
        },
      },
    });
    await expect(attempt).rejects.toThrow(/offer needs an end date that is still ahead/);
    expect(published).toBe(true);
    const rows = await trx('estimates').where({ customer_id: customer.id, source: 'plan_start' });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(plain.estimateId);
    expect(rows[0].archived_at).toBeNull();
  });

  // An offer quote is never a member of a multi-property group. "Add another property" on it is refused on the
  // locked row (the only write that groups an existing estimate); a plain plan-start quote may anchor a group.
  test('an offer quote cannot anchor a multi-property group; a plain plan-start quote can', async () => {
    const { ensureEstimateGroupId } = require('../services/admin-estimate-persistence');
    const { customer, job } = await seedCustomerWithJob();
    const option = await cardOption(customer, job);
    const offered = await mintFor({ customer, option, shown: shownOf(option, 0), offer: offerOf(job) });
    const sibling = { customer_id: customer.id, address: '77 Other Home Rd, Parrish, FL 34219' };
    await expect(ensureEstimateGroupId(trx, offered.estimateId, sibling))
      .rejects.toMatchObject({ statusCode: 400, code: 'plan_offer_grouped' });
    expect((await rowOf(offered.estimateId)).estimate_group_id).toBeNull();

    const other = await seedCustomerWithJob();
    const plain = await mintFor({ customer: other.customer, option, shown: shownOf(option, option.setupFee) });
    const groupId = await ensureEstimateGroupId(trx, plain.estimateId, { ...sibling, customer_id: other.customer.id });
    expect((await rowOf(plain.estimateId)).estimate_group_id).toBe(groupId);
  });

  // The belt behind that rule: an offer row that carries a group all the same (written by hand here) is not one of
  // the group's links. It gets no navigation promise from a live sibling, and its expired link is not refreshed.
  test('an offer row in a group is never a group link: no navigation promise, no refresh of its expired link', async () => {
    const navigation = require('../services/estimate-group-navigation');
    const { customer, job } = await seedCustomerWithJob();
    const option = await cardOption(customer, job);
    const offered = await mintFor({ customer, option, shown: shownOf(option, 0), offer: offerOf(job) });
    const other = await seedCustomerWithJob();
    const live = await mintFor({ customer: other.customer, option, shown: shownOf(option, option.setupFee) });
    const groupId = crypto.randomUUID();
    await trx('estimates').whereIn('id', [offered.estimateId, live.estimateId]).update({ estimate_group_id: groupId });
    await trx('estimates').where({ id: offered.estimateId }).update({ status: 'expired', expires_at: new Date(Date.now() - 2 * DAY_MS) });

    const links = await navigation.publishedGroupLinks(trx, await rowOf(live.estimateId));
    expect(links.map((link) => link.id)).toEqual([live.estimateId]);
    await navigation.extendPublishedGroupLinks(trx, await rowOf(live.estimateId));
    expect(parse((await rowOf(offered.estimateId)).estimate_data).groupLinkViewableThrough).toBeUndefined();
    expect(await navigation.refreshExpiredGroupNavigation(trx, await rowOf(offered.estimateId))).toBeNull();
    expect(parse((await rowOf(offered.estimateId)).estimate_data).groupLinkViewableThrough).toBeUndefined();

    // The same row without the stamp is a group link and takes the live sibling's promise: only the stamp closes it.
    await trx.raw("UPDATE estimates SET estimate_data = estimate_data #- '{planStart,offer}' WHERE id = ?", [offered.estimateId]);
    const refreshed = await navigation.refreshExpiredGroupNavigation(trx, await rowOf(offered.estimateId));
    expect(parse(refreshed.estimate_data).groupLinkViewableThrough).toBeTruthy();
  });

  // Staff can put estimates of several homes on one link (a group). The extension of one of them brings its siblings
  // back to the same new date. The offer quote keeps its own end date and its status: the real extension, on real rows.
  test("a grouped sibling's extension never revives or re-dates the offer quote; an ordinary sibling is revived", async () => {
    const { extendEstimate } = require('../services/estimate-extension');
    const plainQuote = async () => {
      const { customer, job } = await seedCustomerWithJob();
      const option = await cardOption(customer, job);
      return mintFor({ customer, option, shown: shownOf(option, option.setupFee) });
    };
    const { customer, job } = await seedCustomerWithJob();
    const option = await cardOption(customer, job);
    const offered = await mintFor({ customer, option, shown: shownOf(option, 0), offer: offerOf(job) });
    const extended = await plainQuote();
    const ordinary = await plainQuote();
    const ids = [offered.estimateId, extended.estimateId, ordinary.estimateId];
    const groupId = crypto.randomUUID();
    const past = new Date(Date.now() - 2 * DAY_MS);
    await trx('estimates').whereIn('id', ids).update({ estimate_group_id: groupId, status: 'expired', expires_at: past });

    await extendEstimate({ estimate: await rowOf(extended.estimateId), days: 7, silent: true, entryPoint: 'test' });
    const anchor = await rowOf(extended.estimateId);
    expect(anchor.status).toBe('sent');
    expect(new Date(anchor.expires_at).getTime()).toBeGreaterThan(Date.now());
    const sibling = await rowOf(ordinary.estimateId);
    expect(sibling.status).toBe('sent');
    expect(new Date(sibling.expires_at).getTime()).toBe(new Date(anchor.expires_at).getTime());
    const offerRow = await rowOf(offered.estimateId);
    expect(offerRow.status).toBe('expired');
    expect(new Date(offerRow.expires_at).getTime()).toBe(past.getTime());
    expect(offerRow.extension_auto_granted_at).toBeNull();

    // A LIVE offer quote in the group keeps its own end date too, when a sibling is extended past it.
    await trx('estimates').where({ id: offered.estimateId }).update({ status: 'sent', expires_at: ENDS });
    await trx('estimates').where({ id: extended.estimateId }).update({ status: 'expired', expires_at: past });
    await extendEstimate({ estimate: await rowOf(extended.estimateId), days: 90, silent: true, entryPoint: 'test' });
    expect(new Date((await rowOf(extended.estimateId)).expires_at).getTime()).toBeGreaterThan(ENDS.getTime());
    expect(new Date((await rowOf(ordinary.estimateId)).expires_at).getTime()).toBeGreaterThan(ENDS.getTime());
    const liveOffer = await rowOf(offered.estimateId);
    expect(liveOffer.status).toBe('sent');
    expect(new Date(liveOffer.expires_at).getTime()).toBe(ENDS.getTime());
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

    // The tap reads and locks one row: the newest LIVE quote. A newer quote of the customer that has ended (still
    // unarchived) is neither the answer nor a reason to miss the live offer behind it.
    test('finds the live offer quote behind a newer quote that has ended', async () => {
      const { customer, offerQuote, plainTap } = await withLiveOffer();
      const endedId = crypto.randomUUID();
      await trx.raw(
        `INSERT INTO estimates
         SELECT (jsonb_populate_record(NULL::estimates, to_jsonb(e) || jsonb_build_object(
           'id', ?::text, 'token', ?::text, 'estimate_slug', ?::text, 'expires_at', ?::timestamptz, 'created_at', ?::timestamptz,
           'estimate_data', e.estimate_data #- '{planStart,offer}'))).*
         FROM estimates e WHERE e.id = ?`,
        [endedId, crypto.randomBytes(16).toString('hex'), `ended-${endedId}`, new Date(Date.now() - DAY_MS), new Date(Date.now() + DAY_MS), offerQuote.estimateId],
      );
      expect(await plainTap()).toMatchObject({ estimateId: offerQuote.estimateId, reused: true });
      expect((await rowOf(offerQuote.estimateId)).archived_at).toBeNull();
      expect((await rowOf(endedId)).archived_at).toBeNull();
      expect(await trx('estimates').where({ customer_id: customer.id, source: 'plan_start' })).toHaveLength(2);
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
