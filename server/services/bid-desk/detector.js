'use strict';

/**
 * Bid Desk detector and parser (GATE_BID_DESK). PURE: no database, no network, NO LLM.
 *
 * detectBidEmail(email)  is this stored email a bid invite, an addendum or a reminder for one?
 * parseBidEmail(email)   the fields we may read from it.
 *
 * Fields are read ONLY from the two fixed provider templates:
 *   BuildingConnected   "<GC> has invited you to bid on <Project>: <Package>", "Location: ...", "Job Walk: <date>",
 *                       "Bid Due: <date>", "Lead: <name> | <email>"
 *   Procore             "Bid Due: <weekday>, <date> at <time>", "Project Name <x>", "Bid Form Name <x>"
 * Every other email (a city RFQ, an HOA RFP, a portal notice) leaves the fields null: a date guessed out of free
 * text would become a deadline somebody trusts. A date we do read is stored with the exact line it came from.
 * Dates are America/New_York wall time; a date with no time is stored at 23:59 ET.
 */
const { parseETDateTime, validCalendarDate } = require('../../utils/datetime-et');

const OWN_ADDRESS = 'contact@wavespestcontrol.com';
const BC_DOMAIN = 'buildingconnected.com';
const PROCORE_DOMAIN = 'procoretech.com';
const PORTAL_DOMAINS = ['bonfirehub.com', 'opengov.com', 'demandstar.com', 'bidnetdirect.com'];
const GOV_SUFFIXES = ['.gov', '.fl.us'];
const INTERNAL_SUBJECT = /^\s*(?:FIX|ACT|FYI|OK)\s*:/;
const BID_WORDS = /\b(?:RFP|RFQ|ITB|IFB|ITN)\b|invitation to bid|bid invite|request for (?:proposal|quote|qualifications)|addend(?:um|ums|a)\b|pre-?bid/i;
// Subject patterns for the kind of message once an email is known to be about a bid.
const ADDENDUM_WORDS = /\baddend(?:um|ums|a)\b|\bdate change\b|\b(?:due date|deadline|bid date|bid due)\b.{0,40}\b(?:change[sd]?|extended|extension|revised|moved|postponed)\b|\b(?:extended|extension|revised|postponed)\b.{0,40}\b(?:due|deadline|bid)\b/i;
const PROVIDER_BID_BODY = /^\s*Bid Due\s*:|has invited you to bid on|sent your company a message about|invitation to bid/im;
const REMINDER_WORDS = /\breminder\b|\bdue (?:soon|tomorrow|today)\b|\bclosing soon\b|\blast chance\b/i;

const MONTH_INDEX = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_NAME = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
const TIME_TAIL = '(?:\\s*(?:,|at|@|by|-)?\\s*(\\d{1,2})(?::(\\d{2}))?\\s*([ap])\\.?m\\.?)?';
const NAMED_DATE = new RegExp(`\\b(${MONTH_NAME})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b${TIME_TAIL}`, 'i');
const NUMERIC_DATE = new RegExp(`\\b(\\d{1,2})/(\\d{1,2})/(\\d{4})\\b${TIME_TAIL}`, 'i');

const pad = (n) => String(n).padStart(2, '0');

