/**
 * recruiting-comms.js — the offer_sent stage (GATE_JOB_OFFERS): the owner-approved email words, the text template
 * key and variables, the purpose the messaging policy maps it to, and the gate (jobOffers alone governs this stage;
 * recruitingComms governs the others). Synthetic applicant only.
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

describe('the gate', () => {
  const opts = { sms: true, email: true, stillEligible: async () => false, vars };

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
