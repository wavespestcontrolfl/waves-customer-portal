/**
 * The caller's word for the phone-yes cards (call-phone-yes-word.js) through PostgreSQL: which calls still owe a read
 * (recent and not final, bounded in time), the customer's latest word since the send, and what
 * stands between it and the booking call. Runs inside a rolled-back transaction. Synthetic names and numbers only.
 * Skips without DATABASE_URL.
 */
const SKIP = !process.env.DATABASE_URL;

jest.setTimeout(120000);
let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = (...args) => mockConn.transaction(...args);
  Object.defineProperty(proxy, 'fn', { get: () => mockConn.fn });
  Object.defineProperty(proxy, 'schema', { get: () => mockConn.schema });
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('crypto');
const {
  owedReadSql, latestBillingChoice, unreadCallSince, laterWordProblem, callerWord,
} = require('../services/call-phone-yes-word');

const describeDb = SKIP ? describe.skip : describe;
const DAY = 86400000;
const WORDS = "Let's do the quarterly plan, just bill me each time you come out.";
const RECORDED = { recording_url: 'https://example.test/recording.mp3', recording_duration_seconds: 60 };
// The V2 extraction: the caller's plan choice with its evidence quote (the caller's own sentence).
const extractionWith = (choice, intent = null) => ({
  meta: { call_summary: 'Caller asked about the quarterly plan.' },
  service_request: { primary_service_category: 'pest_general', ...(choice ? { billing_choice: choice } : {}), ...(intent ? { service_intent: intent } : {}) },
  scheduling: { status: 'confirmed' },
  evidence: choice ? [
    { field_path: '/service_request/billing_choice', quote: 'You can bill each time.', speaker: 'agent', transcript_offset_ms: 900 },
    { field_path: '/service_request/billing_choice', quote: WORDS, speaker: 'caller', transcript_offset_ms: 1200 },
  ] : [],
});
// The same extraction from someone the call reader names (a tenant, by default), with no model flag.
const thirdParty = (choice, intent = null, caller = {}) => JSON.stringify({
  ...extractionWith(choice, intent), caller: { relationship_to_property: 'tenant', on_site_authorization: false, ...caller },
});
// A labeled two-speaker transcript: the caller says WORDS on a call that names the plan.
const transcriptWith = (choice) => (choice
  ? `Agent: Thanks for calling Waves, how can I help?\nCaller: ${WORDS}\nAgent: You can bill each time. You are all set.`
  : 'Agent: Thanks for calling Waves, how can I help?\nCaller: I need someone out for the bugs.\nAgent: You are all set.');

