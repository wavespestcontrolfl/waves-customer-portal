const { _internals: findTimeInternals } = require('../services/scheduling/find-time');
const { _internals: slotAvailabilityInternals } = require('../services/estimate-slot-availability');

describe('estimate slot weekend and expander behavior', () => {
  test('find-time keeps legacy Sunday skip unless includeWeekends is enabled', () => {
    expect(findTimeInternals.enumerateDates('2026-05-16', '2026-05-18')).toEqual([
      '2026-05-16',
      '2026-05-18',
    ]);

    expect(findTimeInternals.enumerateDates('2026-05-16', '2026-05-18', { includeWeekends: true })).toEqual([
      '2026-05-16',
      '2026-05-17',
      '2026-05-18',
    ]);
  });

  test('estimate availability returns three visible slots plus three more slots', () => {
    const slots = Array.from({ length: 8 }, (_, idx) => ({ slotId: `slot-${idx + 1}` }));

    expect(slotAvailabilityInternals.splitSlotResults(slots, 3, 3)).toEqual({
      primary: [{ slotId: 'slot-1' }, { slotId: 'slot-2' }, { slotId: 'slot-3' }],
      expander: [{ slotId: 'slot-4' }, { slotId: 'slot-5' }, { slotId: 'slot-6' }],
    });
  });

  test('estimate slot profile uses selected per-service treatments for combo first visit duration', () => {
    const profile = slotAvailabilityInternals.resolveEstimateSlotProfile({
      service_interest: 'Pest Control + Lawn Care',
      estimate_data: {
        inputs: { homeSqFt: 2070, lotSqFt: 7326, lawnSqFt: 3200 },
        sendSnapshot: {
          pricingBundle: {
            frequencies: [{
              key: 'quarterly',
              perServiceTreatments: [
                { service: 'pest_control', label: 'Pest Control (Quarterly)', visitsPerYear: 4 },
                { service: 'lawn_care', label: 'Lawn Care', visitsPerYear: 9 },
              ],
            }],
          },
        },
      },
    }, { selectedFrequency: 'quarterly' });

    expect(profile.durationMinutes).toBe(90);
    expect(profile.serviceLabel).toBe('4x Pest Control + 9x Lawn Care');
    expect(profile.services.map((svc) => svc.service)).toEqual(['pest_control', 'lawn_care']);
  });

  test('estimate slot profile honors selected v1 pricing frequency without a send snapshot', () => {
    const profile = slotAvailabilityInternals.resolveEstimateSlotProfile({
      service_interest: 'Pest Control + Lawn Care',
      estimate_data: {
        inputs: { homeSqFt: 2070, lotSqFt: 7326, lawnSqFt: 3200 },
        result: {
          results: {
            pestTiers: [
              { label: 'Quarterly', mo: 50, ann: 600, pa: 150, apps: 4 },
              { label: 'Monthly', mo: 90, ann: 1080, pa: 90, apps: 12 },
            ],
          },
          recurring: {
            services: [
              { service: 'pest_control', name: 'Pest Control', mo: 50 },
              { service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 9 },
            ],
          },
        },
      },
    }, { selectedFrequency: 'monthly' });

    expect(profile.durationMinutes).toBe(75);
    expect(profile.serviceLabel).toBe('12x Pest Control + 9x Lawn Care');
    expect(profile.services).toEqual([
      expect.objectContaining({ service: 'pest_control', visitsPerYear: 12 }),
      expect.objectContaining({ service: 'lawn_care', visitsPerYear: 9 }),
    ]);
  });

  test('estimate slot profile ignores stale pricing snapshots before sizing duration', () => {
    const profile = slotAvailabilityInternals.resolveEstimateSlotProfile({
      service_interest: 'Pest Control + Lawn Care',
      monthly_total: 180,
      annual_total: 2160,
      estimate_data: {
        inputs: { homeSqFt: 2070, lotSqFt: 7326, lawnSqFt: 3200 },
        sendSnapshot: {
          pricingBundle: {
            frequencies: [{
              key: 'quarterly',
              monthly: 70,
              annual: 840,
              perServiceTreatments: [
                { service: 'pest_control', label: 'Pest Control (Quarterly)', visitsPerYear: 4 },
              ],
            }],
          },
        },
        result: {
          recurring: {
            services: [
              { service: 'pest_control', label: 'Pest Control', visitsPerYear: 4 },
              { service: 'lawn_care', label: 'Lawn Care', visitsPerYear: 9 },
            ],
          },
        },
      },
    }, { selectedFrequency: 'quarterly' });

    expect(profile.durationMinutes).toBe(90);
    expect(profile.serviceLabel).toBe('4x Pest Control + 9x Lawn Care');
    expect(profile.services.map((svc) => svc.service)).toEqual(['pest_control', 'lawn_care']);
  });

  test('slot classification uses the service-profile duration in displayed windows', () => {
    const slot = slotAvailabilityInternals.classifySlot({
      date: '2026-05-20',
      start_time: '09:00',
      detour_minutes: 0,
      technician: { id: 'tech-1', name: 'Sam Tech' },
      insertion: { after_stop_id: null, before_stop_id: null },
    }, 20, 90);

    expect(slot.windowStart).toBe('09:00');
    expect(slot.windowEnd).toBe('10:30');
    expect(slot.durationMinutes).toBe(90);
  });

  test('longer service windows must still fit the customer-facing workday', () => {
    expect(slotAvailabilityInternals.slotWindowFitsDay('15:00', '16:30')).toBe(true);
    expect(slotAvailabilityInternals.slotWindowFitsDay('16:00', '17:30')).toBe(false);
  });
});