// "Friday, September 25, 2026 at 12:00 pm" -> { at: Date, hasTime }. null when no complete, real date is in the text.
function parseDateET(text, { defaultTime = '23:59' } = {}) {
  const raw = String(text || '');
  let year; let month; let day; let hourText; let minuteText; let meridiem;
  const named = NAMED_DATE.exec(raw);
  if (named) {
    month = MONTH_INDEX[named[1].slice(0, 3).toLowerCase()];
    day = Number(named[2]);
    year = Number(named[3]);
    [, , , , hourText, minuteText, meridiem] = named;
  } else {
    const numeric = NUMERIC_DATE.exec(raw);
    if (!numeric) return null;
    month = Number(numeric[1]);
    day = Number(numeric[2]);
    year = Number(numeric[3]);
    [, , , , hourText, minuteText, meridiem] = numeric;
  }
  const ymd = `${year}-${pad(month)}-${pad(day)}`;
  if (!validCalendarDate(ymd)) return null;
  let hhmm = defaultTime;
  let hasTime = false;
  if (hourText != null) {
    const hour12 = Number(hourText);
    const minute = minuteText == null ? 0 : Number(minuteText);
    if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
    const hour = (hour12 % 12) + (meridiem.toLowerCase() === 'p' ? 12 : 0);
    hhmm = `${pad(hour)}:${pad(minute)}`;
    hasTime = true;
  }
  const at = parseETDateTime(`${ymd}T${hhmm}`);
  return Number.isNaN(at.getTime()) ? null : { at, hasTime };
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function htmlToText(html) {
  return String(html || '')
    .replace(/<(?:style|script)[\s\S]*?<\/(?:style|script)>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(?:p|div|tr|li|h[1-6]|table|ul|ol)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, code) => {
      if (code[0] === '#') {
        const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : ' ';
      }
      return ENTITIES[code.toLowerCase()] ?? whole;
    });
}

function bodyText(email) {
  return String(email.body_text || '').trim() ? String(email.body_text) : htmlToText(email.body_html);
}

function bodyLines(email) {
  const text = String(email.body_text || '').trim() ? String(email.body_text) : htmlToText(email.body_html);
  return text.split(/\r?\n/).map((line) => line.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean);
}

const domainOf = (address) => {
  const at = String(address || '').toLowerCase().trim().lastIndexOf('@');
  return at === -1 ? '' : String(address).toLowerCase().trim().slice(at + 1).replace(/[>\s]+$/, '');
};
const inDomain = (domain, root) => domain === root || domain.endsWith(`.${root}`);

function senderKind(email) {
  const domain = domainOf(email.from_address);
  if (inDomain(domain, BC_DOMAIN)) return 'buildingconnected';
  if (inDomain(domain, PROCORE_DOMAIN)) return 'procore';
  if (PORTAL_DOMAINS.some((root) => inDomain(domain, root)) || GOV_SUFFIXES.some((suffix) => domain.endsWith(suffix))) {
    return 'gov_email';
  }
  return null;
}

function classifyKind(email) {
  const subject = String(email.subject || '');
  if (ADDENDUM_WORDS.test(subject)) return 'addendum';
  if (REMINDER_WORDS.test(subject)) return 'reminder';
  return 'invite';
}

/**
 * { bid: boolean, source, kind, reason }. `source` is the bid_opportunities.source value this email would create.
 * Our own mail, internal ops mail and GitHub notifications are never bids.
 */
function detectBidEmail(email = {}) {
  const from = String(email.from_address || '').toLowerCase().trim();
  const subject = String(email.subject || '');
  if (from === OWN_ADDRESS) return { bid: false, reason: 'own_mail' };
  if (INTERNAL_SUBJECT.test(subject)) return { bid: false, reason: 'internal_mail' };
  const domain = domainOf(from);
  if (inDomain(domain, 'github.com') || from.endsWith('@github.com')) return { bid: false, reason: 'github' };

  const sender = senderKind(email);
  const bidWords = BID_WORDS.test(subject);
  let source = null;
  // BuildingConnected / Procore also send account and marketing mail: a bid needs a bid line in the body or bid
  // words in the subject.
  if ((sender === 'buildingconnected' || sender === 'procore') && (bidWords || PROVIDER_BID_BODY.test(subject) || PROVIDER_BID_BODY.test(bodyText(email)))) {
    source = sender;
  } else if (sender === 'buildingconnected' || sender === 'procore') return { bid: false, reason: 'provider_not_bid' };
  else if (sender === 'gov_email' && bidWords) source = 'gov_email';
  else if (bidWords) source = 'email_subject';
  if (!source) return { bid: false, reason: 'not_bid' };
  return { bid: true, source, kind: classifyKind(email), reason: 'matched' };
}

