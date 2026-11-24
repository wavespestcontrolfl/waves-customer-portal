// The job-offer state machine on a real, migrated PostgreSQL (services/job-offers.js): the Technician Terms lookup
// (issued versions only), the draft / send / revise / withdraw writers, the public view / consent / sign / date
// request / decline, the staff record a signature makes, and the two partial unique indexes. Every row is written inside ONE root transaction that is
// rolled back at the end (services reach it through savepoints), so nothing persists. Synthetic people only.
// Comms and bells are mocked: nothing is sent.

// CI's DB-gated step selects suites by this exact line.
const SKIP = !process.env.DATABASE_URL;
const connection = process.env.DATABASE_URL;

const { randomUUID } = require('node:crypto');
const { addStaffWorkDays } = require('../utils/staff-time-work-date');

let mockDb;
jest.mock('../models/db', () => {
  const database = (...args) => mockDb(...args);
  database.transaction = (...args) => mockDb.transaction(...args);
  database.raw = (...args) => mockDb.raw(...args);
  Object.defineProperty(database, 'fn', { get: () => mockDb.fn });
  return database;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockSendStageComms = jest.fn(async () => ({ sms: 'sent', email: 'sent' }));
// The gates of a recruiting stage, as job-offers.js asks the sender for them (the reminder pass). On in this suite.
const mockStageEnabled = jest.fn(() => true);
jest.mock('../services/recruiting-comms', () => ({
  ...jest.requireActual('../services/recruiting-comms'),
  sendStageComms: (...args) => mockSendStageComms(...args),
  stageEnabled: (...args) => mockStageEnabled(...args),
}));
// The Florida minimum wage a pay step is checked against (payroll-rate-steps.js createStep). The real table ends at
// the last year on file, so a suite that signs offers 3 months ahead must not depend on it.
const mockWageFloor = jest.fn(() => 1500n);
jest.mock('../services/payroll-calc', () => ({
  ...jest.requireActual('../services/payroll-calc'),
  floridaMinimumWageCentsFor: (...args) => mockWageFloor(...args),
}));
const mockRaise = jest.fn(async () => ({ id: 'bell-1' }));
jest.mock('../services/admin-alert-compose', () => ({
  ...jest.requireActual('../services/admin-alert-compose'),
  raiseAdminAlert: (...args) => mockRaise(...args),
}));

jest.setTimeout(120000);

(SKIP ? describe.skip : describe)('job offers (PostgreSQL)', () => {
  let database;
  let root;
  let JobOffers;
  let owner;
  const actor = () => ({ id: owner.id, name: 'Test Owner' });

  const goodSnapshot = (over = {}) => ({
    title: 'Technician Terms',
    body: '## Duties {#duties}\nDo the work.\n\n## Pay {#pay}\nPaid weekly.',
    policy_values: { pay_frequency: 'weekly', pay_schedule: 'Pay day is Friday for the week ending the prior Sunday' },
    ...over,
  });

  async function seedTerms(conn, { published = true, snapshot = goodSnapshot(), effectiveAt = new Date('2026-01-01T00:00:00Z') } = {}) {
    const [doc] = await conn('document_templates').insert({
      template_key: JobOffers.TERMS_TEMPLATE_KEY, name: 'Offer Letter', audience: 'staff', staff_kind: 'policy', staff_access: 'staff',
    }).returning('*');
    const [version] = await conn('document_template_versions').insert({
      template_id: doc.id, version_number: 1, title: snapshot.title || 'Technician Terms', body: 'source',
      ...(published ? {
        content_snapshot: JSON.stringify(snapshot), content_hash: 'a'.repeat(64), published_at: new Date('2026-01-01T00:00:00Z'), effective_at: effectiveAt,
      } : {}),
    }).returning('*');
    return { doc, version };
  }

  async function inRolledBack(work) {
    try {
      await root.transaction(async (sp) => { await work(sp); throw new Error('rollback'); });
    } catch (err) {
      if (err.message !== 'rollback') throw err;
    }
  }

  // Runs `work` with the service's next transaction opened by `first`; the ones after it are the real ones.
  async function withNextTransaction(first, work) {
    const real = mockDb;
    let used = false;
    const stand = (...args) => real(...args);
    stand.raw = (...args) => real.raw(...args);
    stand.transaction = (...args) => {
      if (used) return real.transaction(...args);
      used = true;
      return first(...args);
    };
    mockDb = stand;
    try { return await work(); } finally { mockDb = real; }
  }

  // The version a read of the link shows: what the page sends back with each answer.
  const shownVersion = async (token) => (await JobOffers.publicView(token)).version;

  // Presses Send as the page does: with the draft's hash and the offers out the owner's read showed (outStamp).
  async function sendAsPage(applicationId, offerId, draftHash) {
    const { outStamp } = await JobOffers.adminPanel(applicationId, actor());
    return JobOffers.sendOffer(applicationId, offerId, actor(), draftHash, new Date(), { expectedOut: outStamp });
  }

  // Saves the default draft and presses Send on exactly the preview the draft's hash names.
  async function sendNew(app) {
    const draft = await JobOffers.saveDraft(app.id, {}, actor());
    return sendAsPage(app.id, draft.id, draft.draftHash);
  }

  // Each application has its own email: a signature makes a staff row, and a staff email is held by one row only.
  const applicantEmail = () => `jordan.rivera.${randomUUID().slice(0, 8)}@example.test`;
  // Every application the suite made (a setup step that sets earlier tests' rows aside names only these).
  const suiteApplications = [];
  async function newApplication(over = {}) {
    const [row] = await root('job_applications').insert({
      role: 'technician', status: 'reviewed',
      contact_snapshot: JSON.stringify({ name: 'Jordan Rivera', phone: '(941) 555-0100', email: applicantEmail() }),
      ...over,
    }).returning('*');
    suiteApplications.push(row.id);
    return row;
  }

  beforeAll(async () => {
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    root = await database.transaction();
    mockDb = root;
    JobOffers = require('../services/job-offers');
    [owner] = await root('technicians').insert({ name: 'Test Owner', role: 'admin', email: `owner-${randomUUID()}@example.test` }).returning('*');
  });
  afterAll(async () => { await root?.rollback(); await database?.destroy(); });
  beforeEach(() => { mockSendStageComms.mockClear(); mockRaise.mockClear(); });

  describe('the Technician Terms lookup', () => {
    test('no document, a draft only, a [DECISION marker and missing pay policy all block', async () => {
      await inRolledBack(async (sp) => {
        const none = await JobOffers.loadIssuedTerms(sp);
        expect(none.terms).toBeNull();
        expect(none.blockers).toEqual(['The Technician Terms document is not set up.']);
      });
      await inRolledBack(async (sp) => {
        await seedTerms(sp, { published: false });
        expect((await JobOffers.loadIssuedTerms(sp)).blockers).toEqual(['The Technician Terms have no issued version.']);
      });
      await inRolledBack(async (sp) => {
        await seedTerms(sp, { snapshot: goodSnapshot({ body: '## Pay {#pay}\nSet by [DECISION: weekly or not].' }) });
        expect((await JobOffers.loadIssuedTerms(sp)).blockers).toEqual(['The issued Technician Terms still hold a [DECISION marker.']);
      });
      await inRolledBack(async (sp) => {
        await seedTerms(sp, { snapshot: goodSnapshot({ policy_values: undefined }) });
        expect((await JobOffers.loadIssuedTerms(sp)).blockers).toEqual(['The pay frequency and pay schedule are missing, or too long to print on the offer (500 characters in all).']);
      });
    });

    test('a version that is not yet in force is not used; the pay line falls back to the issued policy row', async () => {
      await inRolledBack(async (sp) => {
        await seedTerms(sp, { effectiveAt: new Date(Date.now() + 86400000 * 30) });
        expect((await JobOffers.loadIssuedTerms(sp)).blockers).toEqual(['The Technician Terms have no issued version.']);
      });
      await inRolledBack(async (sp) => {
        const [{ max }] = await sp('policy_values').max('revision as max');
        await sp('policy_values').insert({
          revision: Number(max || 0) + 1, effective_at: new Date('2026-02-01T00:00:00Z'), content_hash: 'b'.repeat(64), approved_by: owner.id,
          values: JSON.stringify({ pay_frequency: 'weekly', pay_schedule: 'Fridays' }),
        });
        await seedTerms(sp, { snapshot: goodSnapshot({ policy_values: undefined }) });
        const issued = await JobOffers.loadIssuedTerms(sp);
        expect(issued.blockers).toEqual([]);
        expect(issued.payDayLine).toBe('Paid weekly. Fridays.');
      });
    });
  });

  describe('send with the Terms not issued', () => {
    test('409 TERMS_NOT_ISSUED names the blockers and leaves the draft a draft', async () => {
      const app = await newApplication();
      const offer = await JobOffers.saveDraft(app.id, {}, actor());
      await expect(sendAsPage(app.id, offer.id, offer.draftHash)).rejects.toMatchObject({ status: 409, code: 'TERMS_NOT_ISSUED' });
      expect((await root('job_offers').where({ id: offer.id }).first()).status).toBe('draft');
      expect(mockSendStageComms).not.toHaveBeenCalled();
    });
  });

  describe('the flow, with the Terms issued', () => {
    beforeAll(async () => { await seedTerms(root); });

    test('a draft prefills the owner defaults and updates in place; one draft per application', async () => {
      const app = await newApplication();
      const first = await JobOffers.saveDraft(app.id, {}, actor());
      expect(first).toMatchObject({ status: 'draft', jobTitle: 'Pest Control Technician', hourlyRate: 23, stepRate: 25, reportTo: 'Test Owner, owner' });
      expect(first.startDate).toBe(JobOffers.suggestStartDate());
      expect(first.stepEffectiveOn).toBe(JobOffers.stepDateFor(first.startDate));
      const updated = await JobOffers.saveDraft(app.id, { hourlyRate: 24, draftId: first.id, draftHash: first.draftHash }, actor());
      expect(updated.id).toBe(first.id);
      expect(updated.hourlyRate).toBe(24);
      expect(await root('job_offers').where({ application_id: app.id }).count('* as n').first()).toEqual({ n: '1' });
    });

    test('invalid input is a 400 with the field errors; a non-technician and a closed application are 409', async () => {
      const app = await newApplication();
      await expect(JobOffers.saveDraft(app.id, { hourlyRate: 5 }, actor())).rejects.toMatchObject({ status: 400, code: 'INVALID_OFFER' });
      const sales = await newApplication({ role: 'sales' });
      await expect(JobOffers.saveDraft(sales.id, {}, actor())).rejects.toMatchObject({ status: 409, code: 'ROLE_NOT_SUPPORTED' });
      const hired = await newApplication({ status: 'hired' });
      await expect(JobOffers.saveDraft(hired.id, {}, actor())).rejects.toMatchObject({ status: 409, code: 'APPLICATION_CLOSED' });
    });

    test('send freezes the offer, moves the application to offer, texts and emails once, and refuses a replay', async () => {
      const app = await newApplication();
      const draft = await JobOffers.saveDraft(app.id, {}, actor());
      const sent = await sendAsPage(app.id, draft.id, draft.draftHash);
      expect(sent.comms).toEqual({ sms: { outcome: 'sent', code: null }, email: { outcome: 'sent', code: null } });
      expect(sent.offer).toMatchObject({ status: 'sent', sentByName: 'Test Owner', payDayLine: 'Paid weekly. Pay day is Friday for the week ending the prior Sunday.' });
      expect(sent.offer.offerUrl).toMatch(/\/careers\/offer\/[0-9a-f]{64}$/);

      const row = await root('job_offers').where({ id: draft.id }).first();
      expect(row.token).toMatch(/^[0-9a-f]{64}$/);
      expect(row.snapshot_hash).toBe(JobOffers.snapshotHashOf(row.snapshot));
      expect(row.terms_content_hash).toBe('a'.repeat(64));
      expect(row.snapshot.terms.markdown).toContain('## Duties');
      expect(row.snapshot.terms.markdown).not.toContain('{#');
      const appRow = await root('job_applications').where({ id: app.id }).first();
      expect(appRow.status).toBe('offer');
      expect(appRow.status_history.at(-1)).toMatchObject({ from: 'reviewed', to: 'offer', by: owner.id });

      expect(mockSendStageComms).toHaveBeenCalledTimes(1);
      const [, stage, opts] = mockSendStageComms.mock.calls[0];
      expect(stage).toBe('offer_sent');
      expect(opts).toMatchObject({ sms: true, email: true, by: owner.id, offerId: draft.id, offerToken: row.token });
      expect(opts.vars).toMatchObject({ job_title: 'Pest Control Technician', sender_name: 'Test Owner' });
      expect(opts.vars.offer_link).toContain(row.token);
      expect(await opts.stillEligible()).toBe(true);

      await expect(sendAsPage(app.id, draft.id, draft.draftHash)).rejects.toMatchObject({ status: 409, code: 'OFFER_NOT_DRAFT' });
      expect(mockSendStageComms).toHaveBeenCalledTimes(1);
    });

    test('an applicant with no phone and no email cannot be sent an offer', async () => {
      const app = await newApplication({ contact_snapshot: JSON.stringify({ name: 'Casey Morgan' }) });
      const draft = await JobOffers.saveDraft(app.id, {}, actor());
      await expect(sendAsPage(app.id, draft.id, draft.draftHash)).rejects.toMatchObject({ status: 409, code: 'NO_CONTACT' });
    });

    test('the offer read names every channel Send tries, by the rule the send uses, masked', async () => {
      // A number too short to mask is still on file, so the send tries it: the read names it as '***'.
      const app = await newApplication({ contact_snapshot: JSON.stringify({ name: 'Casey Morgan', phone: '555-01', email: 'Casey.Morgan@Example.test' }) });
      expect((await JobOffers.adminPanel(app.id, actor())).sendTo).toEqual({ sms: '***', email: 'C***@example.test' });
      const draft = await JobOffers.saveDraft(app.id, {}, actor());
      mockSendStageComms.mockClear();
      await sendAsPage(app.id, draft.id, draft.draftHash);
      expect(mockSendStageComms.mock.calls[0][2]).toMatchObject({ sms: true, email: true });
      const emailOnly = await newApplication({ contact_snapshot: JSON.stringify({ name: 'Sam Lee', email: 'sam@example.test' }) });
      expect((await JobOffers.adminPanel(emailOnly.id, actor())).sendTo).toEqual({ sms: null, email: 's***@example.test' });
    });

    test('a comms failure after the commit leaves the offer sent and reports each channel it tried as uncertain', async () => {
      // The send threw partway, so the text may already have gone out: no channel reads as failed.
      const app = await newApplication();
      const draft = await JobOffers.saveDraft(app.id, {}, actor());
      mockSendStageComms.mockRejectedValueOnce(new Error('boom'));
      const sent = await sendAsPage(app.id, draft.id, draft.draftHash);
      expect(sent.offer.status).toBe('sent');
      expect(sent.comms).toEqual({ sms: { outcome: 'uncertain', code: 'comms_threw' }, email: { outcome: 'uncertain', code: 'comms_threw' } });
      // A channel with nothing on file was not tried.
      const textOnly = await newApplication({ contact_snapshot: JSON.stringify({ name: 'Sam Lee', phone: '(941) 555-0101' }) });
      const second = await JobOffers.saveDraft(textOnly.id, {}, actor());
      mockSendStageComms.mockRejectedValueOnce(new Error('boom'));
      expect((await sendAsPage(textOnly.id, second.id, second.draftHash)).comms).toEqual({
        sms: { outcome: 'uncertain', code: 'comms_threw' }, email: { outcome: 'not_requested', code: null },
      });
    });

    test('revise leaves the old offer out until the new draft is sent; sending supersedes it', async () => {
      const app = await newApplication();
      const draft = await JobOffers.saveDraft(app.id, {}, actor());
      const sent = await sendAsPage(app.id, draft.id, draft.draftHash);
      const oldToken = (await root('job_offers').where({ id: draft.id }).first()).token;

      await expect(JobOffers.saveDraft(app.id, {}, actor())).rejects.toMatchObject({ status: 409, code: 'OFFER_ALREADY_OPEN' });
      const revised = await JobOffers.reviseOffer(app.id, sent.offer.id, { expectedStatus: 'sent', startDate: addStaffWorkDays(JobOffers.suggestStartDate(), 7) }, actor());
      expect(revised).toMatchObject({ status: 'draft', supersedesId: sent.offer.id });
      expect((await root('job_offers').where({ id: draft.id }).first()).status).toBe('sent');
      expect((await JobOffers.reviseOffer(app.id, sent.offer.id, { expectedStatus: 'sent' }, actor())).id).toBe(revised.id);

      const resent = await sendAsPage(app.id, revised.id, revised.draftHash);
      expect(resent.offer.status).toBe('sent');
      const old = await root('job_offers').where({ id: draft.id }).first();
      expect(old).toMatchObject({ status: 'superseded', superseded_by_id: revised.id });
      const view = await JobOffers.publicView(oldToken);
      expect(view).toMatchObject({ state: 'superseded', contactPhone: '(941) 297-5749' });
      expect(view.terms).toBeUndefined();
      expect(view.message).toMatch(/^This offer was updated\. Please use the newest link /);
      expect((await root('job_applications').where({ id: app.id }).first()).status_history.at(-1).note).toBe('Updated job offer sent');
    });

    test('the offer read names the offer a Send of the revision replaces, while its link still works', async () => {
      const app = await newApplication();
      const draft = await JobOffers.saveDraft(app.id, {}, actor());
      expect((await JobOffers.adminPanel(app.id, actor())).sendReplacesId).toBeNull();
      const sent = await sendAsPage(app.id, draft.id, draft.draftHash);
      expect((await JobOffers.adminPanel(app.id, actor())).sendReplacesId).toBeNull();
      await JobOffers.reviseOffer(app.id, sent.offer.id, { expectedStatus: 'sent' }, actor());
      expect((await JobOffers.adminPanel(app.id, actor())).sendReplacesId).toBe(sent.offer.id);
      // Past its expiry the old link already says so: a Send stops no working link.
      const later = new Date(Date.parse(sent.offer.expiresAt) + 60 * 1000);
      expect((await JobOffers.adminPanel(app.id, actor(), later)).sendReplacesId).toBeNull();
    });

    // The page reads the application and the offers separately; the panel's own stage lets it see when its application
    // read is behind the offer card. Both come from one read-only snapshot (here a savepoint inside the suite's
    // transaction, which takes no isolation level: the options are checked as passed, on the db module the service reads).
    test('the offer read returns the stage it read with the offers, from one read-only snapshot', async () => {
      const app = await newApplication();
      const spy = jest.spyOn(require('../models/db'), 'transaction');
      try {
        expect((await JobOffers.adminPanel(app.id, actor())).applicationStatus).toBe('reviewed');
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'repeatable read', readOnly: true });
      } finally {
        spy.mockRestore();
      }
      const sent = await sendNew(app);
      const token = (await root('job_offers').where({ id: sent.offer.id }).first()).token;
      expect((await JobOffers.adminPanel(app.id, actor())).applicationStatus).toBe('offer');
      await JobOffers.acceptOffer(token, { signedName: 'Jordan Rivera', version: await shownVersion(token) });
      expect(await JobOffers.adminPanel(app.id, actor())).toMatchObject({ applicationStatus: 'hired', current: { id: sent.offer.id, status: 'accepted' } });
    });

    test('a revision Send is refused when the offer out changed after the read, and nothing is replaced or sent', async () => {
      const app = await newApplication();
      const sent = await sendNew(app);
      const token = (await root('job_offers').where({ id: sent.offer.id }).first()).token;
      const revised = await JobOffers.reviseOffer(app.id, sent.offer.id, { expectedStatus: 'sent' }, actor());
      const read = await JobOffers.adminPanel(app.id, actor());
      // The applicant asks for another start date after the owner's read; the revision's own hash is unchanged.
      const wanted = addStaffWorkDays(JobOffers.suggestStartDate(), 14);
      await JobOffers.requestDate(token, { requestedStartDate: wanted, note: 'Need two more weeks', version: await shownVersion(token) });
      mockSendStageComms.mockClear();
      await expect(JobOffers.sendOffer(app.id, revised.id, actor(), revised.draftHash, new Date(), { expectedOut: read.outStamp }))
        .rejects.toMatchObject({ status: 409, code: 'OFFERS_CHANGED' });
      expect((await root('job_offers').where({ id: sent.offer.id }).first()).status).toBe('date_requested');
      expect((await root('job_offers').where({ id: revised.id }).first()).status).toBe('draft');
      expect(mockSendStageComms).not.toHaveBeenCalled();
      // A read after the request carries it, and that send goes through.
      const fresh = await JobOffers.adminPanel(app.id, actor());
      expect(fresh.outStamp).not.toBe(read.outStamp);
      const resent = await JobOffers.sendOffer(app.id, revised.id, actor(), revised.draftHash, new Date(), { expectedOut: fresh.outStamp });
      expect(resent.offer.status).toBe('sent');
    });

    test('a revision Send without the stamp of the offers out is refused, and nothing is replaced or sent', async () => {
      const app = await newApplication();
      const sent = await sendNew(app);
      const token = (await root('job_offers').where({ id: sent.offer.id }).first()).token;
      const revised = await JobOffers.reviseOffer(app.id, sent.offer.id, { expectedStatus: 'sent' }, actor());
      // The applicant asks for another start date; the revision's own hash is unchanged, so only the stamp can catch it.
      const wanted = addStaffWorkDays(JobOffers.suggestStartDate(), 14);
      await JobOffers.requestDate(token, { requestedStartDate: wanted, note: 'Need two more weeks', version: await shownVersion(token) });
      mockSendStageComms.mockClear();
      await expect(JobOffers.sendOffer(app.id, revised.id, actor(), revised.draftHash))
        .rejects.toMatchObject({ status: 400, code: 'OUT_STAMP_REQUIRED' });
      expect((await root('job_offers').where({ id: sent.offer.id }).first()).status).toBe('date_requested');
      expect((await root('job_offers').where({ id: revised.id }).first()).status).toBe('draft');
      expect(mockSendStageComms).not.toHaveBeenCalled();
    });

    // The card's dated update names the asked day. On that day (Eastern) the server no longer takes it as a start date:
    // the dated update is refused and writes nothing, so no draft starts on another day than its button named. A Revise
    // without a date still falls back to the suggested start.
    test('on the asked day, the dated update is refused and writes nothing; a Revise without a date falls back to the suggested start', async () => {
      const app = await newApplication();
      const sent = await sendNew(app);
      const token = (await root('job_offers').where({ id: sent.offer.id }).first()).token;
      const wanted = addStaffWorkDays(JobOffers.suggestStartDate(), 14);
      await JobOffers.requestDate(token, { requestedStartDate: wanted, note: 'Need two more weeks', version: await shownVersion(token) });
      const onTheDay = new Date(`${wanted}T17:00:00Z`); // noon in Eastern time on the asked day
      await expect(JobOffers.reviseOffer(app.id, sent.offer.id, { expectedStatus: 'date_requested', startDate: wanted }, actor(), onTheDay)).rejects.toMatchObject({
        status: 409,
        code: 'START_DATE_UNAVAILABLE',
        message: 'The start date must be in the future. Nothing was changed. Use Revise to choose another start date.',
      });
      // A start date the request carries is checked even when empty: only a request without the field falls back.
      for (const startDate of ['', null, false]) {
        await expect(JobOffers.reviseOffer(app.id, sent.offer.id, { expectedStatus: 'date_requested', startDate }, actor()))
          .rejects.toMatchObject({ status: 409, code: 'START_DATE_UNAVAILABLE' });
      }
      expect(await root('job_offers').where({ application_id: app.id, status: 'draft' })).toEqual([]);
      const revised = await JobOffers.reviseOffer(app.id, sent.offer.id, { expectedStatus: 'date_requested' }, actor(), onTheDay);
      expect(revised.startDate).toBe(JobOffers.suggestStartDate(onTheDay));
    });

    // The clock is read once the row locks are held. A dated update that waits for a lock across Eastern midnight is
    // judged by the day it writes in. Here only Date is fake: it starts on the eve of the asked day, and every FOR UPDATE
    // the revision sends moves it to the asked day, as a long lock wait would.
    test('a dated update is judged by the clock after its row locks', async () => {
      const app = await newApplication();
      const sent = await sendNew(app);
      const token = (await root('job_offers').where({ id: sent.offer.id }).first()).token;
      const wanted = addStaffWorkDays(JobOffers.suggestStartDate(), 14);
      await JobOffers.requestDate(token, { requestedStartDate: wanted, note: 'Need two more weeks', version: await shownVersion(token) });
      const onTheDay = new Date(`${wanted}T17:00:00Z`); // noon in Eastern time on the asked day
      const eve = new Date(onTheDay.getTime() - 24 * 3600e3); // about noon the day before
      const lockWait = (query) => {
        if (/for update/i.test(query.sql)) jest.setSystemTime(onTheDay);
      };
      jest.useFakeTimers({
        now: eve,
        doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
      });
      database.on('query', lockWait);
      try {
        await expect(JobOffers.reviseOffer(app.id, sent.offer.id, { expectedStatus: 'date_requested', startDate: wanted }, actor()))
          .rejects.toMatchObject({ status: 409, code: 'START_DATE_UNAVAILABLE' });
      } finally {
        database.removeListener('query', lockWait);
        jest.useRealTimers();
      }
      expect(await root('job_offers').where({ application_id: app.id, status: 'draft' })).toEqual([]);
    });

    test('a date request becomes a revised offer at the requested date', async () => {
      const app = await newApplication();
      const sent = await sendNew(app);
      const token = (await root('job_offers').where({ id: sent.offer.id }).first()).token;
      const wanted = addStaffWorkDays(JobOffers.suggestStartDate(), 14);
      const result = await JobOffers.requestDate(token, { requestedStartDate: wanted, note: 'Need two more weeks', version: await shownVersion(token) });
      expect(result.body).toEqual({ state: 'date_requested' });
      const revised = await JobOffers.reviseOffer(app.id, sent.offer.id, { expectedStatus: 'date_requested' }, actor());
      expect(revised.startDate).toBe(wanted);
      expect(revised.stepEffectiveOn).toBe(JobOffers.stepDateFor(wanted));
      const resent = await sendAsPage(app.id, revised.id, revised.draftHash);
      expect(resent.offer.status).toBe('sent');
      expect((await root('job_offers').where({ id: sent.offer.id }).first()).status).toBe('superseded');
    });

    // Signing or declining the offer out closes a revision the owner was drafting meanwhile. That revision is newer but
    // was never sent: the card shows the offer the applicant answered, and the closed revision is an earlier offer.
    test.each(['signs', 'declines'])('when the applicant %s while a revision is in draft, the panel shows the answered offer, not the closed revision', async (answer) => {
      const app = await newApplication();
      const sent = await sendNew(app);
      // Every row here is written in one transaction, so all share one created_at. Live, the revision comes in a later
      // request: the offer was drafted an hour before it.
      await root('job_offers').where({ id: sent.offer.id }).update({ created_at: new Date(Date.now() - 3600e3) });
      const token = (await root('job_offers').where({ id: sent.offer.id }).first()).token;
      const revised = await JobOffers.reviseOffer(app.id, sent.offer.id, { expectedStatus: 'sent' }, actor());
      // The answer carries the version the applicant's page showed (#8115: an answer without it is refused).
      const version = await shownVersion(token);
      const out = answer === 'signs'
        ? await JobOffers.acceptOffer(token, { signedName: 'Jordan Rivera', version })
        : await JobOffers.declineOffer(token, { version });
      expect(out.refused).toBeUndefined();
      const panel = await JobOffers.adminPanel(app.id, actor());
      expect(panel.current).toMatchObject({ id: sent.offer.id, status: answer === 'signs' ? 'accepted' : 'declined' });
      expect(panel.applicationStatus).toBe(answer === 'signs' ? 'hired' : 'withdrawn');
      expect(panel.draft).toBeNull();
      expect(panel.history.map((o) => [o.id, o.status])).toEqual([[revised.id, 'withdrawn']]);
    });

    test('withdraw sends nothing, leaves the application status, and the link says so', async () => {
      const app = await newApplication();
      const sent = await sendNew(app);
      mockSendStageComms.mockClear();
      const token = (await root('job_offers').where({ id: sent.offer.id }).first()).token;
      const out = await JobOffers.withdrawOffer(app.id, sent.offer.id, actor(), { expectedStatus: 'sent' });
      expect(out.status).toBe('withdrawn');
      await expect(JobOffers.withdrawOffer(app.id, sent.offer.id, actor(), { expectedStatus: 'sent' })).rejects.toMatchObject({ status: 409, code: 'OFFER_CHANGED' }); // a second press: nothing written
      expect(mockSendStageComms).not.toHaveBeenCalled();
      expect((await root('job_applications').where({ id: app.id }).first()).status).toBe('offer');
      expect(await JobOffers.publicView(token)).toMatchObject({ state: 'withdrawn', contactPhone: '(941) 297-5749' });
      const accepted = await JobOffers.acceptOffer(token, { signedName: 'Jordan Rivera' });
      expect(accepted).toMatchObject({ refused: true, body: { state: 'withdrawn' } });
    });

    describe('the applicant side', () => {
      let app;
      let offer;
      let token;
      beforeEach(async () => {
        app = await newApplication();
        offer = (await sendNew(app)).offer;
        token = (await root('job_offers').where({ id: offer.id }).first()).token;
        mockRaise.mockClear();
      });

      test('the view serves the frozen personal terms and the Terms, and stamps opened / last viewed', async () => {
        const view = await JobOffers.publicView(token);
        expect(view).toMatchObject({
          state: 'open', firstName: 'Jordan', jobTitle: 'Pest Control Technician', hourlyRate: 23, stepRate: 25,
          hoursLine: '40 paid hours each full week, four 10-hour days, Monday to Thursday', reportTo: 'Test Owner, owner',
          owner: { name: 'Test Owner', title: 'owner' }, textConsent: false, signedName: null,
          terms: { title: 'Technician Terms' },
        });
        expect(view.terms.markdown).toContain('## Pay');
        const row = await root('job_offers').where({ id: offer.id }).first();
        expect(row.opened_at).toBeTruthy();
        expect(row.last_viewed_at).toBeTruthy();
        expect(await JobOffers.publicView('0'.repeat(64))).toBeNull();
      });

      test('a view and the Terms stay as sent when the Terms change afterwards', async () => {
        await root('document_template_versions').insert({
          template_id: (await root('document_templates').where({ template_key: JobOffers.TERMS_TEMPLATE_KEY }).first()).id, version_number: 2,
          title: 'Technician Terms', body: 'x', content_snapshot: JSON.stringify(goodSnapshot({ body: '## New {#new}\nChanged.' })),
          content_hash: 'c'.repeat(64), published_at: new Date(), effective_at: new Date(Date.now() - 1000),
        });
        expect((await JobOffers.publicView(token)).terms.markdown).toContain('## Duties');
      });

      test('text consent records and clears the stamp from the current version; a late save from an older read cannot undo a later choice', async () => {
        const stamp = async () => (await root('job_offers').where({ id: offer.id }).first()).text_consent_at;
        const first = (await JobOffers.publicView(token)).version;
        const on = await JobOffers.setTextConsent(token, true, first);
        expect(on).toEqual({ body: { textConsent: true, version: expect.any(String) } });
        expect(on.body.version).not.toBe(first);
        expect(await stamp()).toBeTruthy();
        // The same choice again (Try again after a lost reply) writes nothing and answers the stored choice.
        expect(await JobOffers.setTextConsent(token, true, first)).toEqual({ body: { textConsent: true, version: on.body.version } });
        const off = await JobOffers.setTextConsent(token, false, on.body.version);
        expect(off).toEqual({ body: { textConsent: false, version: expect.any(String) } });
        expect(off.body.version).not.toBe(on.body.version);
        expect(await stamp()).toBeNull();
        // The first save of "on" lands only now: refused, and "off" stays.
        expect(await JobOffers.setTextConsent(token, true, first)).toEqual({ refused: true, body: { state: 'open' } });
        expect(await stamp()).toBeNull();
        expect((await JobOffers.publicView(token)).version).toBe(off.body.version);
        expect(await JobOffers.setTextConsent(token, 'yes', off.body.version)).toMatchObject({ invalid: expect.any(String) });
      });

      test('signing records the signature, hires the applicant, raises one bell, and a replay never signs twice', async () => {
        expect(await JobOffers.acceptOffer(token, { signedName: 'Jordan' })).toMatchObject({ invalid: expect.any(String) });
        expect(await JobOffers.acceptOffer(token, { signedName: '  ' })).toMatchObject({ invalid: expect.any(String) });
        const signed = await JobOffers.acceptOffer(token, { signedName: '  Jordan   Rivera ', ip: '203.0.113.9', userAgent: 'TestAgent/1.0', version: await shownVersion(token) });
        expect(signed.body).toMatchObject({ state: 'signed' });
        expect(signed.body.replay).toBeUndefined(); // this request signed
        const row = await root('job_offers').where({ id: offer.id }).first();
        expect(row).toMatchObject({ status: 'accepted', signed_name: 'Jordan Rivera', signed_ip: '203.0.113.9', signed_user_agent: 'TestAgent/1.0' });
        expect(row.signature_hash).toBe(JobOffers.signatureHashOf({
          snapshotHash: row.snapshot_hash, termsContentHash: row.terms_content_hash, signedName: 'Jordan Rivera', signedAt: row.signed_at,
        }));
        const appRow = await root('job_applications').where({ id: app.id }).first();
        expect(appRow.status).toBe('hired');
        expect(appRow.status_history.at(-1)).toMatchObject({ from: 'offer', to: 'hired', by: 'applicant' });
        expect(mockRaise).toHaveBeenCalledTimes(1);
        const [category, spec, opts] = mockRaise.mock.calls[0];
        expect(category).toBe('job_application');
        expect(spec.action).toBe('Jordan Rivera signed the job offer');
        expect(opts).toMatchObject({ bell: true, dedupeKey: `job-offer-signed:${offer.id}` });

        // A replay signs nothing and says so, with the stored signature, so a second tab never claims it (Codex P1).
        const replay = await JobOffers.acceptOffer(token, { signedName: 'jordan rivera' });
        expect(replay.body).toEqual({ state: 'signed', signedAt: row.signed_at.toISOString(), signedName: 'Jordan Rivera', replay: true });
        expect(await JobOffers.acceptOffer(token, { signedName: 'Someone Else' })).toMatchObject({ refused: true, body: { state: 'signed' } });
        expect(mockRaise).toHaveBeenCalledTimes(1);
        expect(await JobOffers.declineOffer(token, {})).toMatchObject({ refused: true, body: { state: 'signed' } });

        const copy = await JobOffers.signedCopy(app.id, offer.id);
        expect(copy).toMatchObject({ signedName: 'Jordan Rivera', signedIp: '203.0.113.9', signatureHash: row.signature_hash });
        expect(copy.markdown).toContain('Signed electronically by Jordan Rivera');
        expect(copy.markdown).toContain('## Technician Terms');
        const view = await JobOffers.publicView(token);
        expect(view).toMatchObject({ state: 'signed', signedName: 'Jordan Rivera' });
      });

      test('a date request needs a future Monday to Thursday, keeps the application at offer, and rings once', async () => {
        const saturday = addStaffWorkDays(JobOffers.suggestStartDate(), 12);
        expect(JobOffers.dowOf(saturday)).toBe(6);
        expect(await JobOffers.requestDate(token, { requestedStartDate: saturday })).toMatchObject({ invalid: expect.any(String) });
        expect(await JobOffers.requestDate(token, { requestedStartDate: '2020-01-06' })).toMatchObject({ invalid: expect.any(String) });
        const monday = addStaffWorkDays(JobOffers.suggestStartDate(), 7);
        const result = await JobOffers.requestDate(token, { requestedStartDate: monday, note: 'My notice ends later', version: await shownVersion(token) });
        expect(result.body).toEqual({ state: 'date_requested' });
        const row = await root('job_offers').where({ id: offer.id }).first();
        expect(row).toMatchObject({ status: 'date_requested', date_request_note: 'My notice ends later' });
        expect((await root('job_applications').where({ id: app.id }).first()).status).toBe('offer');
        expect(mockRaise).toHaveBeenCalledTimes(1);
        expect(mockRaise.mock.calls[0][1].action).toContain('asked for another start date');
        expect(await JobOffers.requestDate(token, { requestedStartDate: monday })).toMatchObject({ refused: true, body: { state: 'date_requested' } });
        expect(await JobOffers.acceptOffer(token, { signedName: 'Jordan Rivera' })).toMatchObject({ refused: true, body: { state: 'date_requested' } });
      });

      test('declining withdraws the application with the applicant as the actor, and rings once', async () => {
        const result = await JobOffers.declineOffer(token, { reason: 'Took another job', version: await shownVersion(token) });
        expect(result.body).toEqual({ state: 'declined' });
        const appRow = await root('job_applications').where({ id: app.id }).first();
        expect(appRow.status).toBe('withdrawn');
        expect(appRow.status_history.at(-1)).toMatchObject({ from: 'offer', to: 'withdrawn', by: 'applicant', reason: 'offer_declined' });
        expect((await root('job_offers').where({ id: offer.id }).first()).decline_reason).toBe('Took another job');
        expect(mockRaise).toHaveBeenCalledTimes(1);
        expect(mockRaise.mock.calls[0][1].action).toBe('Jordan Rivera declined the job offer');
      });

      // Another tab saved a text choice after this page read the offer. A sign, a date request or a decline made on the
      // older read is refused with the offer still open and writes nothing, so none of them fixes a choice the applicant
      // did not see; made on the version the page now shows, the sign goes through.
      test('a sign, date request or decline made on an older read is refused and writes nothing', async () => {
        const first = await shownVersion(token);
        const on = await JobOffers.setTextConsent(token, true, first);
        expect(on.body.version).not.toBe(first);
        const monday = addStaffWorkDays(JobOffers.suggestStartDate(), 7);
        expect(await JobOffers.acceptOffer(token, { signedName: 'Jordan Rivera', version: first })).toEqual({ refused: true, body: { state: 'open' } });
        expect(await JobOffers.requestDate(token, { requestedStartDate: monday, version: first })).toEqual({ refused: true, body: { state: 'open' } });
        expect(await JobOffers.declineOffer(token, { reason: 'Changed my mind', version: first })).toEqual({ refused: true, body: { state: 'open' } });
        expect(await root('job_offers').where({ id: offer.id }).first()).toMatchObject({
          status: 'sent', signed_at: null, signed_name: null, declined_at: null, date_requested_at: null,
        });
        expect((await root('job_applications').where({ id: app.id }).first()).status).toBe('offer');
        expect(mockRaise).not.toHaveBeenCalled();
        expect(await shownVersion(token)).toBe(on.body.version);
        const signed = await JobOffers.acceptOffer(token, { signedName: 'Jordan Rivera', version: on.body.version });
        expect(signed.body).toMatchObject({ state: 'signed' });
        expect((await root('job_offers').where({ id: offer.id }).first()).text_consent_at).toBeTruthy();
      });

      // A write with no version is refused like one made on an older version (409, state open) and writes nothing, so
      // no answer skips the check. The page always sends one (CareersOfferPage.test.jsx).
      test.each([
        ['text choice', (t) => JobOffers.setTextConsent(t, false)],
        ['sign', (t) => JobOffers.acceptOffer(t, { signedName: 'Jordan Rivera' })],
        ['date request', (t) => JobOffers.requestDate(t, { requestedStartDate: addStaffWorkDays(JobOffers.suggestStartDate(), 7) })],
        ['decline', (t) => JobOffers.declineOffer(t, { reason: 'Took another job' })],
      ])('a %s sent with no version is refused, and nothing is written', async (_, answer) => {
        await JobOffers.setTextConsent(token, true, await shownVersion(token));
        const before = await root('job_offers').where({ id: offer.id }).first();
        expect(await answer(token)).toEqual({ refused: true, body: { state: 'open' } });
        expect(await root('job_offers').where({ id: offer.id }).first()).toEqual(before);
        expect((await root('job_applications').where({ id: app.id }).first()).status).toBe('offer');
      });

      // The server signs only a frozen offer that carries every term the page shows, so no client (a tab from before
      // the page's own check included) signs a gap. The answer is the same 409, and nothing is written.
      test.each([
        ['no hourly rate', { hourlyRate: null }],
        ['an hourly rate that shows as $0.00', { hourlyRate: 0.001 }],
        ['an hourly rate sent as text', { hourlyRate: '23.00' }],
        ['a step rate with no step date', { stepEffectiveOn: null }],
        ['no pay step fields', { stepRate: undefined, stepEffectiveOn: undefined }],
        ['no job', { jobTitle: ' ' }],
        ['no start date', { startDate: null }],
        ['empty Terms', { terms: { title: 'Technician Terms', markdown: '' } }],
      ])('a signature on a frozen offer with %s is refused, and nothing is written', async (_, gap) => {
        const sent = await root('job_offers').where({ id: offer.id }).first();
        const snapshot = typeof sent.snapshot === 'string' ? JSON.parse(sent.snapshot) : sent.snapshot;
        await root('job_offers').where({ id: offer.id }).update({ snapshot: JSON.stringify({ ...snapshot, ...gap }) });
        const version = await shownVersion(token); // read before the row: a view stamps last_viewed_at
        const before = await root('job_offers').where({ id: offer.id }).first();
        expect(await JobOffers.acceptOffer(token, { signedName: 'Jordan Rivera', version })).toEqual({ refused: true, body: { state: 'open' } });
        expect(await root('job_offers').where({ id: offer.id }).first()).toEqual(before);
        expect((await root('job_applications').where({ id: app.id }).first()).status).toBe('offer');
      });

      // A text choice equal to the stored one writes nothing either way, so with no version it answers as any resend
      // does: the stored choice and the version on file.
      test('a text choice equal to the stored one, sent with no version, writes nothing and answers the stored choice', async () => {
        await JobOffers.setTextConsent(token, true, await shownVersion(token));
        const version = await shownVersion(token); // read before the row: a view stamps last_viewed_at
        const before = await root('job_offers').where({ id: offer.id }).first();
        expect(await JobOffers.setTextConsent(token, true)).toEqual({ body: { textConsent: true, version } });
        expect(await root('job_offers').where({ id: offer.id }).first()).toEqual(before);
      });

      test('past its expiry the offer reads expired before any sweep, and nothing can be signed', async () => {
        await root('job_offers').where({ id: offer.id }).update({ expires_at: new Date(Date.now() - 60000) });
        const view = await JobOffers.publicView(token);
        expect(view).toMatchObject({ state: 'expired', contactPhone: '(941) 297-5749' });
        expect(view.terms).toBeUndefined();
        expect(view.message).toMatch(/^This offer closed on .+ Please call .+ at \(941\) 297-5749 if you still want the job\.$/);
        expect(await JobOffers.acceptOffer(token, { signedName: 'Jordan Rivera' })).toMatchObject({ refused: true, body: { state: 'expired' } });
        expect((await root('job_applications').where({ id: app.id }).first()).status).toBe('offer');
      });

      test('an application the owner closed meanwhile makes the offer read withdrawn', async () => {
        await root('job_applications').where({ id: app.id }).update({ status: 'rejected' });
        expect((await JobOffers.publicView(token)).state).toBe('withdrawn');
        expect(await JobOffers.acceptOffer(token, { signedName: 'Jordan Rivera' })).toMatchObject({ refused: true });
      });
    });

    test('Send needs the preview hash and refuses a draft that changed after it was read', async () => {
      const app = await newApplication();
      const draft = await JobOffers.saveDraft(app.id, {}, actor());
      expect(draft.draftHash).toMatch(/^[0-9a-f]{64}$/);
      await expect(JobOffers.sendOffer(app.id, draft.id, actor(), undefined)).rejects.toMatchObject({ status: 400, code: 'DRAFT_HASH_REQUIRED' });
      // The panel serves the same hash the writer returned.
      const panel = await JobOffers.adminPanel(app.id, actor());
      expect(panel.current.draftHash).toBe(draft.draftHash);
      // Another admin edits the rate after the owner opened the preview.
      const edited = await JobOffers.saveDraft(app.id, { hourlyRate: 24, draftId: draft.id, draftHash: draft.draftHash }, actor());
      expect(edited.draftHash).not.toBe(draft.draftHash);
      await expect(sendAsPage(app.id, draft.id, draft.draftHash))
        .rejects.toMatchObject({ status: 409, code: 'DRAFT_CHANGED', message: 'This draft changed after you opened it. Review the new preview, then send.' });
      expect((await root('job_offers').where({ id: draft.id }).first()).status).toBe('draft');
      expect(mockSendStageComms).not.toHaveBeenCalled();
      expect((await sendAsPage(app.id, draft.id, edited.draftHash)).offer.status).toBe('sent');
    });

    // The stage move's stamp versions each offer by updated_at. Two saves of one draft in the same millisecond (the
    // clock frozen) still give two stamps, so a move confirmed on the first preview never discards the second save.
    test('two saves of one draft in the same millisecond give the stage move two stamps', async () => {
      const app = await newApplication();
      const draft = await JobOffers.saveDraft(app.id, {}, actor());
      const ALL_BUT_DATE = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate',
        'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];
      jest.useFakeTimers({ now: new Date(), doNotFake: ALL_BUT_DATE });
      try {
        const first = await JobOffers.saveDraft(app.id, { hourlyRate: 24, draftId: draft.id, draftHash: draft.draftHash }, actor());
        const seen = (await JobOffers.liveOfferStake(root, app.id)).stamp;
        const second = await JobOffers.saveDraft(app.id, { hourlyRate: 23.5, draftId: first.id, draftHash: first.draftHash }, actor());
        expect(second.hourlyRate).toBe(23.5);
        expect((await JobOffers.liveOfferStake(root, app.id)).stamp).not.toBe(seen);
      } finally {
        jest.useRealTimers();
      }
    });

    test('a save over an open draft must name that draft and its hash, or it is refused and writes nothing', async () => {
      const app = await newApplication();
      const draft = await JobOffers.saveDraft(app.id, { draftHash: 'ignored' }, actor()); // no draft yet, no draftId: creates
      const refuse = (input) => expect(JobOffers.saveDraft(app.id, { hourlyRate: 24, ...input }, actor())).rejects
        .toMatchObject({ status: 409, code: 'DRAFT_CHANGED', message: 'This draft changed after you opened it. Review the new preview, then save.' });
      await refuse({});
      await refuse({ draftId: draft.id });
      await refuse({ draftId: draft.id, draftHash: 'f'.repeat(64) });
      await refuse({ draftId: randomUUID(), draftHash: draft.draftHash });
      expect(Number((await root('job_offers').where({ id: draft.id }).first()).hourly_rate)).toBe(23);
      const saved = await JobOffers.saveDraft(app.id, { hourlyRate: 24, draftId: draft.id, draftHash: draft.draftHash }, actor());
      expect(saved.hourlyRate).toBe(24);
      // The saver's old preview no longer matches the new draft.
      await expect(JobOffers.saveDraft(app.id, { hourlyRate: 24.5, draftId: draft.id, draftHash: draft.draftHash }, actor())).rejects.toMatchObject({ code: 'DRAFT_CHANGED' });
      // A save that names a draft which was withdrawn meanwhile does not start a new one.
      await JobOffers.withdrawOffer(app.id, draft.id, actor(), { expectedStatus: 'draft', draftHash: saved.draftHash });
      await expect(JobOffers.saveDraft(app.id, { hourlyRate: 24, draftId: draft.id, draftHash: saved.draftHash }, actor())).rejects.toMatchObject({ code: 'DRAFT_CHANGED' });
      expect(await root('job_offers').where({ application_id: app.id }).count('* as n').first()).toEqual({ n: '1' });
    });

    test('only the owner account is served the offer link, and a closed offer shows the letter the applicant received', async () => {
      const app = await newApplication();
      const sent = (await sendNew(app)).offer;
      expect(sent.offerUrl).toMatch(/\/careers\/offer\/[0-9a-f]{64}$/);
      expect((await JobOffers.adminPanel(app.id, { ...actor(), ownerAccount: true })).current.offerUrl).toBe(sent.offerUrl);
      expect((await JobOffers.adminPanel(app.id, { ...actor(), ownerAccount: false })).current.offerUrl).toBeNull();
      expect((await JobOffers.adminPanel(app.id, actor())).current.offerUrl).toBeNull();
      // The owner (a different name today) reads the frozen letter after the offer closes, not a new one.
      await JobOffers.withdrawOffer(app.id, sent.id, actor(), { expectedStatus: 'sent' });
      const frozen = await root('job_offers').where({ id: sent.id }).first();
      const panel = await JobOffers.adminPanel(app.id, { id: owner.id, name: 'Someone Else' });
      expect(panel.current.status).toBe('withdrawn');
      expect(panel.letterPreview.markdown).toBe(JobOffers.renderLetterMarkdown(frozen.snapshot));
      expect(panel.letterPreview.markdown).toContain('Signed by Test Owner');
      expect(panel.letterPreview.markdown).not.toContain('Someone Else');
    });

    test("another admin's draft preview names no one as the signer, and that admin's save still goes through", async () => {
      const app = await newApplication();
      const draft = await JobOffers.saveDraft(app.id, {}, actor());
      const other = { id: owner.id, name: 'Office Admin', ownerAccount: false };
      const read = await JobOffers.adminPanel(app.id, other);
      expect(read.letterPreview.markdown).toContain("Signed by [owner's name], owner ·");
      expect(read.letterPreview.markdown).toContain("- **Reports to:** [owner's name], owner");
      expect(read.letterPreview.markdown).not.toContain('Office Admin');
      expect(read.defaults.reportTo).toBe("[owner's name], owner");
      // An owner account's read names that owner, as its Send will.
      const own = await JobOffers.adminPanel(app.id, { ...actor(), ownerAccount: true });
      expect(own.letterPreview.markdown).toContain('Signed by Test Owner, owner ·');
      // The other admin's save is checked against the hash of their own read.
      const saved = await JobOffers.saveDraft(app.id, { hourlyRate: 24, draftId: draft.id, draftHash: read.letterPreview.draftHash }, other);
      expect(saved.hourlyRate).toBe(24);
    });

    test('the panel names current (the offer out), draft (a revision in progress) and history', async () => {
      const app = await newApplication();
      const empty = await JobOffers.adminPanel(app.id, actor());
      expect(empty).toMatchObject({ enabled: true, termsIssued: true, current: null, draft: null, history: [] });
      const sent = (await sendNew(app)).offer;
      const revised = await JobOffers.reviseOffer(app.id, sent.id, { expectedStatus: 'sent' }, actor());
      const panel = await JobOffers.adminPanel(app.id, actor());
      expect(panel.current.id).toBe(sent.id);
      expect(panel.draft.id).toBe(revised.id);
      expect(panel.draft.draftHash).toBe(revised.draftHash);
      expect(panel.history).toEqual([]);
      expect(panel.letterPreview.markdown).toContain('# Your job offer');
      expect(panel.letterPreview.markdown).not.toContain('{#');
      await JobOffers.withdrawOffer(app.id, revised.id, actor(), { expectedStatus: 'draft', draftHash: revised.draftHash });
      await JobOffers.withdrawOffer(app.id, sent.id, actor(), { expectedStatus: 'sent' });
      const after = await JobOffers.adminPanel(app.id, actor());
      expect(after.draft).toBeNull();
      expect(after.current.status).toBe('withdrawn');
      expect(after.history.map((o) => o.status)).toEqual(['withdrawn']);
    });

    test('after a withdraw or a clock expiry (application still at offer) a fresh draft can be made and sent', async () => {
      const app = await newApplication();
      const first = (await sendNew(app)).offer;
      await JobOffers.withdrawOffer(app.id, first.id, actor(), { expectedStatus: 'sent' });
      const second = await JobOffers.saveDraft(app.id, {}, actor());
      expect(second).toMatchObject({ status: 'draft', supersedesId: null });
      expect((await sendAsPage(app.id, second.id, second.draftHash)).offer.status).toBe('sent');

      await root('job_offers').where({ id: second.id }).update({ expires_at: new Date(Date.now() - 60000) });
      const third = await JobOffers.saveDraft(app.id, {}, actor());
      await sendAsPage(app.id, third.id, third.draftHash);
      expect((await root('job_offers').where({ id: second.id }).first()).status).toBe('expired');
      expect((await root('job_offers').where({ id: third.id }).first()).status).toBe('sent');
    });

    test('accepted (hired) and declined (withdrawn) applications cannot get another draft', async () => {
      const signedApp = await newApplication();
      const signed = (await sendNew(signedApp)).offer;
      const signedToken = (await root('job_offers').where({ id: signed.id }).first()).token;
      expect((await JobOffers.acceptOffer(signedToken, { signedName: 'Jordan Rivera', version: await shownVersion(signedToken) })).body).toMatchObject({ state: 'signed' });
      await expect(JobOffers.saveDraft(signedApp.id, {}, actor())).rejects.toMatchObject({ status: 409, code: 'APPLICATION_CLOSED' });
      const declinedApp = await newApplication();
      const declined = (await sendNew(declinedApp)).offer;
      const declinedToken = (await root('job_offers').where({ id: declined.id }).first()).token;
      expect((await JobOffers.declineOffer(declinedToken, { version: await shownVersion(declinedToken) })).body).toEqual({ state: 'declined' });
      await expect(JobOffers.saveDraft(declinedApp.id, {}, actor())).rejects.toMatchObject({ status: 409, code: 'APPLICATION_CLOSED' });
    });

    test('an application the owner closes takes its offers with it: reject, reopen, and the old link stays dead', async () => {
      const app = await newApplication();
      const sent = (await sendNew(app)).offer;
      const token = (await root('job_offers').where({ id: sent.id }).first()).token;
      await root.transaction((trx) => JobOffers.closeOffersWithApplication(trx, app.id, owner.id));
      expect(await root('job_offers').where({ id: sent.id }).first()).toMatchObject({ status: 'withdrawn', withdrawn_by: owner.id });
      await root('job_applications').where({ id: app.id }).update({ status: 'reviewed' }); // the owner reopens it
      expect(await JobOffers.publicView(token)).toMatchObject({ state: 'withdrawn' });
      expect(await JobOffers.acceptOffer(token, { signedName: 'Jordan Rivera' })).toMatchObject({ refused: true, body: { state: 'withdrawn' } });
      expect((await root('job_applications').where({ id: app.id }).first()).status).toBe('reviewed');
    });

    test('signing or declining withdraws a revision draft that was in progress', async () => {
      for (const answer of ['accept', 'decline']) {
        const app = await newApplication();
        const sent = (await sendNew(app)).offer;
        const token = (await root('job_offers').where({ id: sent.id }).first()).token;
        const revision = await JobOffers.reviseOffer(app.id, sent.id, { expectedStatus: 'sent' }, actor());
        const version = await shownVersion(token);
        const result = answer === 'accept'
          ? await JobOffers.acceptOffer(token, { signedName: 'Jordan Rivera', version })
          : await JobOffers.declineOffer(token, { version });
        expect(result.body).toMatchObject({ state: answer === 'accept' ? 'signed' : 'declined' });
        expect((await root('job_offers').where({ id: revision.id }).first()).status).toBe('withdrawn');
        expect((await root('job_offers').where({ id: sent.id }).first()).status).toBe(answer === 'accept' ? 'accepted' : 'declined');
      }
    });

    test('a draft edit that sends the same start date keeps the negotiated raise date', async () => {
      const app = await newApplication();
      const start = JobOffers.suggestStartDate();
      const raise = addStaffWorkDays(JobOffers.stepDateFor(start), 7);
      const draft = await JobOffers.saveDraft(app.id, { startDate: start, stepEffectiveOn: raise }, actor());
      const edited = await JobOffers.saveDraft(app.id, { startDate: start, hoursLine: 'Four 10-hour days', draftId: draft.id, draftHash: draft.draftHash }, actor());
      expect(edited.stepEffectiveOn).toBe(raise);
    });

    test('Send clears a released interview booking when the application was not at interview', async () => {
      const app = await newApplication({
        status: 'reviewed', interview_mode: 'phone', interview_at: new Date('2027-01-05T15:00:00Z'),
        interview_end_at: new Date('2027-01-05T15:30:00Z'), interview_booked_at: new Date('2026-11-18T15:00:00Z'),
      });
      await sendNew(app);
      expect(await root('job_applications').where({ id: app.id }).first()).toMatchObject({
        status: 'offer', interview_mode: null, interview_at: null, interview_end_at: null, interview_booked_at: null,
      });
      const live = await newApplication({ status: 'interview', interview_mode: 'phone', interview_at: new Date('2027-01-05T15:00:00Z'), interview_booked_at: new Date() });
      await sendNew(live);
      expect((await root('job_applications').where({ id: live.id }).first()).interview_mode).toBe('phone'); // still at interview: kept
    });

    test('Revise keeps a negotiated raise date unless the start date changes, and a second Revise returns the draft untouched', async () => {
      const app = await newApplication();
      const first = await JobOffers.saveDraft(app.id, { stepEffectiveOn: addStaffWorkDays(JobOffers.stepDateFor(JobOffers.suggestStartDate()), 7) }, actor());
      const sent = (await sendAsPage(app.id, first.id, first.draftHash)).offer;
      const token = (await root('job_offers').where({ id: sent.id }).first()).token;
      expect((await JobOffers.requestDate(token, { requestedStartDate: sent.startDate, version: await shownVersion(token) })).body)
        .toEqual({ state: 'date_requested' }); // asks for the very same day
      const revised = await JobOffers.reviseOffer(app.id, sent.id, { expectedStatus: 'date_requested', startDate: sent.startDate }, actor());
      expect(revised.stepEffectiveOn).toBe(sent.stepEffectiveOn);
      const edited = await JobOffers.saveDraft(app.id, { hoursLine: 'Four 10-hour days', draftId: revised.id, draftHash: revised.draftHash }, actor());
      const again = await JobOffers.reviseOffer(app.id, sent.id, { expectedStatus: 'date_requested', startDate: addStaffWorkDays(sent.startDate, 7) }, actor());
      expect(again.id).toBe(revised.id);
      expect(again.hoursLine).toBe('Four 10-hour days');
      expect(again.startDate).toBe(sent.startDate);
      expect(again.draftHash).toBe(edited.draftHash);
    });

    test('a sent offer past its expiry reads expired to the owner: no withdraw, no revise, a new draft is allowed', async () => {
      const app = await newApplication();
      const sent = (await sendNew(app)).offer;
      await root('job_offers').where({ id: sent.id }).update({ expires_at: new Date(Date.now() - 60000) });
      const panel = await JobOffers.adminPanel(app.id, actor());
      expect(panel.current.status).toBe('expired');
      await expect(JobOffers.withdrawOffer(app.id, sent.id, actor(), { expectedStatus: 'sent' })).rejects.toMatchObject({ status: 409, code: 'OFFER_NOT_WITHDRAWABLE' });
      await expect(JobOffers.reviseOffer(app.id, sent.id, { expectedStatus: 'sent' }, actor())).rejects.toMatchObject({ status: 409, code: 'OFFER_NOT_REVISABLE' });
      const draft = await JobOffers.saveDraft(app.id, {}, actor());
      const panel2 = await JobOffers.adminPanel(app.id, actor());
      expect(panel2.current.id).toBe(draft.id);
      expect(panel2.history.map((o) => o.status)).toEqual(['expired']);
    });

    describe('the 7-day close', () => {
      const lapse = (id, msAgo = 60000) => root('job_offers').where({ id }).update({ expires_at: new Date(Date.now() - msAgo) });
      const statusOf = async (id) => (await root('job_offers').where({ id }).first('status')).status;
      const tokenOf = async (id) => (await root('job_offers').where({ id }).first('token')).token;
      // Earlier cases leave lapsed offers in the shared transaction: close them first, so each count is this case's own.
      beforeEach(async () => {
        await JobOffers.closeExpiredOffers();
        mockRaise.mockClear();
      });
      test('a sent offer past its expiry is stored as expired and rings one bell; a second pass does nothing', async () => {
        const app = await newApplication();
        const sent = (await sendNew(app)).offer;
        await lapse(sent.id);
        expect(await JobOffers.closeExpiredOffers()).toEqual({ closed: 1, failed: 0 });
        expect(await statusOf(sent.id)).toBe('expired');
        expect((await root('job_applications').where({ id: app.id }).first()).status).toBe('offer');
        expect(mockRaise).toHaveBeenCalledTimes(1);
        const [category, spec, opts] = mockRaise.mock.calls[0];
        expect(category).toBe('job_application');
        expect(spec).toMatchObject({
          action: "Jordan Rivera's job offer closed unsigned", severity: 'needs-you', who: 'person',
          link: `/admin/recruiting?application=${app.id}`,
        });
        expect(spec.why).toMatch(/^It closed \w{3}, \w{3} \d{1,2} with no answer; open the application to make a new offer or close it\.$/);
        expect(opts).toMatchObject({ bell: true, dedupeKey: `job-offer-expired:${sent.id}` });
        expect(typeof opts.trx).toBe('function'); // written in the transaction that stores the expiry
        // The alert rules (one sentence, the length limits) take the bell as written: a refused bell is never raised.
        expect(jest.requireActual('../services/admin-alert-compose').composeAdminAlert(spec).headline)
          .toBe("Leads — Jordan Rivera's job offer closed unsigned");

        expect(await JobOffers.closeExpiredOffers()).toEqual({ closed: 0, failed: 0 });
        expect(mockRaise).toHaveBeenCalledTimes(1);
        // Both pages read the stored state as they read the clock before it, and a new offer can go out.
        expect((await JobOffers.publicView(await tokenOf(sent.id))).state).toBe('expired');
        const panel = await JobOffers.adminPanel(app.id, actor());
        expect(panel.current).toMatchObject({ id: sent.id, status: 'expired' });
        expect(panel.current.timeline.map((item) => item.kind)).toContain('expired');
        const next = await JobOffers.saveDraft(app.id, {}, actor());
        expect((await sendAsPage(app.id, next.id, next.draftHash)).offer.status).toBe('sent');
      });

      test('it leaves an offer still open, a date request, and an offer whose application left Offer', async () => {
        const open = (await sendNew(await newApplication())).offer;
        const asked = (await sendNew(await newApplication())).offer;
        const askedToken = await tokenOf(asked.id);
        await JobOffers.requestDate(askedToken, {
          requestedStartDate: addStaffWorkDays(JobOffers.suggestStartDate(), 7), version: await shownVersion(askedToken),
        });
        await lapse(asked.id);
        const goneApp = await newApplication();
        const gone = (await sendNew(goneApp)).offer;
        await lapse(gone.id);
        await root('job_applications').where({ id: goneApp.id }).update({ status: 'rejected' });
        mockRaise.mockClear(); // the date request rang its own bell

        expect(await JobOffers.closeExpiredOffers()).toEqual({ closed: 0, failed: 0 });
        expect(await statusOf(open.id)).toBe('sent');
        expect(await statusOf(asked.id)).toBe('date_requested');
        expect(await statusOf(gone.id)).toBe('sent');
        expect(mockRaise).not.toHaveBeenCalled();
      });

      test('the pass does not wait on a row another transaction holds: both locked reads are SKIP LOCKED', async () => {
        const sent = (await sendNew(await newApplication())).offer;
        await lapse(sent.id);
        const rowLocks = [];
        const listen = (query) => { if (/for update/i.test(query.sql) && /"job_(applications|offers)"/.test(query.sql)) rowLocks.push(query.sql); };
        database.on('query', listen);
        try {
          expect(await JobOffers.closeExpiredOffers()).toEqual({ closed: 1, failed: 0 });
        } finally {
          database.removeListener('query', listen);
        }
        expect(rowLocks).toHaveLength(2);
        for (const sql of rowLocks) expect(sql).toMatch(/for update skip locked$/);
      });

      test('an offer the owner withdrew while the close waited is left withdrawn, with no bell', async () => {
        const app = await newApplication();
        const sent = (await sendNew(app)).offer;
        await lapse(sent.id);
        // The withdrawal lands after the pass listed the offer and before it took the locks.
        const withdrawThenOpen = async (work) => {
          await root('job_offers').where({ id: sent.id }).update({ status: 'withdrawn', withdrawn_at: new Date(), updated_at: new Date() });
          return root.transaction(work);
        };
        expect(await withNextTransaction(withdrawThenOpen, () => JobOffers.closeExpiredOffers())).toEqual({ closed: 0, failed: 0 });
        expect(await statusOf(sent.id)).toBe('withdrawn');
        expect(mockRaise).not.toHaveBeenCalled();
      });

      test('storing an expiry the owner already saw changes no stamp: his open Send goes through, and the stage stamp holds', async () => {
        const app = await newApplication();
        const lapsed = (await sendNew(app)).offer;
        await lapse(lapsed.id);
        // The owner starts a new offer on the card that shows the old one closed. Then a pass stores the expiry.
        const next = await JobOffers.saveDraft(app.id, {}, actor());
        const { outStamp } = await JobOffers.adminPanel(app.id, actor());
        const stageStamp = (await JobOffers.liveOfferStake(root, app.id)).stamp;
        expect(await JobOffers.closeExpiredOffers()).toEqual({ closed: 1, failed: 0 });
        expect((await JobOffers.adminPanel(app.id, actor())).outStamp).toBe(outStamp);
        expect((await JobOffers.liveOfferStake(root, app.id)).stamp).toBe(stageStamp);
        const sent = await JobOffers.sendOffer(app.id, next.id, actor(), next.draftHash, new Date(), { expectedOut: outStamp });
        expect(sent.offer.status).toBe('sent');
      });

      test('an offer that lapses after the owner opened Send refuses that Send, and the next read sends', async () => {
        const app = await newApplication();
        const out = (await sendNew(app)).offer;
        const revision = await JobOffers.reviseOffer(app.id, out.id, { expectedStatus: 'sent' }, actor());
        const { outStamp } = await JobOffers.adminPanel(app.id, actor());
        await lapse(out.id);
        await expect(JobOffers.sendOffer(app.id, revision.id, actor(), revision.draftHash, new Date(), { expectedOut: outStamp }))
          .rejects.toMatchObject({ status: 409, code: 'OFFERS_CHANGED' });
        expect(await statusOf(revision.id)).toBe('draft');
        expect((await sendAsPage(app.id, revision.id, revision.draftHash)).offer.status).toBe('sent');
      });

      test('an expired offer stays expired on its link when the application is closed, reopened and offered again', async () => {
        const linkStates = async (passFirst) => {
          const app = await newApplication();
          const sent = (await sendNew(app)).offer;
          const token = await tokenOf(sent.id);
          await lapse(sent.id);
          if (passFirst) expect(await JobOffers.closeExpiredOffers()).toEqual({ closed: 1, failed: 0 });
          // The owner rejects the application: the stage move closes its offers in that transaction.
          await root.transaction(async (trx) => {
            await trx('job_applications').where({ id: app.id }).update({ status: 'rejected' });
            await JobOffers.closeOffersWithApplication(trx, app.id, owner.id);
          });
          expect(await root('job_offers').where({ id: sent.id }).first()).toMatchObject({ status: 'expired', withdrawn_at: null });
          const whileClosed = (await JobOffers.publicView(token)).state;
          // He reopens it and sends a new offer.
          await root('job_applications').where({ id: app.id }).update({ status: 'interview' });
          const next = await JobOffers.saveDraft(app.id, {}, actor());
          expect((await sendAsPage(app.id, next.id, next.draftHash)).offer.status).toBe('sent');
          return [whileClosed, (await JobOffers.publicView(token)).state];
        };
        // The same answers whether the stage move or the 7-day close stored the expiry.
        expect(await linkStates(false)).toEqual(['expired', 'expired']);
        expect(await linkStates(true)).toEqual(['expired', 'expired']);
      });

      test('a revision sent after its parent lapsed leaves the parent expired, before a pass or after it', async () => {
        const parentAfterSend = async (passFirst) => {
          const app = await newApplication();
          const parent = (await sendNew(app)).offer;
          const revision = await JobOffers.reviseOffer(app.id, parent.id, { expectedStatus: 'sent' }, actor());
          await lapse(parent.id);
          if (passFirst) expect(await JobOffers.closeExpiredOffers()).toEqual({ closed: 1, failed: 0 });
          expect((await JobOffers.adminPanel(app.id, actor())).sendReplacesId).toBeNull();
          expect((await sendAsPage(app.id, revision.id, revision.draftHash)).offer.status).toBe('sent');
          return [await statusOf(parent.id), (await JobOffers.publicView(await tokenOf(parent.id))).state];
        };
        expect(await parentAfterSend(false)).toEqual(['expired', 'expired']);
        expect(await parentAfterSend(true)).toEqual(['expired', 'expired']);
      });

      // Runs `work` with the offer's expiry falling after the call started and before its transaction holds the locks.
      const expiringWhileItWaits = (offerId, work) => {
        const started = Date.now();
        return withNextTransaction(async (body) => {
          await root('job_offers').where({ id: offerId }).update({ expires_at: new Date(started + 5) });
          await new Promise((resolve) => { setTimeout(resolve, 25); });
          return root.transaction(body);
        }, work);
      };

      test('an offer that passes its expiry while a Send waits for the locks refuses that Send', async () => {
        const app = await newApplication();
        const out = (await sendNew(app)).offer;
        const revision = await JobOffers.reviseOffer(app.id, out.id, { expectedStatus: 'sent' }, actor());
        const { outStamp } = await JobOffers.adminPanel(app.id, actor());
        // No clock is passed, as from the route.
        const send = () => JobOffers.sendOffer(app.id, revision.id, actor(), revision.draftHash, undefined, { expectedOut: outStamp });
        await expect(expiringWhileItWaits(out.id, send)).rejects.toMatchObject({ status: 409, code: 'OFFERS_CHANGED' });
        expect(await statusOf(out.id)).toBe('sent');
        expect(await statusOf(revision.id)).toBe('draft');
      });

      test('an offer that passes its expiry while a withdrawal waits for the locks is not withdrawn; the pass closes it', async () => {
        const app = await newApplication();
        const out = (await sendNew(app)).offer;
        const withdraw = () => JobOffers.withdrawOffer(app.id, out.id, actor(), { expectedStatus: 'sent' });
        await expect(expiringWhileItWaits(out.id, withdraw)).rejects.toMatchObject({ status: 409, code: 'OFFER_NOT_WITHDRAWABLE' });
        expect(await statusOf(out.id)).toBe('sent');
        expect(await JobOffers.closeExpiredOffers()).toEqual({ closed: 1, failed: 0 });
        expect(await statusOf(out.id)).toBe('expired');
        expect(mockRaise).toHaveBeenCalledTimes(1);
      });

      test('a Send that replaces a lapsed offer stores its expiry with no bell, and no later pass rings for it', async () => {
        const app = await newApplication();
        const lapsed = (await sendNew(app)).offer;
        await lapse(lapsed.id);
        // The owner sends a new offer before a pass runs: that Send is his answer to the closed one.
        const next = await JobOffers.saveDraft(app.id, {}, actor());
        await sendAsPage(app.id, next.id, next.draftHash);
        expect(await statusOf(lapsed.id)).toBe('expired');
        expect(await JobOffers.closeExpiredOffers()).toEqual({ closed: 0, failed: 0 });
        expect(mockRaise).not.toHaveBeenCalled();
      });

      // A sent offer closed by a pass that wrote its bell through the real alert writer.
      const bellOf = (offerId) => root('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`job-offer-expired:${offerId}`]);
      async function closedWithItsBell() {
        const app = await newApplication();
        const sent = (await sendNew(app)).offer;
        await lapse(sent.id);
        const { raiseAdminAlert } = jest.requireActual('../services/admin-alert-compose');
        mockRaise.mockImplementation((...args) => raiseAdminAlert(...args));
        try {
          expect(await JobOffers.closeExpiredOffers()).toEqual({ closed: 1, failed: 0 });
        } finally {
          mockRaise.mockImplementation(async () => ({ id: 'bell-1' }));
        }
        return { app, sent };
      }

      test('the real alert writer stores the bell row in the close, once', async () => {
        const { app, sent } = await closedWithItsBell();
        const bells = await bellOf(sent.id);
        expect(bells).toHaveLength(1);
        expect(bells[0]).toMatchObject({
          recipient_type: 'admin', category: 'job_application', title: "Leads — Jordan Rivera's job offer closed unsigned",
          link: `/admin/recruiting?application=${app.id}`, done_at: null,
        });
      });

      test('the bell clears when the owner does what it asks: a new offer sent, or the application moved out of Offer', async () => {
        const resent = await closedWithItsBell();
        const next = await JobOffers.saveDraft(resent.app.id, {}, actor());
        // A draft is not the answer yet.
        expect(await bellOf(resent.sent.id).first()).toMatchObject({ done_at: null });
        await sendAsPage(resent.app.id, next.id, next.draftHash);
        expect(await bellOf(resent.sent.id).first()).toMatchObject({
          done_at: expect.any(Date), done_by: 'episodes', resolution: 'Cleared: a new offer was sent',
          metadata: expect.objectContaining({ autoCleared: true, autoClearedReason: 'offer_reviewed' }),
        });

        const moved = await closedWithItsBell();
        await root.transaction(async (trx) => {
          await trx('job_applications').where({ id: moved.app.id }).update({ status: 'rejected' });
          await JobOffers.closeOffersWithApplication(trx, moved.app.id, owner.id);
        });
        expect(await bellOf(moved.sent.id).first()).toMatchObject({
          done_at: expect.any(Date), done_by: 'episodes', resolution: 'Cleared: the application left the offer stage',
        });
      });

      test('a close whose bell is not written is undone, and the next pass stores the expiry and rings', async () => {
        const sent = (await sendNew(await newApplication())).offer;
        await lapse(sent.id);
        mockRaise.mockRejectedValueOnce(new Error('insert failed'));
        expect(await JobOffers.closeExpiredOffers()).toEqual({ closed: 0, failed: 1 });
        expect(await statusOf(sent.id)).toBe('sent');
        // A write that reports no row is a failure too.
        mockRaise.mockResolvedValueOnce(null);
        expect(await JobOffers.closeExpiredOffers()).toEqual({ closed: 0, failed: 1 });
        expect(await statusOf(sent.id)).toBe('sent');

        mockRaise.mockClear();
        expect(await JobOffers.closeExpiredOffers()).toEqual({ closed: 1, failed: 0 });
        expect(await statusOf(sent.id)).toBe('expired');
        expect(mockRaise).toHaveBeenCalledTimes(1);
      });

      test('an offer whose close fails is counted, the next one still closes, and a later pass closes the first', async () => {
        const first = (await sendNew(await newApplication())).offer;
        const second = (await sendNew(await newApplication())).offer;
        await lapse(first.id, 120000); // the pass takes the oldest expiry first
        await lapse(second.id);
        const lost = async () => { throw new Error('connection lost'); };
        expect(await withNextTransaction(lost, () => JobOffers.closeExpiredOffers())).toEqual({ closed: 1, failed: 1 });
        expect(await statusOf(first.id)).toBe('sent');
        expect(await statusOf(second.id)).toBe('expired');
        expect(mockRaise).toHaveBeenCalledTimes(1);
        expect(await JobOffers.closeExpiredOffers()).toEqual({ closed: 1, failed: 0 });
        expect(await statusOf(first.id)).toBe('expired');
        expect(mockRaise).toHaveBeenCalledTimes(2);
      });
    });

    describe('the 2-day reminder', () => {
      const offerRow = (id) => root('job_offers').where({ id }).first();
      // The pass runs on a test clock: noon Eastern on the day this suite loaded, inside the reminder hours whenever
      // the suite runs. The day is read once, so a run across midnight keeps one clock.
      const { etDateString, parseETDateTime } = require('../utils/datetime-et');
      const testDay = etDateString();
      const atEt = (time) => () => parseETDateTime(`${testDay}T${time}`);
      const midday = atEt('12:00');
      // The offer was sent `hours` before that noon. Its expiry stays 7 days after the real send, so it is still open.
      const sentAgo = (id, hours) => root('job_offers').where({ id }).update({ sent_at: new Date(midday().getTime() - hours * 3600000) });
      // Ticks, or clears, "Text me about this offer" on the offer page.
      const tickTextBox = async (offerId, consent = true) => {
        const { token } = await offerRow(offerId);
        return JobOffers.setTextConsent(token, consent, await shownVersion(token));
      };
      // An offer two days old (and one hour), for an applicant who ticked "Text me about this offer" (texts: false
      // leaves the box empty).
      async function dueOffer({ texts = true, ...over } = {}, hours = 49) {
        const app = await newApplication(over);
        const sent = (await sendNew(app)).offer;
        if (texts) await tickTextBox(sent.id);
        await sentAgo(sent.id, hours);
        mockSendStageComms.mockClear();
        return { app, sent };
      }
      const none = { reminded: 0, notSent: 0, failed: 0 };
      const one = { reminded: 1, notSent: 0, failed: 0 };
      // Earlier cases leave due offers in the shared transaction: take them first, so each count is this case's own.
      beforeEach(async () => {
        await JobOffers.sendDueReminders(midday);
        mockSendStageComms.mockClear();
      });

      test('an open offer two days old gets one reminder, by text and email, and never a second one', async () => {
        const { app, sent } = await dueOffer();
        const before = await offerRow(sent.id);
        // The offer is taken before anything is sent: a send that fails, or a process that stops, cannot lead to a second one.
        let takenAtSend;
        mockSendStageComms.mockImplementationOnce(async () => {
          takenAtSend = await offerRow(sent.id);
          return { sms: 'sent', email: 'sent' };
        });
        expect(await JobOffers.sendDueReminders(midday)).toEqual(one);
        expect(takenAtSend).toMatchObject({ reminder_claimed_at: expect.any(Date), reminder_sent_at: null });
        expect(mockSendStageComms).toHaveBeenCalledTimes(1);
        const [application, stage, opts] = mockSendStageComms.mock.calls[0];
        expect(application.id).toBe(app.id);
        expect(stage).toBe('offer_reminder');
        expect(opts).toMatchObject({
          sms: true, email: true, by: 'system',
          vars: {
            offer_link: expect.stringMatching(new RegExp(`/careers/offer/${before.token}$`)),
            expires_on: JobOffers.fmtDay(etDateString(new Date(before.expires_at))),
            job_title: 'Pest Control Technician', sender_name: 'Test Owner',
          },
        });
        const after = await offerRow(sent.id);
        expect(after.reminder_claimed_at).toBeInstanceOf(Date);
        expect(after.reminder_sent_at).toBeInstanceOf(Date);
        // The reminder changes nothing the applicant or the owner acts on: the offer keeps its version and its state.
        expect(after.updated_at).toEqual(before.updated_at);
        expect(after.status).toBe('sent');
        const panel = await JobOffers.adminPanel(app.id, actor());
        expect(panel.current.timeline.map((t) => t.kind)).toContain('reminded');

        expect(await JobOffers.sendDueReminders(midday)).toEqual(none);
        expect(mockSendStageComms).toHaveBeenCalledTimes(1);
      });

      test('with a gate off a direct call takes nothing: the offer keeps its one attempt', async () => {
        const { sent } = await dueOffer();
        mockStageEnabled.mockReturnValueOnce(false);
        expect(await JobOffers.sendDueReminders(midday)).toEqual(none);
        expect(mockStageEnabled).toHaveBeenLastCalledWith('offer_reminder');
        expect(mockSendStageComms).not.toHaveBeenCalled();
        expect((await offerRow(sent.id)).reminder_claimed_at).toBeNull();
        // With the gates on again the same offer gets its reminder.
        expect(await JobOffers.sendDueReminders(midday)).toEqual(one);
      });

      test('the check before each provider passes only while the offer is the open one with this link', async () => {
        const { app, sent } = await dueOffer();
        await JobOffers.sendDueReminders(midday);
        const { stillEligible } = mockSendStageComms.mock.calls[0][2];
        for (const channel of ['sms', 'email']) expect(await stillEligible(root, channel)).toBe(true);
        await inRolledBack(async (sp) => {
          // The check reads the pass's clock (noon Eastern), so the expiry is set against that clock.
          await sp('job_offers').where({ id: sent.id }).update({ expires_at: new Date(midday().getTime() - 1000) });
          for (const channel of ['sms', 'email']) expect(await stillEligible(sp, channel)).toBe(false);
        });
        await inRolledBack(async (sp) => {
          await sp('job_applications').where({ id: app.id }).update({ status: 'rejected' });
          for (const channel of ['sms', 'email']) expect(await stillEligible(sp, channel)).toBe(false);
        });
        await JobOffers.withdrawOffer(app.id, sent.id, actor(), { expectedStatus: 'sent' });
        for (const channel of ['sms', 'email']) expect(await stillEligible(root, channel)).toBe(false);
      });

      test('an applicant who clears "Text me about this offer" after the pass took the offer gets no text; the email still goes', async () => {
        // Text consent on the application does not keep the text alive: the cleared box is the answer for this offer.
        const { sent } = await dueOffer({ sms_consent: true });
        expect(await JobOffers.sendDueReminders(midday)).toEqual(one);
        const opts = mockSendStageComms.mock.calls[0][2];
        expect(opts).toMatchObject({ sms: true, email: true });
        expect(await opts.stillEligible(root, 'sms')).toBe(true);
        // The box is cleared before the text reaches the provider: the sender reads this check inside its locked handoff.
        await tickTextBox(sent.id, false);
        expect(await opts.stillEligible(root, 'sms')).toBe(false);
        expect(await opts.stillEligible(root, 'email')).toBe(true);
      });

      test('it leaves an offer under two days old, an expired one, a date request, and an application that left Offer', async () => {
        const young = (await sendNew(await newApplication())).offer;
        await sentAgo(young.id, 47);
        const lapsed = (await dueOffer()).sent;
        await root('job_offers').where({ id: lapsed.id }).update({ expires_at: new Date(midday().getTime() - 60000) });
        const asked = (await dueOffer()).sent;
        const askedToken = (await offerRow(asked.id)).token;
        await JobOffers.requestDate(askedToken, { requestedStartDate: JobOffers.suggestStartDate(new Date(Date.now() + 14 * 86400000)), version: await shownVersion(askedToken) });
        const gone = await dueOffer();
        await root('job_applications').where({ id: gone.app.id }).update({ status: 'interview' });
        mockSendStageComms.mockClear();

        expect(await JobOffers.sendDueReminders(midday)).toEqual(none);
        expect(mockSendStageComms).not.toHaveBeenCalled();
        for (const id of [young.id, lapsed.id, asked.id, gone.sent.id]) expect((await offerRow(id)).reminder_claimed_at).toBeNull();
      });

      test('an offer with reminder_sent_at is never reminded, also when the row holds no claim', async () => {
        // reminder_sent_at alone closes the offer for the pass (a row restored or repaired without its claim).
        const { sent } = await dueOffer();
        await root('job_offers').where({ id: sent.id }).update({ reminder_claimed_at: null, reminder_sent_at: new Date(midday().getTime() - 3600000) });
        expect(await JobOffers.sendDueReminders(midday)).toEqual(none);
        expect(mockSendStageComms).not.toHaveBeenCalled();
        expect((await offerRow(sent.id)).reminder_claimed_at).toBeNull();
      });

      test('an offer withdrawn, or signed, while the pass waited for it gets no reminder', async () => {
        const withdrawn = await dueOffer();
        // The change lands after the pass listed the offer and before it took the locks.
        const changeThenOpen = (change) => async (work) => { await change(); return root.transaction(work); };
        const withdraw = changeThenOpen(() => root('job_offers').where({ id: withdrawn.sent.id }).update({ status: 'withdrawn', withdrawn_at: new Date(), updated_at: new Date() }));
        expect(await withNextTransaction(withdraw, () => JobOffers.sendDueReminders(midday))).toEqual(none);

        const signed = await dueOffer();
        const sign = changeThenOpen(() => root('job_offers').where({ id: signed.sent.id }).update({ status: 'accepted', updated_at: new Date() }));
        expect(await withNextTransaction(sign, () => JobOffers.sendDueReminders(midday))).toEqual(none);

        expect(mockSendStageComms).not.toHaveBeenCalled();
        for (const { sent } of [withdrawn, signed]) expect((await offerRow(sent.id)).reminder_claimed_at).toBeNull();
      });

      test('outside 9:00 AM to 5:55 PM Eastern the pass takes nothing', async () => {
        const { sent } = await dueOffer({}, 72);
        for (const time of ['08:59', '17:55', '18:00', '21:00']) {
          expect(await JobOffers.sendDueReminders(atEt(time))).toEqual(none);
        }
        expect(mockSendStageComms).not.toHaveBeenCalled();
        expect((await offerRow(sent.id)).reminder_claimed_at).toBeNull();
        expect(await JobOffers.sendDueReminders(atEt('09:00'))).toEqual(one);
      });

      test('a pass still running at 5:55 PM takes no more offers: the clock is read for each offer, after its row locks', async () => {
        // Offers that earlier cases left under two days old at noon are due by the evening: take them first.
        await JobOffers.sendDueReminders(atEt('17:50'));
        mockSendStageComms.mockClear();
        const first = await dueOffer({}, 72);
        const second = await dueOffer({}, 71);
        // The pass starts at 5:54 PM; the first offer is taken then; the clock passes 5:55 PM before the second one.
        const times = [atEt('17:54')(), atEt('17:54')(), atEt('17:55')()];
        const events = [];
        const clock = () => { events.push('clock'); return times.shift() || atEt('17:55')(); };
        const listen = (query) => { if (/for update/i.test(query.sql) && /"job_(applications|offers)"/.test(query.sql)) events.push('lock'); };
        database.on('query', listen);
        try {
          expect(await JobOffers.sendDueReminders(clock)).toEqual(one);
        } finally {
          database.removeListener('query', listen);
        }
        // One read to start the pass, then for each offer: both row locks, then the clock.
        expect(events).toEqual(['clock', 'lock', 'lock', 'clock', 'lock', 'lock', 'clock']);
        expect((await offerRow(first.sent.id)).reminder_claimed_at).toBeInstanceOf(Date);
        expect((await offerRow(second.sent.id)).reminder_claimed_at).toBeNull();
        // The next working day's pass takes the one that was left.
        expect(await JobOffers.sendDueReminders(midday)).toEqual(one);
        expect((await offerRow(second.sent.id)).reminder_sent_at).toBeInstanceOf(Date);
      });

      test('a channel that reaches its provider at 6 PM is not sent: the text went at 5:59, the email did not', async () => {
        await JobOffers.sendDueReminders(atEt('17:50'));
        mockSendStageComms.mockClear();
        const { sent } = await dueOffer({}, 72);
        // The pass starts and takes the offer at 5:54 PM; the text's check runs at 5:59 PM, the email's at 6:00 PM.
        const times = [atEt('17:54')(), atEt('17:54')(), atEt('17:59')()];
        const clock = () => times.shift() || atEt('18:00')();
        let answers;
        mockSendStageComms.mockImplementationOnce(async (_application, _stage, opts) => {
          answers = { sms: await opts.stillEligible(root, 'sms'), email: await opts.stillEligible(root, 'email') };
          return { sms: answers.sms ? 'sent' : 'stale', email: answers.email ? 'sent' : 'stale' };
        });
        expect(await JobOffers.sendDueReminders(clock)).toEqual(one);
        expect(answers).toEqual({ sms: true, email: false });
        expect((await offerRow(sent.id)).reminder_sent_at).toBeInstanceOf(Date);
      });

      test('a check before a provider that cannot be read stops that channel and fails the pass; the other channel still runs', async () => {
        const { sent } = await dueOffer();
        const down = () => { throw new Error('connection lost'); };
        mockSendStageComms.mockImplementationOnce(async (_application, _stage, opts) => {
          // The text's check cannot read the offer; the email's check reads it.
          const sms = await opts.stillEligible(down, 'sms');
          const email = await opts.stillEligible(root, 'email');
          return { sms: sms ? 'sent' : 'stale', email: email ? 'sent' : 'stale' };
        });
        expect(await JobOffers.sendDueReminders(midday)).toEqual({ reminded: 1, notSent: 0, failed: 1 });
        expect((await offerRow(sent.id)).reminder_sent_at).toBeInstanceOf(Date);

        // Neither check could be read: nothing went out, and the job still fails.
        const none2 = await dueOffer();
        mockSendStageComms.mockImplementationOnce(async (_application, _stage, opts) => {
          expect(await opts.stillEligible(down, 'sms')).toBe(false);
          expect(await opts.stillEligible(down, 'email')).toBe(false);
          return { sms: 'stale', email: 'stale' };
        });
        expect(await JobOffers.sendDueReminders(midday)).toEqual({ reminded: 0, notSent: 0, failed: 1 });
        expect(await offerRow(none2.sent.id)).toMatchObject({ reminder_claimed_at: expect.any(Date), reminder_sent_at: null });
      });

      test('the text goes only to an applicant who ticked "Text me about this offer"; the email goes to everyone with an email', async () => {
        // An empty box means no text, also for an applicant who agreed to texts on the application: the page shows
        // the box empty.
        const quiet = await dueOffer({ texts: false, sms_consent: true });
        expect(await JobOffers.sendDueReminders(midday)).toEqual(one);
        expect(mockSendStageComms.mock.calls[0][2]).toMatchObject({ sms: false, email: true });
        expect((await offerRow(quiet.sent.id)).reminder_sent_at).toBeInstanceOf(Date);

        // A ticked box is the yes, with no text consent on the application.
        await dueOffer({ sms_consent: false });
        expect(await JobOffers.sendDueReminders(midday)).toEqual(one);
        expect(mockSendStageComms.mock.calls[0][2]).toMatchObject({ sms: true, email: true });
      });

      test('an applicant the pass cannot reach is not taken, and gets the reminder after a yes to texts', async () => {
        const { sent } = await dueOffer({
          texts: false, contact_snapshot: JSON.stringify({ name: 'Jordan Rivera', phone: '(941) 555-0100' }),
        });
        expect(await JobOffers.sendDueReminders(midday)).toEqual(none);
        expect(mockSendStageComms).not.toHaveBeenCalled();
        expect((await offerRow(sent.id)).reminder_claimed_at).toBeNull();

        await tickTextBox(sent.id);
        expect(await JobOffers.sendDueReminders(midday)).toEqual(one);
        expect(mockSendStageComms.mock.calls[0][2]).toMatchObject({ sms: true, email: false });
      });

      test('a reminder that did not go out for a known reason is not marked sent, is not a failure, and is not tried again', async () => {
        // The applicant opted out of texts and the email address is suppressed.
        const blocked = await dueOffer();
        mockSendStageComms.mockResolvedValueOnce({ sms: 'blocked', email: 'blocked' });
        expect(await JobOffers.sendDueReminders(midday)).toEqual({ reminded: 0, notSent: 1, failed: 0 });
        expect(await offerRow(blocked.sent.id)).toMatchObject({ reminder_claimed_at: expect.any(Date), reminder_sent_at: null });
        const panel = await JobOffers.adminPanel(blocked.app.id, actor());
        expect(panel.current.timeline.map((t) => t.kind)).not.toContain('reminded');

        // The offer closed between the claim and the provider.
        await dueOffer();
        mockSendStageComms.mockResolvedValueOnce({ sms: 'stale', email: 'stale' });
        expect(await JobOffers.sendDueReminders(midday)).toEqual({ reminded: 0, notSent: 1, failed: 0 });

        mockSendStageComms.mockClear();
        expect(await JobOffers.sendDueReminders(midday)).toEqual(none);
        expect(mockSendStageComms).not.toHaveBeenCalled();
      });

      test('a channel that failed fails the pass, also when the other channel went out, and the offer is not tried again', async () => {
        // An applicant with an email only, whose email failed: nothing went out.
        const emailOnly = await dueOffer({ texts: false });
        mockSendStageComms.mockResolvedValueOnce({ sms: 'not_requested', email: 'failed' });
        expect(await JobOffers.sendDueReminders(midday)).toEqual({ reminded: 0, notSent: 0, failed: 1 });
        expect(await offerRow(emailOnly.sent.id)).toMatchObject({ reminder_claimed_at: expect.any(Date), reminder_sent_at: null });

        // The email went and the text failed: reminded, and still a failure for the job's health.
        const half = await dueOffer();
        mockSendStageComms.mockResolvedValueOnce({ sms: 'failed', email: 'sent' });
        expect(await JobOffers.sendDueReminders(midday)).toEqual({ reminded: 1, notSent: 0, failed: 1 });
        expect((await offerRow(half.sent.id)).reminder_sent_at).toBeInstanceOf(Date);

        // A send that threw may have reached one channel: counted, and never repeated.
        const threw = await dueOffer();
        mockSendStageComms.mockRejectedValueOnce(new Error('provider down'));
        expect(await JobOffers.sendDueReminders(midday)).toEqual({ reminded: 0, notSent: 0, failed: 1 });
        expect(await offerRow(threw.sent.id)).toMatchObject({ reminder_claimed_at: expect.any(Date), reminder_sent_at: null });

        mockSendStageComms.mockClear();
        expect(await JobOffers.sendDueReminders(midday)).toEqual(none);
        expect(mockSendStageComms).not.toHaveBeenCalled();
      });

      test('a reminder that went out but whose time was not stored counts as reminded, fails the pass, and is not sent again', async () => {
        const { sent } = await dueOffer();
        const real = mockDb;
        // The pass's only plain write to job_offers is the reminder_sent_at stamp (the claim runs in a transaction).
        const stand = (table) => (table === 'job_offers' ? { where: () => ({ update: async () => { throw new Error('write failed'); } }) } : real(table));
        stand.raw = (...args) => real.raw(...args);
        stand.transaction = (...args) => real.transaction(...args);
        mockDb = stand;
        try {
          expect(await JobOffers.sendDueReminders(midday)).toEqual({ reminded: 1, notSent: 0, failed: 1 });
        } finally {
          mockDb = real;
        }
        expect(mockSendStageComms).toHaveBeenCalledTimes(1);
        expect(await offerRow(sent.id)).toMatchObject({ reminder_claimed_at: expect.any(Date), reminder_sent_at: null });
        expect(await JobOffers.sendDueReminders(midday)).toEqual(none);
        expect(mockSendStageComms).toHaveBeenCalledTimes(1);
      });

      test('a channel whose result is not known fails the pass, is not shown as "Reminder sent", and is not tried again', async () => {
        // The applicant may hold the message and nobody can say so: no timeline entry, a failed job, no second send.
        const unknown = await dueOffer({ texts: false });
        mockSendStageComms.mockResolvedValueOnce({ sms: 'not_requested', email: 'uncertain' });
        expect(await JobOffers.sendDueReminders(midday)).toEqual({ reminded: 0, notSent: 0, failed: 1 });
        expect(await offerRow(unknown.sent.id)).toMatchObject({ reminder_claimed_at: expect.any(Date), reminder_sent_at: null });
        const panel = await JobOffers.adminPanel(unknown.app.id, actor());
        expect(panel.current.timeline.map((t) => t.kind)).not.toContain('reminded');

        // The email went and the text is not known: reminded by the email, and still a failure for the job.
        const half = await dueOffer();
        mockSendStageComms.mockResolvedValueOnce({ sms: 'uncertain', email: 'sent' });
        expect(await JobOffers.sendDueReminders(midday)).toEqual({ reminded: 1, notSent: 0, failed: 1 });
        expect((await offerRow(half.sent.id)).reminder_sent_at).toBeInstanceOf(Date);

        mockSendStageComms.mockClear();
        expect(await JobOffers.sendDueReminders(midday)).toEqual(none);
        expect(mockSendStageComms).not.toHaveBeenCalled();
      });

      test('the pass does not wait on a row another transaction holds: both locked reads are SKIP LOCKED', async () => {
        await dueOffer();
        const rowLocks = [];
        const listen = (query) => { if (/for update/i.test(query.sql) && /"job_(applications|offers)"/.test(query.sql)) rowLocks.push(query.sql); };
        database.on('query', listen);
        try {
          expect(await JobOffers.sendDueReminders(midday)).toEqual(one);
        } finally {
          database.removeListener('query', listen);
        }
        expect(rowLocks).toHaveLength(2);
        for (const sql of rowLocks) expect(sql).toMatch(/for update skip locked$/);
      });
    });

    test('Discard (withdraw) is tied to the state the owner saw: a stale one writes nothing', async () => {
      const app = await newApplication();
      const draft = await JobOffers.saveDraft(app.id, {}, actor());
      const refuse = (id, precondition, code, status) => expect(JobOffers.withdrawOffer(app.id, id, actor(), precondition))
        .rejects.toMatchObject({ status, code });
      await refuse(draft.id, {}, 'EXPECTED_STATUS_REQUIRED', 400);
      await refuse(draft.id, { expectedStatus: 'bogus' }, 'EXPECTED_STATUS_REQUIRED', 400);
      await refuse(draft.id, { expectedStatus: 'draft' }, 'DRAFT_HASH_REQUIRED', 400);
      await refuse(draft.id, { expectedStatus: 'sent' }, 'OFFER_CHANGED', 409); // the tab thinks it is out; it is a draft
      await refuse(draft.id, { expectedStatus: 'draft', draftHash: 'f'.repeat(64) }, 'DRAFT_CHANGED', 409);
      expect((await root('job_offers').where({ id: draft.id }).first()).status).toBe('draft');
      // The stale "Discard draft": the draft was sent meanwhile, so the live offer must NOT be withdrawn.
      await sendAsPage(app.id, draft.id, draft.draftHash);
      await refuse(draft.id, { expectedStatus: 'draft', draftHash: draft.draftHash }, 'OFFER_CHANGED', 409);
      expect((await root('job_offers').where({ id: draft.id }).first()).status).toBe('sent');
      expect((await JobOffers.withdrawOffer(app.id, draft.id, actor(), { expectedStatus: 'sent' })).status).toBe('withdrawn');
    });

    test('Revise needs the state the owner saw, and always yields an editable draft', async () => {
      const app = await newApplication();
      const sent = (await sendNew(app)).offer;
      const refuse = (input, code, status) => expect(JobOffers.reviseOffer(app.id, sent.id, input, actor())).rejects.toMatchObject({ status, code });
      await refuse({}, 'EXPECTED_STATUS_REQUIRED', 400);
      await refuse({ expectedStatus: 'draft' }, 'EXPECTED_STATUS_REQUIRED', 400);
      await refuse({ expectedStatus: 'date_requested' }, 'OFFER_CHANGED', 409);
      expect(await root('job_offers').where({ application_id: app.id }).count('* as n').first()).toEqual({ n: '1' });
      // The copied start date has passed: no refusal, the suggested start and a recomputed raise date.
      await root('job_offers').where({ id: sent.id }).update({ start_date: '2020-01-06', step_effective_on: '2020-04-13' });
      const revised = await JobOffers.reviseOffer(app.id, sent.id, { expectedStatus: 'sent' }, actor());
      expect(revised).toMatchObject({ status: 'draft', startDate: JobOffers.suggestStartDate(), stepEffectiveOn: JobOffers.stepDateFor(JobOffers.suggestStartDate()) });
      expect(revised.draftHash).toMatch(/^[0-9a-f]{64}$/);
    });

    test('the letter preview names its offer and draft hash', async () => {
      const app = await newApplication();
      const none = await JobOffers.adminPanel(app.id, actor());
      expect(none.letterPreview).toMatchObject({ offerId: null, draftHash: null, markdown: expect.stringContaining('# Your job offer') });
      const draft = await JobOffers.saveDraft(app.id, {}, actor());
      const withDraft = await JobOffers.adminPanel(app.id, actor());
      expect(withDraft.letterPreview).toMatchObject({ offerId: draft.id, draftHash: draft.draftHash });
      const sent = (await sendAsPage(app.id, draft.id, draft.draftHash)).offer;
      const out = await JobOffers.adminPanel(app.id, actor());
      expect(out.letterPreview).toMatchObject({ offerId: sent.id, draftHash: null });
    });

    test('the database allows one draft and one offer out per application, and no more', async () => {
      const app = await newApplication();
      const base = { application_id: app.id, start_date: '2027-03-01', hourly_rate: 23, hours_line: 'x', report_to: 'x' };
      await root.transaction(async (sp) => {
        await sp('job_offers').insert({ ...base, status: 'draft' });
        await sp('job_offers').insert({ ...base, status: 'sent' });
        await expect(sp.transaction((s2) => s2('job_offers').insert({ ...base, status: 'draft' }))).rejects.toMatchObject({ code: '23505' });
        await expect(sp.transaction((s2) => s2('job_offers').insert({ ...base, status: 'date_requested' }))).rejects.toMatchObject({ code: '23505' });
        await expect(sp.transaction((s2) => s2('job_offers').insert({ ...base, status: 'bogus' }))).rejects.toMatchObject({ code: '23514' });
      });
    });

    describe('the staff record a signature makes', () => {
      const offerRow = (id) => root('job_offers').where({ id }).first();
      const staffRow = (id) => root('technicians').where({ id }).first();
      const stepsOf = (technicianId) => root('payroll_rate_steps').where({ technician_id: technicianId })
        .select('hourly_rate', 'created_by', 'applied_at', 'cancelled_at', 'note', root.raw("to_char(effective_on, 'YYYY-MM-DD') as effective_on"));
      const contactOf = (email, over = {}) => JSON.stringify({ name: 'Jordan Rivera', phone: '(941) 555-0100', email, ...over });
      // An application with an offer out, and the offer's link.
      async function openOffer(appOver = {}, draft = {}) {
        const app = await newApplication(appOver);
        const saved = await JobOffers.saveDraft(app.id, draft, actor());
        const { offer } = await sendAsPage(app.id, saved.id, saved.draftHash);
        return { app, offer, token: (await offerRow(offer.id)).token };
      }
      const sign = async (token) => JobOffers.acceptOffer(token, { signedName: 'Jordan Rivera', version: await shownVersion(token) });
      // A signed offer whose staff record step has not run: the state a restart between the two commits leaves.
      async function signedWithoutRecord(appOver, draft) {
        const made = await openOffer(appOver, draft);
        await root('job_offers').where({ id: made.offer.id }).update({ status: 'accepted', signed_at: new Date(), signed_name: 'Jordan Rivera' });
        await root('job_applications').where({ id: made.app.id }).update({ status: 'hired' });
        return made;
      }
      // Every statement `work` runs, in order, with its bindings (the service runs them on nested transactions).
      async function statementsOf(work) {
        const seen = [];
        const listen = (query) => seen.push(`${query.sql} ${JSON.stringify(query.bindings || [])}`);
        database.client.on('query', listen);
        try { await work(); } finally { database.client.removeListener('query', listen); }
        return seen;
      }
      const PAYROLL_LOCK = 'payroll.mutation';
      beforeEach(() => { mockWageFloor.mockClear(); mockRaise.mockClear(); });

      test('signing makes a prospective staff row with the offer\'s first day, pay, title and W-2, and the pay step', async () => {
        const email = applicantEmail();
        const { app, offer, token } = await openOffer({ contact_snapshot: contactOf(`  ${email.toUpperCase()} `) });
        expect((await sign(token)).body).toMatchObject({ state: 'signed' });

        const row = await offerRow(offer.id);
        expect(row.technician_id).toBeTruthy();
        expect(row.checklist.staff_record).toEqual({ at: expect.any(String), made: true, pay_step: 'made' });
        const staff = await root('technicians').where({ id: row.technician_id })
          .first('*', root.raw("to_char(hire_date, 'YYYY-MM-DD') as first_day"));
        expect(staff).toMatchObject({
          name: 'Jordan Rivera', phone: '(941) 555-0100', email, role: 'technician',
          employment_status: 'prospective', active: false, field_dispatchable: false,
          first_day: offer.startDate, job_title: 'Pest Control Technician', employment_type: 'w2',
          password_hash: null,
        });
        expect(Number(staff.pay_rate)).toBe(23);
        // The step is the offer's, in the name of the owner who sent it, and still open.
        const steps = await stepsOf(staff.id);
        expect(steps).toEqual([{
          hourly_rate: '25.00', effective_on: offer.stepEffectiveOn, created_by: owner.id, applied_at: null, cancelled_at: null,
          note: 'From the signed job offer.',
        }]);
        // As a row added on the Team tab: every service, pending review.
        expect(Number((await root('technician_capabilities').where({ technician_id: staff.id }).count('* as n').first()).n)).toBeGreaterThan(0);
        // One audit row, ids only.
        const audit = await root('audit_log').where({ action: 'staff.prospective_from_offer', resource_id: staff.id }).first();
        expect(audit.metadata).toEqual({ technician_id: staff.id, job_offer_id: offer.id });
        // The only bell is the signature's.
        expect(mockRaise.mock.calls.map(([, spec]) => spec.action)).toEqual(['Jordan Rivera signed the job offer']);
        // The owner's card shows it.
        const panel = await JobOffers.adminPanel(app.id, actor());
        expect(panel.current).toMatchObject({ status: 'accepted', technicianId: staff.id });
        expect(panel.current.timeline.map((t) => t.label)).toContain('Staff record made, with the pay step');

        // The step ran: a replay of the signature, a direct call and the pass each make nothing more.
        await JobOffers.acceptOffer(token, { signedName: 'Jordan Rivera' });
        expect(await JobOffers.makeStaffRecord(offer.id)).toBeNull();
        expect(await JobOffers.makeDueStaffRecords()).toEqual({ made: 0, refused: 0, failed: 0 });
        expect(Number((await root('technicians').where({ email }).count('* as n').first()).n)).toBe(1);
        expect(await stepsOf(staff.id)).toHaveLength(1);
      });

      test('an offer with no step makes the row and no step, and takes no payroll lock', async () => {
        const { offer, token } = await openOffer({}, { stepRate: null, stepEffectiveOn: null });
        const statements = await statementsOf(() => sign(token));
        expect(statements.some((sql) => sql.includes('LOCK TABLE technicians IN SHARE ROW EXCLUSIVE MODE'))).toBe(true);
        expect(statements.some((sql) => sql.includes(PAYROLL_LOCK))).toBe(false);
        const row = await offerRow(offer.id);
        expect(row.checklist.staff_record).toMatchObject({ made: true, pay_step: 'none' });
        expect(await stepsOf(row.technician_id)).toEqual([]);
        expect(mockWageFloor).not.toHaveBeenCalled();
        expect(JobOffers.timelineOf(row).map((t) => t.label)).toContain('Staff record made');
      });

      test('an email that is already a staff login makes no row and rings one bell, once', async () => {
        const email = applicantEmail();
        await root('technicians').insert({ name: 'Former Tech', email, employment_status: 'inactive', active: false });
        const { app, offer, token } = await openOffer({ contact_snapshot: contactOf(email.toUpperCase()) });
        const count = async (table) => Number((await root(table).count('* as n').first()).n);
        const before = { staff: await count('technicians'), steps: await count('payroll_rate_steps') };
        expect((await sign(token)).body).toMatchObject({ state: 'signed' }); // the signature stands

        const row = await offerRow(offer.id);
        expect(row).toMatchObject({ status: 'accepted', technician_id: null });
        expect(row.checklist.staff_record).toEqual({ at: expect.any(String), made: false, reason: 'email_in_use' });
        expect({ staff: await count('technicians'), steps: await count('payroll_rate_steps') }).toEqual(before);
        const bells = mockRaise.mock.calls.filter(([, , opts]) => opts.dedupeKey === `job-offer-staff_record:${offer.id}`);
        expect(bells).toHaveLength(1);
        const [category, spec, opts] = bells[0];
        expect(category).toBe('job_application');
        expect(spec).toMatchObject({
          action: "Jordan Rivera's staff record was not made", severity: 'needs-you', who: 'person',
          why: 'The email on the application is already a staff login, so add this hire on the Team tab by hand.',
          link: `/admin/recruiting?application=${app.id}`,
        });
        expect(typeof opts.trx).toBe('function'); // written with the mark, so the mark never stands without its bell
        expect(jest.requireActual('../services/admin-alert-compose').composeAdminAlert(spec).headline)
          .toBe("Leads — Jordan Rivera's staff record was not made");
        expect(JobOffers.timelineOf(row).map((t) => t.label)).toContain('Staff record not made: the email is already a staff login');

        // The mark is final: the pass does not try this offer again and rings nothing more.
        mockRaise.mockClear();
        expect(await JobOffers.makeDueStaffRecords()).toEqual({ made: 0, refused: 0, failed: 0 });
        expect(mockRaise).not.toHaveBeenCalled();
      });

      test('an email that is another staff row\'s Google sign-in address makes no row', async () => {
        const email = applicantEmail();
        await root('technicians').insert({ name: 'Linked Tech', email: applicantEmail(), google_email: email.toUpperCase() });
        const { offer, token } = await openOffer({ contact_snapshot: contactOf(email) });
        await sign(token);
        expect(await offerRow(offer.id)).toMatchObject({ technician_id: null, checklist: { staff_record: { made: false, reason: 'email_in_use' } } });
        expect(await root('technicians').where({ email }).first()).toBeUndefined();
        expect(mockRaise.mock.calls.map(([, spec]) => spec.action)).toContain("Jordan Rivera's staff record was not made");
      });

      test('an owner login address is never given to a new staff row', async () => {
        const saved = process.env.IB_FULL_ACCESS_EMAILS;
        const email = applicantEmail();
        process.env.IB_FULL_ACCESS_EMAILS = email;
        try {
          const { offer, token } = await openOffer({ contact_snapshot: contactOf(email) });
          await sign(token);
          expect(await offerRow(offer.id)).toMatchObject({ technician_id: null, checklist: { staff_record: { made: false, reason: 'email_in_use' } } });
          expect(mockRaise.mock.calls.map(([, spec]) => spec.action)).toContain("Jordan Rivera's staff record was not made");
          expect(await root('technicians').where({ email }).first()).toBeUndefined();
        } finally {
          if (saved === undefined) delete process.env.IB_FULL_ACCESS_EMAILS; else process.env.IB_FULL_ACCESS_EMAILS = saved;
        }
      });

      test('a pay step the payroll rules refuse leaves the row made, with one bell', async () => {
        const { offer, token } = await openOffer();
        mockWageFloor.mockImplementation(() => { throw new Error('No Florida minimum wage on file for that day yet'); });
        try { await sign(token); } finally { mockWageFloor.mockImplementation(() => 1500n); }

        const row = await offerRow(offer.id);
        expect(row.technician_id).toBeTruthy();
        expect(row.checklist.staff_record).toEqual({ at: expect.any(String), made: true, pay_step: 'refused' });
        expect(await staffRow(row.technician_id)).toMatchObject({ employment_status: 'prospective', employment_type: 'w2' });
        expect(await stepsOf(row.technician_id)).toEqual([]);
        const bells = mockRaise.mock.calls.filter(([, , opts]) => opts.dedupeKey === `job-offer-pay_step:${offer.id}`);
        expect(bells).toHaveLength(1);
        expect(bells[0][1]).toMatchObject({
          action: "Jordan Rivera's pay step was not made",
          why: 'The staff record is made without the pay step of the offer; add the step on the staff record.',
        });
        expect(typeof bells[0][2].trx).toBe('function');
        expect(jest.requireActual('../services/admin-alert-compose').composeAdminAlert(bells[0][1]).headline)
          .toBe("Leads — Jordan Rivera's pay step was not made");
        expect(JobOffers.timelineOf(row).map((t) => t.label)).toContain('Staff record made, without the pay step');
      });

      test('a name or a phone too long for the staff row, and an email that is no address, do not stop the row', async () => {
        const { offer, token } = await openOffer({
          contact_snapshot: JSON.stringify({ name: `Jordan ${'R'.repeat(110)}`, phone: '+1 (941) 555-0100 extension 12345', email: 'not an address' }),
        });
        await JobOffers.acceptOffer(token, { signedName: `Jordan ${'R'.repeat(110)}`, version: await shownVersion(token) });
        const row = await offerRow(offer.id);
        const staff = await staffRow(row.technician_id);
        expect(staff.name).toBe(`Jordan ${'R'.repeat(93)}`);
        expect(staff).toMatchObject({ phone: null, email: null, employment_status: 'prospective' });
      });

      test('an error at signing leaves the signature and no mark; the pass makes the record later', async () => {
        const { offer, token } = await openOffer();
        const logger = require('../services/logger');
        logger.error.mockClear();
        // The staff record's transaction fails once: the signature's own transaction is the first one, this the second.
        const real = mockDb;
        let opened = 0;
        const stand = (...args) => real(...args);
        stand.raw = (...args) => real.raw(...args);
        stand.transaction = (...args) => {
          opened += 1;
          if (opened === 2) return Promise.reject(Object.assign(new Error('connection lost'), { code: '08006' }));
          return real.transaction(...args);
        };
        const version = await shownVersion(token);
        mockDb = stand;
        let signed;
        try { signed = await JobOffers.acceptOffer(token, { signedName: 'Jordan Rivera', version }); } finally { mockDb = real; }
        expect(signed.body).toMatchObject({ state: 'signed' });
        expect(opened).toBe(2);
        expect(await offerRow(offer.id)).toMatchObject({ status: 'accepted', technician_id: null });
        expect((await offerRow(offer.id)).checklist).toEqual({});
        expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/staff record not made at signing \(offer [0-9a-f-]+\), the next pass tries again: Error 08006/));

        expect(await JobOffers.makeDueStaffRecords()).toEqual({ made: 1, refused: 0, failed: 0 });
        const row = await offerRow(offer.id);
        expect(row.checklist.staff_record).toMatchObject({ made: true, pay_step: 'made' });
        expect(await stepsOf(row.technician_id)).toHaveLength(1);
        expect(await JobOffers.makeDueStaffRecords()).toEqual({ made: 0, refused: 0, failed: 0 });
      });

      test('the pass makes the record of a signature that never tried, counts a failure, and leaves the rest alone', async () => {
        const unmarked = async (id) => {
          const row = await offerRow(id);
          expect(row.technician_id).toBeNull();
          expect(row.checklist).toEqual({});
        };
        const due = await signedWithoutRecord();
        // Its email is a staff login's, and its bell cannot be written: the whole step fails, mark included.
        const takenEmail = applicantEmail();
        await root('technicians').insert({ name: 'Former Tech', email: takenEmail, employment_status: 'inactive', active: false });
        const broken = await signedWithoutRecord({ contact_snapshot: contactOf(takenEmail) });
        // Not Hired any more (the owner moved the application back), and an offer still out: neither is the pass's.
        const moved = await signedWithoutRecord();
        await root('job_applications').where({ id: moved.app.id }).update({ status: 'interview' });
        const out = await openOffer();
        const logger = require('../services/logger');
        logger.error.mockClear();
        mockRaise.mockClear();

        mockRaise.mockRejectedValueOnce(new Error('alert store down'));
        expect(await JobOffers.makeDueStaffRecords()).toEqual({ made: 1, refused: 0, failed: 1 });
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(`staff record not made (offer ${broken.offer.id})`));
        expect((await offerRow(due.offer.id)).checklist.staff_record).toMatchObject({ made: true, pay_step: 'made' });
        await unmarked(broken.offer.id);
        await unmarked(moved.offer.id);
        await unmarked(out.offer.id);
        expect(await JobOffers.makeStaffRecord(moved.offer.id)).toBeNull();
        expect(await JobOffers.makeStaffRecord(out.offer.id)).toBeNull();
        expect(await JobOffers.makeStaffRecord(randomUUID())).toBeNull();

        // The failed one was left due: the next pass refuses it with its bell, and then it is final.
        mockRaise.mockClear();
        expect(await JobOffers.makeDueStaffRecords()).toEqual({ made: 0, refused: 1, failed: 0 });
        expect(mockRaise).toHaveBeenCalledTimes(1);
        expect((await offerRow(broken.offer.id)).checklist.staff_record).toMatchObject({ made: false, reason: 'email_in_use' });
        expect(await JobOffers.makeDueStaffRecords()).toEqual({ made: 0, refused: 0, failed: 0 });
      });

      test('only the newest signature of a reopened application makes the record, whatever order the pass reads them in', async () => {
        // Two signed offers wait for their record: the owner reopened the application, and the applicant signed a
        // second offer at another rate. The pass reads the older one first.
        const first = await signedWithoutRecord();
        await root('job_applications').where({ id: first.app.id }).update({ status: 'reviewed' });
        const saved = await JobOffers.saveDraft(first.app.id, { hourlyRate: 24 }, actor());
        const { offer: second } = await sendAsPage(first.app.id, saved.id, saved.draftHash);
        await root('job_offers').where({ id: first.offer.id }).update({ signed_at: new Date(Date.now() - 86400000) });
        await root('job_offers').where({ id: second.id }).update({ status: 'accepted', signed_at: new Date(), signed_name: 'Jordan Rivera' });
        await root('job_applications').where({ id: first.app.id }).update({ status: 'hired' });
        mockRaise.mockClear();

        expect(await JobOffers.makeDueStaffRecords()).toEqual({ made: 1, refused: 0, failed: 0 });
        const older = await offerRow(first.offer.id);
        expect(older.technician_id).toBeNull();
        expect(older.checklist.staff_record).toEqual({ at: expect.any(String), made: false, reason: 'newer_offer' });
        expect(JobOffers.timelineOf(older).map((t) => t.kind)).not.toContain('staff_record');
        const newer = await offerRow(second.id);
        expect(newer.checklist.staff_record).toMatchObject({ made: true, pay_step: 'made' });
        expect(Number((await staffRow(newer.technician_id)).pay_rate)).toBe(24);
        expect(await stepsOf(newer.technician_id)).toHaveLength(1);
        expect(mockRaise).not.toHaveBeenCalled();
        // The older signature is final too: a direct call and the next pass make nothing.
        expect(await JobOffers.makeStaffRecord(first.offer.id)).toBeNull();
        expect(await JobOffers.makeDueStaffRecords()).toEqual({ made: 0, refused: 0, failed: 0 });
      });

      test('a second signature after the staff record exists changes nothing on the row and rings one bell', async () => {
        const { app, offer: first, token } = await openOffer();
        await sign(token);
        const staffId = (await offerRow(first.id)).technician_id;
        expect(staffId).toBeTruthy();
        // The owner reopens the application and sends a new offer at another rate; the applicant signs it.
        await root('job_applications').where({ id: app.id }).update({ status: 'interview' });
        const saved = await JobOffers.saveDraft(app.id, { hourlyRate: 24 }, actor());
        const { offer: second } = await sendAsPage(app.id, saved.id, saved.draftHash);
        const staffCount = async () => Number((await root('technicians').count('* as n').first()).n);
        const before = await staffCount();
        mockRaise.mockClear();
        expect((await sign((await offerRow(second.id)).token)).body).toMatchObject({ state: 'signed' });

        const row = await offerRow(second.id);
        expect(row.technician_id).toBeNull();
        expect(row.checklist.staff_record).toEqual({ at: expect.any(String), made: false, reason: 'earlier_record' });
        // The portal does not rewrite a staff row's pay by itself: the row and its step are the first offer's.
        expect(await staffCount()).toBe(before);
        expect(Number((await staffRow(staffId)).pay_rate)).toBe(23);
        expect(await stepsOf(staffId)).toEqual([expect.objectContaining({ hourly_rate: '25.00', effective_on: first.stepEffectiveOn })]);
        const bells = mockRaise.mock.calls.filter(([, , opts]) => opts.dedupeKey === `job-offer-staff_terms:${second.id}`);
        expect(bells).toHaveLength(1);
        expect(bells[0][1]).toMatchObject({
          action: "Jordan Rivera's staff record needs the new terms",
          why: 'An earlier signed offer made the staff record; set its first day, pay and pay step to the new offer by hand.',
          link: `/admin/recruiting?application=${app.id}`,
        });
        expect(typeof bells[0][2].trx).toBe('function');
        expect(jest.requireActual('../services/admin-alert-compose').composeAdminAlert(bells[0][1]).headline)
          .toBe("Leads — Jordan Rivera's staff record needs the new terms");
        expect(JobOffers.timelineOf(row).map((t) => t.label)).toContain('Staff record kept from an earlier offer: set its first day and pay by hand');
        mockRaise.mockClear();
        expect(await JobOffers.makeDueStaffRecords()).toEqual({ made: 0, refused: 0, failed: 0 });
        expect(mockRaise).not.toHaveBeenCalled();
      });

      test('the step waits at most 3 seconds for a lock, and takes the payroll lock before the staff table lock', async () => {
        const { token } = await openOffer();
        const statements = await statementsOf(() => sign(token));
        const at = (text) => statements.findIndex((sql) => sql.includes(text));
        expect(at('lock_timeout')).toBeGreaterThan(-1);
        expect(statements[at('lock_timeout')]).toContain('["3000"]');
        // The limit is set before the step's first read, so no statement of it waits longer.
        expect(at('select "application_id" from "job_offers"')).toBe(at('lock_timeout') + 1);
        expect(at('skip locked')).toBeGreaterThan(at('lock_timeout'));
        expect(at(PAYROLL_LOCK)).toBeGreaterThan(at('lock_timeout'));
        expect(at('LOCK TABLE technicians IN SHARE ROW EXCLUSIVE MODE')).toBeGreaterThan(at(PAYROLL_LOCK));
        // The staff row is written only under both locks.
        expect(at('insert into "technicians"')).toBeGreaterThan(at('LOCK TABLE technicians IN SHARE ROW EXCLUSIVE MODE'));
      });

      describe('the first-days checklist', () => {
        const { etDateString, parseETDateTime } = require('../utils/datetime-et');
        const logger = require('../services/logger');
        const NONE = { rung: 0, closed: 0, failed: 0 };
        const ring = (clock) => JobOffers.ringDueChecklists(clock);
        const byHand = () => ({ done_at: new Date(), done_by: owner.id, resolution: 'Closed by hand' });
        const LABELS = ['Driving record copy', "Driver's license check", "Workers' comp in force", 'Form I-9'];
        // A clock at an Eastern wall time of one day.
        const at = (ymd, hm) => () => parseETDateTime(`${ymd}T${hm}:00`);
        const shiftDay = (ymd, days) => {
          const [y, m, d] = ymd.split('-').map(Number);
          return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
        };
        // The Eastern day the test's signatures are made on, and the mornings after it.
        const signedDay = () => etDateString(new Date());
        const morning = (days, hm = '07:00') => at(shiftDay(signedDay(), days), hm);
        const bellsOf = (applicationId) => root('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`job-offer-checklist:${applicationId}`]);
        const openBellsOf = (applicationId) => bellsOf(applicationId).whereNull('done_at');
        const checklistOf = async (app) => (await JobOffers.adminPanel(app.id, actor())).firstDays;
        // A mark, or an undo of the mark the card shows at that time.
        const shownDoneAt = async (app, key) => (await checklistOf(app)).items.find((item) => item.key === key).doneAt;
        const mark = async (made, key, done = true, now) => JobOffers.setChecklistItem(made.app.id, made.offer.id, key, done, actor(),
          { clock: now && (() => now), seenDoneAt: done ? null : await shownDoneAt(made.app, key) });
        // A signed offer with its staff record: the hire. The default start date is a Monday.
        async function hire() {
          const made = await openOffer();
          await sign(made.token);
          return { ...made, staffId: (await offerRow(made.offer.id)).technician_id, firstDay: made.offer.startDate };
        }
        // The applicant signs a second offer after the owner reopened the application.
        async function signAgain(made, fields) {
          await root('job_applications').where({ id: made.app.id }).update({ status: 'interview' });
          const saved = await JobOffers.saveDraft(made.app.id, fields, actor());
          const { offer } = await sendAsPage(made.app.id, saved.id, saved.draftHash);
          expect((await sign((await offerRow(offer.id)).token)).body).toMatchObject({ state: 'signed' });
          return offer;
        }

        // The checklist has four items while staff Google sign-in is off: these tests run that way whatever the
        // environment holds, and the nested suite at the end turns it on.
        let signinGate;
        beforeAll(() => { signinGate = process.env.GATE_STAFF_GOOGLE_SIGNIN; process.env.GATE_STAFF_GOOGLE_SIGNIN = 'false'; });
        afterAll(() => { if (signinGate === undefined) delete process.env.GATE_STAFF_GOOGLE_SIGNIN; else process.env.GATE_STAFF_GOOGLE_SIGNIN = signinGate; });

        beforeEach(async () => {
          // The suite keeps its rows (one root transaction): the hires of earlier tests are not this test's. Their
          // items are done and their bells are closed. Only rows of the suite's own applications are written.
          const mark = { at: '2026-01-01T00:00:00.000Z' };
          await root('job_offers').whereIn('application_id', suiteApplications).where({ status: 'accepted' }).update({
            checklist: root.raw('checklist || ?::jsonb', [JSON.stringify({ driving_record: mark, license: mark, workers_comp: mark, i9: mark, google_login: mark })]),
          });
          // The bell rows are real (the alert writer's own rules decide a ring, a rewrite and a close).
          await root('notifications').whereRaw("metadata->>'dedupeKey' = ANY(?::text[])", [suiteApplications.map((id) => `job-offer-checklist:${id}`)])
            .update({ done_at: new Date(), metadata: root.raw("metadata || '{\"autoCleared\": true}'::jsonb") });
          logger.error.mockClear();
        });

        test('a Hired application shows four items on its newest signed offer, with due days from the first day on the staff record', async () => {
          const made = await hire();
          const dayOf = (ymd) => JobOffers.fmtDay(ymd, { year: true });
          expect(dayOf(made.firstDay)).toMatch(/^Mon, [A-Z][a-z]{2} \d{1,2}, \d{4}$/);
          const before = { due: `Due before the first day, ${dayOf(made.firstDay)}`, dueOn: made.firstDay, doneAt: null, doneByName: null };
          // Form I-9: 3 business days after a Monday is the Thursday.
          const thursday = shiftDay(made.firstDay, 3);
          expect(await checklistOf(made.app)).toEqual({
            offerId: made.offer.id,
            firstDay: made.firstDay,
            items: [
              { key: 'driving_record', label: LABELS[0], ...before },
              { key: 'license', label: LABELS[1], ...before },
              { key: 'workers_comp', label: LABELS[2], ...before },
              { key: 'i9', label: LABELS[3], due: `Due ${dayOf(thursday)}, 3 business days after the first day`, dueOn: thursday, doneAt: null, doneByName: null },
            ],
          });
          // The owner moves the first day to the Friday on the Team tab: the due days follow, and the weekend is skipped.
          const friday = shiftDay(made.firstDay, 4);
          await root('technicians').where({ id: made.staffId }).update({ hire_date: friday });
          const moved = await checklistOf(made.app);
          expect(moved.firstDay).toBe(friday);
          expect(moved.items.map((item) => item.dueOn)).toEqual([friday, friday, friday, shiftDay(friday, 5)]);
          // No checklist while the application is not Hired, or has no signed offer.
          await root('job_applications').where({ id: made.app.id }).update({ status: 'interview' });
          expect(await checklistOf(made.app)).toBeNull();
          expect(await checklistOf((await openOffer()).app)).toBeNull();
        });

        test('the owner marks an item done once and can undo it; the other marks of the offer stay', async () => {
          const made = await hire();
          const when = new Date('2026-12-01T15:00:00.000Z');
          const { firstDays } = await mark(made, 'driving_record', true, when);
          expect(firstDays.offerId).toBe(made.offer.id);
          expect(firstDays.items.map((item) => [item.doneAt, item.doneByName])).toEqual([[when.toISOString(), 'Test Owner'], [null, null], [null, null], [null, null]]);
          let row = await offerRow(made.offer.id);
          expect(row.checklist.driving_record).toEqual({ at: when.toISOString(), by: owner.id, by_name: 'Test Owner' });
          expect(row.checklist.staff_record).toMatchObject({ made: true });
          expect(JobOffers.timelineOf(row)).toContainEqual({ at: when.toISOString(), kind: 'checklist_done', label: 'Driving record copy marked done by Test Owner' });
          // A second mark keeps the first one.
          await mark(made, 'driving_record', true, new Date('2026-12-02T15:00:00.000Z'));
          expect((await offerRow(made.offer.id)).checklist.driving_record.at).toBe(when.toISOString());
          expect((await checklistOf(made.app)).items.map((item) => Boolean(item.doneAt))).toEqual([true, false, false, false]);

          // An undo names the mark the card showed. A card that shows an older mark, or none, removes nothing.
          const write = (done, more) => JobOffers.setChecklistItem(made.app.id, made.offer.id, 'driving_record', done, actor(), more);
          await expect(write(false, { seenDoneAt: '2026-11-30T15:00:00.000Z' })).rejects.toMatchObject({ status: 409, code: 'CHECKLIST_CHANGED' });
          await expect(write(false)).rejects.toMatchObject({ status: 409, code: 'CHECKLIST_CHANGED' });
          expect((await offerRow(made.offer.id)).checklist.driving_record.at).toBe(when.toISOString());
          expect((await write(false, { seenDoneAt: when.toISOString() })).firstDays.items[0]).toMatchObject({ doneAt: null, doneByName: null });
          row = await offerRow(made.offer.id);
          expect(row.checklist.driving_record).toBeUndefined();
          // An undo of an item that is not done changes nothing and is not refused.
          expect((await write(false, { seenDoneAt: when.toISOString() })).firstDays.items[0]).toMatchObject({ doneAt: null });
          expect(row.checklist.staff_record).toMatchObject({ made: true });
          expect(JobOffers.timelineOf(row).map((entry) => entry.kind)).not.toContain('checklist_done');

          // The time of a mark is read after its locks: a write that waited across midnight settles the day it ran on.
          const clock = jest.fn(() => new Date('2026-12-03T05:00:01.000Z'));
          let readsAtLock = null;
          const listen = (query) => {
            if (query.sql.includes('order by "signed_at" desc, "id" desc for update')) readsAtLock = clock.mock.calls.length;
          };
          database.client.on('query', listen);
          try { await JobOffers.setChecklistItem(made.app.id, made.offer.id, 'driving_record', true, actor(), { clock }); } finally { database.client.removeListener('query', listen); }
          expect(readsAtLock).toBe(0);
          expect(clock).toHaveBeenCalledTimes(1);
          expect((await offerRow(made.offer.id)).checklist).toMatchObject({ driving_record: { at: '2026-12-03T05:00:01.000Z' } });
        });

        test('a write is refused for an unknown item, another application\'s offer and an application no longer Hired', async () => {
          const made = await hire();
          const other = await hire();
          await expect(mark(made, 'not_an_item')).rejects.toMatchObject({ status: 400, code: 'INVALID_CHECKLIST_ITEM' });
          await expect(mark(made, 'i9', 'yes')).rejects.toMatchObject({ status: 400, code: 'INVALID_CHECKLIST_ITEM' });
          await expect(JobOffers.setChecklistItem(made.app.id, other.offer.id, 'i9', true, actor())).rejects.toMatchObject({ status: 409, code: 'CHECKLIST_CLOSED' });
          await expect(JobOffers.setChecklistItem(randomUUID(), made.offer.id, 'i9', true, actor())).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
          await root('job_applications').where({ id: made.app.id }).update({ status: 'interview' });
          await expect(mark(made, 'i9')).rejects.toMatchObject({ status: 409, code: 'CHECKLIST_CLOSED' });
          for (const hired of [made, other]) expect((await offerRow(hired.offer.id)).checklist.i9).toBeUndefined();
        });

        test('from 7:00 AM the morning after the signature the owner has one bell; a mark rewrites it with no ring, and the last due mark closes it', async () => {
          const made = await hire();
          const before = JobOffers.fmtDay(made.firstDay);
          // Not on the day of the signature, and not before 7:00 AM.
          expect(await ring(morning(0, '23:00'))).toEqual(NONE);
          expect(await ring(morning(1, '06:59'))).toEqual(NONE);
          expect(await bellsOf(made.app.id)).toHaveLength(0);

          expect(await ring(morning(1))).toEqual({ ...NONE, rung: 1 });
          const bells = await bellsOf(made.app.id);
          expect(bells).toHaveLength(1);
          expect(bells[0]).toMatchObject({
            recipient_type: 'admin', category: 'job_application', title: "Leads — finish Jordan Rivera's first-days checklist",
            body: `4 of 4 items are open; next: the driving record copy, due before ${before}.`,
            link: `/admin/recruiting?application=${made.app.id}`, done_at: null,
          });
          expect(bells[0].metadata).toMatchObject({
            doneWhen: 'checklist_done', applicationId: made.app.id, offerId: made.offer.id, itemKeys: ['driving_record', 'license', 'workers_comp'],
          });
          // The later runs of the day write nothing.
          expect(await ring(morning(1, '07:15'))).toEqual(NONE);
          expect(await bellsOf(made.app.id)).toEqual(bells);

          // A mark with an item still due leaves the row to the next run: its words follow with no ring, and the
          // owner's read stays.
          await root('notifications').where({ id: bells[0].id }).update({ read_at: new Date() });
          await mark(made, 'driving_record', true, morning(1, '08:00')());
          expect(await bellsOf(made.app.id)).toMatchObject([{ id: bells[0].id, done_at: null, body: bells[0].body }]);
          expect(await ring(morning(1, '08:15'))).toEqual(NONE);
          let [row] = await bellsOf(made.app.id);
          expect(row).toMatchObject({ id: bells[0].id, done_at: null, body: `3 of 4 items are open; next: the driver's license check, due before ${before}.` });
          expect(row.read_at).not.toBeNull();
          // A stale card sends "done" again for the item that is already done: nothing changes.
          await mark(made, 'driving_record', true, morning(1, '08:20')());
          expect(await openBellsOf(made.app.id)).toHaveLength(1);

          // The mark that leaves no item due closes the row, in the write (Form I-9 is not due before the first day).
          await mark(made, 'license', true, morning(1, '09:00')());
          expect(await openBellsOf(made.app.id)).toHaveLength(1);
          await mark(made, 'workers_comp', true, morning(1, '09:05')());
          [row] = await bellsOf(made.app.id);
          expect(row).toMatchObject({ id: bells[0].id, done_at: expect.any(Date), done_by: 'episodes', resolution: 'No first-days item is due today' });
          expect(row.metadata).toMatchObject({ autoCleared: true, autoClearedReason: 'checklist_done' });
          expect(await ring(morning(2))).toEqual(NONE);
          expect(await bellsOf(made.app.id)).toHaveLength(1);
        });

        test('Form I-9 rings on the first day, on its due day and the morning after it; the last mark ends the row, and an undo brings it back', async () => {
          const made = await hire();
          for (const key of ['driving_record', 'license', 'workers_comp']) await mark(made, key);
          // Before the first day nothing is due.
          expect(await ring(at(shiftDay(made.firstDay, -1), '09:00'))).toEqual(NONE);
          expect(await bellsOf(made.app.id)).toHaveLength(0);
          const due = shiftDay(made.firstDay, 3);
          expect(await ring(at(made.firstDay, '07:00'))).toEqual({ ...NONE, rung: 1 });
          const [first] = await bellsOf(made.app.id);
          expect(first).toMatchObject({ done_at: null, body: `1 of 4 items is open; next: Form I-9, due ${JobOffers.fmtDay(due)}.` });
          expect(first.metadata.itemKeys).toEqual(['i9']);
          // The owner marks the row done by hand: it stays done while nothing new is due.
          await root('notifications').where({ id: first.id }).update(byHand());
          expect(await ring(at(shiftDay(made.firstDay, 1), '07:00'))).toEqual(NONE);
          expect(await ring(at(shiftDay(made.firstDay, 2), '07:00'))).toEqual(NONE);
          expect(await openBellsOf(made.app.id)).toHaveLength(0);
          // The due day: the SAME row rings again, with the same words.
          expect(await ring(at(due, '06:59'))).toEqual(NONE);
          expect(await ring(at(due, '07:00'))).toEqual({ ...NONE, rung: 1 });
          expect(await bellsOf(made.app.id)).toMatchObject([{ id: first.id, done_at: null, read_at: null, body: first.body, metadata: expect.objectContaining({ itemKeys: ['i9', 'i9:due'] }) }]);
          expect(await ring(at(due, '07:15'))).toEqual(NONE);
          await root('notifications').where({ id: first.id }).update(byHand());
          // The morning after the due day the item is late: one more ring.
          expect(await ring(at(shiftDay(due, 1), '06:45'))).toEqual(NONE);
          expect(await ring(at(shiftDay(due, 1), '07:00'))).toEqual({ ...NONE, rung: 1 });
          let rows = await bellsOf(made.app.id);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({ id: first.id, done_at: null, read_at: null, body: `1 of 4 items is open; next: Form I-9, was due ${JobOffers.fmtDay(due)}.` });
          expect(rows[0].metadata.itemKeys).toEqual(['i9', 'i9:due', 'i9:late']);
          expect(await ring(at(shiftDay(due, 2), '07:00'))).toEqual(NONE);

          await mark(made, 'i9', true, at(shiftDay(due, 2), '10:00')());
          rows = await bellsOf(made.app.id);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({ done_at: expect.any(Date), resolution: 'Every first-days item is marked done' });
          expect(await ring(at(shiftDay(due, 3), '07:00'))).toEqual(NONE);
          // An item marked not done again is due again: the next run from 7:00 AM rings the same row.
          await mark(made, 'i9', false, at(shiftDay(due, 3), '08:00')());
          expect(await ring(at(shiftDay(due, 3), '08:15'))).toEqual({ ...NONE, rung: 1 });
          rows = await bellsOf(made.app.id);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({ id: first.id, done_at: null });
        });

        test('a row the owner marked done stays done until an item joins; leaving Hired closes the row in the next run, also at night, and Hired again rings', async () => {
          const made = await hire();
          expect(await ring(morning(1))).toEqual({ ...NONE, rung: 1 });
          const [row] = await bellsOf(made.app.id);
          await root('notifications').where({ id: row.id }).update({ ...byHand(), created_at: new Date('2026-01-05T12:00:00Z') });
          expect(await ring(morning(1, '12:00'))).toEqual(NONE);
          // A mark changes the words of the row. It stays done.
          await mark(made, 'workers_comp', true, morning(1, '13:00')());
          expect(await ring(morning(2))).toEqual(NONE);
          expect(await bellsOf(made.app.id)).toMatchObject([{ id: row.id, resolution: 'Closed by hand', done_by: owner.id, body: expect.stringContaining('3 of 4 items are open') }]);
          await mark(made, 'workers_comp', false, morning(2, '06:00')());
          // The undo is before 7:00 AM: the row waits.
          expect(await ring(morning(2, '06:30'))).toEqual(NONE);
          expect(await bellsOf(made.app.id)).toMatchObject([{ id: row.id, resolution: 'Closed by hand' }]);
          await mark(made, 'workers_comp', true, morning(2, '06:45')());
          // The first day: Form I-9 joins and the three other items are late. One ring, on the same row.
          expect(await ring(at(made.firstDay, '07:00'))).toEqual({ ...NONE, rung: 1 });
          let rows = await bellsOf(made.app.id);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({ id: row.id, done_at: null, body: `3 of 4 items are open; next: the driving record copy, was due before ${JobOffers.fmtDay(made.firstDay)}.` });
          expect(rows[0].metadata.itemKeys).toEqual(['driving_record', 'driving_record:late', 'i9', 'license', 'license:late']);
          // A ring moves the row to the top of the bell.
          expect(new Date(rows[0].created_at).getTime()).toBeGreaterThan(Date.parse('2026-06-01T00:00:00Z'));
          expect(await ring(at(made.firstDay, '07:15'))).toEqual(NONE);

          // The owner moves the application out of Hired: the next run closes the row, also on the day it rang.
          await root('job_applications').where({ id: made.app.id }).update({ status: 'rejected' });
          expect(await ring(at(made.firstDay, '07:30'))).toEqual({ ...NONE, closed: 1 });
          expect(await bellsOf(made.app.id)).toMatchObject([{ id: row.id, done_by: 'episodes', resolution: 'The application is no longer Hired' }]);
          expect(await ring(at(made.firstDay, '07:45'))).toEqual(NONE);
          // Hired again: the items are due again, and the same row rings.
          await root('job_applications').where({ id: made.app.id }).update({ status: 'hired' });
          expect(await ring(at(shiftDay(made.firstDay, 1), '07:00'))).toEqual({ ...NONE, rung: 1 });
          expect(await bellsOf(made.app.id)).toMatchObject([{ id: row.id, done_at: null }]);
          // Out of Hired at night: the close does not wait for 7:00 AM.
          await root('job_applications').where({ id: made.app.id }).update({ status: 'rejected' });
          expect(await ring(at(shiftDay(made.firstDay, 2), '01:00'))).toEqual({ ...NONE, closed: 1 });
          expect(await openBellsOf(made.app.id)).toHaveLength(0);
          // A row the owner marked done closes too when the application leaves Hired, and it is counted once.
          const other = await hire();
          expect(await ring(morning(1))).toEqual({ ...NONE, rung: 1 });
          await bellsOf(other.app.id).update(byHand());
          await root('job_applications').where({ id: other.app.id }).update({ status: 'rejected' });
          expect(await ring(morning(1, '07:15'))).toEqual({ ...NONE, closed: 1 });
          expect(await bellsOf(other.app.id)).toMatchObject([{ resolution: 'Closed by hand', metadata: expect.objectContaining({ autoCleared: true }) }]);
          expect(await ring(morning(1, '07:30'))).toEqual(NONE);
          // A deleted application (its offers go with it): its row closes in the next run.
          const gone = await hire();
          expect(await ring(morning(1, '07:45'))).toEqual({ ...NONE, rung: 1 });
          await root('job_applications').where({ id: gone.app.id }).del();
          expect(await ring(morning(1, '08:00'))).toEqual({ ...NONE, closed: 1 });
          expect(await bellsOf(gone.app.id)).toMatchObject([{ done_by: 'episodes', resolution: 'The application was deleted' }]);
          expect(await ring(morning(1, '08:15'))).toEqual(NONE);
        });

        test('a mark takes the item off the row at once, so an undo before the next run rings a row the owner marked done; a name the alert rules refuse keeps the same row', async () => {
          const made = await hire();
          expect(await ring(morning(1))).toEqual({ ...NONE, rung: 1 });
          const [row] = await bellsOf(made.app.id);
          await root('notifications').where({ id: row.id }).update(byHand());
          // A mark and its undo with no run between them: the item is due again, and the next run rings the row.
          await mark(made, 'license', true, morning(1, '08:00')());
          expect((await bellsOf(made.app.id).first()).metadata.itemKeys).toEqual(['driving_record', 'workers_comp']);
          expect(await openBellsOf(made.app.id)).toHaveLength(0);
          await mark(made, 'license', false, morning(1, '08:05')());
          expect(await ring(morning(1, '08:15'))).toEqual({ ...NONE, rung: 1 });
          expect(await bellsOf(made.app.id)).toMatchObject([{ id: row.id, done_at: null, read_at: null, body: row.body }]);

          // The alert copy rules refuse this name. The row is written with no name, with no ring.
          const { contact_snapshot: snapshot } = await root('job_applications').where({ id: made.app.id }).first('contact_snapshot');
          const contact = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
          await root('job_applications').where({ id: made.app.id }).update({ contact_snapshot: JSON.stringify({ ...contact, name: 'Jordan Rivera!' }) });
          expect(await ring(morning(1, '08:30'))).toEqual(NONE);
          expect(await bellsOf(made.app.id)).toMatchObject([{ id: row.id, done_at: null, title: "Leads — finish An applicant's first-days checklist" }]);
          // It still closes with the last due mark and comes back with an undo.
          for (const key of ['driving_record', 'license', 'workers_comp']) await mark(made, key, true, morning(1, '09:00')());
          expect(await bellsOf(made.app.id)).toMatchObject([{ id: row.id, done_by: 'episodes', resolution: 'No first-days item is due today' }]);
          await mark(made, 'workers_comp', false, morning(1, '09:05')());
          expect(await ring(morning(1, '09:15'))).toEqual({ ...NONE, rung: 1 });
          expect(await bellsOf(made.app.id)).toMatchObject([{
            id: row.id, done_at: null, title: "Leads — finish An applicant's first-days checklist",
            body: expect.stringContaining("2 of 4 items are open; next: workers' comp in force"),
          }]);
        });

        test('a replacement offer keeps the marks and the one row: the next run moves the row to the newer offer with no ring', async () => {
          const made = await hire();
          await mark(made, 'license');
          expect(await ring(morning(1))).toEqual({ ...NONE, rung: 1 });
          const [row] = await bellsOf(made.app.id);
          expect(row.metadata).toMatchObject({ offerId: made.offer.id, itemKeys: ['driving_record', 'workers_comp'] });
          await root('notifications').where({ id: row.id }).update({ read_at: new Date() });

          const second = await signAgain(made, { hourlyRate: 24 });
          const shown = await checklistOf(made.app);
          expect(shown.offerId).toBe(second.id);
          expect(shown.items.map((item) => Boolean(item.doneAt))).toEqual([false, true, false, false]);
          // The first day is still the staff record's.
          expect(shown.firstDay).toBe(made.firstDay);
          // The items do not start again with the new signature (made that morning): the same items are due that day,
          // and the row moves to the newer offer with the same words, no ring, and the owner's read.
          await root('job_offers').where({ id: second.id }).update({ signed_at: morning(1, '08:30')() });
          expect(await ring(morning(1, '09:00'))).toEqual(NONE);
          let rows = await bellsOf(made.app.id);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({ id: row.id, title: row.title, body: row.body, done_at: null });
          expect(rows[0].metadata).toMatchObject({ offerId: second.id, itemKeys: ['driving_record', 'workers_comp'] });
          expect(rows[0].read_at).not.toBeNull();

          // A card read before the second signature writes nothing.
          await expect(mark(made, 'i9')).rejects.toMatchObject({ status: 409, code: 'CHECKLIST_CLOSED' });
          // A write on the newer offer moves every mark there; the older offer keeps its other marks.
          await JobOffers.setChecklistItem(made.app.id, second.id, 'i9', true, actor());
          expect(Object.keys((await offerRow(second.id)).checklist)).toEqual(expect.arrayContaining(['license', 'i9', 'staff_record']));
          const older = (await offerRow(made.offer.id)).checklist;
          expect(older.license).toBeUndefined();
          expect(older.staff_record).toMatchObject({ made: true });
          // A carried mark can be undone. The item is due again: the next run rings the one row.
          await JobOffers.setChecklistItem(made.app.id, second.id, 'license', false, actor(), { seenDoneAt: await shownDoneAt(made.app, 'license') });
          expect((await checklistOf(made.app)).items.map((item) => Boolean(item.doneAt))).toEqual([false, false, false, true]);
          expect(await ring(morning(2))).toEqual({ ...NONE, rung: 1 });
          rows = await bellsOf(made.app.id);
          expect(rows).toHaveLength(1);
          expect(rows[0].metadata).toMatchObject({ offerId: second.id, itemKeys: ['driving_record', 'license', 'workers_comp'] });
        });

        test('a first day moved later closes the row of an item that is no longer due, and the new first day rings again', async () => {
          const made = await hire();
          for (const key of ['driving_record', 'license', 'workers_comp']) await mark(made, key);
          expect(await ring(at(made.firstDay, '07:00'))).toEqual({ ...NONE, rung: 1 });
          const [first] = await openBellsOf(made.app.id);
          // The owner moves the first day one week later on the Team tab: Form I-9 is not due yet. The next run closes.
          const later = shiftDay(made.firstDay, 7);
          await root('technicians').where({ id: made.staffId }).update({ hire_date: later });
          expect(await ring(at(made.firstDay, '07:15'))).toEqual({ ...NONE, closed: 1 });
          expect(await bellsOf(made.app.id)).toMatchObject([{ id: first.id, done_by: 'episodes', resolution: 'No first-days item is due today' }]);
          expect(await ring(at(shiftDay(made.firstDay, 2), '07:00'))).toEqual(NONE);
          // The new first day: the row rings again with the new due day (a Monday + 3 business days = the Thursday).
          expect(await ring(at(later, '07:00'))).toEqual({ ...NONE, rung: 1 });
          expect(await bellsOf(made.app.id)).toMatchObject([{ id: first.id, done_at: null, body: `1 of 4 items is open; next: Form I-9, due ${JobOffers.fmtDay(shiftDay(later, 3))}.` }]);
        });

        test('a row that cannot be written fails the pass and is tried again; the pass waits at most 3 seconds for a lock and reads the time under the locks', async () => {
          const made = await hire();
          const episodes = require('../services/admin-alert-episodes');
          const down = jest.spyOn(episodes, 'raiseAdminAlertWithReopen').mockRejectedValueOnce(new Error('alert store down'));
          try {
            expect(await ring(morning(1))).toEqual({ ...NONE, failed: 1 });
          } finally { down.mockRestore(); }
          expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(`checklist bell failed (application ${made.app.id})`));
          expect(await bellsOf(made.app.id)).toHaveLength(0);

          const clock = jest.fn(morning(1, '07:15'));
          let clockReadsAtLock = null;
          const seen = [];
          const listen = (query) => {
            seen.push(`${query.sql} ${JSON.stringify(query.bindings || [])}`);
            if (query.sql.includes('order by "signed_at" desc, "id" desc for update')) clockReadsAtLock = clock.mock.calls.length;
          };
          database.client.on('query', listen);
          try { expect(await ring(clock)).toEqual({ ...NONE, rung: 1 }); } finally { database.client.removeListener('query', listen); }
          const where = (text) => seen.findIndex((sql) => sql.includes(text));
          expect(seen[where('lock_timeout')]).toContain('["3000"]');
          // The limit is the transaction's first statement. Then the application row, its signed offers, the row's lock.
          expect(where('skip locked')).toBe(where('lock_timeout') + 1);
          expect(where('order by "signed_at" desc, "id" desc for update')).toBeGreaterThan(where('skip locked'));
          expect(where('pg_advisory_xact_lock')).toBeGreaterThan(where('order by "signed_at" desc, "id" desc for update'));
          // The time is read once for the hire, after its locks: a run that started before midnight follows the new day.
          expect(clockReadsAtLock).toBe(0);
          expect(clock).toHaveBeenCalledTimes(1);
        });

        // The hire's login (owner 2026-11-22 "press"): the item is in the checklist while staff Google sign-in is live.
        describe('with staff Google sign-in live: the Waves Google login item', () => {
          const GOOGLE = { GATE_STAFF_GOOGLE_SIGNIN: 'true', GOOGLE_STAFF_SIGNIN_CLIENT_ID: 'fixture-client', GOOGLE_STAFF_SIGNIN_CLIENT_SECRET: 'fixture-secret' };
          const saved = {};
          beforeEach(() => {
            for (const [name, value] of Object.entries(GOOGLE)) { saved[name] = process.env[name]; process.env[name] = value; }
          });
          afterEach(() => {
            for (const name of Object.keys(GOOGLE)) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
          });

          test('the item comes first and is marked by hand; with sign-in off the checklist has four items and keeps the mark', async () => {
            const made = await hire();
            const keys = async () => (await checklistOf(made.app)).items.map((item) => item.key);
            expect(await keys()).toEqual(['google_login', 'driving_record', 'license', 'workers_comp', 'i9']);
            expect((await checklistOf(made.app)).items[0]).toEqual({
              key: 'google_login', label: 'Waves Google login', note: 'On the Team tab, link the Waves Google address, and press Hired if the row shows it.',
              due: `Due before the first day, ${JobOffers.fmtDay(made.firstDay, { year: true })}`, dueOn: made.firstDay, doneAt: null, doneByName: null,
            });
            const when = new Date('2026-12-01T15:00:00.000Z');
            const { firstDays } = await mark(made, 'google_login', true, when);
            expect(firstDays.items[0]).toMatchObject({ key: 'google_login', doneAt: when.toISOString(), doneByName: 'Test Owner' });
            const row = await offerRow(made.offer.id);
            expect(row.checklist.google_login).toEqual({ at: when.toISOString(), by: owner.id, by_name: 'Test Owner' });
            expect(JobOffers.timelineOf(row)).toContainEqual({ at: when.toISOString(), kind: 'checklist_done', label: 'Waves Google login marked done by Test Owner' });

            // Sign-in off: four items, the login item takes no mark, and a mark of another item keeps the stored one.
            process.env.GATE_STAFF_GOOGLE_SIGNIN = 'false';
            expect(await keys()).toEqual(['driving_record', 'license', 'workers_comp', 'i9']);
            await expect(mark(made, 'google_login')).rejects.toMatchObject({ status: 400, code: 'INVALID_CHECKLIST_ITEM' });
            await mark(made, 'license');
            expect((await offerRow(made.offer.id)).checklist.google_login.at).toBe(when.toISOString());
            process.env.GATE_STAFF_GOOGLE_SIGNIN = 'true';
            expect((await checklistOf(made.app)).items.map((item) => Boolean(item.doneAt))).toEqual([true, false, true, false, false]);
            // An undo, as for the other items.
            await mark(made, 'google_login', false);
            expect((await offerRow(made.offer.id)).checklist.google_login).toBeUndefined();
          });

          test('the bell names the login first, finds a hire whose other items are all done, and the mark closes it', async () => {
            const fresh = await hire();
            const made = await hire();
            const before = JobOffers.fmtDay(made.firstDay);
            // The four other items are done before any bell: the run still finds this hire, for the login alone.
            const stamp = { at: '2026-01-01T00:00:00.000Z' };
            await root('job_offers').where({ id: made.offer.id })
              .update({ checklist: root.raw('checklist || ?::jsonb', [JSON.stringify({ driving_record: stamp, license: stamp, workers_comp: stamp, i9: stamp })]) });
            expect(await ring(morning(1))).toEqual({ ...NONE, rung: 2 });
            const [first] = await bellsOf(fresh.app.id);
            expect(first).toMatchObject({ done_at: null, body: `5 of 5 items are open; next: the Waves Google login on the Team tab, due before ${before}.` });
            expect(first.metadata.itemKeys).toEqual(['driving_record', 'google_login', 'license', 'workers_comp']);
            const [row] = await bellsOf(made.app.id);
            expect(row).toMatchObject({ done_at: null, body: `1 of 5 items is open; next: the Waves Google login on the Team tab, due before ${before}.` });
            expect(row.metadata.itemKeys).toEqual(['google_login']);

            // The owner marks it done: nothing is left, and the row closes with the mark.
            await mark(made, 'google_login', true, morning(1, '09:00')());
            expect(await bellsOf(made.app.id)).toMatchObject([{ id: row.id, resolution: 'Every first-days item is marked done' }]);
            expect(await ring(morning(1, '09:15'))).toEqual(NONE);

            // The first day comes with the login still open: the row rings again, and its longest words fit the alert.
            expect(await ring(at(fresh.firstDay, '07:00'))).toEqual({ ...NONE, rung: 1 });
            expect(await openBellsOf(fresh.app.id)).toMatchObject([{
              id: first.id, body: `5 of 5 items are open; next: the Waves Google login on the Team tab, was due before ${before}.` }]);
          });
        });
      });
    });
  });
});
