/**
 * GATE_CALL_APPLICANT_HANDLING — job-applicant / vendor call hygiene (dark).
 *
 *   1. disposition: the nature default beats a model "no_action_needed";
 *   2. cards: no customer-only review card on those natures;
 *   3. promises: Waves-party promises are stored as kind 'other', no due time;
 *   4. Careers row: one comms-free job_applications row, idempotent by call and
 *      deduped by phone.
 * Off = byte-identical: every test also pins the gate-off behavior.
 * Synthetic names only.
 */

const fs = require('fs');
const { decideDisposition } = require('../services/call-disposition');
const {
  thirdPartyCustomerOnlyCards, THIRD_PARTY_CUSTOMER_ONLY_CARDS, dropUnneededCallCards,
} = require('../services/call-triage-flags');
const { recordCallCommitments, asThirdPartyPromise } = require('../services/call-commitments');
const { createJobApplicationFromCall, OPEN_STATUSES } = require('../services/job-applications');
const gates = require('../config/feature-gates');

describe('GATE_CALL_APPLICANT_HANDLING reader', () => {
  const saved = process.env.GATE_CALL_APPLICANT_HANDLING;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_CALL_APPLICANT_HANDLING; else process.env.GATE_CALL_APPLICANT_HANDLING = saved;
  });
  test('dark unless exactly "true", read at call time', () => {
    delete process.env.GATE_CALL_APPLICANT_HANDLING;
    expect(gates.callApplicantHandlingLive()).toBe(false);
    for (const v of ['1', 'on', 'TRUE', 'yes', '']) {
      process.env.GATE_CALL_APPLICANT_HANDLING = v;
      expect(gates.callApplicantHandlingLive()).toBe(false);
    }
    process.env.GATE_CALL_APPLICANT_HANDLING = 'true';
    expect(gates.callApplicantHandlingLive()).toBe(true);
    process.env.GATE_CALL_APPLICANT_HANDLING = 'false';
    expect(gates.callApplicantHandlingLive()).toBe(false);
  });
});

describe('1. disposition', () => {
  const ext = (nature, recommended) => ({ call_nature: nature, recommended_disposition: recommended });

  test('gate off: the model "no_action_needed" still wins (byte-identical to main)', () => {
    expect(decideDisposition({ extraction: ext('job_applicant', 'no_action_needed') }).disposition).toBe('no_action_needed');
    expect(decideDisposition({ extraction: ext('job_applicant', 'no_action_needed'), thirdPartyNatureDefault: false }).disposition).toBe('no_action_needed');
  });

  test('gate on: job_applicant and vendor_or_partner keep the nature default vendor_logged', () => {
    for (const nature of ['job_applicant', 'vendor_or_partner']) {
      const out = decideDisposition({ extraction: ext(nature, 'no_action_needed'), thirdPartyNatureDefault: true });
      expect(out.disposition).toBe('vendor_logged');
      expect(out.reason).toBe('third_party_nature_default');
    }
  });

  test('gate on: any other model recommendation still stands', () => {
    const out = decideDisposition({ extraction: ext('job_applicant', 'voicemail_processed'), thirdPartyNatureDefault: true });
    expect(out.disposition).toBe('voicemail_processed');
  });

  test('gate on: other natures are untouched (silent_or_noise stays no_action_needed)', () => {
    expect(decideDisposition({ extraction: ext('silent_or_noise', 'no_action_needed'), thirdPartyNatureDefault: true }).disposition).toBe('no_action_needed');
    expect(decideDisposition({ extraction: ext('new_lead', 'no_action_needed'), thirdPartyNatureDefault: true }).disposition).toBe('no_action_needed');
  });

  test('gate on: spam, booked and complaint precedence stay as they are', () => {
    const base = { extraction: ext('job_applicant', 'no_action_needed'), thirdPartyNatureDefault: true };
    expect(decideDisposition({ ...base, spamVerdict: { verdict: 'spam' } }).disposition).toBe('spam_discarded');
    expect(decideDisposition({ ...base, outcome: { appointmentCreated: true } }).disposition).toBe('booked');
    expect(decideDisposition({
      ...base,
      extraction: { ...base.extraction, customer_history: { prior_complaint_mentioned: true } },
      outcome: { isKnownCustomer: true },
    }).disposition).toBe('complaint_escalated');
  });

  test('gate on: wrong_number nature still closes as wrong_number', () => {
    expect(decideDisposition({ extraction: ext('wrong_number', 'no_action_needed'), thirdPartyNatureDefault: true }).disposition).toBe('wrong_number_closed');
  });

  test('only the boolean true opts in', () => {
    expect(decideDisposition({ extraction: ext('job_applicant', 'no_action_needed'), thirdPartyNatureDefault: 'true' }).disposition).toBe('no_action_needed');
  });
});