// ---------- parsing ----------

// The value after a label on the same line ("Label: value" or, with allowBare, "Label value").
function labelledValues(lines, label, { allowBare = false } = {}) {
  const re = new RegExp(`^${label}\\s*${allowBare ? ':?' : ':'}\\s*(.+)$`, 'i');
  return lines.flatMap((line, index) => {
    const m = re.exec(line);
    return m ? [{ line, value: m[1].trim(), index }] : [];
  });
}

// "Project Name" on a line alone, then the value on the next line (a table that lost its cell break).
function labelledValue(lines, label) {
  const sameLine = labelledValues(lines, label, { allowBare: true })[0];
  if (sameLine) return sameLine.value;
  const alone = lines.findIndex((line) => new RegExp(`^${label}\\s*:?$`, 'i').test(line));
  return alone !== -1 && lines[alone + 1] ? lines[alone + 1] : null;
}

function firstDate(matches, defaultTime) {
  for (const match of matches) {
    const parsed = parseDateET(match.value, { defaultTime });
    if (parsed) return { ...parsed, line: match.line };
  }
  return null;
}

// "<Person> from <GC> has invited you to bid on <Project>: <Package>" or "<Person> of <GC> sent your company a message
// about <Project>: <Package>". The project often sits on the NEXT line (the template breaks after "bid on").
const BC_INVITE = /^(.{1,200}?)\s+has invited you to bid on:?\s*(.*)$/i;
const BC_MESSAGE = /^(.{1,200}?)\s+sent your company a message about:?\s*(.*)$/i;
const BC_PERSON_ORG = /^(.{1,80}?)\s+(?:from|of)\s+(.{2,160})$/i;
const EMAIL_IN_LINE = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i;

function splitProjectPackage(text) {
  const rest = String(text || '').trim().replace(/\.$/, '');
  if (!rest) return { project_title: null, package_name: null };
  const split = rest.lastIndexOf(': ');
  return {
    project_title: (split > 0 ? rest.slice(0, split) : rest).trim() || null,
    package_name: split > 0 ? rest.slice(split + 2).trim() || null : null,
  };
}

function parseBuildingConnected(lines) {
  const out = {};
  let index = -1;
  let match = null;
  for (const re of [BC_INVITE, BC_MESSAGE]) {
    index = lines.findIndex((line) => re.test(line));
    if (index !== -1) { match = re.exec(lines[index]); break; }
  }
  if (match) {
    const who = BC_PERSON_ORG.exec(match[1].trim());
    if (who) {
      out.buyer_name = who[1].trim();
      out.gc_or_agency = who[2].trim();
    } else {
      out.gc_or_agency = match[1].trim();
    }
    const projectText = match[2].trim() || lines[index + 1] || '';
    Object.assign(out, splitProjectPackage(projectText));
  }
  const location = labelledValues(lines, 'Location')[0];
  if (location) out.location = location.value;
  // "Lead: <name> | <email>" on one line, or "Lead: <name>" with the email on the next line
  // ("Estimator • name@gc.com"). The "Sender Details" block of a message names the person, then the email.
  const leadIndex = lines.findIndex((line) => /^Lead\s*:/i.test(line));
  if (leadIndex !== -1) {
    const sameLine = /^Lead\s*:\s*(.+?)(?:\s*\|\s*(\S+@\S+))?\s*$/i.exec(lines[leadIndex]);
    if (sameLine) out.buyer_name = sameLine[1].replace(EMAIL_IN_LINE, '').replace(/[|•]\s*$/, '').trim() || out.buyer_name;
    const emailMatch = EMAIL_IN_LINE.exec(lines[leadIndex]) || EMAIL_IN_LINE.exec(lines[leadIndex + 1] || '');
    if (emailMatch) out.buyer_email = emailMatch[1].toLowerCase();
  } else {
    const sender = lines.findIndex((line) => /^Sender Details$/i.test(line));
    if (sender !== -1) {
      const emailMatch = lines.slice(sender + 1, sender + 4).map((line) => EMAIL_IN_LINE.exec(line)).find(Boolean);
      if (emailMatch) out.buyer_email = emailMatch[1].toLowerCase();
    }
  }
  return out;
}

