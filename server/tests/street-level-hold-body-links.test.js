// Owner ruling 2026-10-01: NO customer text or email about a live unconfirmed street-level
// address hold until the office confirms. Enforced at the shared send step (sendCustomerMessage,
// every visit-scoped customer SMS) and at the appointment email sender. Synthetic data only.
// A tiny fake database for the body-link resolver: scheduled_services rows keyed by their token columns,
// appointment_card_requests, short_codes. Every call is counted so "no links, no queries" is assertable.
const mockTables = { scheduled_services: [], appointment_card_requests: [], short_codes: [] };
jest.mock('../models/db', () => {
  const fake = jest.fn((table) => {
    fake.queries.push(table);
    const filters = [];
    const q = {
      where(arg) {
        if (typeof arg === 'function') arg(q); else filters.push(['eq', arg]);
        return q;
      },
      orWhereIn(col, vals) { filters.push(['in', col, vals]); return q; },
      whereIn(col, vals) { filters.push(['in', col, vals]); return q; },
      select() { return Promise.resolve(q._rows()); },
      first() { return Promise.resolve(q._rows()[0]); },
      _rows() {
        return mockTables[table].filter((row) => filters.length === 0 || filters.some((f) => (
          f[0] === 'in' ? f[2].includes(row[f[1]]) : Object.entries(f[1]).every(([k, v]) => row[k] === v)
        ))).filter((row) => filters.filter((f) => f[0] === 'eq').every((f) => Object.entries(f[1]).every(([k, v]) => row[k] === v)));
      },
    };
    return q;
  });
  fake.queries = [];
  return fake;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, isEnabled: jest.fn(() => false) };
});
jest.mock('../services/messaging/validators/consent', () => ({
  loadContactState: jest.fn(async () => ({})),
  checkConsentForPurpose: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/validators/suppression', () => ({
  loadSuppressionState: jest.fn(async (_input, contactState) => contactState),
  checkSuppression: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/validators/line-type', () => ({
  checkLineType: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/validators/identity', () => ({
  validateRequiredIds: jest.fn(() => ({ ok: true })),
  validateIdentityTrust: jest.fn(() => ({ ok: true })),
  resolveTrustLevel: jest.fn(() => 'phone_matches_customer'),
}));
jest.mock('../services/messaging/validators/voice', () => ({
  validateNoCustomerEmoji: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/compliance-contact-checks', () => ({
  checkContactCompliance: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/audit', () => ({
  persistAudit: jest.fn(async () => ({ id: 'audit-1' })),
}));
jest.mock('../services/messaging/providers/twilio-sms', () => ({
  sendViaTwilio: jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM-real' })),
  mapPurposeToMessageType: jest.fn(() => 'manual'),
}));
jest.mock('../services/estimate-annual-guard', () => ({
  annualHandoffGuard: jest.fn(() => async () => ({ blocked: false, reason: null, estimateId: null })),
  rewriteWithheldEstimateLinks: jest.fn(async ({ text }) => ({ html: undefined, text, rewrittenIds: [] })),
  withheldLinkPolicyForSmsPurpose: jest.fn(() => 'refuse'),
}));
jest.mock('../services/disclaimed-number-holds', () => ({
  disclaimedNumberBlocksSend: jest.fn(async () => false),
}));
jest.mock('../services/street-level-hold', () => ({
  ...jest.requireActual('../services/street-level-hold'),
  isStreetLevelHoldVisit: jest.fn(async () => false),
}));


const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { persistAudit } = require('../services/messaging/audit');
const { sendViaTwilio } = require('../services/messaging/providers/twilio-sms');
const { isStreetLevelHoldVisit } = require('../services/street-level-hold');
const { visitsLinkedInBody } = require('../services/composer-customer-links');
const { publicPortalUrl } = require('../utils/portal-url');

// A visit whose several bearer tokens are all distinct 22-character strings.
const tok = (c) => c.repeat(22);
const PORTAL = publicPortalUrl().replace(/\/$/, '');
const HELD = { id: 'visit-held', status: 'confirmed', reschedule_token: tok('a'), track_view_token: tok('b'), prep_token: tok('c') };
const ENDED = { id: 'visit-ended', status: 'cancelled', reschedule_token: tok('d'), track_view_token: tok('e'), prep_token: tok('f') };
const CLEAR = { id: 'visit-clear', status: 'confirmed', reschedule_token: tok('g'), track_view_token: tok('h'), prep_token: tok('i') };

