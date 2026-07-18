import { describe, expect, it } from 'vitest';
import { NEWSLETTER_UI_COPY } from './newsletterUiCopy';

describe('newsletter admin identity contract', () => {
  it('keeps operator-facing identity and calendar cadence aligned', () => {
    expect(NEWSLETTER_UI_COPY).toMatchInlineSnapshot(`
      {
        "calendarWeekHeading": "Fresh This Week (Tuesday 6:00 AM ET)",
        "name": "Fresh This Week",
        "scheduleHint": "Fresh This Week delivery is locked to Tuesday at exactly 6:00 AM ET.",
        "sendCadence": "Tuesday 6:00 AM ET",
        "tagline": "A local weekend guide from the Waves crew",
        "weekStartLabel": "Week starting (Tuesday · 6:00 AM ET delivery)",
      }
    `);
  });
});
