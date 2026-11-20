import { describe, expect, it } from 'vitest';
import {
  describeSend,
  isSendComms,
  shownOffer,
  stageMoveOfferNote,
  expiryLabel,
  formatDay,
  formatIssued,
  formatTimelineTime,
  isGateOffAnswer,
  isLostAnswer,
  isStaleWrite,
  isStartWeekday,
  isValidDay,
  offerErrorMessage,
  outChangeDetail,
  sendChannels,
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

  it('says what changed in the offer a draft replaces, as the card words it', () => {
    const draft = { id: 'offer-2', supersedesId: 'offer-1' };
    const asked = { id: 'offer-1', status: 'date_requested', requestedStartDate: '2027-01-18', dateRequestNote: 'Need two more weeks' };
    expect(outChangeDetail({ current: asked, history: [] }, draft)).toBe('Asked to start Mon, Jan 18, 2027. Note: Need two more weeks');
    expect(outChangeDetail({ current: draft, history: [{ id: 'offer-1', status: 'accepted' }] }, draft)).toBe('It now shows: Signed.');
    expect(outChangeDetail({ current: draft, history: [] }, { id: 'offer-2' })).toBe('Check the offer card before you send.');
  });

  // The server names the channels Send tries; a mask it could not make ('***') is still a channel.
  it('says what Send will do from the channels the server names', () => {
    expect(sendChannels({ sms: '(941) ***-1234', email: 'j***@example.com' })).toBe('one text and one email');
    expect(sendChannels({ sms: '***', email: null })).toBe('one text');
    expect(sendChannels({ sms: null, email: '***' })).toBe('one email');
    expect(sendChannels({ sms: null, email: null })).toBeNull();
    expect(sendChannels(undefined)).toBeNull();
  });

  // Save, Send and Discard all answer DRAFT_CHANGED, and Send and Discard answer DRAFT_HASH_REQUIRED: the words must
  // not tell an owner who tried to discard or save to send.
  it('names no action in the two draft-conflict messages', () => {
    for (const code of ['DRAFT_CHANGED', 'DRAFT_HASH_REQUIRED']) {
      const text = offerErrorMessage({ body: { code } });
      expect(text).toMatch(/nothing was done/);
      expect(text).not.toMatch(/send|save|discard/i);
    }
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

  it('reads no reply, a 5xx or an unreadable reply as a lost answer, and only 404 enabled:false as offers turned off', () => {
    for (const err of [new TypeError('Failed to fetch'), { status: 500 }, { status: 502 }, { status: 503 }, {}]) expect(isLostAnswer(err)).toBe(true);
    for (const status of [400, 401, 403, 404, 409]) expect(isLostAnswer({ status })).toBe(false);
    expect(isGateOffAnswer({ status: 404, body: { enabled: false } })).toBe(true);
    for (const err of [{ status: 404, body: { error: 'Not found' } }, { status: 404, body: null }, { status: 409, body: { enabled: false } }]) expect(isGateOffAnswer(err)).toBe(false);
    expect(offerErrorMessage({ status: 404, body: { enabled: false } })).toBe('Job offers are turned off, so this did not go through. The plain Offer move works as before.');
  });

  it('accepts real calendar dates only', () => {
    expect(isValidDay('2027-01-04')).toBe(true);
    expect(isValidDay('2028-02-29')).toBe(true);
    for (const bad of ['2026-02-30', '2027-02-29', '2027-1-4', '10000-01-03', '', null, 20270104]) expect(isValidDay(bad)).toBe(false);
  });

  it('describes a send plainly: every channel out, queued, unsure or failed', () => {
    expect(describeSend({ sms: { outcome: 'sent' }, email: { outcome: 'handoff' } }, 'Jordan', 'sent')).toEqual({ headline: 'Offer sent to Jordan.', lines: [] });
    expect(describeSend({ sms: { outcome: 'deferred' }, email: { outcome: 'failed' } }, 'Jordan', 'sent')).toEqual({
      headline: 'The offer is open.',
      lines: ['The text is queued.', 'The email did not go out.'],
    });
    expect(describeSend({ sms: { outcome: 'uncertain' }, email: {} }, 'Jordan', 'sent').lines).toEqual([
      'The text may not have gone out.',
      'The email may not have gone out.',
    ]);
    expect(describeSend({ sms: { outcome: 'blocked' }, email: { outcome: 'skipped' } }, 'Jordan', 'sent').lines).toEqual([
      'The text did not go out.',
      'The email did not go out.',
      'Check the phone and email on file, then use Revise to send a new link.',
    ]);
    // Only the channel that was tried is described.
    expect(describeSend({ email: { outcome: 'sent' } }, 'Jordan', 'sent').headline).toBe('Offer sent to Jordan.');
    expect(describeSend({}, 'Jordan', 'sent')).toEqual({ headline: 'The offer is open.', lines: [] });
    // A channel that was never tried (nothing on file, not requested) is left out.
    expect(describeSend({ sms: { outcome: 'sent' }, email: { outcome: 'not_requested' } }, 'Jordan', 'sent')).toEqual({ headline: 'Offer sent to Jordan.', lines: [] });
    expect(describeSend({ sms: { outcome: 'skipped', code: 'no_phone' }, email: { outcome: 'failed' } }, 'Jordan', 'sent').lines).toEqual([
      'The email did not go out.',
      'Check the phone and email on file, then use Revise to send a new link.',
    ]);
  });

  it('reads the offer status of the send answer: closed during the send, or already answered', () => {
    const failed = { sms: { outcome: 'failed' }, email: { outcome: 'failed' } };
    for (const status of ['withdrawn', 'superseded']) {
      expect(describeSend(failed, 'Jordan', status)).toEqual({
        headline: 'This offer is no longer open.',
        lines: ['The text did not go out.', 'The email did not go out.', 'It was withdrawn or replaced after you pressed Send. The offer card shows where it stands.'],
      });
    }
    // Closed by its expiry, not by anyone: its own words, and no Revise advice.
    expect(describeSend(failed, 'Jordan', 'expired')).toEqual({
      headline: 'This offer is no longer open.',
      lines: ['The text did not go out.', 'The email did not go out.', 'It passed its expiry before Jordan signed it. The offer card shows it as Closed unsigned.'],
    });
    // The same expiry when the offer card does not hold this version (the read after the send failed): only the
    // expiry is known, not whether the applicant signed first.
    expect(describeSend(failed, 'Jordan', 'expired', false)).toEqual({
      headline: "This offer's expiry has passed.",
      lines: [
        'The text did not go out.',
        'The email did not go out.',
        'The page could not read the offer after the send, so it cannot tell whether Jordan signed it before then. Close this and use Try again on the offer card.',
      ],
    });
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

// The stage dialog's line words what the server's stage preview says (admin-careers.js stageOfferEffect).
describe('stageMoveOfferNote', () => {
  it('words what the move withdraws, and who may make it', () => {
    const name = 'Jordan Rivera';
    expect(stageMoveOfferNote({ held: true, draft: false, owner_only: false }, name))
      .toBe('This move also withdraws the offer you sent to Jordan, so their link stops working.');
    expect(stageMoveOfferNote({ held: true, draft: true, owner_only: false }, name))
      .toBe('This move also withdraws the offer you sent to Jordan, so their link stops working, and discards the unsent draft.');
    expect(stageMoveOfferNote({ held: false, draft: true, owner_only: false }, name)).toBe('This move also discards the unsent offer draft.');
    expect(stageMoveOfferNote({ held: true, draft: true, owner_only: true }, name))
      .toBe('This application has a job offer out. Only the owner account can move it out of Offer.');
    expect(stageMoveOfferNote({ held: false, draft: false, owner_only: false }, name)).toBeNull();
  });
});

describe('isSendComms', () => {
  it('needs both channels, each with an outcome the server sends', () => {
    expect(isSendComms({ sms: { outcome: 'sent', code: null }, email: { outcome: 'not_requested', code: null } })).toBe(true);
    expect(isSendComms({ sms: { outcome: 'uncertain', code: 'comms_threw' }, email: { outcome: 'stale', code: null } })).toBe(true);
    expect(isSendComms({ sms: { outcome: 'sent', code: null } })).toBe(false);
    expect(isSendComms({ sms: { outcome: 'sent' }, email: { outcome: 'delivered' } })).toBe(false);
    expect(isSendComms({ sms: 'sent', email: 'sent' })).toBe(false);
    expect(isSendComms(null)).toBe(false);
  });
});
