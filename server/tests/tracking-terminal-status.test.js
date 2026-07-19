// The authed portal tracker must terminalize visits whose OPERATIONAL status
// is terminal even when track_state lags (several cancellation paths flip
// status without cancelling tracking). A stale track_state='en_route' on a
// cancelled/skipped/completed visit previously kept currentStep at 3, which
// streams live tech GPS to the customer every 15s. Mirrors track-public.js.

const trackingRouter = require('../routes/tracking');

const format = trackingRouter._test.formatScheduledTracker;

const baseService = {
  id: 'svc-1',
  status: 'confirmed',
  track_state: 'en_route',
  track_view_token: 'tok-1',
  track_token_expires_at: null,
  scheduled_date: '2026-07-18',
  service_type: 'pest_control',
  window_start: '09:00',
  window_end: '11:00',
  created_at: '2026-07-17T12:00:00.000Z',
  en_route_at: '2026-07-18T13:00:00.000Z',
};

const tech = { id: 'tech-1', name: 'Adam Benetti' };
const customer = { latitude: 27.4, longitude: -82.5, address_line1: '1 Test St' };

describe('terminal operational status wins over stale track_state', () => {
  test.each([
    ['cancelled', 'cancelled'],
    ['skipped', 'cancelled'],
    ['completed', 'complete'],
    ['no_show', 'no_show'],
  ])('status %s → customer state %s, step 7 (GPS enrichment gated off)', (status, expectedState) => {
    const tracker = format({ ...baseService, status }, tech, customer);
    expect(tracker.state).toBe(expectedState);
    // currentStep 7 is what stops both enrichScheduledWithTechStatus
    // (currentStep !== 3 → no techPosition) and the client's 15s poll.
    expect(tracker.currentStep).toBe(7);
  });

  test('non-terminal status keeps mapping 1:1 from track_state', () => {
    const tracker = format({ ...baseService, status: 'confirmed' }, tech, customer);
    expect(tracker.state).toBe('en_route');
    expect(tracker.currentStep).toBe(3);
  });

  test('terminal status also wins over on_property and scheduled track states', () => {
    expect(format({ ...baseService, status: 'cancelled', track_state: 'on_property' }, tech, customer).currentStep).toBe(7);
    expect(format({ ...baseService, status: 'skipped', track_state: 'scheduled' }, tech, customer).currentStep).toBe(7);
  });
});
