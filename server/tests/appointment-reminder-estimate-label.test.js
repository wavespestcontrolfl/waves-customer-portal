// Estimate-backed reminder labels: when scheduled_services.service_type is
// the canonical-mapping fall-through (the estimate's raw service_interest
// category — e.g. "Termite" for an accepted Pre-Slab Termiticide
// Treatment), reminder registration recovers the accepted service name from
// the "Accepted service mix: X." notes line instead of texting the bare
// category ("Your Termite is this Monday").
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(),
}));
jest.mock('../services/estimate-card-holds', () => ({
  cardHoldReminderLine: jest.fn(async () => ''),
}));

const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const AppointmentReminders = require('../services/appointment-reminders');

const { acceptedMixServiceName, estimateBackedServiceName } = AppointmentReminders._test;

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    first: jest.fn(),
    pluck: jest.fn(),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockReturnThis(),
    returning: jest.fn(),
    ...overrides,
  };
}

describe('acceptedMixServiceName', () => {
  test('extracts a single-service mix and drops the trailing period', () => {
    expect(acceptedMixServiceName('Accepted service mix: Pre-Slab Termiticide Treatment.'))
      .toBe('Pre-Slab Termiticide Treatment');
  });

  test('finds the mix line inside multi-line notes', () => {
    expect(acceptedMixServiceName('Gate code 4411\nAccepted service mix: Slab Pre-Treat Termite Service.\nCall on arrival'))
      .toBe('Slab Pre-Treat Termite Service');
  });

  test('strips visit-count prefixes — counts belong in estimates, not reminders', () => {
    expect(acceptedMixServiceName('Accepted service mix: 6x Lawn Care.')).toBe('Lawn Care');
  });

  test("rejects multi-service mixes by the producer's ' + ' join — the addon join owns joined labels", () => {
    expect(acceptedMixServiceName('Accepted service mix: 4x Pest Control + 12x Lawn Care.')).toBeNull();
  });

  test("preserves '&' and commas in legitimate single-service names", () => {
    expect(acceptedMixServiceName('Accepted service mix: Tree & Shrub.')).toBe('Tree & Shrub');
    expect(acceptedMixServiceName('Accepted service mix: Rodent Trapping, Exclusion & Sanitation Service.'))
      .toBe('Rodent Trapping, Exclusion & Sanitation Service');
  });

  test('returns null when no mix line exists', () => {
    expect(acceptedMixServiceName('Gate code 4411')).toBeNull();
    expect(acceptedMixServiceName(null)).toBeNull();
  });

  test('preserves long recovered labels intact — service_type is text (20260428000010)', () => {
    const name = 'Very Long Service Name '.repeat(8).trim();
    expect(acceptedMixServiceName(`Accepted service mix: ${name}.`)).toBe(name);
  });
});

