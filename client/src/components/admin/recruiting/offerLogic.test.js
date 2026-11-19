import { describe, expect, it } from 'vitest';
import {
  describeSend,
  shownOffer,
  expiryLabel,
  formatDay,
  formatIssued,
  formatTimelineTime,
  isStaleWrite,
  isStartWeekday,
  isValidDay,
  maskEmail,
  maskPhone,
  offerErrorMessage,
  stepDateFor,
} from './offerLogic';

describe('offer helpers', () => {
  it('puts the pay step on the first Monday after day 90 (day 1 = start date)', () => {
    expect(stepDateFor('2027-01-04')).toBe('2027-04-05');
    // Start Tue 2027-01-05: day 90 = Sun 04-04, so the next day (Mon 04-05) is the step.
    expect(stepDateFor('2027-01-05')).toBe('2027-04-05');
    // Start Wed 2027-01-06: day 90 is itself Mon 04-05, which is not "after" it; the next Monday wins.
    expect(stepDateFor('2027-01-06')).toBe('2027-04-12');
    expect(stepDateFor('')).toBe('');
    // A date that cannot be formed, or whose step date would pass year 9999, has no step date.
    for (const bad of ['9999-12-27', '2027-02-30', '0050-01-04', '275760-09-13', 'nope']) expect(stepDateFor(bad)).toBe('');
    expect(stepDateFor('9999-01-04')).toMatch(/^9999-/);
  });

  it('accepts Monday to Thursday start dates only', () => {
    expect(['2027-01-04', '2027-01-05', '2027-01-06', '2027-01-07'].map(isStartWeekday)).toEqual([true, true, true, true]);
    expect(['2027-01-03', '2027-01-08', '2027-01-09', 'nope'].map(isStartWeekday)).toEqual([false, false, false, false]);
  });

  it('formats days without a time-zone shift and times in Eastern', () => {
    expect(formatDay('2027-01-04')).toBe('Mon, Jan 4, 2027');
    expect(formatTimelineTime('2026-12-11T15:20:00Z')).toBe('Fri, Dec 11, 10:20 AM');
    // 9 PM Eastern is already the next day in UTC: the Eastern day must show.
    expect(formatIssued('2026-11-11T02:30:00Z')).toBe('Nov 10, 2026');
    expect(expiryLabel(new Date('2026-12-11T15:20:00Z'))).toBe('Fri, Dec 18, 2026');
  });

  it('masks phone and email', () => {
    expect(maskPhone('9415551234')).toBe('(941) ***-1234');
    expect(maskPhone('12')).toBe('');
    expect(maskEmail('jordan@example.com')).toBe('j***@example.com');
    expect(maskEmail('x')).toBe('');
  });

  it('turns each 409 code into a plain sentence', () => {
    for (const code of ['TERMS_NOT_ISSUED', 'DRAFT_CHANGED', 'OFFER_CHANGED', 'DRAFT_HASH_REQUIRED', 'OFFER_NOT_DRAFT', 'NO_CONTACT', 'APPLICATION_CLOSED', 'ROLE_NOT_SUPPORTED', 'OFFER_NOT_WITHDRAWABLE', 'OFFER_NOT_REVISABLE']) {
      const text = offerErrorMessage({ message: 'HTTP 409', body: { code } });
      expect(text).not.toBe('HTTP 409');
      expect(text).not.toContain(code);
    }
    expect(offerErrorMessage({ message: 'Start date must be in the future' })).toBe('Start date must be in the future');
  });

  it('treats every refusal that means "this changed meanwhile" as a stale write to re-read', () => {
    for (const code of ['DRAFT_CHANGED', 'OFFER_CHANGED', 'OFFER_NOT_DRAFT', 'OFFER_NOT_WITHDRAWABLE', 'OFFER_NOT_REVISABLE', 'DRAFT_EXISTS', 'OFFER_ALREADY_OPEN', 'APPLICATION_CLOSED']) {
      expect(isStaleWrite({ body: { code } })).toBe(true);
    }
    for (const code of ['TERMS_NOT_ISSUED', 'NO_CONTACT', 'OWNER_ONLY', undefined]) expect(isStaleWrite({ body: { code } })).toBe(false);
  });

  it('accepts real calendar dates only', () => {
    expect(isValidDay('2027-01-04')).toBe(true);
    expect(isValidDay('2028-02-29')).toBe(true);
    for (const bad of ['2026-02-30', '2027-02-29', '2027-1-4', '10000-01-03', '', null, 20270104]) expect(isValidDay(bad)).toBe(false);
  });

  it('describes a send plainly: every channel out, queued, unsure or failed', () => {
    expect(describeSend({ sms: { outcome: 'sent' }, email: { outcome: 'handoff' } }, 'Jordan')).toEqual({ headline: 'Offer sent to Jordan.', lines: [] });
    expect(describeSend({ sms: { outcome: 'deferred' }, email: { outcome: 'failed' } }, 'Jordan')).toEqual({
      headline: 'The offer is open.',
      lines: ['The text is queued.', 'The email did not go out.'],
    });
    expect(describeSend({ sms: { outcome: 'uncertain' }, email: {} }, 'Jordan').lines).toEqual([
      'The text may not have gone out.',
      'The email may not have gone out.',
    ]);
    expect(describeSend({ sms: { outcome: 'blocked' }, email: { outcome: 'skipped' } }, 'Jordan').lines).toEqual([
      'The text did not go out.',
      'The email did not go out.',
      'Check the phone and email on file, then use Revise to send a new link.',
    ]);
    // Only the channel that was tried is described.
    expect(describeSend({ email: { outcome: 'sent' } }, 'Jordan').headline).toBe('Offer sent to Jordan.');
    expect(describeSend({}, 'Jordan')).toEqual({ headline: 'The offer is open.', lines: [] });
    // A channel that was never tried (nothing on file, not requested) is left out.
    expect(describeSend({ sms: { outcome: 'sent' }, email: { outcome: 'not_requested' } }, 'Jordan')).toEqual({ headline: 'Offer sent to Jordan.', lines: [] });
    expect(describeSend({ sms: { outcome: 'skipped', code: 'no_phone' }, email: { outcome: 'failed' } }, 'Jordan').lines).toEqual([
      'The email did not go out.',
      'Check the phone and email on file, then use Revise to send a new link.',
    ]);
  });

  it('reads the offer status of the send answer: closed during the send, or already answered', () => {
    const failed = { sms: { outcome: 'failed' }, email: { outcome: 'failed' } };
    for (const status of ['withdrawn', 'superseded']) {
      expect(describeSend(failed, 'Jordan', status)).toEqual({
        headline: 'This offer is no longer open.',
        lines: ['The text did not go out.', 'The email did not go out.', 'It was withdrawn or replaced while it was being sent. The offer card shows where it stands.'],
      });
    }
    expect(describeSend({ sms: { outcome: 'sent' } }, 'Jordan', 'accepted')).toEqual({
      headline: 'Offer sent to Jordan.',
      lines: ['Jordan has already answered it. The offer card shows the answer.'],
    });
    expect(describeSend({ sms: { outcome: 'sent' } }, 'Jordan', 'sent')).toEqual({ headline: 'Offer sent to Jordan.', lines: [] });
  });

  it('reads a sent offer past its expiry as expired', () => {
    const now = new Date('2026-12-20T15:00:00Z');
    expect(shownOffer({ status: 'sent', expiresAt: '2026-12-19T04:59:59Z' }, now).status).toBe('expired');
    expect(shownOffer({ status: 'sent', expiresAt: '2026-12-21T04:59:59Z' }, now).status).toBe('sent');
    expect(shownOffer({ status: 'accepted', expiresAt: '2026-12-19T04:59:59Z' }, now).status).toBe('accepted');
  });
});