// "<Person> from <GC> has invited you to bid on project <Project> (<Package>)."
const PROCORE_INVITE = /^(.{1,80}?)\s+from\s+(.{2,160}?)\s+has invited you to bid on project\b/i;

function parseProcore(lines) {
  const out = {};
  const invite = lines.map((line) => PROCORE_INVITE.exec(line)).find(Boolean);
  if (invite) {
    out.buyer_name = invite[1].trim();
    out.gc_or_agency = invite[2].trim();
  }
  const project = labelledValue(lines, 'Project Name');
  if (project) out.project_title = project;
  const form = labelledValue(lines, 'Bid Form Name');
  if (form) out.package_name = form;
  // "Client Details" then "<Person> - <email>".
  const client = lines.findIndex((line) => /^Client Details$/i.test(line));
  if (client !== -1) {
    const emailMatch = EMAIL_IN_LINE.exec(lines[client + 1] || '');
    if (emailMatch) out.buyer_email = emailMatch[1].toLowerCase();
  }
  return out;
}

const normalizeTitle = (title) => String(title || '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// A subject with reply, forward, addendum and reminder markers removed: grouping only, never stored as a title.
function subjectForGrouping(subject) {
  return String(subject || '')
    .replace(/^\s*(?:(?:re|fwd?)\s*:\s*)+/i, '')
    .replace(/\b(?:addendum|addendums|addenda)\s*(?:no\.?|#)?\s*\d*\s*[:\-–]?/ig, ' ')
    .replace(/\breminder\s*[:\-–]?/ig, ' ');
}

function senderOrg(email, gc) {
  const named = gc || String(email.from_name || '').replace(/\s+via\s+.*$/i, '').replace(/["']/g, '').trim();
  return normalizeTitle(named || domainOf(email.from_address));
}

/**
 * The fields readable from this email. Every key is present; anything not read from a fixed template is null.
 * due_source_line is the exact body line the due date came from (null when no due date was read).
 */
function parseBidEmail(email = {}) {
  const detected = detectBidEmail(email);
  const template = senderKind(email) === 'buildingconnected' ? 'buildingconnected'
    : senderKind(email) === 'procore' ? 'procore' : null;
  const lines = template ? bodyLines(email) : [];
  const fields = template === 'buildingconnected' ? parseBuildingConnected(lines)
    : template === 'procore' ? parseProcore(lines) : {};
  let due = null;
  let jobWalk = null;
  if (template) {
    due = firstDate(labelledValues(lines, 'Bid Due', { allowBare: template === 'procore' }), '23:59');
    jobWalk = firstDate(labelledValues(lines, 'Job Walk'), '23:59');
  }
  const groupTitle = normalizeTitle(fields.project_title || subjectForGrouping(email.subject));
  const org = senderOrg(email, fields.gc_or_agency);
  return {
    template,
    source: detected.source || null,
    kind: detected.kind || classifyKind(email),
    buyer_name: fields.buyer_name || null,
    buyer_email: fields.buyer_email || null,
    gc_or_agency: fields.gc_or_agency || null,
    project_title: fields.project_title || null,
    package_name: fields.package_name || null,
    solicitation_number: null,
    location: fields.location || null,
    due_at: due ? due.at : null,
    due_source_line: due ? due.line : null,
    job_walk_at: jobWalk ? jobWalk.at : null,
    questions_due_at: null,
    org,
    group_key: org && groupTitle ? `${org}|${groupTitle}` : null,
  };
}

module.exports = {
  detectBidEmail, parseBidEmail, parseDateET, htmlToText, normalizeTitle, senderOrg, classifyKind, domainOf,
  BID_WORDS, ADDENDUM_WORDS,
};
