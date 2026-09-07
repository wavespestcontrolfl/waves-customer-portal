/**
 * Booking-recovery SMS fits ONE segment (owner, 2026-09-07 — multi-segment
 * texts have failed to deliver). The stock body (what the 2026-08-01 sweep
 * wrote) is rendered the way the SMS renderer renders it (portal link scheme
 * stripped) with a real 10-character short code, every service label, the
 * longest names firstNameOf admits, and accented names — one GSM-7 segment
 * every time. A name that still spills the budget is replaced by the generic
 * greeting; nothing else about the body is touched.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async () => 'https://portal.wavespestcontrol.com/l/k3j9m7p2xq') }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
jest.mock('../services/experimentation/growthbook', () => ({ assignBookingRecoveryExperiment: jest.fn() }));
jest.mock('../services/feature-flags', () => ({ isEnabled: jest.fn(() => false) }));

const { countSegments } = require('../services/messaging/segment-counter');
const { stripPortalUrlScheme } = require('../routes/admin-sms-templates');
const smsTemplates = require('../routes/admin-sms-templates');
const { _internals } = require('../services/booking-abandon-recovery');

// The stock body: what 20260801000001_sms_house_voice_sweep wrote for
// booking_abandonment_recovery (an /admin edit since would differ — the guard
// below covers whatever renders).
const STOCK_BODY = "Hello {first_name}! Your {service_type} spot isn't reserved yet. Pick a time and you're set: {booking_url}\n\nReply STOP to opt out.";

beforeEach(() => {
  // Render exactly as getTemplate does for the stock row: substitute, strip the portal scheme.
  smsTemplates.getTemplate = jest.fn(async (key, vars) => {
    let body = STOCK_BODY;
    for (const [k, v] of Object.entries(vars)) body = body.replace(new RegExp(`\\{${k}\\}`, 'g'), () => v);
    return stripPortalUrlScheme(body).replace(/\n{3,}/g, '\n\n').trim();
  });
});

const intent = (over = {}) => ({ id: 'bi_1', first_name: 'Christopher', service_id: 'pest_control', ...over });

describe('booking recovery SMS — one segment', () => {
  const ALL_SERVICES = [...Object.keys(_internals.SERVICE_LABELS), 'unknown_service'];

  test('every service label with an 11-character name keeps the name → one GSM-7 segment, scheme-less link', async () => {
    for (const service_id of ALL_SERVICES) {
      const body = await _internals.renderOneSegmentSms(intent({ service_id, first_name: 'Christopher Lee' }));
      const c = countSegments(body);
      expect({ service_id, encoding: c.encoding, segments: c.segmentCount, named: body.startsWith('Hello Christopher!') }).toEqual({ service_id, encoding: 'GSM_7', segments: 1, named: true });
      expect(body).not.toContain('https://');
      expect(body).toContain('portal.wavespestcontrol.com/l/k3j9m7p2xq');
    }
  });

  test('a longer name stays one segment for every label — kept where it fits, generic greeting where it does not', async () => {
    const outcomes = {};
    for (const service_id of ALL_SERVICES) {
      const body = await _internals.renderOneSegmentSms(intent({ service_id, first_name: 'Mary-Catherine' }));
      expect(countSegments(body)).toMatchObject({ encoding: 'GSM_7', segmentCount: 1 });
      outcomes[service_id] = body.startsWith('Hello Mary-Catherine!') ? 'named' : body.startsWith('Hello there!') ? 'generic' : 'other';
    }
    expect(outcomes.pest_control).toBe('named');
    expect(Object.values(outcomes)).not.toContain('other');
  });

  test('an accented name is folded to GSM-7 instead of flipping the whole text to UCS-2', async () => {
    // é is inside the GSM-7 alphabet; ë is not — one such character would turn the whole text UCS-2.
    const body = await _internals.renderOneSegmentSms(intent({ first_name: 'Zoë' }));
    expect(body).toMatch(/^Hello Zoe!/);
    expect(countSegments(body)).toMatchObject({ encoding: 'GSM_7', segmentCount: 1 });
  });

  test('a name that still spills the budget is replaced by the generic greeting, nothing else changes', async () => {
    const forty = 'Wolfeschlegelsteinhausenbergerdorffvonhal'; // 41 → firstNameOf caps at 40
    const body = await _internals.renderOneSegmentSms(intent({ first_name: forty, service_id: 'bora_care' }));
    expect(body).toMatch(/^Hello there! Your Bora-Care spot/);
    expect(countSegments(body).segmentCount).toBe(1);
    expect(smsTemplates.getTemplate).toHaveBeenCalledTimes(2);
  });

  test('a missing template still short-circuits (no claim), and a body that cannot be brought under one segment is sent as rendered', async () => {
    smsTemplates.getTemplate = jest.fn(async () => null);
    expect(await _internals.renderOneSegmentSms(intent())).toBeNull();
    const logger = require('../services/logger');
    smsTemplates.getTemplate = jest.fn(async () => 'x'.repeat(200));
    expect(await _internals.renderOneSegmentSms(intent())).toBe('x'.repeat(200));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/renders as 2 segments/));
  });
});