describe('2. customer-only cards', () => {
  test('gate off: nothing is dropped', () => {
    expect(thirdPartyCustomerOnlyCards({ call_nature: 'job_applicant' })).toEqual([]);
    expect(thirdPartyCustomerOnlyCards({ call_nature: 'job_applicant' }, { gateOn: false })).toEqual([]);
  });

  test('gate on: applicant and vendor drop the address, name, email, consent and visit cards', () => {
    for (const nature of ['job_applicant', 'vendor_or_partner']) {
      const dropped = thirdPartyCustomerOnlyCards({ call_nature: nature }, { gateOn: true });
      // The live applicant shape: the model files service_intent 'quote_only' with no quote asked.
      const applicantShape = {
        call_nature: nature,
        scheduling: { status: 'none' },
        service_request: { service_intent: 'quote_only', quote_requested: false, quote_promised: false, price_discussed: false },
      };
      expect(thirdPartyCustomerOnlyCards(applicantShape, { gateOn: true })).toContain('missing_service_address');
      for (const code of [
        'missing_service_address', 'low_confidence_address', 'missing_unit_number',
        'email_unverified', 'email_invalid', 'missing_last_name', 'missing_first_name',
        'no_sms_consent_captured', 'sms_consent_missing', 'not_confirmed',
      ]) {
        expect(dropped).toContain(code);
      }
    }
  });

  test('gate on: an applicant or vendor call that asks for service keeps every card', () => {
    const asks = [
      { scheduling: { status: 'requested' } },
      { scheduling: { status: 'confirmed' } },
      { scheduling: { status: 'none' }, service_request: { service_intent: 'quote_only', quote_requested: true } },
      { scheduling: { status: 'none' }, service_request: { service_intent: 'quote_only', quote_promised: true } },
      { scheduling: { status: 'none' }, service_request: { service_intent: 'quote_only', price_discussed: true } },
      { scheduling: { status: 'none' }, service_request: { service_intent: 'new_service' } },
    ];
    for (const nature of ['job_applicant', 'vendor_or_partner']) {
      for (const shape of asks) {
        expect(thirdPartyCustomerOnlyCards({ call_nature: nature, ...shape }, { gateOn: true })).toEqual([]);
      }
    }
  });

  test('gate on: every other nature drops nothing', () => {
    for (const nature of ['new_lead', 'existing_customer_service', 'billing_question', 'voicemail_message', 'other', 'wrong_number', undefined]) {
      expect(thirdPartyCustomerOnlyCards({ call_nature: nature }, { gateOn: true })).toEqual([]);
    }
    expect(thirdPartyCustomerOnlyCards(null, { gateOn: true })).toEqual([]);
  });

  test('the office keeps the numbers it needs to reach the applicant back', () => {
    expect(THIRD_PARTY_CUSTOMER_ONLY_CARDS).not.toContain('callback_number_needed');
    expect(THIRD_PARTY_CUSTOMER_ONLY_CARDS).not.toContain('caller_phone_missing');
    expect(THIRD_PARTY_CUSTOMER_ONLY_CARDS).not.toContain('do_not_contact_requested');
  });

  test('the existing card trimmer is unchanged (no nature rule inside it)', () => {
    const out = dropUnneededCallCards(['missing_service_address', 'missing_last_name'], { call_nature: 'job_applicant', scheduling: { status: 'requested' } }, {});
    expect(out.dropped).not.toContain('missing_last_name');
  });
});

