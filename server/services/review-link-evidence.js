'use strict';

/**
 * Evidence that a Google review belongs to a customer (owner 2026-10-31: a customer who had already
 * reviewed got a review ask; the review agent should catch that). The sync's exact-name matcher
 * (google-business.js _findCustomerIdByReviewerName) misses spelling variants, initials and titles,
 * and never asks when a customer first contacted Waves. This module scores each candidate on names,
 * dates and activity and picks a result. It is pure: no reads, no writes. review-link-candidates.js
 * reads its inputs for the Reviews match queue and for ops/agents/review-link-audit.js.
 *
 * Names. First names: equal, in the shared nickname groups (utils/name-match.js), or one letter off
 * with the same first letter (4+ letters: Shelly/Shelley). Surnames: equal, one letter off (5+
 * letters), two neighbouring letters swapped (4+), or one name ending the other (5+:
 * "delacroix"/"lacroix"). The surname near-miss is a REVIEW-only rule: name-match.js keeps a
 * surname typo a conflict for calls and payments on purpose. Titles and punctuation are dropped.
 * A record's surname is its whole last_name ("Santa Cruz"); a display name's surname is its last
 * word plus the particles before it ("De La Cruz"), so different compound surnames never match. A
 * name with digits (a Google handle such as "Pemberton2") only matches itself.
 *
 * Dates. First known contact = the earliest of member_since (the start date carried over at the
 * 2026-04-06 import), customer_since, lead first contact, first call, first text, first visit and
 * first estimate. customers.created_at counts only for portal-born rows: imported rows carry the
 * import day. A review more than 3 days before first contact is a clash: rejected from the portal era
 * on, queued before it (an imported start date marks the first sale, which can follow the
 * consultation a review describes).
 *
 * Activity. A tracked tap on the review link from 3 hours before the review to 10 minutes after, for
 * the same Google profile or a tap with no profile stamped (no credit when the Google surname clashes
 * with every name on the account), a completed visit or a delivered review ask up to 14 days before,
 * and an inbound "I left a review" text from an hour before to a day after.
 *
 * Results. link: the account holder's name (exact surname; first name equal, a nickname or one
 * letter off), dates fit, clear winner. link_confirm: the same name on a listed contact; a near-miss
 * surname or a first-name prefix with activity; a first name only, or no name, with a tap. pause: a
 * near-miss surname with no activity; an initial with a tap or a recent visit or ask. household: same
 * rare surname, different first name, one account holder with that surname. queue: anything else, a
 * tie (under 1.5 points apart), a pre-portal date clash, or a customer already linked on that
 * profile. reject: every candidate has a portal-era date clash. none: no candidate.
 */

const { sameFirstName, foldNameLetters } = require('../utils/name-match');
const { parseETDateTime } = require('../utils/datetime-et');

const DAY_MS = 24 * 60 * 60 * 1000;
const PORTAL_ERA_START = Date.parse('2026-04-06T04:00:00Z');
// lead_source on the rows imported at the 2026-04-06 cutover. Their created_at is the import day.
const IMPORTED_LEAD_SOURCE = 'square';
const DATE_CLASH_GRACE_MS = 3 * DAY_MS;
const TAP_BEFORE_MS = 3 * 60 * 60 * 1000;
const TAP_AFTER_MS = 10 * 60 * 1000;
const RECENT_ACTIVITY_MS = 14 * DAY_MS;
const SAID_REVIEWED_BEFORE_MS = 60 * 60 * 1000;
const SAID_REVIEWED_AFTER_MS = DAY_MS;
const CLEAR_WINNER_MARGIN = 1.5;

const TITLES = new Set(['dr', 'mr', 'mrs', 'ms', 'miss', 'rev', 'jr', 'sr', 'ii', 'iii', 'iv', 'md', 'phd', 'esq']);

