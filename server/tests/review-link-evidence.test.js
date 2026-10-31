/**
 * services/review-link-evidence.js — which customer a Google review belongs to (owner 2026-10-31).
 * Pins the name tiers, the first-contact date rule, the activity windows, and the result for each
 * shape the review audit found: a near-miss surname, an initial, a title, a nickname, a household
 * member, a near twin, a tap by someone else, and a review older than the customer's first contact.
 * All names are synthetic.
 */
const {
  nameParts,
  firstNameRelation,
  surnameRelation,
  firstKnownContactAt,
  dateVerdict,
  activityEvidence,
  scoreCandidate,
  decideReviewLink,
  saysReviewed,
} = require('../services/review-link-evidence');

const REVIEW_AT = '2026-10-20T18:00:00.000Z';
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const at = (offsetMs) => new Date(Date.parse(REVIEW_AT) + offsetMs).toISOString();

const review = (reviewerName, extra = {}) => ({ reviewerName, reviewedAt: REVIEW_AT, locationId: 'parrish', ...extra });

const candidate = (customerId, first, last, extra = {}) => ({
  customerId,
  holder: { first, last },
  contacts: [],
  timeline: { memberSince: '2025-01-15', leadSource: 'website' },
  activity: {},
  linkedProfiles: [],
  ...extra,
});

const decide = (r, candidates, context) => decideReviewLink(candidates.map((c) => scoreCandidate(r, c)), context);
const oneHolder = { surnameHolderCount: () => 1 };

describe('names', () => {
  test('drops titles, suffixes, accents and punctuation; keeps a one-letter surname as an initial', () => {
    expect(nameParts('Dr. Marlow Pemberton Jr.')).toEqual({ first: 'marlow', last: 'pemberton' });
    expect(nameParts('D’Arcy O\'Neill')).toEqual({ first: 'darcy', last: 'oneill' });
    expect(nameParts('Zoë Ashgrove')).toEqual({ first: 'zoe', last: 'ashgrove' });
    expect(nameParts('Frank C.')).toEqual({ first: 'frank', last: 'c' });
    expect(nameParts('Kathy')).toEqual({ first: 'kathy', last: '' });
  });

  test('first names: nickname groups, one letter off with the same first letter, a prefix', () => {
    expect(firstNameRelation('becky', 'rebecca')).toBe('nickname');
    expect(firstNameRelation('shelley', 'shelly')).toBe('spelling');
    expect(firstNameRelation('selena', 'jelena')).toBeNull();
    expect(firstNameRelation('ottil', 'ottilie')).toBe('prefix');
  });

  test('surnames: one letter off at 5+, a swap at 4+, one ending the other at 5+, initials either side', () => {
    expect(surnameRelation('pembertn', 'pemberton')).toBe('near');
    expect(surnameRelation('fenwikc', 'fenwick')).toBe('near');
    expect(surnameRelation('loyn', 'lyon')).toBe('near');
    expect(surnameRelation('lacroix', 'delacroix')).toBe('near');
    expect(surnameRelation('q', 'quill')).toBe('initial');
    expect(surnameRelation('quill', 'q')).toBe('initial');
    expect(surnameRelation('r', 'quill')).toBeNull();
    // Short surnames must match exactly: one letter changes a different family.
    expect(surnameRelation('lea', 'lee')).toBeNull();
    expect(surnameRelation('lion', 'lyon')).toBeNull();
  });
});

describe('first known contact', () => {
  test('an imported row\'s created_at is the import day, not a first contact', () => {
    // A date-only start is that day's Eastern midnight (05:00Z in winter).
    expect(firstKnownContactAt({ leadSource: 'square', createdAt: '2026-04-06T12:00:00Z', memberSince: '2024-03-01' }))
      .toEqual(new Date('2024-03-01T05:00:00Z'));
    expect(firstKnownContactAt({ leadSource: 'square', createdAt: '2026-04-06T12:00:00Z' })).toBeNull();
  });

  test('a portal-born row counts created_at with every other first contact', () => {
    expect(firstKnownContactAt({
      leadSource: 'website',
      createdAt: '2026-09-10T15:00:00Z',
      firstCallAt: '2026-09-08T14:00:00Z',
      firstVisitOn: '2026-09-12',
    })).toEqual(new Date('2026-09-08T14:00:00Z'));
  });

  test('a review more than 3 days before first contact clashes; before the portal era it only queues', () => {
    expect(dateVerdict('2026-09-01T15:00:00Z', '2026-10-15T14:00:00Z')).toBe('clash');
    expect(dateVerdict('2025-06-01T15:00:00Z', '2025-09-01T00:00:00Z')).toBe('clash_early');
    expect(dateVerdict('2026-10-13T15:00:00Z', '2026-10-15T14:00:00Z')).toBe('fits');
    expect(dateVerdict('2026-10-13T15:00:00Z', null)).toBe('unknown');
  });
});

