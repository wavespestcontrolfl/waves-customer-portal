'use strict';

/**
 * Bid Desk detector and parser (GATE_BID_DESK). PURE: no database, no network, NO LLM.
 *
 * detectBidEmail(email)  is this stored email a bid invite, an addendum or a reminder for one?
 * parseBidEmail(email)   the fields we may read from it.
 *
 * Fields are read ONLY from the fixed provider templates:
 *   BuildingConnected   "<GC> has invited you to bid on <Project>: <Package>", "Location: ...", "Job Walk: <date>",
 *                       "Bid Due: <date>", "Lead: <name> | <email>"
 *   Procore             "Bid Due: <weekday>, <date> at <time>", "Project Name <x>", "Bid Form Name <x>"
 *   VendorLink          "SOLICITATION NOTIFICATION", then the agency's name and address, then "BID NUMBER: <x>",
 *                       "BID TITLE: <x>", "BID OPENING DUE DATE/TIME: <mm/dd/yyyy> at <h:mm AM>, Local Time, <city>"
 *                       (or SOLICITATION NUMBER / TITLE / OPENING DUE DATE/TIME)
 *   Blue Book (ONETEAM) "Bid is due by <h:mm AM> (<Eastern|Central|Mountain|Pacific>) on <Month d, yyyy>",
 *                       "You've been invited to bid on a - <Project> in <City, ST>.", "We are looking for <trade>.",
 *                       "<GC> is sharing this project opportunity with you through The Blue Book Network's ONETEAM."
 *   OpenGov             "<Agency> has invited you to the following opportunity:" or "<Agency> has just released the
 *                       following opportunity:", then the title on the next line (no number, no dates)
 *   Charlotte County    "Addendum Notification for <Bid|Quote> <26-676>", "An addendum has been added to Charlotte County
 *                       Purchasing Request for <Bid|Quote>: <20260676> - <Title>", the division's address in the header
 * A Blue Book "Project Notification" (the network's own pick of a project, not a contractor's invite) is never a bid.
 * OpenGov sends both notices by the vendor's registered categories (a "direct invite" to build cemetery columbaria came
 * the day we registered), so an OpenGov notice is a bid only when its title names our trade (TRADE_WORDS). Charlotte
 * County's notices follow the commodity codes we registered and are filed as before; the template only adds the keys.
 * A VendorLink broadcast can come from any agency in the country, so one is a bid only when the agency's address is
 * in the Tampa Bay to Southwest Florida ZIP areas (the same ones the SAM.gov reader files). Its "Vendor Commodity
 * Code Changed" list (every open bid that loosely matches, sent when the codes change) is never a bid.
 * Every other email (a city RFQ, an HOA RFP, a portal notice) leaves the fields null: a date guessed out of free
 * text would become a deadline somebody trusts. A date we do read is stored with the exact line it came from.
 * Dates are America/New_York wall time; a date with no time is stored at 23:59 ET.
 */
const { parseETDateTime, validCalendarDate } = require('../../utils/datetime-et');

