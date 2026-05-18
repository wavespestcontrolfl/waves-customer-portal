import { describe, expect, it } from 'vitest';
import { cleanVisitSummary, customerInteractionCopy, formatDate } from './ReportViewPage.jsx';

describe('ReportViewPage date formatting', () => {
  it('keeps UTC-midnight service dates on their calendar day', () => {
    expect(formatDate('2026-05-17')).toBe('Sunday, May 17, 2026');
    expect(formatDate('2026-05-17T00:00:00.000Z')).toBe('Sunday, May 17, 2026');
  });

  it('still formats true timestamps in Eastern time', () => {
    expect(formatDate('2026-05-17T02:00:00.000Z')).toBe('Saturday, May 16, 2026');
  });
});

describe('ReportViewPage customer copy cleanup', () => {
  it('removes broken Waves signature fragments from the visit summary', () => {
    expect(cleanVisitSummary(
      'Thanks for having us out today. We focused on the perimeter. You should see activity ease over the next 1-2 weeks, and - Waves',
    )).toBe('Your routine service is complete. We focused on the perimeter. You may see activity ease over the next 1-2 weeks.');
  });

  it('translates internal customer interaction values into readable copy', () => {
    expect(customerInteractionCopy('tech_home_spoke_with_them')).toBe('The technician spoke with someone at the home.');
    expect(customerInteractionCopy('not_home_full_access')).toBe('No one was home, and the technician had full access to complete service.');
  });
});
