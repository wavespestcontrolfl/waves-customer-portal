const { foldLawnScoreIntoCompletionSms } = require('../services/service-report/delivery');
const { countSegments } = require('../services/messaging/segment-counter');

// Consolidated lawn report: the assessment score is folded into the single
// completion service-report SMS instead of a separate "lawn health report
// ready" text. These lock the placement + the 2-segment budget guard that
// keeps the fold from turning a compliant text into a 3-segment send.

const SCORE = { scoreLine: 'You scored 60/100, up 5 from last visit.', tipLine: 'Tip: Water only in the early morning.' };

// One-URL body ~ 1 segment: plenty of room for score + tip.
const shortBody = "Hi Verne, your St. Augustine report is ready: https://portal.wavespestcontrol.com/r/abc\nReply STOP to opt out.";

// Two-URL invoice body already at the 2-segment ceiling (the screenshot case).
const invoiceBody = "Hello Verne! Your Lawn Care Visit service report is ready: https://portal.wavespestcontrol.com/l/report-rgggp\n\nInvoice for today's visit: https://portal.wavespestcontrol.com/l/wpc-2026-0233-0704-eq2ez\n\nQuestions or requests? Reply here.";

describe('foldLawnScoreIntoCompletionSms', () => {
  it('folds score + tip directly under the report lead line when there is room', () => {
    const { body, folded, truncated } = foldLawnScoreIntoCompletionSms(shortBody, SCORE, { maxSegments: 2 });
    expect(folded).toBe(true);
    expect(truncated).toBe(false);
    const lines = body.split('\n');
    // score lands on the line immediately after the "report is ready: <link>" lead
    expect(lines[0]).toMatch(/report is ready/);
    expect(lines[1]).toBe(SCORE.scoreLine);
    expect(lines[2]).toBe(SCORE.tipLine);
    expect(body).toContain('Reply STOP to opt out.');
    expect(countSegments(body).segmentCount).toBeLessThanOrEqual(2);
  });

  it('drops the tip (keeps the score) rather than exceed the segment budget', () => {
    expect(countSegments(invoiceBody).segmentCount).toBe(2); // already at the ceiling
    const { body, folded, truncated } = foldLawnScoreIntoCompletionSms(invoiceBody, SCORE, { maxSegments: 2 });
    expect(folded).toBe(true);
    expect(truncated).toBe(true);
    expect(body).toContain(SCORE.scoreLine);
    expect(body).not.toContain(SCORE.tipLine);
    // score sits between the report lead and the invoice paragraph
    expect(body.indexOf(SCORE.scoreLine)).toBeGreaterThan(body.indexOf('report is ready'));
    expect(body.indexOf(SCORE.scoreLine)).toBeLessThan(body.indexOf('Invoice'));
    expect(countSegments(body).segmentCount).toBeLessThanOrEqual(2);
  });

  it('folds score-only cleanly when no tip is available (recommendation race)', () => {
    const { body, folded, truncated } = foldLawnScoreIntoCompletionSms(invoiceBody, { scoreLine: SCORE.scoreLine, tipLine: '' }, { maxSegments: 2 });
    expect(folded).toBe(true);
    expect(truncated).toBe(false); // no tip existed, so nothing was dropped
    expect(body).toContain(SCORE.scoreLine);
  });

  it('skips the fold entirely when even the score alone would overflow', () => {
    // Body padded to sit right at the 2-segment ceiling (<=306 GSM chars) with
    // no headroom for the score line.
    const pad = 'x'.repeat(290);
    const tight = `Lead line ${pad}`;
    expect(countSegments(tight).segmentCount).toBe(2);
    const { body, folded, truncated } = foldLawnScoreIntoCompletionSms(tight, SCORE, { maxSegments: 2 });
    expect(folded).toBe(false);
    expect(truncated).toBe(false);
    expect(body).toBe(tight); // unchanged
  });

  it('is a no-op when there is no score', () => {
    const { body, folded } = foldLawnScoreIntoCompletionSms(invoiceBody, null, { maxSegments: 2 });
    expect(folded).toBe(false);
    expect(body).toBe(invoiceBody);
  });
});
