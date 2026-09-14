const { etParts, addETDays, validCalendarDate } = require('../utils/datetime-et');

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
const clock = '(?: (?:morning|afternoon|evening|at (?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon|midnight|[0-9:]+)(?: ?(?:am|pm))?))?';
// Anchored whole-clause forms prove roles without trusting the model's label.
// Corrections, negations, conditionals, ranges and unrecognised mixed clauses
// deliberately have no matching production and remain office work.
const ROLES = [
  [new RegExp(`^${appointment}@ appointment$`), ['appointment']],
  [new RegExp(`^${appointment}appointment (?:is |is on |on )?@$`), ['appointment']],
  [new RegExp(`^(?:please )?move ${appointment}@ appointment to @$`), ['appointment', 'requested']],
  [new RegExp(`^${appointment}@ appointment needs to move to @$`), ['appointment', 'requested']],
  [new RegExp(`^${delivery} (?:on |by )?@${clock}(?: for that appointment)?$`), ['delivery']],
  [new RegExp(`^${delivery} (?:on |by )?@${clock} for ${appointment}@ appointment$`), ['delivery', 'appointment']],
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
  // Preserve turn boundaries and sentence punctuation before normalizing.
  const clauses = String(transcript || '').replace(/\b(jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\./gi, '$1')
    .replace(/\?/g, ' question.').split(/[.!;\n]+/).map(text => normalize(text.replace(/^\s*(?:agent|caller|customer):\s*/i, ''))).filter(Boolean);
  for (const clause of clauses) {
    const matches = [...clause.matchAll(DATE)];
    const shape = clause.replace(DATE, '@');
    if (!matches.length && DATE_FREE.some(pattern => pattern.test(clause))) continue;
    const roles = ROLES.find(([pattern]) => pattern.test(shape))?.[1];
    if (!roles || roles.length !== matches.length) return null;
    for (let i = 0; i < matches.length; i++) {
      const parts = components(matches[i][0], reference);
      if (!parts) return null;
      dates.push({ text: matches[i][0], clause, binding: roles[i], parts });
    }
  }
  return dates;
}

// The transcript, not the model's list, establishes both coverage and roles.
// Called on extraction AND on persisted rows immediately before selection.
function verifyRescheduleDateClaims(claims, transcript, reference) {
  if (!Array.isArray(claims)) return false;
  const dates = transcriptDates(transcript, reference);
  if (!dates) return false;
  const covers = (claim, date) => {
    const quote = normalize(claim?.quote);
    if (!quote || !date.clause.includes(quote) || !quote.includes(date.text) || claim.binding !== date.binding) return false;
    return ['year', 'month', 'day', 'weekday'].every(key => claim[key] === date.parts[key]);
  };
  return dates.every(date => claims.some(claim => covers(claim, date)))
    && claims.every(claim => dates.some(date => covers(claim, date)));
}

module.exports = { verifyRescheduleDateClaims };