describe('3. promises', () => {
  const transcript = 'Agent: I will set up a time to meet you on Friday afternoon at our office, sound good? Caller: yes, I will bring my license.';
  const quote = 'I will set up a time to meet you on Friday afternoon at our office';
  const modelAnswer = JSON.stringify({
    commitments: [
      { party: 'waves', kind: 'schedule_visit', description: 'Meet the applicant at the office', channel: 'in_person', due_text: 'Friday afternoon', due_at: '2026-10-30T14:00:00-04:00', due_type: 'deadline', confidence: 0.9, evidence: [{ quote, speaker: 'agent' }] },
      { party: 'waves', kind: 'callback', description: 'Call back to confirm the meeting time', channel: 'call', due_text: null, due_at: null, confidence: 0.9, evidence: [{ quote: 'I will set up a time to meet you', speaker: 'agent' }] },
    ],
  });
  const setup = () => {
    const raw = jest.fn(async () => ({ rows: [{ id: 'row' }], rowCount: 1 }));
    const trx = Object.assign(jest.fn(() => ({ where: () => ({ forShare: () => ({ first: async () => ({ id: 'c' }) }) }) })), { raw });
    return {
      raw,
      conn: { transaction: async (fn) => fn(trx) },
      modelClient: { messages: { create: jest.fn(async () => ({ content: [{ type: 'text', text: modelAnswer }] })) } },
    };
  };
  const call = { id: 'c', created_at: '2026-10-29T15:00:00Z', transcript_structured: null };
  const inserted = (raw) => raw.mock.calls
    .filter(([sql]) => String(sql).includes('INSERT INTO call_commitments'))
    .map(([, b]) => ({ party: b[2], kind: b[3], description: b[4], dueAt: b[6], dueBasis: b[7], dueType: b[8] }));

  test('asThirdPartyPromise: a Waves row becomes kind other with no due time, the time moves into the words', () => {
    const out = asThirdPartyPromise({ party: 'waves', kind: 'schedule_visit', description: 'Meet him', due_at: '2026-10-30T14:00:00-04:00', due_basis: 'stated', due_type: 'deadline', due_text: 'Friday afternoon' });
    expect(out).toMatchObject({ party: 'waves', kind: 'other', due_at: null, due_basis: null, due_type: null, due_text: 'Friday afternoon' });
  });

  test('asThirdPartyPromise: with no spoken wording, the stated instant is written out in Eastern time', () => {
    const out = asThirdPartyPromise({ party: 'waves', kind: 'callback', description: 'Call him', due_at: '2026-10-30T18:00:00.000Z' });
    expect(out.kind).toBe('other');
    expect(out.due_at).toBeNull();
    expect(out.due_text).toMatch(/10\/30\/2026.*2:00:00 PM ET/);
  });

  test('asThirdPartyPromise: a customer-party row is returned untouched', () => {
    const item = { party: 'customer', kind: 'provide_info', description: 'Send a resume', due_at: null };
    expect(asThirdPartyPromise(item)).toBe(item);
  });

  test('the stored kind is not an SLA kind and not a prompt kind', () => {
    const { SLA_KINDS } = require('../services/followup-sla-watcher');
    expect(SLA_KINDS).not.toContain('other');
  });

  test('gate off (thirdPartyCall false): the staff promise is stored as schedule_visit with its due time, as before', async () => {
    const { raw, conn, modelClient } = setup();
    await recordCallCommitments({ conn, call, transcript, procToken: 'tok', modelClient });
    const rows = inserted(raw);
    expect(rows.find((r) => r.kind === 'schedule_visit')).toBeTruthy();
    expect(rows.find((r) => r.kind === 'callback')).toBeTruthy();
    expect(rows.find((r) => r.kind === 'schedule_visit').dueAt).toBeInstanceOf(Date);
  });

  test('gate on, applicant call: every Waves promise is stored as other, undated, wording kept', async () => {
    const { raw, conn, modelClient } = setup();
    await recordCallCommitments({ conn, call, transcript, procToken: 'tok', modelClient, thirdPartyCall: true });
    const rows = inserted(raw);
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.party).toBe('waves');
      expect(r.kind).toBe('other');
      expect(r.dueAt).toBeNull();
      expect(r.dueBasis).toBeNull();
    }
    expect(rows.some((r) => /Friday afternoon/.test(r.description))).toBe(true);
  });
});

