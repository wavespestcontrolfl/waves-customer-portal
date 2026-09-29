jest.mock('../models/db', () => jest.fn());
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const db = require('../models/db');
const { livePayloadForRun, exitReasonFor } = require('../services/email-template-automation-executor');
const { etDateString, addETDays } = require('../utils/datetime-et');

function mockTables(rows) {
  db.mockImplementation((table) => {
    const q = {
      where: jest.fn(() => q),
      first: jest.fn(async () => rows[table]),
    };
    return q;
  });
}

describe('livePayloadForRun — scheduled_service refresh', () => {
  beforeEach(() => jest.clearAllMocks());

  test('refreshes service_date and property_address at send time', async () => {
    mockTables({
      scheduled_services: {
        id: 'svc-1',
        status: 'confirmed',
        service_type: 'Cockroach Treatment',
        scheduled_date: '2026-08-01',
        customer_id: 'cust-1',
      },
      customers: {
        id: 'cust-1',
        address_line1: '9 Corrected St',
        city: 'Venice',
        zip: '34285',
      },
    });

    const live = await livePayloadForRun({ entity_type: 'scheduled_service', entity_id: 'svc-1' });

    expect(live.service_status).toBe('confirmed');
    expect(live.service_type).toBe('Cockroach Treatment');
    expect(live.service_date).toBe('August 1, 2026');
    expect(live.service_date_ymd).toBe('2026-08-01');
    expect(live.property_address).toBe('9 Corrected St, Venice, 34285');
  });

  test('DATE column returned as a UTC-midnight Date keeps the ET calendar day', async () => {
    mockTables({
      scheduled_services: {
        id: 'svc-1',
        scheduled_date: new Date('2026-08-01T00:00:00Z'),
        customer_id: null,
      },
    });

    const live = await livePayloadForRun({ entity_type: 'scheduled_service', entity_id: 'svc-1' });

    expect(live.service_date).toBe('August 1, 2026');
  });

  test('leaves stored values alone when live fields are missing', async () => {
    mockTables({
      scheduled_services: {
        id: 'svc-1',
        status: 'scheduled',
        scheduled_date: null,
        customer_id: 'cust-1',
      },
      customers: undefined,
    });

    const live = await livePayloadForRun({ entity_type: 'scheduled_service', entity_id: 'svc-1' });

    expect(live).not.toHaveProperty('service_date');
    expect(live).not.toHaveProperty('property_address');
  });
});

describe('livePayloadForRun — review revalidation (review.linked_5star)', () => {
  beforeEach(() => jest.clearAllMocks());

  function run(overrides = {}) {
    return { entity_type: 'review', entity_id: 'rev-1', recipient_id: 'cust-1', ...overrides };
  }

  test('still valid: five-star, linked to the run\'s own customer, not dismissed, not missing — no block', async () => {
    mockTables({
      google_reviews: { id: 'rev-1', star_rating: 5, customer_id: 'cust-1', dismissed: false, missing_since: null },
    });

    const live = await livePayloadForRun(run());

    expect(live).toEqual({});
  });

  test('blocked: the review no longer exists', async () => {
    mockTables({ google_reviews: undefined });

    const live = await livePayloadForRun(run());

    expect(live.__blocked).toBe('linked review no longer exists');
  });

  test('blocked: reattributed to a different customer since queueing', async () => {
    mockTables({
      google_reviews: { id: 'rev-1', star_rating: 5, customer_id: 'cust-2', dismissed: false, missing_since: null },
    });

    const live = await livePayloadForRun(run());

    expect(live.__blocked).toBe('linked review is attributed to a different customer now');
  });

  test('blocked: edited below five stars since queueing', async () => {
    mockTables({
      google_reviews: { id: 'rev-1', star_rating: 4, customer_id: 'cust-1', dismissed: false, missing_since: null },
    });

    const live = await livePayloadForRun(run());

    expect(live.__blocked).toBe('linked review is no longer five-star');
  });

  test('blocked: dismissed since queueing', async () => {
    mockTables({
      google_reviews: { id: 'rev-1', star_rating: 5, customer_id: 'cust-1', dismissed: true, missing_since: null },
    });

    const live = await livePayloadForRun(run());

    expect(live.__blocked).toBe('linked review was dismissed');
  });

  test('blocked: removed from Google (missing_since stamped) since queueing', async () => {
    mockTables({
      google_reviews: { id: 'rev-1', star_rating: 5, customer_id: 'cust-1', dismissed: false, missing_since: new Date() },
    });

    const live = await livePayloadForRun(run());

    expect(live.__blocked).toBe('linked review is no longer visible on Google');
  });
});

