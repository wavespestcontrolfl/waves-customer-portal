import { describe, expect, it } from 'vitest';
import { NEWSLETTER_UI_COPY } from './newsletterUiCopy';

describe('newsletter admin identity contract', () => {
  it('keeps operator-facing identity and calendar cadence aligned', () => {
    expect(NEWSLETTER_UI_COPY).toMatchInlineSnapshot(`
      {
        "calendarWeekHeading": "The Waves Newsletter (Tuesday 6:00 AM ET)",
        "name": "The Waves Newsletter",
        "scheduleHint": "The Waves Newsletter delivery is locked to Tuesday at exactly 6:00 AM ET.",
        "sendCadence": "Tuesday 6:00 AM ET",
        "tagline": "",
        "weekStartLabel": "Week starting (Tuesday · 6:00 AM ET delivery)",
      }
    `);
  });

  it('never resurrects the retired Fresh This Week identity', () => {
    const copy = JSON.stringify(NEWSLETTER_UI_COPY);
    expect(copy).not.toContain('Fresh This Week');
    expect(copy).not.toContain('A local weekend guide from the Waves crew');
  });
});
