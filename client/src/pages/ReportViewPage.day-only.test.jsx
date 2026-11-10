// @vitest-environment jsdom
// GATE_DAY_ONLY_PROMISE: the service report's next-visit label. The server blanks windowStart for a visit the customer
// was told only the day for and sends day_only + arrival_note; the label prints the date and the note, no hour.
import { describe, expect, it } from 'vitest';
import { formatNextAppointmentLabel } from './ReportViewPage';

const NOTE = 'Arrival window texted the day before';

describe('formatNextAppointmentLabel', () => {
  it('day-only: service, date and the note, no hour', () => {
    expect(formatNextAppointmentLabel({
      serviceType: 'Quarterly Pest Control', scheduledDate: '2999-01-03', windowStart: null, day_only: true, arrival_note: NOTE,
    })).toBe(`Quarterly Pest Control · Thu, Jan 3 · ${NOTE}`);
  });

  it('day-only without a service name: the date and the note', () => {
    expect(formatNextAppointmentLabel({ scheduledDate: '2999-01-03', windowStart: null, day_only: true, arrival_note: NOTE }))
      .toBe(`Thu, Jan 3 · ${NOTE}`);
  });

  it('an hour keeps the window and gets no note', () => {
    expect(formatNextAppointmentLabel({ serviceType: 'Quarterly Pest Control', scheduledDate: '2999-01-03', windowStart: '09:00:00' }))
      .toBe('Quarterly Pest Control · Thu, Jan 3 · 9:00 AM\u201311:00 AM');
  });

  it('an older payload with no window and no flag prints the date alone, as before', () => {
    expect(formatNextAppointmentLabel({ scheduledDate: '2999-01-03', windowStart: null })).toBe('Thu, Jan 3');
  });
});