const OWN_ADDRESS = 'contact@wavespestcontrol.com';
const BC_DOMAIN = 'buildingconnected.com';
const PROCORE_DOMAIN = 'procoretech.com';
const VENDORLINK_DOMAIN = 'myvendorlink.com';
const BLUEBOOK_DOMAIN = 'thebluebook.com';
const OPENGOV_DOMAIN = 'opengov.com';
const CHARLOTTE_DOMAIN = 'charlottecountyfl.gov';
const PORTAL_DOMAINS = ['bonfirehub.com', 'opengov.com', 'demandstar.com', 'bidnetdirect.com', 'internationaleprocurement.com', 'myflorida.com'];
const GOV_SUFFIXES = ['.gov', '.fl.us'];
const INTERNAL_SUBJECT = /^\s*(?:FIX|ACT|FYI|OK)\s*:/;
const BID_WORDS = /\b(?:RFP|RFQ|ITB|IFB|ITN)\b|invitation to bid|bid invite|request for (?:proposal|quote|qualifications)|addend(?:um|ums|a)\b|pre-?bid/i;
// Subject patterns for the kind of message once an email is known to be about a bid.
const ADDENDUM_WORDS = /\baddend(?:um|ums|a)\b|\bdate change\b|\b(?:due date|deadline|bid date|bid due)\b.{0,40}\b(?:change[sd]?|extended|extension|revised|moved|postponed)\b|\b(?:extended|extension|revised|postponed)\b.{0,40}\b(?:due|deadline|bid)\b/i;
const PROVIDER_BID_BODY = /^\s*Bid Due\s*:|has invited you to bid on|sent your company a message about|invitation to bid/im;
// VendorLink's notice: the subject says only "Solicitation Broadcast", the body opens with this line.
const VENDORLINK_NOTICE = /^\s*SOLICITATION NOTIFICATION\s*$/im;
// Sent when the vendor's codes change: a catch-up list of every open bid that loosely matches, not a new posting.
const VENDORLINK_CATCH_UP = /\bVendor Commodity Code Changed\b/i;
// The agency address block, before the first labelled field: "<City>, FL 34231". ZIP areas as the SAM.gov reader.
const AREA_ZIP = /\b(?:FL|FLORIDA)\.?,?\s+(33[5-9]\d\d|34[12]\d\d)(?:-\d{4})?\b/i;
// Blue Book invite lines. The apostrophe may be straight or curly; the "a -" before the project is the template's.
const BB_INVITED = /^You[\u2019']ve been invited to bid on\s+(?:an?\s*-\s*)?(.+?)\.?$/i;
const BB_DUE = /^Bid is due by (\d{1,2}):(\d{2})\s*([AP])\.?M\.?\s*\((Eastern|Central|Mountain|Pacific)\)\s+on\s+(.+)$/i;
const BB_SHARING = /^(.{2,160}?) is sharing this project opportunity with you\b/i;
const BB_LOOKING = /^We are looking for:?\s*(.*)$/i;
// Hours to add to the GC's wall time to reach Eastern time (the US zones change clocks on the same dates).
const BB_ZONE_HOURS = { eastern: 0, central: 1, mountain: 2, pacific: 3 };
const REMINDER_WORDS = /\breminder\b|\bdue (?:soon|tomorrow|today)\b|\bclosing soon\b|\blast chance\b/i;
// OpenGov notice line ("<Agency> has invited you to ..." or "<Agency> has just released ..."); the title is the next line.
const OG_NOTICE = /^(.{2,160}?) has (?:invited you to|just released) the following opportunity:?$/i;
// Work we bid on, read from an OpenGov broadcast title ("Pest Control Services", "Mole Cricket Application",
// "Grounds Maintenance", "Lot Mowing"). A title without one of these is another trade's work.
const TRADE_WORDS = /\b(?:pests?|termites?|mosquito(?:es)?|rodents?|rats?|exterminat\w*|fumigat\w*|insects?|insecticides?|bed ?bugs?|wildlife|mole crickets?|lawns?|turf|weeds?|herbicides?|fertiliz\w*|landscap\w*|grounds|mow(?:ing)?|vegetation|trees?|shrubs?)\b/i;
// Charlotte County Purchasing notice lines.
const CC_NOTICE = /^Addendum Notification for (?:Bid|Quote|Proposal|RFP|RFQ|ITB|ITN)\s+(\d{2}-\d{2,5})$/i;
const CC_ADDED = /^An addendum has been added to Charlotte County Purchasing Request for (?:Bid|Quote|Proposal)s?\s*:\s*(?:\d{6,10}\s*-\s*)?(.+?)\.?$/i;
const CC_DIVISION = /^Charlotte County Purchasing\b/i;

const MONTH_INDEX = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_NAME = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
const TIME_TAIL = '(?:\\s*(?:,|at|@|by|-)?\\s*(\\d{1,2})(?::(\\d{2}))?\\s*([ap])\\.?m\\.?)?';
const NAMED_DATE = new RegExp(`\\b(${MONTH_NAME})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b${TIME_TAIL}`, 'i');
const NUMERIC_DATE = new RegExp(`\\b(\\d{1,2})/(\\d{1,2})/(\\d{4})\\b${TIME_TAIL}`, 'i');

const pad = (n) => String(n).padStart(2, '0');
const KEY_PART_MAX = 160;
// A long key part keeps a readable head plus a hash of the WHOLE part, so two long names that share a head stay
// two keys and the indexed key stays far below PostgreSQL's B-tree entry limit.
function keyPart(text) {
  const value = String(text || '');
  if (value.length <= KEY_PART_MAX) return value;
  const hash = require('crypto').createHash('sha256').update(value).digest('hex').slice(0, 16);
  return `${value.slice(0, KEY_PART_MAX - 18)}~${hash}`;
}

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

// Blue Book's text part is only a stub ("IF you can't see this email login to ..."); the invite is in the HTML
// part. Its lines are both parts, text first.
function bluebookLines(email) {
  const html = htmlToText(email.body_html).split(/\r?\n/).map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim()).filter(Boolean);
  return [...(String(email.body_text || '').trim() ? bodyLines(email) : []), ...html];
}

