// Job offers (services/job-offers.js): the pure rules. Dates (step date, suggested start, expiry), validation, merge of a
// request onto a draft, the hashes, the letter text, the pay-day line, the public state and the admin shape. No database.
// Synthetic people only.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const J = require('../services/job-offers');

// 2026-11-19 is a Thursday. Noon ET, so the ET date is the same in every zone.
const NOW = new Date('2026-11-19T17:00:00Z');

describe('dates', () => {
  test('the step date is the first Monday strictly after day 90 (day 1 = the start date)', () => {
    // Spec example: start Mon 2027-01-04 -> day 90 is Sat 2027-04-03 -> step Mon 2027-04-05.
    expect(J.stepDateFor('2027-01-04')).toBe('2027-04-05');
    expect(J.dowOf('2027-04-05')).toBe(1);
    // Day 90 landing ON a Monday still steps the Monday after it ("strictly after").
    expect(J.addDays('2027-01-04', 89)).toBe('2027-04-03');
    expect(J.stepDateFor('2027-01-06')).toBe('2027-04-12'); // start Wed: day 90 = Mon Apr 5 -> next Monday Apr 12
    expect(J.dowOf(J.addDays('2027-01-06', 89))).toBe(1);
  });

  test('the suggested start is the first Monday at least 21 days after today in ET', () => {
    expect(J.suggestStartDate(NOW)).toBe('2026-12-14'); // today + 21 = Thu Dec 10 -> Mon Dec 14
    expect(J.suggestStartDate(new Date('2026-11-23T17:00:00Z'))).toBe('2026-12-14'); // + 21 is itself a Monday
    // 9 PM ET on Thu Nov 19 is already Fri Nov 20 in UTC: the ET date rules.
    expect(J.suggestStartDate(new Date('2026-11-20T02:00:00Z'))).toBe('2026-12-14');
  });

  test('the offer expires at 23:59:59 ET on the send day plus 7 days (EST and EDT)', () => {
    expect(J.expiryFor(NOW).toISOString()).toBe('2026-11-27T04:59:59.000Z'); // Thu Nov 26 23:59:59 EST
    expect(J.expiryFor(new Date('2027-03-04T17:00:00Z')).toISOString()).toBe('2027-03-12T04:59:59.000Z'); // Thu Mar 11 23:59:59 EST
    expect(J.expiryFor(new Date('2027-03-09T17:00:00Z')).toISOString()).toBe('2027-03-17T03:59:59.000Z'); // Tue Mar 16 23:59:59 EDT (clocks changed Mar 14)
  });

  test('dates print the way the page and the texts say them', () => {
    expect(J.fmtDay('2026-12-18')).toBe('Fri, Dec 18');
    expect(J.fmtDay('2027-01-04', { year: true })).toBe('Mon, Jan 4, 2027');
    expect(J.fmtDay('nope')).toBe('');
    expect(J.isYmd('2027-02-30')).toBe(false);
    expect(J.isYmd('2027-02-28')).toBe(true);
  });
});

describe('defaults', () => {
  test('are the owner rulings, with the step date from the suggested start', () => {
    expect(J.defaultsFor(NOW)).toEqual({
      jobTitle: 'Pest Control Technician', startDate: '2026-12-14', hourlyRate: 23, stepRate: 25, stepEffectiveOn: '2027-03-15',
      hoursLine: '40 paid hours each full week, four 10-hour days, Monday to Thursday',
    });
  });
});