describeDb("the caller's word (PostgreSQL)", () => {
  let database; let trx;

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });
  afterAll(async () => { await database.destroy(); });
  beforeEach(async () => {
    trx = await database.transaction();
    mockConn = trx;
  });
  afterEach(async () => { await trx.rollback(); });

  let seq = 0;
  const hoursAgo = (h) => new Date(Date.now() - h * 3600000);
  async function customer() {
    const id = randomUUID();
    seq += 1;
    await trx('customers').insert({
      id, first_name: 'Pat', last_name: 'Sampleton', phone: `+1941555${String(5000 + seq)}`, email: `qa-${id.slice(0, 8)}@example.test`, active: true,
    });
    return id;
  }
  async function call(customerId, choice, over = {}, intent = null) {
    const id = randomUUID();
    await trx('call_log').insert({
      id, customer_id: customerId, twilio_call_sid: `CA${id.replace(/-/g, '')}`, from_phone: '+19415550101', answered_by: 'human',
      processing_status: 'processed', v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify(extractionWith(choice, intent)),
      transcription: transcriptWith(choice), direction: 'inbound', ...over,
    });
    return id;
  }
  const since = () => new Date(Date.now() - 2 * DAY);
  const rowOf = (id) => trx('call_log').where({ id }).first(require('../services/call-phone-yes-word').CALL_COLUMNS);

  test('owed: a recent call not in a final state, or one a pass holds now; never a row no pass will finish', async () => {
    const customerId = await customer();
    const recent = hoursAgo(1);
    const old = hoursAgo(3);
    const cases = [
      // [state, owed]
      [{ processing_status: null, created_at: recent }, true],
      [{ processing_status: 'pending', created_at: recent }, true],
      [{ processing_status: 'processing', created_at: recent }, true],
      [{ processing_status: 'no_transcription', extraction_attempts: 1, created_at: recent }, true],
      [{ processing_status: 'extraction_failed', extraction_attempts: 2, created_at: recent }, true],
      [{ processing_status: 'processed', created_at: recent }, false],
      [{ processing_status: 'processed', transcription_status: 'pending', transcription: null, created_at: recent }, false],
      [{ processing_status: 'voicemail', created_at: recent }, false],
      [{ processing_status: 'spam', created_at: recent }, false],
      [{ processing_status: 'no_transcription', extraction_attempts: 3, created_at: recent }, false],
      [{ processing_status: 'extraction_failed', extraction_attempts: 3, created_at: recent }, false],
      // Past the bound: a row no pass finished never holds a card back.
      [{ processing_status: null, created_at: old, updated_at: old }, false],
      [{ processing_status: 'extraction_failed', extraction_attempts: 1, created_at: old, updated_at: old }, false],
      [{ processing_status: 'processing', created_at: old, updated_at: old }, false],
      // An old call a pass holds now (a re-read of replaced audio) is owed, and so is one whose replaced audio is
      // still waiting for a claim (the recording webhook set the status back to NULL and bumped updated_at).
      [{ processing_status: 'processing', created_at: old, updated_at: recent }, true],
      [{ processing_status: null, created_at: old, updated_at: recent }, true],
      // A long pass writes only its heartbeat (every minute): a recent beat keeps the call owed; a beat that stopped
      // long ago (a dead claim) does not.
      [{ processing_status: 'processing', created_at: old, updated_at: old, processing_heartbeat_at: recent }, true],
      [{ processing_status: 'processing', created_at: old, updated_at: old, processing_heartbeat_at: old }, false],
      // A failed read past the processor's 7-day retry window is final, even with a recent row change.
      [{ processing_status: 'extraction_failed', extraction_attempts: 1, created_at: new Date(Date.now() - 8 * DAY), updated_at: recent }, false],
      // A final row is never owed, however recently it changed.
      [{ processing_status: 'processed', created_at: old, updated_at: recent }, false],
    ];
    const ids = [];
    for (const [state] of cases) ids.push(await call(customerId, null, state));
    const owed = new Set(await trx('call_log').whereIn('id', ids).whereRaw(owedReadSql('call_log')).pluck('id'));
    const read = new Set(await trx('call_log').whereIn('id', ids).whereRaw(`NOT ${owedReadSql('call_log')}`).pluck('id'));
    expect(cases.map(([state], n) => [state, owed.has(ids[n])])).toEqual(cases);
    expect(owed.size + read.size).toBe(cases.length);
  });

  test('a call being read holds the customer back; a read one does not', async () => {
    const customerId = await customer();
    const callId = await call(customerId, null, { processing_status: 'processing' });
    await expect(unreadCallSince(trx, { customerId, since: since() })).resolves.toBe(true);
    await trx('call_log').where({ id: callId }).update({ processing_status: 'processed' });
    await expect(unreadCallSince(trx, { customerId, since: since() })).resolves.toBe(false);
  });

  test('an owed call before the window, or a sandbox call, does not count', async () => {
    const { VOICE_RELAY_SANDBOX_SOURCE } = require('../services/voice-agent/relay-protocol');
    const customerId = await customer();
    await call(customerId, null, { processing_status: 'processing', created_at: new Date(Date.now() - 3 * DAY) });
    await call(customerId, null, { processing_status: 'processing', source: VOICE_RELAY_SANDBOX_SOURCE });
    await expect(unreadCallSince(trx, { customerId, since: since() })).resolves.toBe(false);
  });

  // Intake links a call by the primary phone only; the processor links a service-contact number after its read.
  // Each customer: a service-contact number, a secondary number filed in another format, a number abroad, and a Waves
  // number in a slot.
  const OURS = () => require('../config/twilio-numbers').mainLine.number;
  async function customerWithNumbers() {
    const customerId = await customer();
    const numbers = { contact: `+1941555${6000 + seq}`, secondary: `+1941555${7000 + seq}` };
    await trx('customers').where({ id: customerId }).update({
      service_contact_phone: numbers.contact, secondary_phone: `(941) 555-${7000 + seq}`, service_contact3_phone: OURS(),
      service_contact2_phone: '+44 20 7946 0958',
    });
    return { customerId, ...numbers };
  }

  test.each([
    ['from their service-contact number', (n) => ({ from_phone: n.contact }), true],
    ['from their secondary number, filed in another format', (n) => ({ from_phone: n.secondary }), true],
    ['from their number abroad (all its digits)', () => ({ from_phone: '+442079460958' }), true],
    ['from a number abroad that only ends like theirs', () => ({ from_phone: '+4412079460958' }), false],
    ['from a number abroad that ends like their US number', (n) => ({ from_phone: `+44${n.contact.slice(2)}` }), false],
    ['an outbound call to their secondary number', (n) => ({ direction: 'Outbound-API', from_phone: OURS(), to_phone: n.secondary }), true],
    ['from a number not on their record', () => ({ from_phone: '+19415550199' }), false],
    ['an outbound call whose number called is not theirs', (n) => ({ direction: 'outbound-dial', from_phone: n.contact, to_phone: '+19415550199' }), false],
    ['from the Waves number in their slot (a forwarding leg)', () => ({ from_phone: OURS() }), false],
    ['from their number but linked to another customer', (n) => ({ from_phone: n.contact, customer_id: n.otherId }), false],
    // A deliberate unlink stays one (the relink job's rule).
    ['from their number, but an operator unlinked it', (n) => ({
      from_phone: n.contact, metadata: JSON.stringify({ customer_link_override: { customer_id: null } }),
    }), false],
  ])('a call not linked to the customer, being read: %s', async (_name, over, counts) => {
    const otherId = await customer();
    const n = await customerWithNumbers();
    await call(null, null, { processing_status: 'processing', ...over({ ...n, otherId }) });
    await expect(unreadCallSince(trx, { customerId: n.customerId, since: since() })).resolves.toBe(counts);
  });

  test('a word is read from linked calls only: a yes on an unlinked call from their number is no yes', async () => {
    const n = await customerWithNumbers();
    await call(null, 'per_application', { from_phone: n.contact });
    await expect(callerWord(trx, { customerId: n.customerId, since: since() })).resolves.toEqual({ yes: null, noYes: 'no_yes_heard' });
  });

  test("a yes: the caller's pay-per-application choice with their own sentence", async () => {
    const customerId = await customer();
    const yesCallId = await call(customerId, 'per_application', { created_at: hoursAgo(5) });
    await expect(callerWord(trx, { customerId, since: since() })).resolves.toEqual({
      yes: { callLogId: yesCallId, at: expect.any(Date), quote: WORDS }, noYes: null,
    });
  });

  test.each([
    ['no call names a choice', [[null, {}]], { yes: null, noYes: 'no_yes_heard' }],
    ['the newest word is annual prepay', [['per_application', { created_at: hoursAgo(5) }], ['annual_prepay', { created_at: hoursAgo(2) }]], { skip: 'chose_annual_prepay' }],
    ['a later call asked to cancel', [['per_application', { created_at: hoursAgo(5) }], [null, { created_at: hoursAgo(2) }, 'cancellation_request']], { skip: 'took_back' }],
    ['the yes call also asked for a one-time visit', [['per_application', { created_at: hoursAgo(5) }, 'preventative_one_time']], { skip: 'took_back' }],
    ["a later call carries the call reader's cancel flag, whatever its intent", [['per_application', { created_at: hoursAgo(5) }], [null, {
      created_at: hoursAgo(2), ai_extraction_enriched: JSON.stringify({ ...extractionWith(null, 'follow_up_existing_service'), triage_flags: ['cancellation_request'] }),
    }]], { skip: 'took_back' }],
    ['the yes call itself carries the cancel flag', [['per_application', {
      created_at: hoursAgo(5), ai_extraction_enriched: JSON.stringify({ ...extractionWith('per_application'), triage_flags: ['cancellation_request'] }),
    }]], { skip: 'took_back' }],
    ['the choice came before the send', [['per_application', { created_at: new Date(Date.now() - 3 * DAY) }]], { yes: null, noYes: 'no_yes_heard' }],
    ['the choice call is a voicemail', [['per_application', { answered_by: 'voicemail' }]], { yes: null, noYes: 'no_yes_heard' }],
    ['the choice call is still being read', [['per_application', { processing_status: 'processing' }]], { yes: null, noYes: 'no_yes_heard' }],
    ['the last read of the choice call failed (it keeps the old extraction)', [['per_application', {
      processing_status: 'extraction_failed', extraction_attempts: 3, ...RECORDED,
    }]], { yes: null, noYes: 'no_yes_heard' }],
    ["the transcript does not hold the caller's words", [['per_application', { transcription: transcriptWith(null) }]], { yes: null, noYes: 'yes_without_words' }],
    // A call with no recording keeps its live text, which can cut a turn with no mark: never the caller's words.
    ['the words are only in the live-text backup', [['per_application', { transcription_provider: 'twilio_realtime' }]], { yes: null, noYes: 'yes_without_words' }],
    // Only the account holder's side speaks for the account; anyone else's word still hides an older yes.
    ['the caller on the yes call is a tenant', [['per_application', { ai_extraction_enriched: thirdParty('per_application') }]],
      { yes: null, noYes: 'caller_not_account_holder' }],
    ['a tenant allowed on site is still not the account holder', [['per_application', {
      ai_extraction_enriched: thirdParty('per_application', null, { on_site_authorization: true }),
    }]], { yes: null, noYes: 'caller_not_account_holder' }],
    // Booking lets a relative with a confirmed time book (owner 2026-09-28); agreeing to a price is not booking.
    ['a relative with a confirmed time is not the account holder for a price', [['per_application', {
      ai_extraction_enriched: thirdParty('per_application', null, { relationship_to_property: 'family_member' }),
    }]], { yes: null, noYes: 'caller_not_account_holder' }],
    ['someone else after a yes', [['per_application', { created_at: hoursAgo(5) }], ['per_application', {
      created_at: hoursAgo(2), ai_extraction_enriched: thirdParty('per_application'),
    }]], { yes: null, noYes: 'caller_not_account_holder' }],
    ["someone else's cancel closes nothing", [['per_application', { created_at: hoursAgo(5) }], [null, {
      created_at: hoursAgo(2), ai_extraction_enriched: thirdParty(null, 'cancellation_request'),
    }]], { yes: null, noYes: 'caller_not_account_holder' }],
    ["someone else's call with no word is no word", [['per_application', { created_at: hoursAgo(5) }], [null, {
      created_at: hoursAgo(2), ai_extraction_enriched: thirdParty(null),
    }]], { yes: { callLogId: expect.any(String), at: expect.any(Date), quote: WORDS }, noYes: null }],
    ['a spouse speaks for the account', [['per_application', {
      ai_extraction_enriched: thirdParty('per_application', null, { relationship_to_property: 'spouse_partner' }),
    }]], { yes: { callLogId: expect.any(String), at: expect.any(Date), quote: WORDS }, noYes: null }],
    // The model's flag with no third party named is unsupported (the processor drops it too): the yes stands.
    ['a model flag with no third party named', [['per_application', {
      ai_extraction_enriched: JSON.stringify({ ...extractionWith('per_application'), triage_flags: ['caller_not_authorized'] }),
    }]], { yes: { callLogId: expect.any(String), at: expect.any(Date), quote: WORDS }, noYes: null }],
  ])('%s', async (_name, calls, expected) => {
    const customerId = await customer();
    for (const [choice, over, intent] of calls) await call(customerId, choice, over, intent);
    await expect(callerWord(trx, { customerId, since: since() })).resolves.toEqual(expected);
  });

  test('a row written after the call counts from when the call began: a call that began before the send is no yes', async () => {
    const at = since();
    // A recording recovery inserts the row after hangup; the 10-minute call began 9 minutes before the send.
    const recovered = { created_at: new Date(at.getTime() + 60000), duration_seconds: 600, metadata: JSON.stringify({ source: 'twilio_recording_status_recovered' }) };
    const customerId = await customer();
    await call(customerId, 'per_application', recovered);
    await expect(callerWord(trx, { customerId, since: at })).resolves.toEqual({ yes: null, noYes: 'no_yes_heard' });
    // The same row written when the call began is after the send: a yes, timed at its start.
    const other = await customer();
    const yesCallId = await call(other, 'per_application', { ...recovered, metadata: JSON.stringify({ source: 'voice_webhook' }) });
    await expect(callerWord(trx, { customerId: other, since: at })).resolves.toEqual({
      yes: { callLogId: yesCallId, at: recovered.created_at, quote: WORDS }, noYes: null,
    });
  });

  test("a condition in the caller's turn stays in front of the office: the yes carries the whole turn", async () => {
    const customerId = await customer();
    const yesCallId = await call(customerId, 'per_application', {
      created_at: hoursAgo(5), transcription: `Agent: Thanks for calling Waves.\nCaller: If the price is $49.99, ${WORDS}\nAgent: Okay.`,
    });
    await expect(callerWord(trx, { customerId, since: since() })).resolves.toEqual({
      yes: { callLogId: yesCallId, at: expect.any(Date), quote: `If the price is $49.99, ${WORDS}` }, noYes: null,
    });
  });

  test('a yes on a sandbox call is not heard', async () => {
    const { VOICE_RELAY_SANDBOX_SOURCE } = require('../services/voice-agent/relay-protocol');
    const customerId = await customer();
    await call(customerId, 'per_application', { source: VOICE_RELAY_SANDBOX_SOURCE });
    await expect(latestBillingChoice(trx, { customerId, since: since() })).resolves.toBeNull();
  });

  test.each([
    ['calls with no word', null, {}],
    ['voicemails that name a choice', 'per_application', { answered_by: 'voicemail' }],
  ])('the latest word is found past fifty-five %s', async (_name, choice, over) => {
    const customerId = await customer();
    await call(customerId, 'per_application', { created_at: hoursAgo(5) });
    await call(customerId, null, { created_at: hoursAgo(4) }, 'cancellation_request');
    for (let n = 0; n < 55; n += 1) await call(customerId, choice, { created_at: new Date(Date.now() - 3 * 3600000 + n * 1000), ...over });
    await expect(callerWord(trx, { customerId, since: since() })).resolves.toEqual({ skip: 'took_back' });
  });

  test('each page starts after the last row read: calls with one start time, to the microsecond, are never skipped', async () => {
    const customerId = await customer();
    await call(customerId, 'per_application', { created_at: hoursAgo(5) });
    // One start time for all (now() is fixed inside the transaction), with microseconds a JS Date would drop.
    const at = trx.raw("now() - interval '3 hours'");
    for (let n = 0; n < 120; n += 1) await call(customerId, 'per_application', { created_at: at, answered_by: 'voicemail' });
    // The lowest id sorts last among the ties: the third page.
    await call(customerId, null, { id: '00000000-0000-4000-8000-000000000000', created_at: at }, 'cancellation_request');
    await expect(callerWord(trx, { customerId, since: since() })).resolves.toEqual({ skip: 'took_back' });
  });

  test("an outbound call with swapped labels hears the customer's words", async () => {
    const customerId = await customer();
    const callId = await call(customerId, 'per_application', {
      direction: 'outbound-api',
      transcription: `Caller: Hi, this is Sam with Waves, calling about your quote.\nAgent: ${WORDS}\nCaller: Will do.`,
    });
    await expect(latestBillingChoice(trx, { customerId, since: since() }))
      .resolves.toMatchObject({ choice: 'per_application', callLogId: callId, quote: WORDS });
  });

  test("the voice agent's own text is never evidence; a call it handed to staff is read in its recorded part", async () => {
    const heardOn = async (over) => {
      const customerId = await customer();
      await call(customerId, 'per_application', over);
      return (await latestBillingChoice(trx, { customerId, since: since() })).quote;
    };
    const aiPart = `[AI segment]\nAgent: Thanks for calling Waves.\nCaller: ${WORDS}\n[tool] lookup_customer {"found":true}`;
    // The agent's own text: it can clip a turn without a mark.
    await expect(heardOn({ transcription_provider: 'conversation_relay', transcription: `Agent: Thanks for calling Waves.\nCaller: ${WORDS}\nAgent: Okay.` })).resolves.toBeNull();
    await expect(heardOn({ transcription_provider: 'conversation_relay', transcription: aiPart })).resolves.toBeNull();
    // Handed to staff: the recorded part is read, and only it.
    await expect(heardOn({ transcription: `${aiPart}\n\n[Staff segment]\nAgent: This is Sam.\nCaller: Yes. ${WORDS}` })).resolves.toBe(`Yes. ${WORDS}`);
    await expect(heardOn({ transcription: `${aiPart}\n\n[Staff segment]\nAgent: This is Sam.\nCaller: Thanks.` })).resolves.toBeNull();
  });

  test('a direction in any case is read the processor\'s way: an outbound call with no staff introduction grounds nothing', async () => {
    const transcription = `Agent: Hello?\nCaller: ${WORDS}\nAgent: Okay.`;
    for (const [direction, quote] of [['Outbound-API', null], ['outbound-dial', null], ['inbound', WORDS]]) {
      const customerId = await customer();
      await call(customerId, 'per_application', { direction, transcription });
      await expect(latestBillingChoice(trx, { customerId, since: since() })).resolves.toMatchObject({ choice: 'per_application', quote });
    }
  });

  test.each([
    ['the yes came after the booking call', { yesHoursAgo: 1, bookingHoursAgo: 2 }, 'yes_after_booking'],
    ['the booking call could not be read', { bookingOver: { v2_extraction_status: 'failed' } }, 'booking_call_unread'],
    ["the booking call's last read failed (it keeps the old extraction)", {
      bookingOver: { processing_status: 'extraction_failed', extraction_attempts: 3, ...RECORDED },
    }, 'booking_call_unread'],
    ['the customer called again after the yes', { laterHoursAgo: 1 }, 'newer_call'],
    ['nothing came between', {}, null],
  ])('between the word and the booking: %s', async (_name, setup, expected) => {
    const { yesHoursAgo = 5, bookingHoursAgo = 2, bookingOver = {}, laterHoursAgo = null } = setup;
    const customerId = await customer();
    const yesCallId = await call(customerId, 'per_application', { created_at: hoursAgo(yesHoursAgo) });
    const bookingCallId = await call(customerId, null, { created_at: hoursAgo(bookingHoursAgo), ...bookingOver });
    if (laterHoursAgo != null) await call(customerId, null, { created_at: hoursAgo(laterHoursAgo) });
    const yes = { callLogId: yesCallId, at: hoursAgo(yesHoursAgo) };
    await expect(laterWordProblem(trx, { customerId, yes, booking: await rowOf(bookingCallId) })).resolves.toBe(expected);
  });

  test('with no yes, a call after the booking is a newer call; one before it is not', async () => {
    const customerId = await customer();
    await call(customerId, null, { created_at: hoursAgo(5) });
    const bookingCallId = await call(customerId, null, { created_at: hoursAgo(2) });
    await expect(laterWordProblem(trx, { customerId, yes: null, booking: await rowOf(bookingCallId) })).resolves.toBeNull();
    await call(customerId, null, { created_at: hoursAgo(1) });
    await expect(laterWordProblem(trx, { customerId, yes: null, booking: await rowOf(bookingCallId) })).resolves.toBe('newer_call');
  });

  test("a later call from the customer's other number, linked to no one, is a newer call", async () => {
    const n = await customerWithNumbers();
    const yesCallId = await call(n.customerId, 'per_application', { created_at: hoursAgo(5) });
    const bookingCallId = await call(n.customerId, null, { created_at: hoursAgo(2) });
    const yes = { callLogId: yesCallId, at: hoursAgo(5) };
    await call(null, null, { created_at: hoursAgo(1), from_phone: '+19415550199' });
    // An empty voicemail the processor rejected and unlinked on purpose stays unlinked.
    const { TRANSCRIPTION_REJECTED_SENTINEL } = require('../services/call-log-relink');
    await call(null, null, { created_at: hoursAgo(1), from_phone: n.contact, transcription: TRANSCRIPTION_REJECTED_SENTINEL });
    await expect(laterWordProblem(trx, { customerId: n.customerId, yes, booking: await rowOf(bookingCallId) })).resolves.toBeNull();
    await call(null, null, { created_at: hoursAgo(1), from_phone: n.contact });
    await expect(laterWordProblem(trx, { customerId: n.customerId, yes, booking: await rowOf(bookingCallId) })).resolves.toBe('newer_call');
  });
});