beforeEach(() => {
  jest.clearAllMocks();
  db.queries.length = 0;
  mockTables.scheduled_services = [HELD, ENDED, CLEAR];
  mockTables.appointment_card_requests = [{ token: tok('j'), kind: 'visit', scheduled_service_id: 'visit-held' }];
  mockTables.short_codes = [];
  sendViaTwilio.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM-real' });
  persistAudit.mockResolvedValue({ id: 'audit-1' });
  isStreetLevelHoldVisit.mockImplementation(async (id) => id === 'visit-held');
});

// A pasted / restored / old-tab text: NO linkedVisitIds or any visit metadata, and a lead audience.
const send = (body, extra = {}) => sendCustomerMessage({
  to: '+19415550142', channel: 'sms', audience: 'lead', purpose: 'conversational', identityTrustLevel: 'phone_provided_unverified', body, ...extra,
});

describe('Waves visit links in the body are resolved server-side and the hold applies (no client metadata)', () => {
  const shapes = {
    'reschedule link': `Move your visit here: ${PORTAL}/reschedule/${HELD.reschedule_token}`,
    'appointment page link': `Your visit: ${PORTAL}/appointment/${HELD.reschedule_token}`,
    'tracking link': `Track your tech: ${PORTAL}/track/${HELD.track_view_token}`,
    'prep link': `Prep checklist: ${PORTAL}/prep/${HELD.prep_token}`,
    'card request link': `Add a card: ${PORTAL}/secure/${tok('j')}`,
    'scheme-less, upper-cased host, trailing slash': `Move it: ${PORTAL.replace(/^https:\/\//, '').toUpperCase()}/reschedule/${HELD.reschedule_token}/`,
    'plain http (an upgraded edge opens the same page)': `Move it: ${PORTAL.replace(/^https:/, 'http:')}/reschedule/${HELD.reschedule_token}`,
  };
  for (const [label, body] of Object.entries(shapes)) {
    test(`${label}: an immediate send is held, a scheduled replay too`, async () => {
      for (const entryPoint of ['admin_communications_manual_sms', 'scheduled_sms_cron']) {
        const result = await send(body, { entryPoint, metadata: { humanAuthored: true } });
        expect(result).toMatchObject({ sent: false, blocked: true, code: 'STREET_LEVEL_HOLD', retryable: true });
      }
      expect(sendViaTwilio).not.toHaveBeenCalled();
      expect(persistAudit).toHaveBeenCalledWith(expect.objectContaining({ validatorsFailed: ['street_level_hold'] }));
    });
  }

  test('the /l/<code> short forms (reschedule and tracking wrappers expand to their targets; the appointment short row carries its token)', async () => {
    mockTables.short_codes = [
      { code: 'resch12345', kind: 'reschedule', target_url: `${PORTAL}/reschedule/${HELD.reschedule_token}`, expires_at: null },
      { code: 'track12345', kind: 'other', target_url: `${PORTAL}/track/${HELD.track_view_token}`, expires_at: null },
      { code: 'appt123456', kind: 'appointment', target_url: `${PORTAL}/appointment/${HELD.reschedule_token}`, expires_at: null },
    ];
    for (const code of ['resch12345', 'track12345', 'appt123456']) {
      const result = await send(`Link: ${PORTAL}/l/${code}`);
      expect(result).toMatchObject({ sent: false, code: 'STREET_LEVEL_HOLD' });
    }
  });

  test('explicit metadata ids still apply on top of the body (appointmentId, scheduled_service_id, linked ids)', async () => {
    expect(await send('Hello', { appointmentId: 'visit-held' })).toMatchObject({ code: 'STREET_LEVEL_HOLD' });
    expect(await send('Hello', { metadata: { linked_scheduled_service_ids: ['visit-held'] } })).toMatchObject({ code: 'STREET_LEVEL_HOLD' });
  });

  test('a link to a visit that is NOT held, an estimate link, a foreign-host look-alike and an unknown token are unaffected', async () => {
    for (const body of [
      `Move it: ${PORTAL}/reschedule/${CLEAR.reschedule_token}`,
      `Your estimate: ${PORTAL}/estimate/${tok('z')}`,
      `See https://evil.example/reschedule/${HELD.reschedule_token}`,
      `Move it: ${PORTAL}/reschedule/${tok('y')}`,
    ]) {
      expect((await send(body)).sent).toBe(true);
    }
  });

  test('a body with no links reads nothing from the visit tables', async () => {
    expect((await send('Thanks, see you Tuesday.')).sent).toBe(true);
    expect(db.queries).toEqual([]);
    // Likewise an owned link that is no visit link at all.
    await send(`Your estimate: ${PORTAL}/estimate/${tok('z')}`);
    expect(db.queries).toEqual([]);
  });

  test('the resolver reports every visit and flags the ones reached through a /reschedule/ link', async () => {
    const linked = await visitsLinkedInBody(`${PORTAL}/reschedule/${CLEAR.reschedule_token} and ${PORTAL}/track/${ENDED.track_view_token}`);
    expect(linked).toEqual(expect.arrayContaining([
      { id: 'visit-clear', status: 'confirmed', rescheduleLink: true },
      { id: 'visit-ended', status: 'cancelled', rescheduleLink: false },
    ]));
    expect(linked).toHaveLength(2);
  });

  test('a lookup error fails closed: the send is held (retryable), never sent', async () => {
    db.mockImplementationOnce(() => { throw new Error('db down'); });
    const result = await send(`Move it: ${PORTAL}/reschedule/${CLEAR.reschedule_token}`);
    expect(result).toMatchObject({ sent: false, blocked: true, code: 'STREET_LEVEL_HOLD', retryable: true });
  });

  test('the office-confirm hook\'s own card request is still released', async () => {
    const result = await sendCustomerMessage({
      to: '+19415550142', channel: 'sms', audience: 'customer', customerId: 'cust-1', purpose: 'card_request',
      body: `Add a card: ${PORTAL}/secure/${tok('j')}`, metadata: { scheduled_service_id: 'visit-held', trigger: 'outbound_review_confirm' },
    });
    expect(result.sent).toBe(true);
  });
});

