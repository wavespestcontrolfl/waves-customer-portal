/**
 * booking.js bookingExpectedMinutes — funnel key -> catalog identity
 * (Codex #4664 r3 P2): an ordinary /book service carries only a display
 * label ('Pest Control', 'Lawn Care'), while the catalog's own rows are
 * cadence-specific ('Quarterly Pest Control Service', 'Bi-Monthly Lawn Care
 * Service'). Looking that label up as a service_key or an exact
 * services.name never resolves, so every /book credit silently degraded to
 * the full window (zero padding) regardless of the gate. The funnel key is
 * now also mapped to services.category (a real catalog key field whose
 * vocabulary is exactly this funnel's) — and bora_care to its own exact
 * service_key — before resolving the credit.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/scheduling/occupancy', () => ({ listOccupiedWindows: jest.fn() }));

const db = require('../models/db');
const { bookingExpectedMinutes } = require('../routes/booking')._internals;
const { clearExpectedServiceMinutesCache } = require('../services/scheduling/expected-service-minutes');

const CATALOG = [
  { service_key: 'quarterly_pest', name: 'Quarterly Pest Control Service', category: 'pest_control', min_duration_minutes: 30, max_duration_minutes: 60 },
  { service_key: 'bimonthly_pest', name: 'Bi-Monthly Pest Control Service', category: 'pest_control', min_duration_minutes: 40, max_duration_minutes: 80 },
  { service_key: 'bimonthly_lawn', name: 'Bi-Monthly Lawn Care Service', category: 'lawn_care', min_duration_minutes: 40, max_duration_minutes: 80 },
  { service_key: 'bora_care', name: 'Bora-Care Wood Treatment', category: 'termite', min_duration_minutes: 60, max_duration_minutes: 240 },
];

const ENV_KEYS = ['GATE_SLOT_TRAVEL_GAP', 'SLOT_TRAVEL_BUFFER_MINUTES'];
const saved = {};
beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  clearExpectedServiceMinutesCache();
  db.mockReset();
  db.mockImplementation((table) => {
    if (table !== 'services') throw new Error(`unexpected table ${table}`);
    return { select: async () => CATALOG };
  });
});

test('gate off: returns the window length untouched, no catalog read', async () => {
  const minutes = await bookingExpectedMinutes(db, 'pest_control', 60);
  expect(minutes).toBe(60);
  expect(db).not.toHaveBeenCalled();
});

describe('gate on', () => {
  beforeEach(() => { process.env.GATE_SLOT_TRAVEL_GAP = 'true'; });

  test('a plain funnel key ("pest_control") resolves a real credit via services.category, not the window length', async () => {
    // quarterly_pest midpoint 45, bimonthly_pest midpoint 60 -> category
    // average 52.5 — anything less than the full 60-minute window proves
    // the category mapping resolved, where a display-label string match
    // against cadence-specific catalog names would have found nothing.
    const minutes = await bookingExpectedMinutes(db, 'pest_control', 60);
    expect(minutes).toBe(52.5);
  });

  test('lawn_care maps to its own category', async () => {
    expect(await bookingExpectedMinutes(db, 'lawn_care', 60)).toBe(60);
  });

  test('bora_care resolves its OWN exact catalog service_key (midpoint 150, clamped to the window)', async () => {
    expect(await bookingExpectedMinutes(db, 'bora_care', 90)).toBe(90);
  });

  test('a multi-service key ("pest_control+lawn_care") sums both categories, clamped to the combined window', async () => {
    // pest_control 52.5 + lawn_care 60 = 112.5, clamped to 120.
    const minutes = await bookingExpectedMinutes(db, 'pest_control+lawn_care', 120);
    expect(minutes).toBe(112.5);
  });

  test('an unrecognized service value still falls back to the window length', async () => {
    expect(await bookingExpectedMinutes(db, 'not_a_real_service', 60)).toBe(60);
  });

  // Codex r5 P2 #5 — reschedule-public.js and the voice agent's
  // revalidateSlot have an EXISTING scheduled_services row's own catalog
  // identity (service_key_snapshot / service_type), never a /book funnel
  // selection. That identity never matches the 7-key funnel vocabulary
  // above, so without this fallback every one of those callers silently
  // degraded to the no-credit legacy gap.
  describe('serviceIdentity fallback (no funnel key resolves)', () => {
    test('an unrecognized serviceKey with a matching catalogServiceKey resolves the EXACT row (bimonthly_pest midpoint 60)', async () => {
      const minutes = await bookingExpectedMinutes(db, '', 80, { catalogServiceKey: 'bimonthly_pest' });
      expect(minutes).toBe(60);
    });

    test('a cadence-specific serviceType name resolves via services.name when no catalogServiceKey is known', async () => {
      // "Quarterly Pest Control Service" midpoint (30+60)/2 = 45.
      const minutes = await bookingExpectedMinutes(db, '', 60, { serviceType: 'Quarterly Pest Control Service' });
      expect(minutes).toBe(45);
    });

    test('an unrecognized serviceKey AND an identity matching nothing in the catalog falls back to the window length', async () => {
      const minutes = await bookingExpectedMinutes(db, '', 60, { catalogServiceKey: 'no_such_key', serviceType: 'Not A Real Service' });
      expect(minutes).toBe(60);
    });

    test('a recognized funnel key wins over serviceIdentity — the identity is never consulted', async () => {
      // pest_control's own category average (52.5) must win, not
      // bimonthly_lawn's 60, proving serviceIdentity is only a fallback.
      const minutes = await bookingExpectedMinutes(db, 'pest_control', 60, { catalogServiceKey: 'bimonthly_lawn' });
      expect(minutes).toBe(52.5);
    });

    test('no serviceIdentity and no funnel key: window length, same as before this fallback existed', async () => {
      expect(await bookingExpectedMinutes(db, '', 60, null)).toBe(60);
    });
  });
});
