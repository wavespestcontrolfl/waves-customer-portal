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

  test('estimate availability returns six visible slots plus three more slots', () => {
    const slots = Array.from({ length: 10 }, (_, idx) => ({ slotId: `slot-${idx + 1}` }));

    expect(slotAvailabilityInternals.splitSlotResults(slots, 6, 3)).toEqual({
      primary: [
        { slotId: 'slot-1' },
        { slotId: 'slot-2' },
        { slotId: 'slot-3' },
        { slotId: 'slot-4' },
        { slotId: 'slot-5' },
        { slotId: 'slot-6' },
      ],
      expander: [{ slotId: 'slot-7' }, { slotId: 'slot-8' }, { slotId: 'slot-9' }],
    });
  });

  test('estimate slot selection prefers soonest dates over future route-optimal slots', () => {
    const slots = [
      { slotId: 'future-nearby', date: '2026-06-10', windowStart: '11:00', routeOptimal: true, nearbyJob: { detourMinutes: 1 } },
      { slotId: 'soon-open', date: '2026-05-24', windowStart: '09:00', routeOptimal: false, nearbyJob: null },
      { slotId: 'next-open', date: '2026-06-01', windowStart: '10:00', routeOptimal: false, nearbyJob: null },
    ];

    expect(slotAvailabilityInternals.selectCustomerFacingSlots(slots, 2).map((slot) => slot.slotId))
      .toEqual(['soon-open', 'next-open']);
  });

  test('estimate slot selection spreads across distinct days instead of stacking one day', () => {
    const slots = [
      { slotId: 'day-one-9', date: '2026-05-24', windowStart: '09:00', routeOptimal: false },
      { slotId: 'day-one-10', date: '2026-05-24', windowStart: '10:00', routeOptimal: false },
      { slotId: 'day-two-9', date: '2026-05-25', windowStart: '09:00', routeOptimal: false },
    ];

    // Soonest day's earliest window leads (the ASAP option), then the next
    // distinct day — not a second same-day window.
    expect(slotAvailabilityInternals.selectCustomerFacingSlots(slots, 2).map((slot) => slot.slotId))
      .toEqual(['day-one-9', 'day-two-9']);
  });

  test('diversifyByDay surfaces one slot per day before doubling up, soonest first', () => {
    // Three days, each with three 9a/11a/1p windows. The customer-facing
    // list should read across days rather than dumping all of day one.
    const slots = ['2026-05-24', '2026-05-25', '2026-05-27'].flatMap((date) =>
      ['09:00', '11:00', '13:00'].map((windowStart) => ({
        slotId: `${date}_${windowStart}`,
        date,
        windowStart,
        routeOptimal: false,
      })));

    const picks = slotAvailabilityInternals.selectCustomerFacingSlots(slots, 6);
    const dates = picks.map((slot) => slot.date);

    // First card is the genuine soonest/earliest window.
    expect(picks[0].slotId).toBe('2026-05-24_09:00');
    // First three cards are three different days (no day repeats before all
    // days are represented).
    expect(new Set(dates.slice(0, 3)).size).toBe(3);
    // Later days lead with a spread of times, not another 9 AM each.
    expect(new Set(picks.slice(0, 3).map((slot) => slot.windowStart)).size)
      .toBeGreaterThan(1);
  });

  test('deduping merged asap and route pools preserves route metadata', () => {
    const merged = slotAvailabilityInternals.dedupeSlots([
      {
        slotId: '2026-05-27_09-00_tech-1',
        date: '2026-05-27',
        windowStart: '09:00',
        techId: 'tech-1',
        routeOptimal: false,
        nearbyJob: null,
        capacityType: 'asap_open',
      },
      {
        slotId: '2026-05-27_09-00_tech-1',
        date: '2026-05-27',
        windowStart: '09:00',
        techId: 'tech-1',
        routeOptimal: true,
        nearbyJob: { detourMinutes: 4 },
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(expect.objectContaining({
      routeOptimal: true,
      nearbyJob: { detourMinutes: 4 },
    }));
  });

  test('asap slot helpers use Eastern calendar dates and skip same-day windows inside lead time', () => {
    const now = new Date('2026-05-26T14:15:00Z'); // 10:15 AM ET

    expect(slotAvailabilityInternals.etDateRange(3, now)).toEqual({
      dateFrom: '2026-05-26',
      dateTo: '2026-05-29',
    });
    expect(slotAvailabilityInternals.earliestBookableMinuteForDate('2026-05-26', now, 120))
      .toBe(12 * 60 + 15);
    expect(slotAvailabilityInternals.earliestBookableMinuteForDate('2026-05-27', now, 120))
      .toBe(0);
  });

  test('past windows on today are dropped while future dates and bookable times stay', () => {
    const now = new Date('2026-05-26T15:01:00Z'); // 11:01 AM ET
    const slots = [
      { slotId: 'today-10', date: '2026-05-26', windowStart: '10:00', routeOptimal: false }, // past
      { slotId: 'today-11', date: '2026-05-26', windowStart: '11:00', routeOptimal: false }, // inside 120m lead
      { slotId: 'today-14', date: '2026-05-26', windowStart: '14:00', routeOptimal: false }, // bookable
      { slotId: 'tomorrow-9', date: '2026-05-27', windowStart: '09:00', routeOptimal: false }, // future date
    ];

    const kept = slotAvailabilityInternals
      .filterPastSlotsForToday(slots, { now, minimumLeadMinutes: 120 })
      .map((slot) => slot.slotId);

    expect(kept).toEqual(['today-14', 'tomorrow-9']);
  });

  test('spreading re-packs today\'s slots onto bookable windows instead of past ones', () => {
    const now = new Date('2026-05-26T15:01:00Z'); // 11:01 AM ET → earliest bookable 13:01 → 14:00 first
    const todayStr = '2026-05-26';
    const slots = Array.from({ length: 3 }, (_, i) => ({
      slotId: `today-${i}`, date: todayStr, windowStart: '14:00', windowEnd: '15:00',
      routeOptimal: false, techId: `tech-${i}`,
    }));

    const spread = slotAvailabilityInternals.spreadWindowsAcrossDay(slots, 60, { now, minimumLeadMinutes: 120 });

    // No same-day window is stamped before the lead-time cutoff…
    spread.forEach((s) => expect(['14:00', '15:00', '16:00']).toContain(s.windowStart));
    // …so all genuine same-day capacity survives the past-slot filter.
    expect(slotAvailabilityInternals.filterPastSlotsForToday(spread, { now, minimumLeadMinutes: 120 })).toHaveLength(3);
  });

  test('past-slot filter also trims a route-optimal window that has already passed today', () => {
    const now = new Date('2026-05-26T15:01:00Z'); // 11:01 AM ET
    const slots = [
      { slotId: 'today-route-10', date: '2026-05-26', windowStart: '10:00', routeOptimal: true, nearbyJob: { detourMinutes: 2 } },
      { slotId: 'today-route-15', date: '2026-05-26', windowStart: '15:00', routeOptimal: true, nearbyJob: { detourMinutes: 2 } },
    ];

    const kept = slotAvailabilityInternals
      .filterPastSlotsForToday(slots, { now, minimumLeadMinutes: 120 })
      .map((slot) => slot.slotId);

    expect(kept).toEqual(['today-route-15']);
  });

  test('asap slot cap preserves later windows when many techs are active', () => {
    const techs = Array.from({ length: 30 }, (_, idx) => ({ id: `tech-${idx + 1}`, name: `Tech ${idx + 1}` }));
    const slots = slotAvailabilityInternals.buildAsapCapacitySlotsForTechs({
      dateFrom: '2026-05-27',
      dateTo: '2026-05-27',
      durationMinutes: 60,
      techs,
      maxCandidates: 12,
    });

    const windows = new Set(slots.map((slot) => slot.windowStart));
    expect(slots).toHaveLength(12);
    expect(windows.has('09:00')).toBe(true);
    expect(windows.has('10:00')).toBe(true);
    expect(windows.has('11:00')).toBe(true);
    expect(windows.has('13:00')).toBe(true);
  });

  test('estimate slot spreading happens before the final customer-facing limit', () => {
    const genericSlots = Array.from({ length: 6 }, (_, idx) => ({
      slotId: `generic-${idx}`,
      date: '2026-05-24',
      windowStart: '09:00',
      windowEnd: '10:00',
      routeOptimal: false,
      techId: `tech-${idx}`,
    }));
    const routeSlot = {
      slotId: 'route-10',
      date: '2026-05-24',
      windowStart: '10:00',
      windowEnd: '11:00',
      routeOptimal: true,
      techId: 'tech-route',
      nearbyJob: { detourMinutes: 1 },
    };

    const spread = slotAvailabilityInternals.spreadWindowsAcrossDay(
      [...genericSlots, routeSlot].sort(slotAvailabilityInternals.compareCustomerFacingSlots),
      60,
    );

    expect(slotAvailabilityInternals.selectCustomerFacingSlots(spread, 6).map((slot) => slot.slotId))
      .toContain('route-10');
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

    expect(profile.durationMinutes).toBe(105);
    expect(profile.serviceLabel).toBe('4x Pest Control + 9x Lawn Care');
    expect(profile.services.map((svc) => svc.service)).toEqual(['pest_control', 'lawn_care']);
  });

  test('quarterly pest estimate slots default to 60 minutes', () => {
    expect(slotAvailabilityInternals.durationForService({
      service: 'pest_control',
      label: 'Pest Control (Quarterly)',
      visitsPerYear: 4,
    })).toBe(60);
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

    expect(profile.durationMinutes).toBe(105);
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