describe('4. Careers row', () => {
  const extraction = (over = {}) => ({
    call_nature: 'job_applicant',
    meta: { call_summary: 'Caller asked about a technician job and wants to meet.' },
    caller: {
      first_name: 'pat', last_name: 'example', organization_name: 'Sample Pest Co', phone_e164: null, email: 'pat@example.com',
    },
    ...over,
  });
  const call = { id: 'call-1', direction: 'inbound', from_phone: '+19415550100', to_phone: '+19415550199' };

  // A fake knex: a table store, a transaction, advisory-lock raws.
  function fakeDb({ existing = [] } = {}) {
    const rows = existing.map((r, i) => ({ id: r.id || `app-${i}`, ...r }));
    const log = { raws: [], inserts: [], tables: [] };
    function table(name) {
      log.tables.push(name);
      if (name !== 'job_applications') throw new Error(`unexpected table ${name}`);
      const filters = [];
      const q = {
        whereIn(col, vals) { filters.push((r) => vals.includes(r[col])); return q; },
        whereRaw(sql, [val]) {
          if (sql.includes("source->>'call_log_id'")) filters.push((r) => r.source && r.source.call_log_id === val);
          else filters.push((r) => String(r.contact_snapshot?.phone || '').replace(/\D/g, '').slice(-10) === val);
          return q;
        },
        async first() { return rows.find((r) => filters.every((f) => f(r))) || undefined; },
        insert(row) {
          log.inserts.push(row);
          return {
            async returning() {
              const stored = {
                id: `new-${log.inserts.length}`, ...row,
                contact_snapshot: JSON.parse(row.contact_snapshot), source: JSON.parse(row.source),
              };
              rows.push(stored);
              return [{ id: stored.id }];
            },
          };
        },
      };
      return q;
    }
    const trx = Object.assign(table, { raw: async (sql, bindings) => { log.raws.push([sql, bindings]); return {}; } });
    const database = Object.assign(table, { transaction: async (fn) => fn(trx) });
    return { database, rows, log };
  }

  test('files ONE row: technician, status new, snapshot from the caller, source phone_call', async () => {
    const { database, log } = fakeDb();
    const out = await createJobApplicationFromCall({ call, extraction: extraction(), database });
    expect(out).toEqual({ created: true, id: 'new-1', reason: 'created' });
    expect(log.inserts).toHaveLength(1);
    const row = log.inserts[0];
    expect(row.role).toBe('technician');
    expect(row.status).toBe('new');
    expect(row.sms_consent).toBe(false);
    expect(JSON.parse(row.answers)).toEqual({});
    expect(JSON.parse(row.contact_snapshot)).toEqual({ name: 'Pat Example', phone: '+19415550100', email: 'pat@example.com', city: null });
    expect(JSON.parse(row.source)).toEqual({
      channel: 'phone_call', call_log_id: 'call-1', organization_name: 'Sample Pest Co',
      call_summary: 'Caller asked about a technician job and wants to meet.',
    });
  });

  test('never an interview or offer status, whatever the extraction says', async () => {
    const { database, log } = fakeDb();
    await createJobApplicationFromCall({
      call, extraction: extraction({ scheduling: { status: 'confirmed' }, status: 'interview' }), database,
    });
    expect(['new']).toContain(log.inserts[0].status);
    expect(log.inserts[0]).not.toHaveProperty('interview_at');
    expect(log.inserts[0]).not.toHaveProperty('interview_token');
  });

  test('a spoken callback number beats the ANI', async () => {
    const { database, log } = fakeDb();
    await createJobApplicationFromCall({ call, extraction: extraction({ caller: { name_full: 'Pat Example', phone_e164: '+19415550177' } }), database });
    expect(JSON.parse(log.inserts[0].contact_snapshot).phone).toBe('+19415550177');
  });

  test('an outbound call uses the number we dialed', async () => {
    const { database, log } = fakeDb();
    await createJobApplicationFromCall({ call: { ...call, direction: 'outbound', from_phone: '+19415550199', to_phone: '+19415550123' }, extraction: extraction(), database });
    expect(JSON.parse(log.inserts[0].contact_snapshot).phone).toBe('+19415550123');
  });

  test('idempotent by call: a reprocess files nothing, whatever became of the first row', async () => {
    const { database, log } = fakeDb({ existing: [{ id: 'app-old', status: 'rejected', source: { call_log_id: 'call-1' }, contact_snapshot: { phone: '+19415550100' } }] });
    const out = await createJobApplicationFromCall({ call, extraction: extraction(), database });
    expect(out).toEqual({ created: false, id: 'app-old', reason: 'already_filed_for_call' });
    expect(log.inserts).toHaveLength(0);
  });

  test('two passes in a row file one row', async () => {
    const { database, log } = fakeDb();
    await createJobApplicationFromCall({ call, extraction: extraction(), database });
    const second = await createJobApplicationFromCall({ call, extraction: extraction(), database });
    expect(second.created).toBe(false);
    expect(log.inserts).toHaveLength(1);
  });

  test('an open application with the same phone (last 10 digits) blocks a second row', async () => {
    for (const status of OPEN_STATUSES) {
      const { database, log } = fakeDb({ existing: [{ id: 'app-form', status, source: { page_url: '/careers' }, contact_snapshot: { phone: '(941) 555-0100' } }] });
      const out = await createJobApplicationFromCall({ call: { ...call, id: 'call-2' }, extraction: extraction(), database });
      expect(out).toEqual({ created: false, id: 'app-form', reason: 'open_application_same_phone' });
      expect(log.inserts).toHaveLength(0);
    }
  });

  test('a closed application on the same phone does not block a new one', async () => {
    for (const status of ['rejected', 'withdrawn', 'hired']) {
      const { database, log } = fakeDb({ existing: [{ id: 'app-closed', status, source: null, contact_snapshot: { phone: '+19415550100' } }] });
      const out = await createJobApplicationFromCall({ call: { ...call, id: 'call-3' }, extraction: extraction(), database });
      expect(out.created).toBe(true);
      expect(log.inserts).toHaveLength(1);
    }
  });

  test('takes a per-call and a per-phone lock before it reads', async () => {
    const { database, log } = fakeDb();
    await createJobApplicationFromCall({ call, extraction: extraction(), database });
    expect(log.raws.map(([, b]) => b[0])).toEqual(['job_application_call:call-1', 'job_application_phone:9415550100']);
  });

  test('skips quietly: not an applicant, no name, no phone', async () => {
    const { database, log } = fakeDb();
    expect((await createJobApplicationFromCall({ call, extraction: extraction({ call_nature: 'new_lead' }), database })).reason).toBe('not_job_applicant');
    expect((await createJobApplicationFromCall({ call, extraction: extraction({ caller: { phone_e164: '+19415550100' } }), database })).reason).toBe('no_name');
    expect((await createJobApplicationFromCall({ call: { id: 'c9', direction: 'inbound', from_phone: 'anonymous' }, extraction: extraction(), database })).reason).toBe('no_phone');
    expect((await createJobApplicationFromCall({ call: {}, extraction: extraction(), database })).reason).toBe('no_call');
    expect(log.inserts).toHaveLength(0);
  });

  test('a bad email is stored as null, never a reason to skip', async () => {
    const { database, log } = fakeDb();
    await createJobApplicationFromCall({ call, extraction: extraction({ caller: { first_name: 'Pat', last_name: 'Example', email: 'not-an-email' } }), database });
    expect(JSON.parse(log.inserts[0].contact_snapshot).email).toBeNull();
  });

  test('touches only the job_applications table', async () => {
    const { database, log } = fakeDb();
    await createJobApplicationFromCall({ call, extraction: extraction(), database });
    expect(new Set(log.tables)).toEqual(new Set(['job_applications']));
  });

  test('the writer sends nothing: no comms, invite or screen module is referenced by it', () => {
    const src = fs.readFileSync(require.resolve('../services/job-applications.js'), 'utf8');
    const start = src.indexOf('async function createJobApplicationFromCall');
    const body = src.slice(start, src.indexOf('module.exports', start));
    expect(body).not.toMatch(/sendStageComms|recruiting-comms|job-application-screen|screenJobApplication|interview_token|triggerNotification|sendSms|twilio|sendgrid/i);
  });
});