describe('a scheduled operator text whose reschedule link points at a visit that ended is blocked terminally', () => {
  const body = `Move your visit here: ${PORTAL}/reschedule/${ENDED.reschedule_token}`;
  const replay = (extra = {}) => send(body, { entryPoint: 'scheduled_sms_cron', metadata: { humanAuthored: true }, ...extra });

  test('cancelled visit: LINKED_VISIT_ENDED, not retryable, audited, never sent', async () => {
    const result = await replay();
    expect(result).toMatchObject({ sent: false, blocked: true, code: 'LINKED_VISIT_ENDED' });
    expect(result.retryable).toBeUndefined();
    expect(result.reason).toMatch(/no longer reschedulable/);
    expect(sendViaTwilio).not.toHaveBeenCalled();
    expect(persistAudit).toHaveBeenCalledWith(expect.objectContaining({ validatorsFailed: ['linked_visit_ended'] }));
  });

  test('every status the /reschedule page refuses ends it; the ones it serves (pending, confirmed, rescheduled) do not', async () => {
    for (const [status, ended] of [['skipped', true], ['completed', true], ['on_site', true], ['pending', false], ['confirmed', false], ['rescheduled', false]]) {
      mockTables.scheduled_services = [{ ...ENDED, status }];
      const r = await replay();
      expect(r.code === 'LINKED_VISIT_ENDED').toBe(ended);
    }
  });

  test('immediate operator sends and automated replays keep their prior behavior; a non-reschedule link to the visit does not end it', async () => {
    expect((await send(body, { entryPoint: 'admin_communications_manual_sms', metadata: { humanAuthored: true } })).sent).toBe(true);
    expect((await send(body, { entryPoint: 'scheduled_sms_cron' })).sent).toBe(true);
    expect((await replay({ })).code).toBe('LINKED_VISIT_ENDED');
    expect((await send(`Track: ${PORTAL}/track/${ENDED.track_view_token}`, { entryPoint: 'scheduled_sms_cron', metadata: { humanAuthored: true } })).sent).toBe(true);
  });
});