describe('validateOffer', () => {
  const good = () => ({ ...J.defaultsFor(NOW) });
  const run = (over) => J.validateOffer({ ...good(), ...over }, NOW);
  const fields = (over) => run(over).errors.map((e) => e.field);

  test('the defaults are valid', () => {
    expect(run({}).errors).toEqual([]);
  });

  test('the start date must be a future ET date, Monday to Thursday', () => {
    expect(fields({ startDate: '2026-11-19' })).toContain('startDate'); // today
    expect(fields({ startDate: '2026-11-18' })).toContain('startDate'); // past
    expect(fields({ startDate: '2026-12-18' })).toContain('startDate'); // Friday
    expect(fields({ startDate: '2026-12-19' })).toContain('startDate'); // Saturday
    expect(fields({ startDate: '2026-12-17', stepEffectiveOn: '2027-03-15' })).toEqual([]); // Thursday
    expect(fields({ startDate: 'soon' })).toContain('startDate');
  });

  test('rates run 15.00 to 60.00 with at most cents, and the step rate beats the hourly rate', () => {
    expect(fields({ hourlyRate: 14.99 })).toContain('hourlyRate');
    expect(fields({ hourlyRate: 60.01 })).toContain('hourlyRate');
    expect(fields({ hourlyRate: 23.555 })).toContain('hourlyRate');
    expect(fields({ hourlyRate: 'abc' })).toContain('hourlyRate');
    expect(run({ hourlyRate: '22.50' }).value.hourlyRate).toBe(22.5);
    expect(fields({ stepRate: 23 })).toContain('stepRate');
    expect(fields({ stepRate: 22 })).toContain('stepRate');
  });

  test('the step rate and step date come together or not at all, and the step date is a Monday after the start', () => {
    expect(run({ stepRate: null, stepEffectiveOn: null }).errors).toEqual([]);
    expect(run({ stepRate: null, stepEffectiveOn: null }).value).toMatchObject({ stepRate: null, stepEffectiveOn: null });
    expect(fields({ stepRate: 25, stepEffectiveOn: null })).toContain('stepEffectiveOn');
    expect(fields({ stepRate: null, stepEffectiveOn: '2027-03-15' })).toContain('stepRate');
    expect(fields({ stepEffectiveOn: '2027-03-16' })).toContain('stepEffectiveOn'); // Tuesday
    expect(fields({ stepEffectiveOn: '2026-12-14' })).toContain('stepEffectiveOn'); // not after the start
  });

  test('the title and hours line are required, bounded and never mention a check or a test', () => {
    expect(fields({ jobTitle: '  ' })).toContain('jobTitle');
    expect(fields({ jobTitle: 'x'.repeat(101) })).toContain('jobTitle');
    expect(fields({ hoursLine: 'x'.repeat(301) })).toContain('hoursLine');
    expect(fields({ hoursLine: '40 hours, after a drug test' })).toContain('hoursLine');
    expect(fields({ jobTitle: 'Technician, background check required' })).toContain('jobTitle');
    expect(run({ jobTitle: ' Pest   Control\u0007 Technician ' }).value.jobTitle).toBe('Pest Control Technician');
  });
});

describe('mergeOfferInput', () => {
  const base = J.defaultsFor(NOW);

  test('only the keys a request carries change; a new start date recomputes the step date', () => {
    expect(J.mergeOfferInput(base, { hourlyRate: 24 })).toEqual({ ...base, hourlyRate: 24 });
    const moved = J.mergeOfferInput(base, { startDate: '2027-01-04' });
    expect(moved.stepEffectiveOn).toBe('2027-04-05');
    expect(J.mergeOfferInput(base, { startDate: '2027-01-04', stepEffectiveOn: '2027-05-03' }).stepEffectiveOn).toBe('2027-05-03');
  });

  test('the same start date sent again keeps a negotiated raise date; a different one recomputes it', () => {
    const negotiated = { ...base, stepEffectiveOn: J.addDays(base.stepEffectiveOn, 7) };
    expect(J.mergeOfferInput(negotiated, { startDate: base.startDate, hoursLine: 'Four 10-hour days' }).stepEffectiveOn).toBe(negotiated.stepEffectiveOn);
    expect(J.mergeOfferInput(negotiated, { startDate: '2027-01-04' }).stepEffectiveOn).toBe('2027-04-05');
  });

  test('clearing the step rate clears the step date; adding one computes it', () => {
    expect(J.mergeOfferInput(base, { stepRate: null })).toMatchObject({ stepRate: null, stepEffectiveOn: null });
    const none = { ...base, stepRate: null, stepEffectiveOn: null };
    expect(J.mergeOfferInput(none, { stepRate: 26 })).toMatchObject({ stepRate: 26, stepEffectiveOn: J.stepDateFor(base.startDate) });
  });
});

