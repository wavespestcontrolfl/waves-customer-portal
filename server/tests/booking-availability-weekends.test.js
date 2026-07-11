const fs = require('fs');
const path = require('path');

// Regression guard (owner bug report 2026-07-11): the public self-booking
// funnel and the Waves AI date/time search were silently dropping every
// Sunday. buildBookingAvailability calls find-time's findAvailableSlots, whose
// enumerateDates default (includeWeekends:false) skips Sundays — so on a
// Saturday, "this weekend"/"tomorrow" both resolved to Sunday and dead-ended
// with "no open window" despite real weekend availability. The estimate slot
// flow already offers Sundays (estimate-slot-availability defaults
// includeWeekends:true); the fix brings buildBookingAvailability in line.
//
// buildBookingAvailability needs a live DB to exercise end-to-end, so this is
// a source-level assertion in the same style as
// booking-slot-commit-validation.test.js — it fails if the findAvailableSlots
// call ever loses the includeWeekends:true that keeps Sundays bookable.
describe('booking availability offers weekends (Sat + Sun)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/booking.js'), 'utf8');

  test('buildBookingAvailability passes includeWeekends: true to findAvailableSlots', () => {
    const call = src.slice(
      src.indexOf('const result = await findAvailableSlots({'),
      src.indexOf('topN: expandOpenDays')
    );
    expect(call).toContain('includeWeekends: true');
  });
});