// A household match on one of these surnames says too little: many unrelated customers share them.
const COMMON_SURNAMES = new Set([
  'smith', 'johnson', 'williams', 'brown', 'jones', 'garcia', 'miller', 'davis', 'rodriguez', 'martinez',
  'hernandez', 'lopez', 'gonzalez', 'wilson', 'anderson', 'thomas', 'taylor', 'moore', 'jackson', 'martin',
  'lee', 'perez', 'thompson', 'white', 'harris', 'sanchez', 'clark', 'ramirez', 'lewis', 'robinson',
  'walker', 'young', 'allen', 'king', 'wright', 'scott', 'torres', 'nguyen', 'hill', 'flores',
  'green', 'adams', 'nelson', 'baker', 'hall', 'rivera', 'campbell', 'mitchell', 'carter', 'roberts',
  'gomez', 'phillips', 'evans', 'turner', 'diaz', 'parker', 'cruz', 'edwards', 'collins', 'reyes',
  'stewart', 'morris', 'morales', 'murphy', 'cook', 'rogers', 'gutierrez', 'ortiz', 'morgan', 'cooper',
  'peterson', 'bailey', 'reed', 'kelly', 'howard', 'ramos', 'kim', 'cox', 'ward', 'richardson',
  'watson', 'brooks', 'chavez', 'wood', 'james', 'bennett', 'gray', 'mendoza', 'ruiz', 'hughes',
  'price', 'alvarez', 'castillo', 'sanders', 'patel', 'myers', 'long', 'ross', 'foster', 'jimenez',
]);

