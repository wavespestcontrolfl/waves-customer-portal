// CI's DB-gated pass runs this against PostgreSQL. Fixture data lives in a
// unique schema dropped after the suite. Pins messaging/auto-text-holds.js —
// who never gets an automated first-touch text (owner rulings 2026-09-27) —
// against the real columns each rule reads, with a near miss beside every
// positive case so a rule can't pass by matching everything.
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  return proxy;
});

const { autoTextHoldReason, RECENT_CONVERSATION_MS } = require('../services/messaging/auto-text-holds');

const PHONE = '+19415550100';
const CALL_AT = new Date('2026-09-26T15:00:00Z');

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('auto-text holds on PostgreSQL', () => {
  let database;
  const schema = `auto_text_holds_${randomUUID().replaceAll('-', '')}`;
  const tables = ['leads', 'estimates', 'call_log', 'sms_log'];

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    for (const table of tables) await database.raw('CREATE TABLE ??.?? AS SELECT * FROM public.?? WITH NO DATA', [schema, table, table]);
    mockConn = database;
  });
  afterEach(async () => {
    for (const table of tables) await database.raw('TRUNCATE TABLE ??.?? CASCADE', [schema, table]);
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  const hold = (opts = {}) => autoTextHoldReason(PHONE, { callAt: CALL_AT, ...opts });
  const lead = (extra) => database('leads').insert({ id: randomUUID(), phone: '(941) 555-0100', status: 'new', ...extra });
  const estimate = async (extra) => { const id = randomUUID(); await database('estimates').insert({ id, status: 'draft', ...extra }); return id; };
  const priorCall = (extra) => database('call_log').insert({
    id: randomUUID(), direction: 'inbound', from_phone: PHONE, to_phone: '+19412975749',
    created_at: new Date(CALL_AT.getTime() - 24 * 60 * 60 * 1000), ...extra,
  });
  const text = (extra) => database('sms_log').insert({
    id: randomUUID(), direction: 'outbound', from_phone: '+19412975749', to_phone: PHONE,
    message_body: 'hi', twilio_sid: 'SM00000000000000000000000000000000', status: 'sent',
    message_type: 'manual', created_at: new Date(CALL_AT.getTime() - 60 * 60 * 1000), ...extra,
  });

  test('a clean number has no hold', async () => {
    expect(await hold()).toBeNull();
  });

  describe('quote_on_file', () => {
    test('an online quote-wizard lead carrying an estimate — they saw their price, sent or not (any phone format)', async () => {
      await lead({ lead_type: 'quote_wizard', estimate_id: await estimate({}) });
      expect(await hold()).toBe('quote_on_file');
    });

    test('a call lead whose linked estimate was sent to them', async () => {
      await lead({ lead_type: 'inbound_call', estimate_id: await estimate({ status: 'expired', sent_at: new Date() }) });
      expect(await hold()).toBe('quote_on_file');
    });

    test('an estimate sent to their number, even with no lead', async () => {
      await database('estimates').insert({ id: randomUUID(), customer_phone: '9415550100', status: 'viewed', sent_at: new Date() });
      expect(await hold()).toBe('quote_on_file');
    });

    test('an expired estimate that was viewed before it lapsed', async () => {
      await database('estimates').insert({ id: randomUUID(), customer_phone: PHONE, status: 'expired', viewed_at: new Date() });
      expect(await hold()).toBe('quote_on_file');
    });

    test('never: a staff draft that never went out, one that expired or failed unsent, or a deleted quote lead', async () => {
      await database('estimates').insert([
        { id: randomUUID(), customer_phone: PHONE, status: 'draft' },
        { id: randomUUID(), customer_phone: PHONE, status: 'expired' },
        { id: randomUUID(), customer_phone: PHONE, status: 'send_failed' },
      ]);
      await lead({ lead_type: 'quote_wizard', estimate_id: await estimate({}), deleted_at: new Date() });
      expect(await hold()).toBeNull();
    });

    test('never: a call lead linked to an estimator draft that was never sent (or has since expired unsent)', async () => {
      await lead({ lead_type: 'inbound_call', estimate_id: await estimate({ status: 'draft' }) });
      await lead({ lead_type: 'voicemail', estimate_id: await estimate({ status: 'expired' }) });
      expect(await hold()).toBeNull();
    });
  });

  describe('lead_assigned', () => {
    test('an open lead a staff member is working', async () => {
      await lead({ assigned_to: randomUUID(), status: 'contacted' });
      expect(await hold()).toBe('lead_assigned');
    });

    test('never: an unassigned lead, or an assigned one that is closed or converted', async () => {
      await lead({});
      await lead({ assigned_to: randomUUID(), status: 'lost' });
      await lead({ assigned_to: randomUUID(), status: 'new', converted_at: new Date() });
      expect(await hold()).toBeNull();
    });
  });

  describe('asked_not_to_be_contacted', () => {
    test('an earlier call where they asked not to be contacted', async () => {
      await priorCall({ ai_extraction_enriched: JSON.stringify({ consent: { do_not_contact_request: true } }) });
      expect(await hold()).toBe('asked_not_to_be_contacted');
    });

    test('an earlier call whose legacy extraction (V2 off or failed) carries the request', async () => {
      await priorCall({ ai_extraction: '{"is_lead": true, "do_not_contact_request": true}' });
      expect(await hold()).toBe('asked_not_to_be_contacted');
    });

    test('never: a call with no such request, in either shape', async () => {
      await priorCall({
        ai_extraction_enriched: JSON.stringify({ consent: { do_not_contact_request: false } }),
        ai_extraction: '{"do_not_contact_request": false}',
      });
      expect(await hold()).toBeNull();
    });
  });

  describe('said_no_texts', () => {
    test('an earlier call where they said no to texts', async () => {
      await priorCall({ v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ consent: { sms_declined: true } }) });
      expect(await hold()).toBe('said_no_texts');
    });

    test('the call setting the text off, read by its id', async () => {
      const id = randomUUID();
      await database('call_log').insert({
        id, direction: 'inbound', from_phone: '+19415559999', to_phone: '+19412975749', created_at: CALL_AT,
        v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ consent: { sms_declined: true } }),
      });
      expect(await hold({ originCallId: id })).toBe('said_no_texts');
    });

    test('a call from another line where they gave this number and said no to texts', async () => {
      await priorCall({
        from_phone: '+19415559999', v2_extraction_status: 'valid',
        ai_extraction_enriched: JSON.stringify({ caller: { phone_e164: PHONE }, consent: { sms_declined: true } }),
      });
      expect(await hold()).toBe('said_no_texts');
    });

    test('never: no decline, a call from before the field existed, or a schema-failed extraction', async () => {
      await priorCall({ v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ consent: { sms_declined: false } }) });
      await priorCall({ v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ consent: { sms_consent_given: false } }) });
      await priorCall({ v2_extraction_status: 'invalid', ai_extraction_enriched: JSON.stringify({ consent: { sms_declined: true } }) });
      expect(await hold()).toBeNull();
    });
  });

  describe('not_a_prospect', () => {
    test.each(['spam_solicitation', 'robocall', 'wrong_number', 'job_applicant'])(
      'a call with this number the V2 extraction called %s',
      async (nature) => {
        await priorCall({ v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ call_nature: nature }) });
        expect(await hold()).toBe('not_a_prospect');
      },
    );

    describe('vendor_or_partner (owner ruling 2026-09-28: holds only alongside a spam flag)', () => {
      test('never: a vendor/partner call V2 cleared of spam — a genuine property manager or referral partner', async () => {
        await priorCall({ v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ call_nature: 'vendor_or_partner' }) });
        expect(await hold()).toBeNull();
      });

      test('a vendor/partner call ALSO flagged spam (compat is_spam true) still holds', async () => {
        await priorCall({
          v2_extraction_status: 'valid',
          ai_extraction_enriched: JSON.stringify({ call_nature: 'vendor_or_partner' }),
          ai_extraction: '{"is_spam": true}',
        });
        expect(await hold()).toBe('not_a_prospect');
      });

      test('a vendor/partner call ALSO flagged spam (legacy call_type spam) still holds', async () => {
        await priorCall({
          v2_extraction_status: 'valid',
          ai_extraction_enriched: JSON.stringify({ call_nature: 'vendor_or_partner' }),
          ai_extraction: '{"call_type": "spam"}',
        });
        expect(await hold()).toBe('not_a_prospect');
      });

      test('never: V2 explicitly cleared it (spam_verdict) even though a shadow-era legacy label still says spam', async () => {
        await priorCall({
          v2_extraction_status: 'valid',
          ai_extraction_enriched: JSON.stringify({ call_nature: 'vendor_or_partner', spam_verdict: { is_spam_content: false } }),
          ai_extraction: '{"is_spam": true, "call_type": "spam"}',
        });
        expect(await hold()).toBeNull();
      });

      test('a V2 spam verdict that did NOT clear it leaves the legacy spam flag holding', async () => {
        await priorCall({
          v2_extraction_status: 'valid',
          ai_extraction_enriched: JSON.stringify({ call_nature: 'vendor_or_partner', spam_verdict: { is_spam_content: true } }),
          ai_extraction: '{"is_spam": true}',
        });
        expect(await hold()).toBe('not_a_prospect');
      });

      test('V2 judged the vendor/partner call spam: holds even with the legacy flag false (shadow-mode row)', async () => {
        await priorCall({
          v2_extraction_status: 'valid',
          ai_extraction_enriched: JSON.stringify({ call_nature: 'vendor_or_partner', spam_verdict: { is_spam_content: true } }),
          ai_extraction: '{"is_spam": false}',
        });
        expect(await hold()).toBe('not_a_prospect');
      });

      test('the V2 clear only exempts vendor/partner: a cleared customer-nature call with a legacy spam flag still holds', async () => {
        await priorCall({
          v2_extraction_status: 'valid',
          ai_extraction_enriched: JSON.stringify({ call_nature: 'new_customer_inquiry', spam_verdict: { is_spam_content: false } }),
          ai_extraction: '{"is_spam": true}',
        });
        expect(await hold()).toBe('not_a_prospect');
      });

      test('the call setting the text off is read by id here too', async () => {
        const id = randomUUID();
        await priorCall({
          id, from_phone: '+19415550188',
          v2_extraction_status: 'valid',
          ai_extraction_enriched: JSON.stringify({ call_nature: 'vendor_or_partner' }),
          ai_extraction: '{"is_spam": true}',
        });
        expect(await hold()).toBeNull(); // by number alone it is invisible
        expect(await hold({ originCallId: id })).toBe('not_a_prospect');
      });
    });

    test('never: a schema-failed V2 extraction\'s nature (it can persist a wrong call_nature)', async () => {
      await priorCall({ v2_extraction_status: 'schema_failed', ai_extraction_enriched: JSON.stringify({ call_nature: 'wrong_number' }) });
      expect(await hold()).toBeNull();
    });

    test('an earlier call the legacy extraction marked spam or wrong number (the text column)', async () => {
      await priorCall({ ai_extraction: '{"call_type": "wrong_number", "is_spam": false}' });
      expect(await hold()).toBe('not_a_prospect');
    });

    test('an outbound call of ours that reached a wrong number counts too', async () => {
      await priorCall({ direction: 'outbound', from_phone: '+19412975749', to_phone: PHONE, ai_extraction: '{"is_spam":true}' });
      expect(await hold()).toBe('not_a_prospect');
    });

    test('never: a new-lead call, or an unreadable legacy extraction', async () => {
      await priorCall({ v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ call_nature: 'new_lead' }), ai_extraction: '{"call_type":"new_inquiry","is_spam":false}' });
      await priorCall({ ai_extraction: 'not json at all' });
      expect(await hold()).toBeNull();
    });
  });

  describe('the call setting the text off is read by id — its text can go to a spoken callback number its row does not carry', () => {
    const fromCallerId = (extra) => priorCall({ from_phone: '+19415550188', ...extra });

    test('its do-not-contact request holds the text', async () => {
      const id = randomUUID();
      await fromCallerId({ id, ai_extraction_enriched: JSON.stringify({ consent: { do_not_contact_request: true } }) });
      expect(await hold()).toBeNull(); // by number alone it is invisible
      expect(await hold({ originCallId: id })).toBe('asked_not_to_be_contacted');
    });

    test('its valid V2 vendor or job-applicant nature holds it too', async () => {
      const id = randomUUID();
      await fromCallerId({ id, v2_extraction_status: 'valid', ai_extraction_enriched: JSON.stringify({ call_nature: 'job_applicant' }) });
      expect(await hold({ originCallId: id })).toBe('not_a_prospect');
    });
  });

  describe('recent_conversation', () => {
    test('a text either way that went through in the 7 days before the call', async () => {
      await text({ direction: 'inbound', from_phone: PHONE, to_phone: '+19412975749', twilio_sid: null, status: 'received' });
      expect(await hold()).toBe('recent_conversation');
    });

    test('never: a failed or undelivered text, an unresolved send reservation, the lane\'s own text, or one older than 7 days', async () => {
      await text({ status: 'failed' });
      await text({ status: 'undelivered' });
      await text({ status: 'sending', twilio_sid: null, metadata: JSON.stringify({ provider_handoff_reservation: true }) });
      await text({ message_type: 'voicemail_quote_link' });
      await text({ created_at: new Date(CALL_AT.getTime() - RECENT_CONVERSATION_MS - 60 * 1000) });
      expect(await hold({ excludeMessageTypes: ['voicemail_quote_link'] })).toBeNull();
    });

    test('a text after the call counts too — a deferred send replayed later still sees it', async () => {
      await text({ created_at: new Date(CALL_AT.getTime() + 60 * 60 * 1000) });
      expect(await hold()).toBe('recent_conversation');
    });
  });
});
