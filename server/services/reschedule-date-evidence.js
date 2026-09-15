const { etParts, addETDays, validCalendarDate, parseETDateTime, parseQuotedETDeadline } = require('../utils/datetime-et');

const MONTHS = 'january february march april may june july august september october november december'.split(' ');
const WEEKDAYS = 'sunday monday tuesday wednesday thursday friday saturday'.split(' ');
const names = (values) => values.flatMap(value => [value, value.slice(0, 3)]).join('|');
const month = `(?:${names(MONTHS)}|sept)`;
const weekday = `(?:${names(WEEKDAYS)}|tues|thur|thurs)`;
const day = '\\d{1,2}(?:st|nd|rd|th)?';
const absolute = `(?:${month}\\s+${day}(?:\\s+\\d{4})?|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}(?:/\\d{4})?)`;
const expression = `(?:${weekday}(?:\\s+(?:${absolute}|(?:the\\s+)?${day}))?|${absolute}|(?:the\\s+)?\\d{1,2}(?:st|nd|rd|th)|today|tomorrow)`;
const DATE = new RegExp(`\\b${expression}\\b`, 'g');
const normalize = (text) => String(text || '').toLowerCase().replace(/[’']/g, '').replace(/[,.]/g, ' ').replace(/\s+/g, ' ').trim();
const indexOfName = (values, text) => values.findIndex(value => value.startsWith(text.slice(0, 3)));

// This is an evidence grammar, not a general prose interpreter. The existing
// quoted-deadline parser requires a clock; confirmed-slot evidence requires a
// full instant. Neither can prove partial appointment dates or business roles.
// Calendar arithmetic/validation stays in datetime-et.
function components(text, reference) {
  const result = {};
  let rest = text;
  const w = new RegExp(`^(${weekday})(?:\\s+|$)`).exec(rest);
  if (w) { result.weekday = indexOfName(WEEKDAYS, w[1]); rest = rest.slice(w[0].length); }
  if (!rest) return result;
  if (/^(today|tomorrow)$/.test(rest)) {
    if (!(reference instanceof Date) || Number.isNaN(reference.getTime())) return null;
    const { year, month: mo, day: d } = etParts(addETDays(reference, rest === 'tomorrow' ? 1 : 0));
    return { year, month: mo, day: d };
  }
  const formats = [
    [/^(\d{4})-(\d{2})-(\d{2})$/, m => ({ year: +m[1], month: +m[2], day: +m[3] })],
    [/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/, m => ({ month: +m[1], day: +m[2], ...(m[3] && { year: +m[3] }) })],
    [new RegExp(`^(${month})\\s+(${day})(?:\\s+(\\d{4}))?$`), m => ({ month: indexOfName(MONTHS, m[1]) + 1, day: parseInt(m[2], 10), ...(m[3] && { year: +m[3] }) })],
    [/^(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?$/, m => ({ day: +m[1] })],
  ];
  const parsed = formats.map(([pattern, read]) => { const match = pattern.exec(rest); return match && read(match); }).find(Boolean);
  if (!parsed) return null;
  Object.assign(result, parsed);
  const ymd = `${result.year || 2000}-${String(result.month || 1).padStart(2, '0')}-${String(result.day).padStart(2, '0')}`;
  if (!validCalendarDate(ymd)) return null;
  if (result.year && result.month && result.weekday !== undefined && new Date(`${ymd}T12:00:00Z`).getUTCDay() !== result.weekday) return null;
  return result;
}

const appointment = '(?:my|your|the|our) (?:current )?';
const delivery = '(?:i will|ill|we will|well) (?:text|send|email or text) (?:you )?(?:the|your|a) reschedule link';
const HOURS = 'one two three four five six seven eight nine ten eleven twelve'.split(' ');
const clock = `(?: (?:morning|afternoon|evening|at (?:${HOURS.join('|')}|noon|midnight|[0-9:]+)(?: ?(?:am|pm))?))?`;
// Anchored whole-clause forms prove roles without trusting the model's label.
// Corrections, negations, conditionals, ranges and unrecognised mixed clauses
// deliberately have no matching production and remain office work.
const ROLES = [
  [new RegExp(`^${appointment}@ appointment$`), ['appointment']],
  [new RegExp(`^${appointment}appointment (?:is |is on |on )?@$`), ['appointment']],
  [new RegExp(`^(?:please )?move ${appointment}@ appointment to @$`), ['appointment', 'requested']],
  [new RegExp(`^${appointment}@ appointment needs to move to @$`), ['appointment', 'requested']],
  [new RegExp(`^${delivery} (?:on |by |before |no later than )?@${clock}(?: for that appointment)?$`), ['delivery']],
  [new RegExp(`^${delivery} (?:on |by |before |no later than )?@${clock} for ${appointment}@ appointment$`), ['delivery', 'appointment']],
];

// Absence of a calendar keyword is NOT evidence that a clause has no date.
// Certify only these complete date-free forms. Arbitrary conversation (even
// an address or an unsupported greeting) remains reviewable office work.
// Do not add wildcard tails: they would reintroduce omitted-date bypasses.
const DATE_FREE = [
  /^(?:hello|hi|goodbye|bye|thanks|thank you|okay|ok|youre welcome)$/,
  /^(?:you are all set )?have a (?:good|great|nice) day$/,
  /^(?:i will|ill|we will|well|im going to|were going to|i am going to|we are going to) (?:text|send|email or text) (?:you )?(?:a|the|your) (?:reschedule |rescheduling )?link(?: for (?:that|your|the) appointment| to (?:pick|choose|book) a new time for your (?:current )?appointment| to (?:move|reschedule) your appointment)?$/,
  /^(?:please )?(?:text|send) (?:me )?(?:a|the|my) (?:reschedule |rescheduling )?link(?: for (?:that|my|the) appointment)?$/,
  /^let me text you a link to re-schedule that visit$/,
  /^i cannot send that link yet$/,
  /^(?:dont|do not) (?:email|text) (?:me )?(?:anything|the link|any links)(?: please)?$/,
  /^(?:dont|do not) email it text it$/,
  /^(?:actually )?text it to me$/,
  /^(?:i need|i want|i would like) to (?:move|reschedule) my appointment$/,
];

function transcriptDates(transcript, reference) {
  const dates = [];
  let complete = true;
  // Every sentence retains its turn's speaker. A caller's own delivery
  // statement must never supply timing for a Waves promise elsewhere.
  const clauses = String(transcript || '').replace(/\b(jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\./gi, '$1')
    .split('\n').flatMap(line => {
      const turn = /^\s*(agent|caller|customer):\s*(.*)$/i.exec(line);
      return (turn ? turn[2] : line).replace(/\?/g, ' question.').split(/[.!;]+/)
        .map(normalize).filter(Boolean).map(clause => ({ clause, speaker: turn?.[1].toLowerCase() }));
    });
  for (const { clause, speaker } of clauses) {
    const matches = [...clause.matchAll(DATE)];
    const shape = clause.replace(DATE, '@');
    if (!matches.length && DATE_FREE.some(pattern => pattern.test(clause))) continue;
    const roles = ROLES.find(([pattern]) => pattern.test(shape))?.[1];
    if (!roles || roles.length !== matches.length || (roles.includes('delivery') && speaker !== 'agent')) {
      complete = false;
      continue;
    }
    const proven = matches.map((match, i) => ({ text: match[0], clause, binding: roles[i], parts: components(match[0], reference),
      before: clause.slice(0, match.index), after: clause.slice(match.index + match[0].length) }));
    if (proven.some(date => !date.parts)) { complete = false; continue; }
    dates.push(...proven);
  }
  return { dates, complete };
}

function claimCoversDate(claim, date) {
  if (typeof claim?.quote !== 'string') return false;
  const quote = normalize(claim?.quote);
  if (!quote || !date.clause.includes(quote) || !quote.includes(date.text) || claim.binding !== date.binding) return false;
  return ['year', 'month', 'day', 'weekday'].every(key => claim[key] === date.parts[key]);
}

// Individually proved appointment identities keep separate office obligations
// distinct even when the call cannot be certified for automatic sending.
// These are NOT complete date_claims and never authorize a delivery.
function verifiedAppointmentIdentityClaims(claims, transcript, reference) {
  if (!Array.isArray(claims)) return [];
  const { dates } = transcriptDates(transcript, reference);
  return claims.flatMap(claim => {
    const date = dates.find(candidate => candidate.binding === 'appointment' && claimCoversDate(claim, candidate));
    return date ? [{ binding: 'appointment', quote: claim.quote.trim(), ...date.parts }] : [];
  });
}

// The transcript, not the model's list, establishes both coverage and roles.
// Called on extraction AND on persisted rows immediately before selection.
function verifyRescheduleDateClaims(claims, transcript, reference, timing = {}) {
  if (!Array.isArray(claims)) return false;
  const { dates, complete } = transcriptDates(transcript, reference);
  if (!complete) return false;
  const deliveryDates = dates.filter(date => date.binding === 'delivery');
  // An empty delivery list proves no timestamp, even when appointment dates
  // are present. Never let an invented floor delay a date-free promise.
  if (!deliveryDates.length && timing.due_at != null) return false;
  return deliveryDates.every(date => deliveryTimingMatches(date, timing, reference))
    && dates.every(date => claims.some(claim => claimCoversDate(claim, date)))
    && claims.every(claim => dates.some(date => claimCoversDate(claim, date)));
}

// The evidence grammar accepts weekday-qualified absolute dates and "Sept";
// the shared deadline parser does not. Normalize only after components() has
// validated the evidence, then retain every stated component in the result.
function parseProvenETDeadline(date, clockText, reference) {
  let dayText = date.text;
  if (date.parts.weekday !== undefined && (date.parts.month !== undefined || date.parts.year !== undefined)) {
    dayText = dayText.replace(new RegExp(`^${weekday}\\s+`), '');
  } else if (date.parts.weekday !== undefined && date.parts.day === undefined) {
    dayText = WEEKDAYS[date.parts.weekday];
  }
  dayText = dayText.replace(/^sept(?=\s)/, 'september');
  const proved = parseQuotedETDeadline(`${dayText} ${clockText}`, reference);
  if (!proved) return null;
  const parsed = etParts(proved);
  return ['year', 'month', 'day', 'weekday'].every(key => {
    if (date.parts[key] === undefined) return true;
    return date.parts[key] === (key === 'weekday' ? parsed.dayOfWeek : parsed[key]);
  }) ? proved : null;
}

// Calendar claims alone cannot prove a delivery floor: the independently
// extracted due_at/type might still say today, deadline, or nothing at all.
// Validate those proposals against the same complete delivery clause.
function deliveryTimingMatches(date, timing, reference) {
  const deadline = /\b(?:by|before|no later than) $/.test(date.before);
  // Untyped persisted rows retain their legacy conservative floor. New model
  // output is checked as an explicit floor when it omits the type, so it
  // cannot introduce a new untyped 'by' promise through this compatibility.
  if (!timing.due_at || (timing.due_type != null && (timing.due_type === 'deadline') !== deadline)) return false;
  const due = parseETDateTime(timing.due_at);
  if (Number.isNaN(due.getTime())) return false;
  const tail = date.after.split(' for ')[0].trim();
  if (tail.startsWith('at ')) {
    const numericClock = tail.replace(new RegExp(`^at (${HOURS.join('|')})(?= ?(?:am|pm)$)`), (_, word) => `at ${HOURS.indexOf(word) + 1}`);
    const proved = parseProvenETDeadline(date, numericClock, reference);
    return !!proved && due.getTime() === proved.getTime();
  }
  // A bare day proves no clock, so it cannot certify an arbitrary model time.
  // "Morning" uses the existing booking band, 08:00–12:00
  // (triage-auto-resolve). Other dayparts remain in review.
  if (tail !== 'morning') return false;
  const provedDay = parseProvenETDeadline(date, 'at 11:59 pm', reference);
  if (!provedDay) return false;
  const actual = etParts(due);
  const expected = etParts(provedDay);
  return ['year', 'month', 'day'].every(key => actual[key] === expected[key])
    && actual.hour >= 8 && actual.hour < 12;
}

module.exports = { verifyRescheduleDateClaims, verifiedAppointmentIdentityClaims };