describe('hashes', () => {
  test('the snapshot hash ignores key order and changes with any value', () => {
    expect(J.snapshotHashOf({ a: 1, b: { c: 2, d: 3 } })).toBe(J.snapshotHashOf({ b: { d: 3, c: 2 }, a: 1 }));
    expect(J.snapshotHashOf({ a: 1 })).not.toBe(J.snapshotHashOf({ a: 2 }));
    expect(J.snapshotHashOf({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  test('the signature hash covers the snapshot, the Terms, the typed name and the signing instant', () => {
    const input = { snapshotHash: 's'.repeat(64), termsContentHash: 't'.repeat(64), signedName: 'Jordan Rivera', signedAt: '2026-11-20T15:00:00.000Z' };
    const base = J.signatureHashOf(input);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(J.signatureHashOf({ ...input, signedAt: new Date('2026-11-20T15:00:00Z') })).toBe(base);
    for (const change of [{ snapshotHash: 'x'.repeat(64) }, { termsContentHash: 'x'.repeat(64) }, { signedName: 'Jordan Rivers' }, { signedAt: '2026-11-20T15:00:01.000Z' }]) {
      expect(J.signatureHashOf({ ...input, ...change })).not.toBe(base);
    }
  });
});

describe('the pay-day line', () => {
  test('comes from the issued policy values, never a fixed phrase', () => {
    expect(J.payDayLineFrom({ pay_frequency: 'weekly', pay_schedule: 'Fridays' })).toBe('Paid weekly. Fridays.');
    expect(J.payDayLineFrom({ pay_frequency: 'weekly', pay_schedule: 'Fridays for the week ending Sunday.' })).toBe('Paid weekly. Fridays for the week ending Sunday.');
    expect(J.payDayLineFrom({ pay_frequency: 'biweekly', pay_schedule: 'Every other Friday' })).toBe('Paid every two weeks. Every other Friday.');
  });

  test('is null when a value is missing or still a placeholder', () => {
    expect(J.payDayLineFrom(null)).toBeNull();
    expect(J.payDayLineFrom({ pay_frequency: 'weekly' })).toBeNull();
    expect(J.payDayLineFrom({ pay_frequency: 'daily', pay_schedule: 'x' })).toBeNull();
    expect(J.payDayLineFrom({ pay_frequency: 'weekly', pay_schedule: '[DECISION: day]' })).toBeNull();
  });

  test('is never cut short: a line over the 500-character column is no line (a Send blocker)', () => {
    expect(J.payDayLineFrom({ pay_frequency: 'weekly', pay_schedule: 'x'.repeat(486) }).length).toBe(500); // 'Paid weekly. ' + 486 + '.'
    expect(J.payDayLineFrom({ pay_frequency: 'weekly', pay_schedule: 'x'.repeat(487) })).toBeNull();
    expect(J.payDayLineFrom({ pay_frequency: 'weekly', pay_schedule: 'x'.repeat(500) })).toBeNull();
  });
});

describe('the letter', () => {
  const view = {
    jobTitle: 'Pest Control Technician', startDate: '2027-01-04', hourlyRate: 23, stepRate: 25, stepEffectiveOn: '2027-04-05',
    hoursLine: '40 paid hours each full week, four 10-hour days, Monday to Thursday', reportTo: 'Test Owner, owner',
    payDayLine: 'Paid weekly. Fridays.', owner: { name: 'Test Owner', title: 'owner', sentOn: '2026-11-20' },
    expiresAt: '2026-11-28T04:59:59.000Z', terms: { title: 'Technician Terms', markdown: '## Duties\n\nDo the work.' },
  };

  test('reads like the page: owner line, rows, notice line, Terms, expiry', () => {
    const text = J.renderLetterMarkdown(view);
    expect(text).toContain('# Your job offer');
    expect(text).toContain('Signed by Test Owner, owner · Fri, Nov 20, 2026');
    expect(text).toContain('- **Start:** Mon, Jan 4, 2027');
    expect(text).toContain('- **Pay:** $23.00 an hour, $25.00 from Apr 5');
    expect(text).toContain('- **Pay day:** Paid weekly. Fridays.');
    expect(text).toContain("Please don't give notice at your current job until you have signed this offer.");
    expect(text).toContain('## Technician Terms\n\n## Duties');
    expect(text).toContain('Open until Fri, Nov 27');
  });

  test('has no step clause without a step, and says so when the Terms are not issued', () => {
    const text = J.renderLetterMarkdown({ ...view, stepRate: null, stepEffectiveOn: null, terms: null, payDayLine: null, expiresAt: null });
    expect(text).toContain('- **Pay:** $23.00 an hour\n');
    expect(text).toContain('The Technician Terms are not issued yet.');
    expect(text).not.toContain('Pay day');
    expect(text).not.toContain('Open until');
  });

  test('never carries a background-check or drug-test line, or the long company name', () => {
    expect(J.renderLetterMarkdown(view)).not.toMatch(/background|drug|Waves Pest Control/i);
  });

  test('clause ids are dropped from the Terms headings only', () => {
    expect(J.readableTerms('## Duties {#duties}\nSee {#not-a-heading}\n## Pay {#pay}')).toBe('## Duties\nSee {#not-a-heading}\n## Pay');
  });
});

describe('the signed name', () => {
  test('is trimmed, 3 to 120 characters and at least two words', () => {
    expect(J.parseSignedName('  Jordan   Rivera ')).toBe('Jordan Rivera');
    expect(J.parseSignedName('Jordan')).toBeNull();
    expect(J.parseSignedName('Jo')).toBeNull();
    expect(J.parseSignedName('A B')).toBe('A B');
    expect(J.parseSignedName(`${'a'.repeat(70)} ${'b'.repeat(60)}`)).toBeNull();
    expect(J.parseSignedName(42)).toBeNull();
    expect(J.parseSignedName(undefined)).toBeNull();
  });
});

describe('the public state', () => {
  const sent = { status: 'sent', expires_at: '2026-11-27T04:59:59.000Z' };
  const at = (iso) => ({ now: new Date(iso) });

  test('maps every status, and a draft is not public', () => {
    expect(J.publicStateOf({ status: 'draft' }, at('2026-11-20T00:00:00Z'))).toBeNull();
    expect(J.publicStateOf(sent, at('2026-11-20T00:00:00Z'))).toBe('open');
    expect(J.publicStateOf({ status: 'accepted' }, {})).toBe('signed');
    expect(J.publicStateOf({ status: 'declined' }, {})).toBe('declined');
    expect(J.publicStateOf({ status: 'date_requested', expires_at: sent.expires_at }, at('2026-11-20T00:00:00Z'))).toBe('date_requested');
    for (const status of ['expired', 'withdrawn', 'superseded']) expect(J.publicStateOf({ status }, {})).toBe(status);
  });

  test('a sent offer past its expiry reads expired before the sweep flips the row', () => {
    expect(J.publicStateOf(sent, at('2026-11-27T04:59:59Z'))).toBe('open');
    expect(J.publicStateOf(sent, at('2026-11-27T05:00:00Z'))).toBe('expired');
  });

  test('an application the owner closed makes a live offer read withdrawn', () => {
    for (const applicationStatus of ['hired', 'rejected', 'withdrawn']) {
      expect(J.publicStateOf(sent, { ...at('2026-11-20T00:00:00Z'), applicationStatus })).toBe('withdrawn');
      expect(J.publicStateOf({ status: 'date_requested' }, { ...at('2026-11-20T00:00:00Z'), applicationStatus })).toBe('withdrawn');
    }
    expect(J.publicStateOf({ status: 'accepted' }, { applicationStatus: 'hired' })).toBe('signed');
  });

  test('closed messages are the owner-approved words, with the main phone', () => {
    const snapshot = { owner: { name: 'Test Owner' } };
    expect(J.closedMessage('superseded', snapshot, {})).toBe('This offer was updated. Please use the newest link Test sent you.');
    expect(J.closedMessage('withdrawn', snapshot, {})).toBe('This offer is no longer open. Please call Test at (941) 297-5749.');
    expect(J.closedMessage('expired', snapshot, { expires_at: '2026-11-27T04:59:59.000Z' }))
      .toBe('This offer closed on Thu, Nov 26, 2026. Please call Test at (941) 297-5749 if you still want the job.');
  });
});

describe('the admin shape', () => {
  const row = {
    id: 'o1', application_id: 'a1', status: 'sent', job_title: 'Pest Control Technician', start_date: new Date('2027-01-04T00:00:00Z'),
    hourly_rate: '23.00', step_rate: '25.00', step_effective_on: new Date('2027-04-05T00:00:00Z'), hours_line: 'h', report_to: 'Test Owner, owner',
    pay_day_line: 'Paid weekly.', expires_at: new Date('2026-11-27T04:59:59Z'), token: 'f'.repeat(64), sent_at: new Date('2026-11-20T15:00:00Z'),
    sent_by: 's1', opened_at: new Date('2026-11-20T16:00:00Z'), text_consent_at: null, created_at: new Date('2026-11-20T14:00:00Z'),
    updated_at: new Date('2026-11-20T16:00:00Z'), checklist: '{}', terms_version_id: 'v1',
  };

  test('numbers, dates, the offer link and a time-ordered timeline', () => {
    const offer = J.presentOffer(row, { sentByName: 'Test Owner', now: new Date('2026-11-21T00:00:00Z'), includeUrl: true });
    expect(offer).toMatchObject({
      id: 'o1', applicationId: 'a1', status: 'sent', startDate: '2027-01-04', hourlyRate: 23, stepRate: 25, stepEffectiveOn: '2027-04-05',
      sentByName: 'Test Owner', textConsentAt: null, signedAt: null, checklist: {}, termsVersionId: 'v1',
    });
    expect(offer.offerUrl).toBe(`https://portal.wavespestcontrol.com/careers/offer/${'f'.repeat(64)}`);
    expect(offer.timeline.map((t) => t.kind)).toEqual(['drafted', 'sent', 'opened']);
    expect(offer.token).toBeUndefined();
    // The link is the applicant's signing credential: without includeUrl (any admin but the owner) it is not served.
    expect(J.presentOffer(row, { now: new Date('2026-11-21T00:00:00Z') }).offerUrl).toBeNull();
  });

  test('a sent offer past its expiry reads expired until the sweep flips the row; a date request does not expire', () => {
    const late = { now: new Date('2026-11-27T05:00:00Z') };
    const expired = J.presentOffer(row, late);
    expect(expired.status).toBe('expired');
    expect(expired.timeline.map((t) => t.kind)).toContain('expired');
    expect(J.presentOffer(row, { now: new Date('2026-11-27T04:59:59Z') }).status).toBe('sent');
    expect(J.presentOffer({ ...row, status: 'date_requested' }, late).status).toBe('date_requested');
    expect(row.status).toBe('sent'); // the row itself is not changed
  });

  test('a draft has no link and no step is shown as null', () => {
    const offer = J.presentOffer({ ...row, status: 'draft', token: null, sent_at: null, opened_at: null, step_rate: null, step_effective_on: null });
    expect(offer).toMatchObject({ offerUrl: null, stepRate: null, stepEffectiveOn: null });
    expect(offer.timeline.map((t) => t.kind)).toEqual(['drafted']);
  });

  test('answers add timeline rows with what the applicant said', () => {
    const offer = J.presentOffer({
      ...row, status: 'date_requested', date_requested_at: new Date('2026-11-21T10:00:00Z'), requested_start_date: new Date('2027-01-11T00:00:00Z'),
      date_request_note: 'Notice runs out',
    });
    const entry = offer.timeline.find((t) => t.kind === 'date_requested');
    expect(entry.label).toBe('Asked to start Mon, Jan 11, 2027 (Notice runs out)');
    expect(offer.requestedStartDate).toBe('2027-01-11');
  });

  test('presenting nothing is null', () => {
    expect(J.presentOffer(null)).toBeNull();
  });
});