describe('estimateBackedServiceName', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function mockServiceLookup(row) {
    const lookup = chain({ first: jest.fn().mockResolvedValue(row) });
    db.mockImplementation((table) => {
      if (table === 'scheduled_services as s') return lookup;
      throw new Error(`Unexpected table query: ${table}`);
    });
    return lookup;
  }

  test('recovers the accepted name when the stored label is the raw estimate category', async () => {
    mockServiceLookup({
      notes: 'Accepted service mix: Pre-Slab Termiticide Treatment.',
      service_interest: 'Termite',
    });
    await expect(estimateBackedServiceName('svc-1', 'Termite'))
      .resolves.toBe('Pre-Slab Termiticide Treatment');
  });

  test("recovers when the stored label is the 'Estimate service' default", async () => {
    mockServiceLookup({
      notes: 'Accepted service mix: Slab Pre-Treat Termite Service.',
      service_interest: null,
    });
    await expect(estimateBackedServiceName('svc-1', 'Estimate service'))
      .resolves.toBe('Slab Pre-Treat Termite Service');
  });

  test('passes mapped canonical labels through unchanged', async () => {
    const lookup = mockServiceLookup({
      notes: 'Accepted service mix: 4x Pest Control.',
      service_interest: 'Pest Control',
    });
    // "Quarterly Pest Control" !== service_interest — not the fall-through
    // signature, so the canonical label stands.
    await expect(estimateBackedServiceName('svc-1', 'Quarterly Pest Control'))
      .resolves.toBe('Quarterly Pest Control');
    expect(lookup.first).toHaveBeenCalled();
  });

  test('no-ops when the recovered name equals the stored label', async () => {
    mockServiceLookup({
      notes: 'Accepted service mix: 6x Lawn Care.',
      service_interest: 'Lawn Care',
    });
    await expect(estimateBackedServiceName('svc-1', 'Lawn Care'))
      .resolves.toBe('Lawn Care');
  });

  test('matches the fall-through signature through cappedServiceType normalization', async () => {
    // The booking path stores cappedServiceType(service_interest) — collapsed
    // whitespace and a 100-char '...' cap. The raw interest differs from the
    // stored value in both cases; the comparison must still match.
    mockServiceLookup({
      notes: 'Accepted service mix: Pre-Slab Termiticide Treatment.',
      service_interest: '  Termite   Category ',
    });
    await expect(estimateBackedServiceName('svc-1', 'Termite Category'))
      .resolves.toBe('Pre-Slab Termiticide Treatment');

    const longInterest = 'X'.repeat(120);
    const cappedStored = `${'X'.repeat(97)}...`;
    mockServiceLookup({
      notes: 'Accepted service mix: Slab Pre-Treat Termite Service.',
      service_interest: longInterest,
    });
    await expect(estimateBackedServiceName('svc-1', cappedStored))
      .resolves.toBe('Slab Pre-Treat Termite Service');
  });

  test('passes through when the visit has no estimate or no mix line', async () => {
    mockServiceLookup({ notes: 'Gate code 4411', service_interest: 'Termite' });
    await expect(estimateBackedServiceName('svc-1', 'Termite')).resolves.toBe('Termite');
  });

  test('fails open on lookup errors — a label enrichment must never block registration', async () => {
    db.mockImplementation(() => { throw new Error('connection reset'); });
    await expect(estimateBackedServiceName('svc-1', 'Termite')).resolves.toBe('Termite');
  });
});

describe('registerAppointment with an estimate fall-through service_type', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    db.raw = jest.fn().mockResolvedValue();
    db.transaction = jest.fn(async (callback) => callback(db));
  });

  test('persists the accepted service name, not the raw category', async () => {
    const insertedReminder = {
      id: 'reminder-preslab',
      scheduled_service_id: 'svc-preslab',
      customer_id: 'customer-1',
      service_type: 'Pre-Slab Termiticide Treatment',
      confirmation_sent: false,
    };
    const estimateLookup = chain({
      first: jest.fn().mockResolvedValue({
        notes: 'Accepted service mix: Pre-Slab Termiticide Treatment.',
        service_interest: 'Termite',
      }),
    });
    const addons = chain({ pluck: jest.fn().mockResolvedValue([]) });
    const byScheduledService = chain({ first: jest.fn().mockResolvedValue(null) });
    const byCustomerAndTime = chain({ first: jest.fn().mockResolvedValue(null) });
    const insertReminder = chain({
      insert: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([insertedReminder]),
    });
    const markConfirmationSkipped = chain();
    const reminderQueries = [byScheduledService, byCustomerAndTime, insertReminder, markConfirmationSkipped];

    db.mockImplementation((table) => {
      if (table === 'appointment_reminders') return reminderQueries.shift();
      if (table === 'scheduled_services as s') return estimateLookup;
      if (table === 'scheduled_service_addons') return addons;
      throw new Error(`Unexpected table query: ${table}`);
    });

    const result = await AppointmentReminders.registerAppointment(
      'svc-preslab',
      'customer-1',
      '2099-08-10T11:00',
      'Termite',
      'booking_new',
      { sendConfirmation: false },
    );

    expect(result).toBe(insertedReminder);
    expect(insertReminder.insert).toHaveBeenCalledWith(expect.objectContaining({
      scheduled_service_id: 'svc-preslab',
      service_type: 'Pre-Slab Termiticide Treatment',
    }));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
});