const domainOf = (address) => {
  const at = String(address || '').toLowerCase().trim().lastIndexOf('@');
  return at === -1 ? '' : String(address).toLowerCase().trim().slice(at + 1).replace(/[>\s]+$/, '');
};
const inDomain = (domain, root) => domain === root || domain.endsWith(`.${root}`);

// A provider template is trusted only when the caller has verified the mail really came from the provider
// (`provider_verified`: aligned SPF/DKIM in Gmail's stored Authentication-Results, checked by the intake). A forged
// "BuildingConnected" message is then read like any plain email: no template fields, no cross-thread grouping.
function senderKind(email) {
  const domain = domainOf(email.from_address);
  const verified = email.provider_verified === true;
  if (inDomain(domain, BC_DOMAIN)) return verified ? 'buildingconnected' : null;
  if (inDomain(domain, PROCORE_DOMAIN)) return verified ? 'procore' : null;
  if (inDomain(domain, VENDORLINK_DOMAIN)) return verified ? 'vendorlink' : null;
  if (inDomain(domain, BLUEBOOK_DOMAIN)) return verified ? 'bluebook' : null;
  // OpenGov and Charlotte County templates trust only the strict reading (`provider_verified_strict`: resinfo clauses
  // or Google's DMARC pass; the loose one can be fooled by a quoted MAIL FROM). Anything less falls through to plain
  // government mail (bid words in the subject).
  const strict = email.provider_verified_strict === true;
  if (strict && inDomain(domain, OPENGOV_DOMAIN)) return 'opengov';
  if (strict && inDomain(domain, CHARLOTTE_DOMAIN)) return 'charlotte_county';
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

  const { source, reason } = bidSource(email, senderKind(email), BID_WORDS.test(subject));
  if (!source) return { bid: false, reason };
  return { bid: true, source, kind: classifyKind(email), reason: 'matched' };
}

// Senders whose bid-word mail is government mail (Charlotte County keeps its source; the template adds only keys).
const GOV_SENDERS = new Set(['gov_email', 'charlotte_county']);

