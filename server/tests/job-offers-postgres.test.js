// The job-offer state machine on a real, migrated PostgreSQL (services/job-offers.js): the Technician Terms lookup
// (issued versions only), the draft / send / revise / withdraw writers, the public view / consent / sign / date
// request / decline, and the two partial unique indexes. Every row is written inside ONE root transaction that is
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
jest.mock('../services/recruiting-comms', () => ({
  ...jest.requireActual('../services/recruiting-comms'),
  sendStageComms: (...args) => mockSendStageComms(...args),
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

  // The version a read of the link shows: what the page sends back with each answer.
  const shownVersion = async (token) => (await JobOffers.publicView(token)).version;

  // Saves the default draft and presses Send on exactly the preview the draft's hash names.
  async function sendNew(app) {
    const draft = await JobOffers.saveDraft(app.id, {}, actor());
    return JobOffers.sendOffer(app.id, draft.id, actor(), draft.draftHash);
  }

  async function newApplication(over = {}) {
    const [row] = await root('job_applications').insert({
      role: 'technician', status: 'reviewed',
      contact_snapshot: JSON.stringify({ name: 'Jordan Rivera', phone: '(941) 555-0100', email: 'jordan.rivera@example.test' }),
      ...over,
    }).returning('*');
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
      await expect(JobOffers.sendOffer(app.id, offer.id, actor(), offer.draftHash)).rejects.toMatchObject({ status: 409, code: 'TERMS_NOT_ISSUED' });
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
      const sent = await JobOffers.sendOffer(app.id, draft.id, actor(), draft.draftHash);
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

      await expect(JobOffers.sendOffer(app.id, draft.id, actor(), draft.draftHash)).rejects.toMatchObject({ status: 409, code: 'OFFER_NOT_DRAFT' });
      expect(mockSendStageComms).toHaveBeenCalledTimes(1);
    });

    test('an applicant with no phone and no email cannot be sent an offer', async () => {
      const app = await newApplication({ contact_snapshot: JSON.stringify({ name: 'Casey Morgan' }) });
      const draft = await JobOffers.saveDraft(app.id, {}, actor());
      await expect(JobOffers.sendOffer(app.id, draft.id, actor(), draft.draftHash)).rejects.toMatchObject({ status: 409, code: 'NO_CONTACT' });
    });

    test('a comms failure after the commit leaves the offer sent and reports the channels as failed', async () => {
      const app = await newApplication();
      const draft = await JobOffers.saveDraft(app.id, {}, actor());
      mockSendStageComms.mockRejectedValueOnce(new Error('boom'));
      const sent = await JobOffers.sendOffer(app.id, draft.id, actor(), draft.draftHash);
      expect(sent.offer.status).toBe('sent');
      expect(sent.comms.sms.outcome).toBe('failed');
    });

    test('revise leaves the old offer out until the new draft is sent; sending supersedes it', async () => {
      const app = await newApplication();
      const draft = await JobOffers.saveDraft(app.id, {}, actor());
      const sent = await JobOffers.sendOffer(app.id, draft.id, actor(), draft.draftHash);
      const oldToken = (await root('job_offers').where({ id: draft.id }).first()).token;

      await expect(JobOffers.saveDraft(app.id, {}, actor())).rejects.toMatchObject({ status: 409, code: 'OFFER_ALREADY_OPEN' });
      const revised = await JobOffers.reviseOffer(app.id, sent.offer.id, { expectedStatus: 'sent', startDate: addStaffWorkDays(JobOffers.suggestStartDate(), 7) }, actor());
      expect(revised).toMatchObject({ status: 'draft', supersedesId: sent.offer.id });
      expect((await root('job_offers').where({ id: draft.id }).first()).status).toBe('sent');
      expect((await JobOffers.reviseOffer(app.id, sent.offer.id, { expectedStatus: 'sent' }, actor())).id).toBe(revised.id);

      const resent = await JobOffers.sendOffer(app.id, revised.id, actor(), revised.draftHash);
      expect(resent.offer.status).toBe('sent');
      const old = await root('job_offers').where({ id: draft.id }).first();
      expect(old).toMatchObject({ status: 'superseded', superseded_by_id: revised.id });
      const view = await JobOffers.publicView(oldToken);
      expect(view).toMatchObject({ state: 'superseded', contactPhone: '(941) 297-5749' });
      expect(view.terms).toBeUndefined();
      expect(view.message).toMatch(/^This offer was updated\. Please use the newest link /);
      expect((await root('job_applications').where({ id: app.id }).first()).status_history.at(-1).note).toBe('Updated job offer sent');
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
      const resent = await JobOffers.sendOffer(app.id, revised.id, actor(), revised.draftHash);
      expect(resent.offer.status).toBe('sent');
      expect((await root('job_offers').where({ id: sent.offer.id }).first()).status).toBe('superseded');
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
        expect(await JobOffers.setTextConsent(token, true, undefined)).toEqual({ refused: true, body: { state: 'open' } });
        expect(await stamp()).toBeNull();
        expect((await JobOffers.publicView(token)).version).toBe(off.body.version);
        expect(await JobOffers.setTextConsent(token, 'yes', off.body.version)).toMatchObject({ invalid: expect.any(String) });
      });

      test('signing records the signature, hires the applicant, raises one bell, and a replay never signs twice', async () => {
        expect(await JobOffers.acceptOffer(token, { signedName: 'Jordan' })).toMatchObject({ invalid: expect.any(String) });
        expect(await JobOffers.acceptOffer(token, { signedName: '  ' })).toMatchObject({ invalid: expect.any(String) });
        const signed = await JobOffers.acceptOffer(token, { signedName: '  Jordan   Rivera ', ip: '203.0.113.9', userAgent: 'TestAgent/1.0', version: await shownVersion(token) });
        expect(signed.body).toMatchObject({ state: 'signed' });
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

        const replay = await JobOffers.acceptOffer(token, { signedName: 'jordan rivera' });
        expect(replay.body).toMatchObject({ state: 'signed' });
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
      // older read (or with no version) is refused with the offer still open and writes nothing, so none of them fixes a
      // choice the applicant did not see; made on the version the page now shows, the sign goes through.
      test('a sign, date request or decline made on an older read is refused and writes nothing', async () => {
        const first = await shownVersion(token);
        const on = await JobOffers.setTextConsent(token, true, first);
        expect(on.body.version).not.toBe(first);
        const monday = addStaffWorkDays(JobOffers.suggestStartDate(), 7);
        for (const stale of [first, undefined]) {
          expect(await JobOffers.acceptOffer(token, { signedName: 'Jordan Rivera', version: stale })).toEqual({ refused: true, body: { state: 'open' } });
          expect(await JobOffers.requestDate(token, { requestedStartDate: monday, version: stale })).toEqual({ refused: true, body: { state: 'open' } });
          expect(await JobOffers.declineOffer(token, { reason: 'Changed my mind', version: stale })).toEqual({ refused: true, body: { state: 'open' } });
        }
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
      await expect(JobOffers.sendOffer(app.id, draft.id, actor(), draft.draftHash))
        .rejects.toMatchObject({ status: 409, code: 'DRAFT_CHANGED', message: 'This draft changed after you opened it. Review the new preview, then send.' });
      expect((await root('job_offers').where({ id: draft.id }).first()).status).toBe('draft');
      expect(mockSendStageComms).not.toHaveBeenCalled();
      expect((await JobOffers.sendOffer(app.id, draft.id, actor(), edited.draftHash)).offer.status).toBe('sent');
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
      expect((await JobOffers.sendOffer(app.id, second.id, actor(), second.draftHash)).offer.status).toBe('sent');

      await root('job_offers').where({ id: second.id }).update({ expires_at: new Date(Date.now() - 60000) });
      const third = await JobOffers.saveDraft(app.id, {}, actor());
      await JobOffers.sendOffer(app.id, third.id, actor(), third.draftHash);
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
      const sent = (await JobOffers.sendOffer(app.id, first.id, actor(), first.draftHash)).offer;
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
      await JobOffers.sendOffer(app.id, draft.id, actor(), draft.draftHash);
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
      const sent = (await JobOffers.sendOffer(app.id, draft.id, actor(), draft.draftHash)).offer;
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
  });
});