// "I left you a review", "review posted", "just submitted my review". Not "did": "did you review
// the estimate?" is a question about something else. A negated statement is not evidence: a
// negation before the verb ("I have not left a review yet") or inside the claim itself ("I left no
// review", "my review isn't done").
const SAID_REVIEWED_RE = /\b(left|posted|wrote|submitted|gave)\b[^.!?]{0,25}\breview\b|\breview\b[^.!?]{0,20}\b(posted|left|submitted|done)\b/i;
const NOT_REVIEWED_RE = /\b(not|never|haven['’]?t|hasn['’]?t|didn['’]?t|isn['’]?t|wasn['’]?t)\b[^.!?]{0,20}\b(left|posted|wrote|submitted|gave|done)\b/i;
const NEGATION_RE = /\b(no|not|never)\b|n['’]t\b/i;
function saysReviewed(body) {
  const text = String(body || '');
  const claim = SAID_REVIEWED_RE.exec(text);
  return Boolean(claim) && !NEGATION_RE.test(claim[0]) && !NOT_REVIEWED_RE.test(text);
}

// Stricter: a sentence that states as a done fact that the customer left a review ("I left you a
// review", "I have already posted a review", "Just posted my review!", "Review posted.", "My review
// was submitted"). saysReviewed only adds weight near a review that exists; this one stops review
// asks by itself, for good (review-click-guard.js), so a question, a plan, a condition, a promise or
// a request never counts ("can you send the link so I can get my review posted?", "I will let you
// know when I have left a review", "I'll confirm once I've left a review", "after my review is
// posted"). Only helper words may stand between the subject and the verb ("I have already left").
const DONE_REVIEW_RE = /\b(i|we|ive|weve)(\s+(have|has|had|already|just|also|actually|finally|recently|literally|both|each|went and|went ahead and|gone ahead and))*\s+(left|posted|wrote|submitted|gave)\b[^.!?]{0,25}\breview\b|\b(my|our|the) review\b[^.!?]{0,10}\b(is|was|has been)\b[^.!?]{0,8}\b(posted|done|submitted)\b|^\s*(just\s+)?(left|posted|submitted)\b[^.!?]{0,25}\breview\b|^\s*review\s+(posted|done|submitted|left)\b/i;
// On the sentence with apostrophes dropped ("I'll" reads "Ill"). A present-tense review inside a time
// clause is a future one: "after I've posted", "before my review is done".
const NOT_A_DONE_FACT_RE = /\?|\b(will|ill|would|could|can|should|going to|gonna|plan|planning|try|trying|when|whenever|once|until|till|unless|as soon as|if|let (you|u) know|so (i|we) can|need to|want to|how|where)\b|\b(after|before)\s+(ive|weve|i have|we have|(my|our|the) review (is|has been))\b/i;
// "we'll", "you'll": dropping the apostrophe would make "well" and "youll".
const CONTRACTED_FUTURE_RE = /['’]ll\b/i;
function saidLeftReview(body) {
  return String(body || '').split(/(?<=[.!?\n])/).some((sentence) => {
    const plain = sentence.replace(/[’']/g, ''); // "I've" -> "Ive"
    return DONE_REVIEW_RE.test(plain) && !NOT_A_DONE_FACT_RE.test(plain) && !CONTRACTED_FUTURE_RE.test(sentence)
      && saysReviewed(sentence);
  });
}

// Digits stay: dropping them would turn a handle ("Pemberton2") into a real surname.
function nameTokens(value) {
  return foldNameLetters(value)
    .toLowerCase()
    .replace(/['’‘`-]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !TITLES.has(t));
}

// Words that start a compound surname: "De La Cruz" is one surname, not a middle name and "Cruz".
const SURNAME_PARTICLES = new Set([
  'de', 'del', 'della', 'der', 'den', 'di', 'da', 'das', 'dos', 'du', 'la', 'le',
  'van', 'von', 'st', 'ste', 'saint', 'santa', 'san', 'ten', 'ter',
]);

// { first, last } from a display name (a Google reviewer, a listed contact). last is '' for a
// one-word name and a single letter for an initial ("Frank C", "Alex M."); a compound surname keeps
// its particles, joined ("delacruz"). Titles never count as a name.
function nameParts(value) {
  const tokens = nameTokens(value);
  if (!tokens.length) return { first: '', last: '' };
  if (tokens.length === 1) return { first: tokens[0], last: '' };
  let start = tokens.length - 1;
  while (start > 1 && SURNAME_PARTICLES.has(tokens[start - 1])) start -= 1;
  return { first: tokens[0], last: tokens.slice(start).join('') };
}

// { first, last } from a record's own fields: the record says where the surname starts, so every
// word of last_name stays ("Santa Cruz" -> "santacruz").
function recordName(first, last) {
  const lastTokens = nameTokens(last);
  if (!lastTokens.length) return nameParts(first);
  return { first: nameTokens(first)[0] || '', last: lastTokens.join('') };
}

const hasDigit = (value) => /\d/.test(value);

// Optimal string alignment distance: insert, delete, substitute, or swap two neighbours, each 1.
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const isSwap = (a, b) => a.length === b.length && editDistance(a, b) === 1 && [...a].sort().join('') === [...b].sort().join('');

// 'exact' | 'nickname' | 'spelling' | 'prefix' | null
function firstNameRelation(a, b) {
  if (!a || !b) return null;
  if (a === b) return 'exact';
  if (hasDigit(a) || hasDigit(b)) return null;
  if (sameFirstName(a, b)) return 'nickname';
  if (a[0] === b[0] && Math.min(a.length, b.length) >= 4 && editDistance(a, b) === 1) return 'spelling';
  if (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a))) return 'prefix';
  return null;
}

// 'exact' | 'near' | 'initial' | null. `review` is the Google surname, `record` the customer's.
function surnameRelation(review, record) {
  if (!review || !record) return null;
  // Before equality: two matching initials ("Q" and "Q.") are still only an initial.
  if (review.length === 1 || record.length === 1) return review[0] === record[0] ? 'initial' : null;
  if (review === record) return 'exact';
  if (hasDigit(review) || hasDigit(record)) return null;
  const shorter = Math.min(review.length, record.length);
  if (shorter >= 5 && editDistance(review, record) === 1) return 'near';
  if (shorter >= 4 && isSwap(review, record)) return 'near';
  if (shorter >= 5 && (review.endsWith(record) || record.endsWith(review))) return 'near';
  return null;
}

// An exact name clears a near-miss twin with no activity (7 vs 5); the same twin with a visit or an
// ask nearby (6) makes it a tie for a person to settle.
const NAME_POINTS = { exact: 7, variant: 6.5, near: 5, initial: 4, household: 2, first_only: 1 };

// How the Google name relates to one person on the account. null = no name evidence.
function nameKind(reviewName, person) {
  const first = firstNameRelation(reviewName.first, person.first);
  const last = surnameRelation(reviewName.last, person.last);
  if (last === 'exact' && first === 'exact') return 'exact';
  if (last === 'exact' && (first === 'nickname' || first === 'spelling')) return 'variant';
  if (last === 'near' && first && first !== 'prefix') return 'near';
  if (last === 'exact' && first === 'prefix') return 'near';
  if (last === 'initial' && first && first !== 'prefix') return 'initial';
  if (last === 'exact' && !first) return 'household';
  if (!reviewName.last && first === 'exact') return 'first_only';
  return null;
}

// Milliseconds, or null. A date-only 'YYYY-MM-DD' (a visit day, member_since) is that day's Eastern
// midnight: Date.parse reads it as UTC midnight, the evening before in Eastern time.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const toTime = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  const text = String(value);
  const t = DATE_ONLY_RE.test(text) ? parseETDateTime(`${text}T00:00`).getTime() : Date.parse(text);
  return Number.isFinite(t) ? t : null;
};

// The earliest moment Waves knew this customer. customers.created_at is an import stamp for imported
// rows, so it only counts for customers born in the portal.
function firstKnownContactAt(timeline = {}) {
  const created = timeline.leadSource === IMPORTED_LEAD_SOURCE ? null : timeline.createdAt;
  const times = [
    timeline.memberSince, timeline.customerSince, timeline.leadFirstContactAt, timeline.firstCallAt,
    timeline.firstSmsAt, timeline.firstVisitOn, timeline.firstEstimateAt, created,
  ].map(toTime).filter((t) => t !== null);
  return times.length ? new Date(Math.min(...times)) : null;
}

// 'fits' | 'unknown' | 'clash' (portal era: the customer is ruled out) | 'clash_early' (queue).
function dateVerdict(reviewAt, firstContactAt) {
  const review = toTime(reviewAt);
  const first = toTime(firstContactAt);
  if (review === null || first === null) return 'unknown';
  if (review >= first - DATE_CLASH_GRACE_MS) return 'fits';
  return review >= PORTAL_ERA_START ? 'clash' : 'clash_early';
}

const within = (times, from, to) => (times || []).some((value) => {
  const t = toTime(value);
  return t !== null && t >= from && t <= to;
});

// Activity around the review. activity.taps = [{ at, locationId }]: a tap opens ONE profile's review
// form, so a tap stamped for another profile is not evidence (review-click-correlation.js). A tap earns
// nothing when the Google surname clashes with every name on the account: someone else may have
// tapped the same hour.
function activityEvidence(reviewAt, activity = {}, { surnameClash = false, locationId = null } = {}) {
  const at = toTime(reviewAt);
  if (at === null) return { tap: false, recent: false, saidReviewed: false };
  const tapsHere = (activity.taps || [])
    .filter((tap) => !tap.locationId || !locationId || tap.locationId === locationId)
    .map((tap) => tap.at);
  const said = (activity.inboundTexts || []).some((m) => {
    const t = toTime(m.at);
    return t !== null && t >= at - SAID_REVIEWED_BEFORE_MS && t <= at + SAID_REVIEWED_AFTER_MS && saysReviewed(m.body);
  });
  return {
    tap: !surnameClash && within(tapsHere, at - TAP_BEFORE_MS, at + TAP_AFTER_MS),
    recent: within(activity.visitsOn, at - RECENT_ACTIVITY_MS, at) || within(activity.asksAt, at - RECENT_ACTIVITY_MS, at),
    saidReviewed: said,
  };
}

// The people on one account as folded names: the holder, then each listed contact. A contact saved
// with a first name only shares the holder's surname.
function accountPeople(candidate) {
  const holder = recordName(candidate.holder?.first, candidate.holder?.last);
  const contacts = (candidate.contacts || []).map((raw) => {
    const parts = nameParts(raw);
    return { first: parts.first, last: parts.last || holder.last, role: 'contact' };
  });
  return [{ ...holder, role: 'holder' }, ...contacts.filter((c) => c.first)];
}

// The best name evidence across the people on the account.
function bestNameOnAccount(reviewName, people) {
  let best = null;
  for (const person of people) {
    const kind = nameKind(reviewName, person);
    if (kind && (!best || NAME_POINTS[kind] > NAME_POINTS[best.kind])) best = { kind, role: person.role, last: person.last };
  }
  return best;
}

/**
 * What is known about one candidate for one review, name evidence or not: the Reviews match queue
 * shows it for every customer a person searched up. candidate = { customerId, holder: {first, last},
 * contacts: [raw names], timeline, activity, linkedProfiles: [location ids with a live linked
 * review], deleted }. null for a deleted customer.
 */
function describeCandidate(review, candidate) {
  if (candidate.deleted) return null;
  const reviewName = nameParts(review.reviewerName);
  const people = accountPeople(candidate);
  const name = bestNameOnAccount(reviewName, people) || { kind: null, role: null, last: people[0].last };
  // A full Google surname that matches nobody on the account: a tap that hour may be someone else's.
  const surnameClash = reviewName.last.length > 1 && people.every((p) => !surnameRelation(reviewName.last, p.last));
  const firstContactAt = firstKnownContactAt(candidate.timeline);
  return {
    customerId: candidate.customerId,
    nameKind: name.kind,
    role: name.role,
    surname: name.last,
    firstContactAt,
    dates: dateVerdict(review.reviewedAt, firstContactAt),
    activity: activityEvidence(review.reviewedAt, candidate.activity, { surnameClash, locationId: review.locationId }),
    alreadyLinkedHere: (candidate.linkedProfiles || []).includes(review.locationId),
  };
}

// One candidate's score for one review, or null when it has no name evidence and no tap.
function scoreCandidate(review, candidate) {
  const found = describeCandidate(review, candidate);
  if (!found || (!found.nameKind && !found.activity.tap)) return null;
  const { activity } = found;
  const score = (NAME_POINTS[found.nameKind] || 0) + (activity.tap ? 3 : 0) + (activity.recent ? 1 : 0) + (activity.saidReviewed ? 3 : 0);
  return { ...found, score };
}

const hasActivity = (c) => c.activity.tap || c.activity.recent || c.activity.saidReviewed;

// The result for a clear winner, from its name evidence and activity.
function resultForWinner(top, { surnameHolderCount = 0 } = {}) {
  switch (top.nameKind) {
    case 'exact':
    case 'variant':
      return top.role === 'holder' ? 'link' : 'link_confirm';
    case 'near':
      return hasActivity(top) ? 'link_confirm' : 'pause';
    case 'initial':
      return top.activity.tap || top.activity.recent ? 'pause' : 'queue';
    case 'household':
      return !COMMON_SURNAMES.has(top.surname) && surnameHolderCount === 1 ? 'household' : 'queue';
    case 'first_only':
      return top.activity.tap ? 'link_confirm' : 'queue';
    default:
      return top.activity.tap ? 'link_confirm' : 'queue';
  }
}

/**
 * Picks the result for one review from its scored candidates (nulls allowed). context =
 * { surnameHolderCount(surname) }. Returns { result, reason, top, runnerUp, rejected }.
 */
function decideReviewLink(scored, context = {}) {
  const live = scored.filter(Boolean);
  const rejected = live.filter((c) => c.dates === 'clash');
  const ranked = live.filter((c) => c.dates !== 'clash').sort((a, b) => b.score - a.score);
  const [top, runnerUp] = ranked;
  if (!top) {
    const reason = rejected.length ? 'date_clash' : 'no_candidate';
    return { result: rejected.length ? 'reject' : 'none', reason, top: null, runnerUp: null, rejected };
  }
  const base = { top, runnerUp: runnerUp || null, rejected };
  if (runnerUp && top.score - runnerUp.score < CLEAR_WINNER_MARGIN) return { ...base, result: 'queue', reason: 'tie' };
  if (top.dates === 'clash_early') return { ...base, result: 'queue', reason: 'date_clash_before_portal' };
  if (top.alreadyLinkedHere) return { ...base, result: 'queue', reason: 'already_linked_on_profile' };
  const count = typeof context.surnameHolderCount === 'function' ? context.surnameHolderCount(top.surname) : 0;
  const result = resultForWinner(top, { surnameHolderCount: count });
  return { ...base, result, reason: top.nameKind || 'tap' };
}

module.exports = {
  nameParts,
  recordName,
  firstNameRelation,
  surnameRelation,
  firstKnownContactAt,
  dateVerdict,
  activityEvidence,
  describeCandidate,
  scoreCandidate,
  decideReviewLink,
  saysReviewed,
  saidLeftReview,
  COMMON_SURNAMES,
  PORTAL_ERA_START,
};