describe('5. processor wiring (the pure parts are covered above)', () => {
  const src = fs.readFileSync(require.resolve('../services/call-recording-processor.js'), 'utf8');
  test('the disposition caller passes the gate in as an argument', () => {
    expect(src).toContain('thirdPartyNatureDefault: callApplicantHandlingLive(),');
  });
  test('the three card sites strip the customer-only cards behind the gate', () => {
    expect(src.match(/thirdPartyCustomerOnlyCards\(/g).length).toBe(3); // enforce, shadow bridge, enforce-mode email branch
  });
  test('the commitments step passes thirdPartyCall from gate + nature + no service ask', () => {
    expect(src).toContain('thirdPartyCall: callApplicantHandlingLive() && thirdPartyCallNatureFromV2(v2Result)');
    expect(src).toContain("&& v2Result?.status === 'valid' && thirdPartyCallMakesNoServiceAsk(v2Result.extraction),");
  });
  test('a mixed-purpose applicant call (asks for service) keeps customer promises', () => {
    const { thirdPartyCallMakesNoServiceAsk } = require('../services/call-triage-flags');
    const applicantOnly = { call_nature: 'job_applicant', scheduling: { status: 'none' }, service_request: { service_intent: 'quote_only', quote_requested: false } };
    const applicantAsksQuote = { call_nature: 'job_applicant', scheduling: { status: 'none' }, service_request: { service_intent: 'quote_only', quote_requested: true } };
    const vendorBooks = { call_nature: 'vendor_or_partner', scheduling: { status: 'confirmed' }, service_request: { service_intent: 'quote_only' } };
    expect(thirdPartyCallMakesNoServiceAsk(applicantOnly)).toBe(true);
    expect(thirdPartyCallMakesNoServiceAsk(applicantAsksQuote)).toBe(false);
    expect(thirdPartyCallMakesNoServiceAsk(vendorBooks)).toBe(false);
  });
  test('the Careers step runs once, after the commitments step, in the main path', () => {
    expect(src.match(/await fileApplicantCareersRowStep\(/g).length).toBe(1);
  });

  describe('fileApplicantCareersRowStep', () => {
    const { fileApplicantCareersRowStep } = require('../services/call-recording-processor')._test;
    const applicant = { status: 'valid', extraction: { call_nature: 'job_applicant', caller: { name_full: 'Pat Example' } } };
    const saved = process.env.GATE_CALL_APPLICANT_HANDLING;
    afterEach(() => {
      if (saved === undefined) delete process.env.GATE_CALL_APPLICANT_HANDLING; else process.env.GATE_CALL_APPLICANT_HANDLING = saved;
    });
    test('gate off: does nothing at all', async () => {
      delete process.env.GATE_CALL_APPLICANT_HANDLING;
      expect(await fileApplicantCareersRowStep({ call: { id: 'x' }, callSid: 'CAx', extracted: {}, v2Result: applicant })).toBeNull();
    });
    test('gate on: spam, a non-valid extraction and a customer call file nothing', async () => {
      process.env.GATE_CALL_APPLICANT_HANDLING = 'true';
      expect(await fileApplicantCareersRowStep({ call: { id: 'x' }, callSid: 'CAx', extracted: { is_spam: true }, v2Result: applicant })).toBeNull();
      expect(await fileApplicantCareersRowStep({ call: { id: 'x' }, callSid: 'CAx', extracted: {}, v2Result: { ...applicant, status: 'schema_failed' } })).toBeNull();
      expect(await fileApplicantCareersRowStep({ call: { id: 'x' }, callSid: 'CAx', extracted: {}, v2Result: { status: 'valid', extraction: { call_nature: 'new_lead' } } })).toBeNull();
      expect(await fileApplicantCareersRowStep({ call: { id: 'x' }, callSid: 'CAx', extracted: {}, v2Result: null })).toBeNull();
    });
  });
});