describe('activity around the review', () => {
  test('a tap counts from 3 hours before to 10 minutes after', () => {
    const tap = (offset) => activityEvidence(REVIEW_AT, { taps: [{ at: at(offset), locationId: null }] }).tap;
    expect(tap(-(3 * HOUR - MINUTE))).toBe(true);
    expect(tap(-(3 * HOUR + MINUTE))).toBe(false);
    expect(tap(9 * MINUTE)).toBe(true);
    expect(tap(11 * MINUTE)).toBe(false);
    expect(activityEvidence(REVIEW_AT, { taps: [{ at: at(-HOUR), locationId: 'parrish' }] }, { surnameClash: true }).tap).toBe(false);
  });

  test('a tap stamped for another Google profile is not evidence; an unstamped tap is', () => {
    const taps = (locationId) => ({ taps: [{ at: at(-HOUR), locationId }] });
    expect(activityEvidence(REVIEW_AT, taps('parrish'), { locationId: 'parrish' }).tap).toBe(true);
    expect(activityEvidence(REVIEW_AT, taps('venice'), { locationId: 'parrish' }).tap).toBe(false);
    expect(activityEvidence(REVIEW_AT, taps(null), { locationId: 'parrish' }).tap).toBe(true);
  });

  test('a completed visit or a delivered ask counts up to 14 days before, never after', () => {
    expect(activityEvidence(REVIEW_AT, { visitsOn: ['2026-10-10'] }).recent).toBe(true);
    expect(activityEvidence(REVIEW_AT, { visitsOn: ['2026-10-01'] }).recent).toBe(false);
    expect(activityEvidence(REVIEW_AT, { asksAt: [at(-13 * DAY)] }).recent).toBe(true);
    expect(activityEvidence(REVIEW_AT, { asksAt: [at(HOUR)] }).recent).toBe(false);
  });

  test('a visit day is an Eastern day: a review at 10 PM gets no credit for the next day\'s visit', () => {
    const lateEvening = '2026-10-20T02:00:00Z'; // October 19, 10 PM Eastern
    expect(activityEvidence(lateEvening, { visitsOn: ['2026-10-20'] }).recent).toBe(false);
    expect(activityEvidence(lateEvening, { visitsOn: ['2026-10-19'] }).recent).toBe(true);
  });

  test('an inbound "I left a review" text counts from an hour before to a day after', () => {
    const said = (offset, body) => activityEvidence(REVIEW_AT, { inboundTexts: [{ at: at(offset), body }] }).saidReviewed;
    expect(said(2 * HOUR, 'Just left you a review!')).toBe(true);
    expect(said(-(HOUR + MINUTE), 'Just left you a review!')).toBe(false);
    expect(said(25 * HOUR, 'Just left you a review!')).toBe(false);
    expect(said(2 * HOUR, 'Did you review the estimate?')).toBe(false);
    expect(saysReviewed('Review posted. Thank you!')).toBe(true);
    expect(saysReviewed('I submitted my review on Google')).toBe(true);
    // A negated statement is not evidence.
    expect(said(2 * HOUR, 'I have not left a review yet, sorry!')).toBe(false);
    expect(saysReviewed('I haven\u2019t posted my review')).toBe(false);
    expect(saysReviewed('My review isn\'t done yet')).toBe(false);
  });
});

