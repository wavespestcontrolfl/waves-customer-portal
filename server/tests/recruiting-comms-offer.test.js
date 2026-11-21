/**
 * recruiting-comms.js — the offer_sent stage (GATE_JOB_OFFERS): the owner-approved email words, the text template
 * key and variables, the purpose the messaging policy maps it to, and the gate (jobOffers alone governs this stage;
 * recruitingComms governs the others). And the offer_reminder stage (GATE_JOB_OFFER_REMINDER, with GATE_JOB_OFFERS):
 * the one reminder of an open offer, with the same link rules. Synthetic applicant only.
 */

const mockIsEnabled = jest.fn(() => true);
jest.mock('../config/feature-gates', () => ({ isEnabled: (...args) => mockIsEnabled(...args) }));
const mockRenderSmsTemplate = jest.fn(async () => 'rendered text');
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: (...args) => mockRenderSmsTemplate(...args) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/messaging/validators/suppression', () => ({ loadSuppressionState: jest.fn(async () => ({})) }));
jest.mock('../services/sendgrid-mail', () => ({ sendOne: jest.fn(), isDefiniteRejection: () => false }));
jest.mock('../services/email-template-library', () => ({ activeSuppressionFor: jest.fn(async () => null) }));
jest.mock('../services/twilio', () => ({ deriveOutboundNumber: jest.fn(async () => '+19415550199') }));
jest.mock('../models/db', () => jest.fn(() => { throw new Error('no database in this suite'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const RC = require('../services/recruiting-comms');
const { resolvePolicy } = require('../services/messaging/policy');

const app = { id: 'app-1', language: 'en', contact_snapshot: { name: 'Jordan Rivera', phone: '(941) 555-0100', email: 'jordan.rivera@example.test' } };
const LINK = `https://portal.wavespestcontrol.com/careers/offer/${'e'.repeat(64)}`;
const vars = { first_name: 'Jordan', offer_link: LINK, expires_on: 'Fri, Dec 18', job_title: 'Pest Control Technician', sender_name: 'Test Owner' };

beforeEach(() => { jest.clearAllMocks(); mockIsEnabled.mockReturnValue(true); });

describe('the offer email', () => {
  const email = RC.buildEmailContent(app, 'offer_sent', vars);

  test('is the owner-approved wording, signed with the sender', () => {
    expect(email.subject).toBe('Your job offer from Waves');
    expect(email.text).toBe([
      "Hi Jordan, I'd like you to join Waves as a Pest Control Technician.",
      'Your offer has your start date and pay. Please read it and the Technician Terms, then sign on your phone or computer.',
      "It stays open until Fri, Dec 18. Please don't give notice at your current job until you have signed it.",
      LINK,
      'Test Owner, owner',
    ].join('\n\n'));
    expect(email.buttonLabel).toBe('Read your offer');
  });

  test('has the heading, a real button to the link, and the sign-off in the html', () => {
    expect(email.html).toContain('>Your job offer</h2>');
    expect(email.html).toContain(`<a href="${LINK}"`);
    expect(email.html).toContain('>Read your offer</a>');
    expect(email.html).toContain('Test Owner, owner</p>');
  });

  test('makes no reply-time promise and never mentions a check, a test or the long company name', () => {
    const all = `${email.subject}\n${email.text}`;
    expect(all).not.toMatch(/within|business days|hours|reply|background|drug|Waves Pest Control/i);
  });

  test('escapes what the owner or applicant typed', () => {
    const hostile = RC.buildEmailContent({ ...app, contact_snapshot: { name: '<b>Jo</b> Rivera' } }, 'offer_sent', { ...vars, first_name: '<b>Jo</b>', sender_name: 'A & B' });
    expect(hostile.html).not.toContain('<b>Jo');
    expect(hostile.html).toContain('A &amp; B, owner');
  });
});

describe('the offer text', () => {
  test('uses the job_offer_sent template with the offer variables', async () => {
    expect(RC.STAGE_KEYS.offer_sent).toBe('job_offer_sent');
    const merged = { ...RC.buildVars(app, 'offer_sent'), ...vars };
    expect(merged.first_name).toBe('Jordan');
    expect(await RC.renderStageSmsBody(app, 'offer_sent', merged)).toEqual({ body: 'rendered text', templateKey: 'job_offer_sent' });
    expect(mockRenderSmsTemplate).toHaveBeenCalledWith('job_offer_sent', expect.objectContaining({ offer_link: LINK, expires_on: 'Fri, Dec 18' }), expect.objectContaining({ entity_type: 'job_application', entity_id: 'app-1' }));
  });

  test('is its own messaging purpose for the applicant audience, transactional, no emoji', () => {
    expect(RC.STAGE_PURPOSE.offer_sent).toBe('offer_sent');
    expect(resolvePolicy('applicant', 'offer_sent')).toMatchObject({ requireConsent: 'transactional', allowEmoji: false, minIdentityTrust: 'phone_provided_unverified' });
  });

  test('the seeded template stays inside the segment limit with the longest realistic values', () => {
    const { _TEMPLATES } = require('../models/migrations/20261119120000_job_offers');
    const body = _TEMPLATES[0].body
      .replace('{first_name}', 'Alexandria-Montgomery')
      .replace('{offer_link}', LINK)
      .replace('{expires_on}', 'Wed, Dec 30');
    expect(/^[\x20-\x7E]*$/.test(body)).toBe(true); // plain ASCII, so GSM-7
    expect(Math.ceil(body.length / 153)).toBeLessThanOrEqual(resolvePolicy('applicant', 'offer_sent').maxSegments);
  });
});

describe('an edited offer text that lost its link', () => {
  test('is skipped, never reported as sent', async () => {
    mockIsEnabled.mockImplementation((gate) => gate === 'jobOffers');
    mockRenderSmsTemplate.mockResolvedValue('Hi Jordan, your job offer is ready. Reply STOP to opt out.');
    const db = require('../models/db');
    db.mockImplementation(() => ({ where: () => ({ update: async () => 1 }) }));
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    const result = await RC.sendStageComms(app, 'offer_sent', { sms: true, email: false, by: 'staff-1', vars, stillEligible: async () => true });
    expect(result.sms).toBe('skipped');
    expect(require('../services/messaging/send-customer-message').sendCustomerMessage).not.toHaveBeenCalled();
  });
});

describe('the offer link survives the real SMS renderer and never stays in stored history', () => {
  const { stripSmsUrlScheme } = jest.requireActual('../services/messaging/sms-link-policy');
  const TOKEN_RE = /[0-9a-f]{64}/;
  function dbCapturingHistory() {
    const db = require('../models/db');
    db.mockImplementation(() => ({ where: () => ({ update: async () => 1 }) }));
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    return () => db.raw.mock.calls.map(([, bindings]) => (bindings || []).join('')).join('\n');
  }
  const { sendCustomerMessage } = require('../services/messaging/send-customer-message');

  test('a template body with https:// stripped (as getTemplate returns it) still sends the offer text', async () => {
    mockIsEnabled.mockImplementation((gate) => gate === 'jobOffers');
    // admin-sms-templates getTemplate ends with stripSmsUrlScheme(body): the rendered text carries the bare link.
    mockRenderSmsTemplate.mockImplementation(async (_key, v) => stripSmsUrlScheme(
      `Hi ${v.first_name}, it's Adam with Waves. Your job offer is ready to read and sign: ${v.offer_link} It stays open until ${v.expires_on}. Reply STOP to opt out.`,
    ));
    const stored = dbCapturingHistory();
    sendCustomerMessage.mockResolvedValueOnce({ sent: true });
    const result = await RC.sendStageComms(app, 'offer_sent', { sms: true, email: false, by: 'staff-1', vars, stillEligible: async () => true });
    expect(result.sms).not.toBe('skipped');
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0].body).toContain(LINK.replace('https://', ''));
    expect(stored()).toContain('/careers/offer/[link hidden]');
    expect(stored()).not.toMatch(TOKEN_RE);
  });

  test('an owner reply that pastes the link goes out whole but is stored with the link hidden', async () => {
    mockIsEnabled.mockReturnValue(true);
    const stored = dbCapturingHistory();
    sendCustomerMessage.mockResolvedValueOnce({ sent: true });
    await RC.sendStageComms(app, 'owner_reply', {
      sms: true, email: false, by: 'staff-1', smsBody: `Here is your offer again: ${LINK}`, stillEligible: async () => true,
    });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage.mock.calls[0][0].body).toContain(LINK);
    expect(stored()).toContain('/careers/offer/[link hidden]');
    expect(stored()).not.toMatch(TOKEN_RE);
  });
});

describe('the reminder email', () => {
  const email = RC.buildEmailContent(app, 'offer_reminder', vars);

  test('is the owner-approved wording, signed with the sender: the offer email with its own subject and first paragraph', () => {
    const offer = RC.buildEmailContent(app, 'offer_sent', vars);
    expect(email.text.split('\n\n').slice(1)).toEqual(offer.text.split('\n\n').slice(1));
    expect(email.subject).toBe('Your job offer is still open');
    expect(email.text).toBe([
      'Hi Jordan, your job offer from Waves is still open until Fri, Dec 18.',
      'Your offer has your start date and pay. Please read it and the Technician Terms, then sign on your phone or computer.',
      "It stays open until Fri, Dec 18. Please don't give notice at your current job until you have signed it.",
      LINK,
      'Test Owner, owner',
    ].join('\n\n'));
    expect(email.buttonLabel).toBe('Read your offer');
  });

  test('has the heading, a real button to the link, and the sign-off in the html', () => {
    expect(email.html).toContain('>Your job offer</h2>');
    expect(email.html).toContain(`<a href="${LINK}"`);
    expect(email.html).toContain('>Read your offer</a>');
    expect(email.html).toContain('Test Owner, owner</p>');
  });

  test('makes no reply-time promise and never mentions a check, a test or the long company name', () => {
    const all = `${email.subject}\n${email.text}`;
    expect(all).not.toMatch(/within|business days|hours|reply|background|drug|Waves Pest Control/i);
  });

  test('escapes what the owner or applicant typed', () => {
    const hostile = RC.buildEmailContent(app, 'offer_reminder', { ...vars, first_name: '<b>Jo</b>', sender_name: 'A & B' });
    expect(hostile.html).not.toContain('<b>Jo');
    expect(hostile.html).toContain('A &amp; B, owner');
  });
});

describe('the reminder text', () => {
  const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
  const reminderBody = (v) => `Hi ${v.first_name}, it's Adam with Waves. Your job offer is still open until ${v.expires_on}: ${v.offer_link} Reply STOP to opt out.`;
  function dbWithHistory() {
    const db = require('../models/db');
    db.mockImplementation(() => ({ where: () => ({ update: async () => 1 }) }));
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    return () => db.raw.mock.calls.map(([, bindings]) => (bindings || []).join('')).join('\n');
  }

  test('uses the job_offer_reminder template with the offer variables', async () => {
    expect(RC.STAGE_KEYS.offer_reminder).toBe('job_offer_reminder');
    mockRenderSmsTemplate.mockResolvedValue('rendered text'); // an earlier case left its own renderer in place
    const merged = { ...RC.buildVars(app, 'offer_reminder'), ...vars };
    expect(merged.first_name).toBe('Jordan');
    expect(await RC.renderStageSmsBody(app, 'offer_reminder', merged)).toEqual({ body: 'rendered text', templateKey: 'job_offer_reminder' });
    expect(mockRenderSmsTemplate).toHaveBeenCalledWith('job_offer_reminder', expect.objectContaining({ offer_link: LINK, expires_on: 'Fri, Dec 18' }), expect.objectContaining({ entity_type: 'job_application', entity_id: 'app-1' }));
  });

  test('is its own messaging purpose for the applicant audience, with the rules of the offer text', () => {
    expect(RC.STAGE_PURPOSE.offer_reminder).toBe('offer_reminder');
    expect(resolvePolicy('applicant', 'offer_reminder')).toEqual(resolvePolicy('applicant', 'offer_sent'));
  });

  test('the seeded template stays inside the segment limit with the longest realistic values', () => {
    const { _TEMPLATE } = require('../models/migrations/20261121100000_job_offer_reminder');
    const body = _TEMPLATE.body
      .replace('{first_name}', 'Alexandria-Montgomery')
      .replace('{offer_link}', LINK)
      .replace('{expires_on}', 'Wed, Dec 30');
    expect(body).not.toMatch(/[{}]/); // every variable the template names is one the pass gives
    expect(/^[\x20-\x7E]*$/.test(body)).toBe(true); // plain ASCII, so GSM-7
    expect(Math.ceil(body.length / 153)).toBeLessThanOrEqual(resolvePolicy('applicant', 'offer_reminder').maxSegments);
  });

  test('goes out as a system text of its own type, with the real link, and is stored with the link hidden', async () => {
    mockRenderSmsTemplate.mockImplementation(async (_key, v) => reminderBody(v));
    const stored = dbWithHistory();
    sendCustomerMessage.mockResolvedValueOnce({ sent: true });
    const result = await RC.sendStageComms(app, 'offer_reminder', { sms: true, email: false, by: 'system', vars, stillEligible: async () => true });
    expect(result.sms).toBe('sent');
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    const input = sendCustomerMessage.mock.calls[0][0];
    expect(input).toMatchObject({ audience: 'applicant', purpose: 'offer_reminder', body: reminderBody(vars) });
    expect(input.metadata).toMatchObject({ original_message_type: 'job_offer_reminder', job_application_id: 'app-1' });
    // No person pressed it: no staff attribution, and no exemption from the 8 AM to 8 PM send window.
    expect(input.metadata).not.toHaveProperty('adminUserId');
    expect(input).not.toHaveProperty('operatorInitiated');
    expect(stored()).toContain('/careers/offer/[link hidden]');
    expect(stored()).not.toMatch(/[0-9a-f]{64}/);
  });

  test('a reminder text the rail holds is not queued for later; the offer text still is', async () => {
    mockRenderSmsTemplate.mockImplementation(async (_key, v) => reminderBody(v));
    dbWithHistory();
    const db = require('../models/db');
    // The queue write is the sender's only transaction in this suite (the locked handoff runs inside the mocked pipeline).
    db.transaction = jest.fn(async () => { throw new Error('the queue write is not under test'); });
    const held = { sent: false, blocked: true, deliveryOutcome: 'not_sent', retryable: true, nextAllowedAt: new Date(Date.now() + 3600000).toISOString(), code: 'QUIET_HOURS_HOLD' };
    const send = (stage) => {
      sendCustomerMessage.mockResolvedValueOnce(held);
      return RC.sendStageComms(app, stage, { sms: true, email: false, by: 'system', vars, stillEligible: async () => true });
    };
    // Nothing replays it, so the reminder text is lost: a failure, not a hold.
    expect((await send('offer_reminder')).sms).toBe('failed');
    expect(db.transaction).not.toHaveBeenCalled();
    // The same hold on the offer text goes to the queue (the write fails here, so the outcome stays 'blocked').
    await send('offer_sent');
    expect(db.transaction).toHaveBeenCalledTimes(1);
    delete db.transaction;
  });

  test('a reminder text that did not go is a failure unless the rail refused it because of the applicant; the offer text keeps its outcome', async () => {
    mockRenderSmsTemplate.mockImplementation(async (_key, v) => reminderBody(v));
    dbWithHistory();
    const held = (code) => ({ sent: false, blocked: true, deliveryOutcome: 'not_sent', code });
    const send = (stage, code) => {
      sendCustomerMessage.mockResolvedValueOnce(held(code));
      return RC.sendStageComms(app, stage, { sms: true, email: false, by: 'system', vars, stillEligible: async () => true });
    };
    // Nothing tries the reminder again, so a reason on our side must not read as an ordinary hold: a store that
    // could not be read, a rule this text broke, a code this list does not know.
    for (const code of ['CONSENT_LOOKUP_FAILED', 'SUPPRESSION_LOOKUP_FAILED', 'CONTRACT_VIOLATION', 'IDENTITY_TRUST_TOO_LOW', 'A_CODE_ADDED_LATER', undefined]) {
      expect((await send('offer_reminder', code)).sms).toBe('failed');
    }
    // The applicant's own state: nothing to fix.
    for (const code of ['SMS_OPTED_OUT', 'PURPOSE_OPTED_OUT', 'SUPPRESSED_OPT_OUT', 'SUPPRESSED_MANUAL_DNC', 'SUPPRESSED_NON_MOBILE', 'NON_MOBILE_SMS_RECIPIENT', 'NO_CONSENT_RECORD', 'CONTACT_DECLINED']) {
      expect((await send('offer_reminder', code)).sms).toBe('blocked');
    }
    // The caller's own check stopped it inside the locked handoff.
    expect((await send('offer_reminder', 'RECRUITING_STALE')).sms).toBe('stale');
    // The offer text has a person who presses Send again: its outcome is unchanged.
    expect((await send('offer_sent', 'CONSENT_LOOKUP_FAILED')).sms).toBe('blocked');
  });

  test('a reminder text with no template body is a failure; the offer text is skipped as before', async () => {
    // The renderer answers empty for a template that is off and for one it could not read.
    mockRenderSmsTemplate.mockResolvedValue(null);
    dbWithHistory();
    const send = (stage) => RC.sendStageComms(app, stage, { sms: true, email: false, by: 'system', vars, stillEligible: async () => true });
    expect((await send('offer_reminder')).sms).toBe('failed');
    expect((await send('offer_sent')).sms).toBe('skipped');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('the check before a provider gets its channel, so the text can stop while the email goes', async () => {
    mockRenderSmsTemplate.mockImplementation(async (_key, v) => reminderBody(v));
    dbWithHistory();
    const stillEligible = jest.fn(async (_conn, channel) => channel !== 'sms');
    const result = await RC.sendStageComms(app, 'offer_reminder', { sms: true, email: false, by: 'system', vars, stillEligible });
    expect(result.sms).toBe('stale');
    expect(stillEligible).toHaveBeenCalledWith(undefined, 'sms');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    // The same check, asked for the email, answers for the email.
    stillEligible.mockClear();
    stillEligible.mockResolvedValue(false);
    expect((await RC.sendStageComms(app, 'offer_reminder', { sms: false, email: true, by: 'system', vars, stillEligible })).email).toBe('stale');
    expect(stillEligible).toHaveBeenCalledWith(undefined, 'email');
  });

  test('an edited reminder text that lost its link is not sent and is a failure, never reported as sent', async () => {
    mockRenderSmsTemplate.mockResolvedValue('Hi Jordan, your job offer is still open. Reply STOP to opt out.');
    dbWithHistory();
    const result = await RC.sendStageComms(app, 'offer_reminder', { sms: true, email: false, by: 'system', vars, stillEligible: async () => true });
    expect(result.sms).toBe('failed');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
});

describe('the gate', () => {
  const opts = { sms: true, email: true, stillEligible: async () => false, vars };

  test('the reminder stage needs GATE_JOB_OFFER_REMINDER and GATE_JOB_OFFERS, and never answers to recruitingComms', async () => {
    const withGates = (on) => { mockIsEnabled.mockImplementation((gate) => on.includes(gate)); return RC.sendStageComms(app, 'offer_reminder', opts); };
    expect(await withGates(['jobOffers', 'recruitingComms'])).toEqual({ sms: 'disabled', email: 'disabled' });
    expect(await withGates(['jobOfferReminder', 'recruitingComms'])).toEqual({ sms: 'disabled', email: 'disabled' });
    // Both on: the stage runs (a stale recheck sends nothing).
    expect(await withGates(['jobOffers', 'jobOfferReminder'])).toEqual({ sms: 'stale', email: 'stale' });
  });

  test('the offer stage is disabled by jobOffers alone, even with recruitingComms on', async () => {
    mockIsEnabled.mockImplementation((gate) => gate === 'recruitingComms');
    expect(await RC.sendStageComms(app, 'offer_sent', opts)).toEqual({ sms: 'disabled', email: 'disabled' });
  });

  test('the offer stage runs with jobOffers on and recruitingComms off (a stale recheck sends nothing)', async () => {
    mockIsEnabled.mockImplementation((gate) => gate === 'jobOffers');
    expect(await RC.sendStageComms(app, 'offer_sent', opts)).toEqual({ sms: 'stale', email: 'stale' });
  });

  test('every other stage still answers to recruitingComms', async () => {
    mockIsEnabled.mockImplementation((gate) => gate === 'jobOffers');
    expect(await RC.sendStageComms(app, 'interview_invite', opts)).toEqual({ sms: 'disabled', email: 'disabled' });
  });
});
