'use strict';

// codex r3 P1: call-booking-link-text.js's own MODULE_LOAD_AT (the anchor
// its first-ever activation boundary falls back to, see
// persistedActivationBoundary's doc comment) must be this process's actual
// boot time — which only holds if scheduler.js requires the module at its
// OWN top level (= process boot), never lazily inside the cron tick body
// (which would defer the capture to whenever the first tick happens to
// fire, 5 minutes later, defeating the fix). A source-text assertion,
// mirroring internal-alert-caller-id.test.js's own convention for pinning
// an exact wiring shape, since executing the real scheduler.js module here
// would drag in every other lane it wires (Twilio, every cron target) for
// no benefit over reading the two lines that actually matter.

const fs = require('fs');
const path = require('path');

function schedulerSource() {
  return fs.readFileSync(path.join(__dirname, '..', 'services', 'scheduler.js'), 'utf8');
}

describe('scheduler.js loads call-booking-link-text.js eagerly, not lazily inside its cron tick', () => {
  test('a top-level require binds callBookingLinkText before any cron.schedule call', () => {
    const src = schedulerSource();
    const requireIndex = src.search(/^const callBookingLinkText = require\('\.\/call-booking-link-text'\);/m);
    expect(requireIndex).toBeGreaterThan(-1);
    const firstCronSchedule = src.indexOf('cron.schedule(');
    expect(firstCronSchedule).toBeGreaterThan(-1);
    expect(requireIndex).toBeLessThan(firstCronSchedule);
  });

  test('the cron tick calls the already-bound callBookingLinkText.sweep(), never require(...) again inline', () => {
    const src = schedulerSource();
    expect(src).toMatch(/callBookingLinkText\.sweep\(\)/);
    // The old lazy-require shape must not reappear.
    expect(src).not.toMatch(/require\('\.\/call-booking-link-text'\)\.sweep\(\)/);
  });
});