describe('decideReviewLink', () => {
  test('links the holder on an exact name, with the title dropped', () => {
    const out = decide(review('Dr. Marlow Pemberton'), [candidate('c1', 'Marlow', 'Pemberton')]);
    expect(out).toMatchObject({ result: 'link', reason: 'exact', top: { customerId: 'c1' } });
  });

  test('links a nickname and a one-letter first-name spelling on an exact surname', () => {
    expect(decide(review('Becky Ashgrove'), [candidate('c1', 'Rebecca', 'Ashgrove')])).toMatchObject({ result: 'link', reason: 'variant' });
    expect(decide(review('Shelley Ashgrove'), [candidate('c1', 'Shelly', 'Ashgrove')])).toMatchObject({ result: 'link', reason: 'variant' });
  });

  test('a different first letter is a household member, never a link', () => {
    const out = decide(review('Selena Varga'), [candidate('c1', 'Jelena', 'Varga')], oneHolder);
    expect(out).toMatchObject({ result: 'household', top: { nameKind: 'household' } });
  });

  test('a near-miss surname pauses asks alone and asks a person to confirm with a tap', () => {
    expect(decide(review('Dana Fenwikc'), [candidate('c1', 'Dana', 'Fenwick')])).toMatchObject({ result: 'pause', reason: 'near' });
    const tapped = candidate('c1', 'Dana', 'Fenwick', { activity: { taps: [{ at: at(-HOUR), locationId: 'parrish' }] } });
    expect(decide(review('Dana Fenwikc'), [tapped])).toMatchObject({ result: 'link_confirm', reason: 'near' });
    expect(decide(review('Dana Loyn'), [candidate('c1', 'Dana', 'Lyon')])).toMatchObject({ result: 'pause' });
  });

  test('an initial queues alone and pauses asks with a tap; it never links, even with an "I left a review" text', () => {
    expect(decide(review('Peter Q'), [candidate('c1', 'Peter', 'Quill')])).toMatchObject({ result: 'queue', reason: 'initial' });
    const tapped = candidate('c1', 'Peter', 'Quill', { activity: { taps: [{ at: at(-HOUR), locationId: 'parrish' }] } });
    expect(decide(review('Peter Q'), [tapped])).toMatchObject({ result: 'pause', reason: 'initial' });
    const said = candidate('c1', 'Peter', 'Quill', {
      activity: { taps: [{ at: at(-HOUR), locationId: 'parrish' }], inboundTexts: [{ at: at(2 * HOUR), body: 'Just left you a review!' }] },
    });
    const out = decide(review('Peter Q'), [said]);
    expect(out).toMatchObject({ result: 'pause', top: { activity: { saidReviewed: true } } });
  });

  test('two customers who fit an initial tie and go to a person', () => {
    const out = decide(review('Peter Q'), [candidate('c1', 'Peter', 'Quill'), candidate('c2', 'Pete', 'Quinlan')]);
    expect(out).toMatchObject({ result: 'queue', reason: 'tie' });
  });

  test('an exact name beats a near-miss twin, but a visit near the twin makes it a tie', () => {
    const exact = candidate('c1', 'Marlow', 'Pemberton');
    expect(decide(review('Marlow Pemberton'), [exact, candidate('c2', 'Marlow', 'Pemberten')]))
      .toMatchObject({ result: 'link', top: { customerId: 'c1' } });
    const visited = candidate('c2', 'Marlow', 'Pemberten', { activity: { visitsOn: ['2026-10-15'] } });
    expect(decide(review('Marlow Pemberton'), [exact, visited])).toMatchObject({ result: 'queue', reason: 'tie' });
  });

  test('a review older than the customer\'s first contact is rejected in the portal era', () => {
    const newcomer = candidate('c1', 'Marlow', 'Pemberton', { timeline: { leadSource: 'website', createdAt: '2026-10-15T14:00:00Z' } });
    const out = decide(review('Marlow Pemberton', { reviewedAt: '2026-09-01T15:00:00Z' }), [newcomer]);
    expect(out).toMatchObject({ result: 'reject', reason: 'date_clash', top: null });
    expect(out.rejected.map((c) => c.customerId)).toEqual(['c1']);
  });

  test('a date clash before the portal era goes to a person', () => {
    const imported = candidate('c1', 'Marlow', 'Pemberton', {
      timeline: { leadSource: 'square', createdAt: '2026-04-06T12:00:00Z', memberSince: '2025-09-01' },
    });
    const out = decide(review('Marlow Pemberton', { reviewedAt: '2025-06-01T15:00:00Z' }), [imported]);
    expect(out).toMatchObject({ result: 'queue', reason: 'date_clash_before_portal' });
  });

  test('the import day never makes an older review clash; a portal-born created_at does', () => {
    const early = review('Marlow Pemberton', { reviewedAt: '2026-04-01T15:00:00Z' });
    const imported = candidate('c1', 'Marlow', 'Pemberton', { timeline: { leadSource: 'square', createdAt: '2026-04-06T12:00:00Z' } });
    expect(decide(early, [imported])).toMatchObject({ result: 'link' });
    const portalBorn = candidate('c1', 'Marlow', 'Pemberton', { timeline: { leadSource: 'website', createdAt: '2026-04-06T12:00:00Z' } });
    expect(decide(early, [portalBorn])).toMatchObject({ result: 'queue', reason: 'date_clash_before_portal' });
  });

  test('a tap earns nothing when the Google surname clashes with every name on the account', () => {
    const tapped = candidate('c1', 'Kathy', 'Brindle', { activity: { taps: [{ at: at(-HOUR), locationId: 'parrish' }] } });
    expect(decide(review('Trent Oakhurst'), [tapped])).toMatchObject({ result: 'none', reason: 'no_candidate' });
  });

  test('a first name only needs a tap to reach a person, and queues without one', () => {
    const tapped = candidate('c1', 'Kathy', 'Brindle', { activity: { taps: [{ at: at(-HOUR), locationId: 'parrish' }] } });
    expect(decide(review('Kathy'), [tapped])).toMatchObject({ result: 'link_confirm', reason: 'first_only' });
    expect(decide(review('Kathy'), [candidate('c1', 'Kathy', 'Brindle')])).toMatchObject({ result: 'queue' });
  });

  test('household: a rare surname held by one account pauses asks; a common surname or a second holder queues', () => {
    const holder = candidate('c1', 'Marlow', 'Pemberton');
    expect(decide(review('Gwen Pemberton'), [holder], oneHolder)).toMatchObject({ result: 'household' });
    expect(decide(review('Gwen Pemberton'), [holder], { surnameHolderCount: () => 2 })).toMatchObject({ result: 'queue' });
    expect(decide(review('Gwen Smith'), [candidate('c1', 'Marlow', 'Smith')], oneHolder)).toMatchObject({ result: 'queue' });
  });

  test('a listed contact\'s name asks a person to confirm, with or without its own surname', () => {
    const firstOnly = candidate('c1', 'Marlow', 'Pemberton', { contacts: ['Gwen'] });
    expect(decide(review('Gwen Pemberton'), [firstOnly], oneHolder)).toMatchObject({ result: 'link_confirm', top: { role: 'contact' } });
    const ownSurname = candidate('c1', 'Marlow', 'Pemberton', { contacts: ['Gwen Harlowe'] });
    expect(decide(review('Gwen Harlowe'), [ownSurname])).toMatchObject({ result: 'link_confirm', top: { role: 'contact' } });
  });

  test('short surnames need an exact match', () => {
    expect(decide(review('Ann Lea'), [candidate('c1', 'Ann', 'Lee')])).toMatchObject({ result: 'none' });
    expect(decide(review('Dana Lion'), [candidate('c1', 'Dana', 'Lyon')])).toMatchObject({ result: 'none' });
  });

  test('a customer already linked on this profile goes to a person; a link on another profile does not count', () => {
    const linkedHere = candidate('c1', 'Marlow', 'Pemberton', { linkedProfiles: ['parrish'] });
    expect(decide(review('Marlow Pemberton'), [linkedHere])).toMatchObject({ result: 'queue', reason: 'already_linked_on_profile' });
    const linkedElsewhere = candidate('c1', 'Marlow', 'Pemberton', { linkedProfiles: ['venice'] });
    expect(decide(review('Marlow Pemberton'), [linkedElsewhere])).toMatchObject({ result: 'link' });
  });

  test('a deleted customer is never a candidate', () => {
    const deleted = candidate('c1', 'Marlow', 'Pemberton', { deleted: true });
    expect(scoreCandidate(review('Marlow Pemberton'), deleted)).toBeNull();
    expect(decide(review('Marlow Pemberton'), [deleted])).toMatchObject({ result: 'none' });
  });
});
