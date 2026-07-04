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