// The source a bid from this sender would carry, or why the email is not a bid.
function bidSource(email, sender, bidWords) {
  const subject = String(email.subject || '');
  // BuildingConnected / Procore also send account and marketing mail: a bid needs a bid line in the body or bid
  // words in the subject.
  if (sender === 'buildingconnected' || sender === 'procore') {
    return bidWords || PROVIDER_BID_BODY.test(subject) || PROVIDER_BID_BODY.test(bodyText(email))
      ? { source: sender } : { reason: 'provider_not_bid' };
  }
  if (sender === 'vendorlink') {
    if (VENDORLINK_CATCH_UP.test(subject)) return { reason: 'catch_up_list' };
    const notice = vendorlinkNotice(bodyLines(email));
    if (!notice) return { reason: 'provider_not_bid' };
    return notice.inArea ? { source: 'gov_email' } : { reason: 'outside_area' };
  }
  if (sender === 'bluebook') {
    // A contractor's invite, reminder or addendum carries the invite line; the network's own "Project Notification"
    // and account mail do not.
    return bluebookLines(email).some((line) => BB_INVITED.test(line) || BB_DUE.test(line))
      ? { source: 'bluebook' } : { reason: 'provider_not_bid' };
  }
  if (sender === 'opengov') {
    // Its notices carry no bid words. Bid words in the subject still file it as before; otherwise a notice needs our
    // trade in its title, and account mail or any other OpenGov wording is not a bid.
    if (bidWords) return { source: 'gov_email' };
    const notice = opengovNotice(bodyLines(email));
    if (notice) return TRADE_WORDS.test(notice.title) ? { source: 'gov_email' } : { reason: 'outside_trade' };
    return { reason: 'provider_not_bid' };
  }
  if (bidWords) return { source: GOV_SENDERS.has(sender) ? 'gov_email' : 'email_subject' };
  return { reason: 'not_bid' };
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

// The notice header (agency name and address) runs from "SOLICITATION NOTIFICATION" to the first labelled line.
const VL_LABEL = /^(?:BID|SOLICITATION|PROPOSAL|RFP|RFQ|ITB)\b[^:]{0,40}:/i;
function vendorlinkNotice(lines) {
  const start = lines.findIndex((line) => VENDORLINK_NOTICE.test(line));
  if (start === -1) return null;
  const end = lines.findIndex((line, i) => i > start && VL_LABEL.test(line));
  const header = lines.slice(start + 1, end === -1 ? start + 6 : end);
  return { header, inArea: header.some((line) => AREA_ZIP.test(line)) };
}

function parseVendorLink(lines) {
  const notice = vendorlinkNotice(lines);
  if (!notice) return {};
  const value = (re) => lines.map((line) => re.exec(line)).find(Boolean)?.[1]?.trim() || null;
  const out = {
    gc_or_agency: notice.header[0] || null,
    location: notice.header.find((line) => AREA_ZIP.test(line)) || null,
    solicitation_number: value(/^(?:BID|SOLICITATION|PROPOSAL)\s+NUMBER\s*:\s*(.+)$/i),
    project_title: value(/^(?:BID|SOLICITATION|PROPOSAL)\s+TITLE\s*:\s*(.+)$/i),
  };
  const agent = lines.find((line) => /^PURCHASING AGENT\s*:/i.test(line));
  const email = agent && EMAIL_IN_LINE.exec(agent);
  if (email) out.buyer_email = email[1].toLowerCase();
  return out;
}

// "BID OPENING DUE DATE/TIME:" with the date on the same line or alone on the next one; the date line is the source.
function vendorlinkDue(lines) {
  const label = /^(?:BID|SOLICITATION|PROPOSAL) OPENING DUE DATE\/TIME\s*:\s*(.*)$/i;
  const index = lines.findIndex((line) => label.test(line));
  if (index === -1) return null;
  const rest = label.exec(lines[index])[1].trim();
  const line = rest ? lines[index] : lines[index + 1] || '';
  return firstDate([{ line, value: rest || line }], '23:59');
}

// "You've been invited to bid on a - Gas Station Project in Sampleton, FL." The whole phrase is the title (one GC
// can invite to two gas stations); the place after the last " in " is the location.
function parseBlueBook(lines) {
  const out = {};
  const invited = lines.map((line) => BB_INVITED.exec(line)).find(Boolean);
  if (invited) {
    out.project_title = invited[1].trim();
    const place = / in ([^,]{2,80},\s*[A-Z]{2})$/i.exec(out.project_title);
    if (place) out.location = place[1];
  }
  const sharing = lines.map((line) => BB_SHARING.exec(line)).find(Boolean);
  if (sharing) out.gc_or_agency = sharing[1].trim();
  // "We are looking for" with the trade on the same line or alone on the next one.
  const looking = lines.findIndex((line) => BB_LOOKING.test(line));
  if (looking !== -1) {
    const trade = BB_LOOKING.exec(lines[looking])[1].trim() || lines[looking + 1] || '';
    out.package_name = trade.replace(/\.$/, '').trim() || null;
  }
  return out;
}

// "Bid is due by 5:00 PM (Pacific) on September 14, 2026": the GC's time zone is named, so the time is moved to ET.
function bluebookDue(lines) {
  for (const line of lines) {
    const m = BB_DUE.exec(line);
    if (!m) continue;
    const parsed = parseDateET(`${m[5]} ${m[1]}:${m[2]} ${m[3]}m`);
    if (!parsed || !parsed.hasTime) return null;
    const hours = BB_ZONE_HOURS[m[4].toLowerCase()];
    return { at: new Date(parsed.at.getTime() + hours * 3600 * 1000), hasTime: true, line };
  }
  return null;
}

// The OpenGov notice (an invite or a release): the agency, and the title on the line after.
function opengovNotice(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    const match = OG_NOTICE.exec(lines[i]);
    if (match && lines[i + 1]) return { agency: match[1].trim(), title: lines[i + 1].trim() };
  }
  return null;
}

function parseOpenGov(lines) {
  const notice = opengovNotice(lines);
  return notice ? { gc_or_agency: notice.agency, project_title: notice.title } : {};
}