describe('livePayloadForRun — estimate revalidation (estimate.expired, codex P1 round 3 on #5154)', () => {
  beforeEach(() => jest.clearAllMocks());

  function run(overrides = {}) {
    return {
      entity_type: 'estimate', entity_id: 'est-1', trigger_event_key: 'estimate.expired', ...overrides,
    };
  }

  test('still valid: estimate is still expired — no block', async () => {
    mockTables({
      estimates: { id: 'est-1', status: 'expired', expires_at: '2026-06-01' },
    });

    const live = await livePayloadForRun(run());

    expect(live.__blocked).toBeUndefined();
    expect(live.status).toBe('expired');
  });

  test('blocked: revived through /extend before a delayed run came due (status back to sent)', async () => {
    mockTables({
      estimates: { id: 'est-1', status: 'sent', expires_at: '2026-07-01' },
    });

    const live = await livePayloadForRun(run());

    expect(live.__blocked).toBe('linked estimate is no longer expired (status is sent)');
  });

  test('blocked: revived through /extend before a delayed run came due (status back to viewed)', async () => {
    mockTables({
      estimates: { id: 'est-1', status: 'viewed', expires_at: '2026-07-01' },
    });

    const live = await livePayloadForRun(run());

    expect(live.__blocked).toBe('linked estimate is no longer expired (status is viewed)');
  });

  test('blocked: the estimate no longer exists', async () => {
    mockTables({ estimates: undefined });

    const live = await livePayloadForRun(run());

    expect(live.__blocked).toBe('linked estimate no longer exists');
  });

  // Scoping guard (codex P1 round 3 fix-forward regression): a DIFFERENT
  // estimate-entity automation (e.g. estimate.extension_notice) legitimately
  // runs while the estimate is sent/viewed/anything else — this hard
  // invalidation must apply ONLY to the estimate.expired trigger, never to
  // every estimate-entity run.
  test('a non-estimate.expired trigger on an estimate entity is never blocked by status', async () => {
    mockTables({
      estimates: { id: 'est-1', status: 'sent', viewed_at: null, expires_at: '2026-07-01' },
    });

    const live = await livePayloadForRun(run({ trigger_event_key: 'estimate.extension_notice' }));

    expect(live.__blocked).toBeUndefined();
    expect(live.status).toBe('sent');
  });

  // codex P1 round 6 on #5154: the ONE shared follow-up rule
  // (estimate-comms-eligibility.js), re-judged against the live row at
  // execution so a pending/delayed/retried run obeys a later archive.
  test('blocked: archived after the run was queued (status still expired)', async () => {
    mockTables({
      estimates: { id: 'est-1', status: 'expired', archived_at: new Date('2026-06-02T12:00:00Z'), estimate_data: {} },
    });

    const live = await livePayloadForRun(run());

    expect(live.__blocked).toBe('estimate is archived');
  });

  test('blocked: a zero-comms lane (estimate_data.noEngagementAutomation) never gets expiry copy', async () => {
    mockTables({
      estimates: { id: 'est-1', status: 'expired', archived_at: null, estimate_data: JSON.stringify({ noEngagementAutomation: true }) },
    });

    const live = await livePayloadForRun(run());

    expect(live.__blocked).toMatch(/noEngagementAutomation/);
  });

  test('the shared rule covers EVERY estimate-entity automation, not just estimate.expired', async () => {
    mockTables({
      estimates: { id: 'est-1', status: 'sent', archived_at: null, estimate_data: { noEngagementAutomation: true } },
    });

    const live = await livePayloadForRun(run({ trigger_event_key: 'estimate.auto_renewed' }));

    expect(live.__blocked).toMatch(/noEngagementAutomation/);
  });
});

describe('exitReasonFor — send-time appointment guards', () => {
  const PREP_EXITS = { stop_if: ['appointment.cancelled', 'appointment.closed', 'appointment.past'] };

  test('appointment.closed exits on every terminal status', () => {
    for (const status of ['cancelled', 'completed', 'rescheduled', 'skipped', 'no_show']) {
      expect(exitReasonFor(PREP_EXITS, { appointment_status: status })).toBeTruthy();
    }
  });

  test('open upcoming appointments do not exit', () => {
    const future = etDateString(addETDays(new Date(), 3));
    expect(exitReasonFor(PREP_EXITS, { appointment_status: 'confirmed', service_date_ymd: future })).toBeNull();
  });

  test('appointment.past exits when the visit date has passed', () => {
    const past = etDateString(addETDays(new Date(), -2));
    expect(exitReasonFor(PREP_EXITS, { appointment_status: 'confirmed', service_date_ymd: past }))
      .toBe('appointment date already passed');
  });

  test('appointment.past tolerates a missing date', () => {
    expect(exitReasonFor(PREP_EXITS, { appointment_status: 'confirmed' })).toBeNull();
  });
});
