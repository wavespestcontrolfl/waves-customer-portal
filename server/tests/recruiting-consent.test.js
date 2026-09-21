/**
 * Consent validator — 'applicant' audience (recruiting comms). Mirrors the
 * 'lead' transactional_allowed exemption exactly: a job_applications row is
 * never a customers/notification_prefs row (job-applicant rule), so
 * checkConsentForPurpose must admit an applicant send carrying an explicit
 * transactional_allowed consentBasis, and block one that doesn't.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { resolvePolicy, MESSAGE_AUDIENCES, MESSAGE_PURPOSES } = require('../services/messaging/policy');
const { checkConsentForPurpose } = require('../services/messaging/validators/consent');

const applicantInput = (overrides = {}) => ({
  to: '+19415550142',
  body: 'x',
  channel: 'sms',
  audience: 'applicant',
  purpose: 'application_received',
  ...overrides,
});

describe('policy registration', () => {
  test('applicant is a registered audience; the three recruiting purposes are registered', () => {
    expect(MESSAGE_AUDIENCES).toContain('applicant');
    expect(MESSAGE_PURPOSES).toEqual(expect.arrayContaining([
      'application_received', 'interview_invite', 'interview_confirmation',
    ]));
  });

  test('every recruiting purpose resolves a transactional, phone-provided-unverified policy with no required ids', () => {
    for (const purpose of ['application_received', 'interview_invite', 'interview_confirmation']) {
      const policy = resolvePolicy('applicant', purpose);
      expect(policy).toMatchObject({
        requireConsent: 'transactional',
        minIdentityTrust: 'phone_provided_unverified',
        allowEmoji: false,
      });
      expect(policy.requireIds).toEqual([]);
    }
  });
});

describe('applicant + transactional_allowed consentBasis', () => {
  test('passes with no notification_prefs row at all (applicants have none)', async () => {
    const policy = resolvePolicy('applicant', 'application_received');
    const res = await checkConsentForPurpose(
      applicantInput({ consentBasis: { status: 'transactional_allowed', source: 'job_application' } }),
      policy,
      { prefs: null, customer: null, lookupFailed: false, suppressionLoaded: true },
    );
    expect(res).toEqual({ ok: true });
  });

  test('opted_in consentBasis also passes (same exemption as transactional_allowed)', async () => {
    const policy = resolvePolicy('applicant', 'interview_invite');
    const res = await checkConsentForPurpose(
      applicantInput({ purpose: 'interview_invite', consentBasis: { status: 'opted_in', source: 'job_application' } }),
      policy,
      { prefs: null, customer: null, lookupFailed: false, suppressionLoaded: true },
    );
    expect(res).toEqual({ ok: true });
  });
});

describe('applicant WITHOUT consentBasis', () => {
  test('blocks as NO_CONSENT_RECORD — the exemption requires the explicit basis', async () => {
    const policy = resolvePolicy('applicant', 'application_received');
    const res = await checkConsentForPurpose(
      applicantInput(),
      policy,
      { prefs: null, customer: null, lookupFailed: false, suppressionLoaded: true },
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe('NO_CONSENT_RECORD');
  });

  test('an opted_out consentBasis also blocks (not in the admitted status list)', async () => {
    const policy = resolvePolicy('applicant', 'interview_confirmation');
    const res = await checkConsentForPurpose(
      applicantInput({ purpose: 'interview_confirmation', consentBasis: { status: 'opted_out' } }),
      policy,
      { prefs: null, customer: null, lookupFailed: false, suppressionLoaded: true },
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe('NO_CONSENT_RECORD');
  });
});