// "Addendum Notification for Bid 26-676", then "... Request for Bid: 20260676 - <Title>". The division's address line
// (with its phone number dropped) is the location.
function parseCharlotteCounty(lines) {
  const out = {};
  const value = (re) => lines.map((line) => re.exec(line)).find(Boolean)?.[1]?.trim() || null;
  out.solicitation_number = value(CC_NOTICE);
  out.project_title = value(CC_ADDED);
  if (!out.solicitation_number || !out.project_title) return {};
  out.gc_or_agency = lines.find((line) => CC_DIVISION.test(line)) || null;
  const address = lines.find((line) => AREA_ZIP.test(line));
  if (address) out.location = address.replace(/\s+\(?\d{3}\)?[-. ]\d{3}[-.]\d{4}$/, '').trim();
  return out;
}

const normalizeTitle = (title) => String(title || '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const TEMPLATE_PARSERS = {
  buildingconnected: parseBuildingConnected, procore: parseProcore, vendorlink: parseVendorLink, bluebook: parseBlueBook,
  opengov: parseOpenGov, charlotte_county: parseCharlotteCounty,
};

// The cross-thread identity of a bid. Only a provider template names the GC and the project (read only when the
// sender is the provider's own domain), so only a template email groups across threads: every other email (a city
// RFQ, an HOA RFP, a portal notice titled "Invitation to Bid") groups by its own Gmail thread and nothing else.
// A display name or a generic subject is never an identity. The package is part of the key (one project can carry
// Termite Treatment and Access Control); group_base lets a later email that names no package join the project's
// only bid. Long parts are bounded with a hash (keyPart).
function groupKeys(fields) {
  const org = normalizeTitle(fields.gc_or_agency);
  const title = normalizeTitle(fields.project_title);
  if (!org || !title) return { org: org || null, group_base: null, group_key: null };
  // A template that names the solicitation number (VendorLink) keeps two solicitations of one agency and title (a
  // yearly re-bid) apart; a repeat notice of the same number still joins its bid.
  const number = normalizeTitle(fields.solicitation_number);
  const base = `${keyPart(org)}|${keyPart(title)}${number ? `|${keyPart(number)}` : ''}`;
  const pkg = normalizeTitle(fields.package_name);
  return { org, group_base: base, group_key: pkg ? `${base}#${keyPart(pkg)}` : base };
}

function templateFields(template, lines) {
  if (!template) return { fields: {}, due: null, jobWalk: null };
  const due = { vendorlink: vendorlinkDue, bluebook: bluebookDue }[template];
  return {
    fields: TEMPLATE_PARSERS[template](lines),
    due: due ? due(lines) : firstDate(labelledValues(lines, 'Bid Due', { allowBare: template === 'procore' }), '23:59'),
    jobWalk: firstDate(labelledValues(lines, 'Job Walk'), '23:59'),
  };
}

/**
 * The fields readable from this email. Every key is present; anything not read from a fixed template is null.
 * due_source_line is the exact body line the due date came from (null when no due date was read).
 */
function parseBidEmail(email = {}) {
  const detected = detectBidEmail(email);
  const kindOfSender = senderKind(email);
  const template = TEMPLATE_PARSERS[kindOfSender] ? kindOfSender : null;
  const lines = { bluebook: bluebookLines }[template] || (template ? bodyLines : () => []);
  const { fields, due, jobWalk } = templateFields(template, lines(email));
  const pick = (key) => fields[key] || null;
  return {
    template,
    source: detected.source || null,
    kind: detected.kind || classifyKind(email),
    buyer_name: pick('buyer_name'),
    buyer_email: pick('buyer_email'),
    gc_or_agency: pick('gc_or_agency'),
    project_title: pick('project_title'),
    package_name: pick('package_name'),
    solicitation_number: pick('solicitation_number'),
    location: pick('location'),
    due_at: due?.at || null,
    due_source_line: due?.line || null,
    job_walk_at: jobWalk?.at || null,
    questions_due_at: null,
    ...groupKeys(fields),
  };
}

// Gmail files Blue Book invites as spam (every one through Oct 2026). Only a Blue Book email whose signature passes
// the STRICT check (`gmail_spam_verified`, set by the intake) may be read past Gmail's SPAM label: the loose check
// can be fooled by a sender-typed MAIL FROM. The detector still decides whether it is a bid.
const passesGmailSpam = (email = {}) => email.gmail_spam_verified === true && senderKind(email) === 'bluebook';

module.exports = {
  detectBidEmail, passesGmailSpam, parseBidEmail, parseDateET, htmlToText, normalizeTitle, classifyKind, domainOf,
  BID_WORDS, ADDENDUM_WORDS,
};
