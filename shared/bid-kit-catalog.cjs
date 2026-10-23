'use strict';

// Bid kit catalog (GATE_BID_KIT, dark, admin only). The list of papers and facts a government bid asks for, in the order
// the owner works through them, plus the pure status rule. Used by the server (server/routes/admin-bid-kit.js,
// server/services/bid-kit-*.js) and by the admin page (client alias @bid-kit-catalog). No I/O, no clock reads except
// the default `now` of etToday().
//
// The catalog lives in code, so the table has no seed rows: a row is created when the owner fills an item.
// Never store, parse or display a FEIN/EIN or SSN here. The W-9 file is the only place one lives.

// Evidence for the first section: Sarasota County Schools bid 24-0118 (May 2024) rejected 3 of 5 bids, the lowest
// included, for a missing business license copy, state employee ID cards, the certified operator's certificate and
// renewal, a notarized statement that the certified operator works full-time for the bidder, and the product list.
const SECTIONS = [
  {
    key: 'sank_bids',
    label: 'Papers that sank bids',
    items: [
      { key: 'business_license_copy', kind: 'document', label: 'FDACS business license copy', why: 'Sarasota County Schools rejected bids for a missing license copy (bid 24-0118).', expires: true, renewalRule: 'Renews every year.', perBid: false, notarized: false },
      { key: 'cpco_certificate', kind: 'document', label: 'Certified operator certificate and current renewal', why: 'The certified operator’s certificate and its renewal were both asked for (bid 24-0118).', expires: true, renewalRule: 'Renews with the FDACS certification cycle.', perBid: false, notarized: false },
      { key: 'cpco_fulltime_statement', kind: 'document', label: 'Notarized statement: the certified operator in charge works full-time for us', why: 'Three of five bids lost on a missing notarized statement (bid 24-0118). Sign and notarize a new one for each bid.', expires: false, renewalRule: null, perBid: true, notarized: true },
      { key: 'employee_id_cards', kind: 'document', label: 'Copies of FDACS employee ID cards', why: 'State employee ID cards were a rejection reason (bid 24-0118).', expires: true, renewalRule: 'Each card carries its own expiry; use the earliest date.', perBid: false, notarized: false },
      { key: 'product_list', kind: 'document', label: 'Product list with EPA registration numbers, labels and SDS', why: 'The product list was a rejection reason (bid 24-0118).', expires: false, renewalRule: 'Refresh when a product changes.', perBid: false, notarized: false },
    ],
  },
  {
    key: 'insurance',
    label: 'Insurance',
    items: [
      { key: 'insurance_certificate', kind: 'document', label: 'Certificate of insurance', why: 'Every agency checks limits and asks to be named as additional insured.', expires: true, renewalRule: 'Renews with the policy term. Ask the agent for a new certificate that names each agency on each bid.', perBid: true, notarized: false },
      { key: 'pollution_coverage', kind: 'document', label: 'Pollution or environmental liability coverage', why: 'Some bids ask for it; the certificate shows the limit.', expires: true, renewalRule: 'Renews with the policy term. Only where a bid asks.', perBid: false, notarized: false },
    ],
  },
  {
    key: 'registration_tax',
    label: 'Registration and tax',
    items: [
      { key: 'w9', kind: 'document', label: 'W-9', why: 'Every agency needs one before it pays. The file is the only place the tax ID lives.', expires: false, renewalRule: null, perBid: false, notarized: false },
      { key: 'sunbiz_status', kind: 'document', label: 'Sunbiz active-status printout', why: 'Agencies check that the company is active in Florida.', expires: false, renewalRule: 'LLC annual report is due between Jan 1 and May 1. Print a new status page after you file.', perBid: false, notarized: false },
      { key: 'business_tax_receipt', kind: 'document', label: 'Local business tax receipt', why: 'Counties and cities ask for the local receipt with the bid.', expires: true, renewalRule: 'Expires Sept 30 each year.', perBid: false, notarized: false },
      { key: 'everify', kind: 'document', label: 'E-Verify enrollment or MOU', why: 'Florida public contracts require E-Verify (F.S. 448.095).', expires: false, renewalRule: null, perBid: false, notarized: false },
      { key: 'drug_free_policy', kind: 'document', label: 'Written drug-free workplace program', why: 'It breaks ties between equal bids (F.S. 287.087).', expires: false, renewalRule: null, perBid: false, notarized: false },
    ],
  },
  {
    key: 'plans_company',
    label: 'Plans and company',
    items: [
      { key: 'ipm_plan', kind: 'document', label: 'IPM plan', why: 'School and county bids ask for an integrated pest management plan.', expires: false, renewalRule: 'Review once a year.', perBid: false, notarized: false },
      { key: 'capability_sheet', kind: 'document', label: 'Capability sheet', why: 'One page that says who we are, what we treat and where we work.', expires: false, renewalRule: null, perBid: false, notarized: false },
      { key: 'service_center_proof', kind: 'document', label: 'Proof the office is a working service center', why: 'Hillsborough County rejected a low bidder in 2026 whose office looked like a residence.', expires: false, renewalRule: 'Refresh when the office or its signage changes.', perBid: false, notarized: false },
    ],
  },
  {
    key: 'references',
    label: 'References',
    items: [
      { key: 'reference', kind: 'reference', label: 'Customer reference', why: 'Agencies ask for three to five. Each person must agree to be named first.', expires: false, renewalRule: null, perBid: false, notarized: false, many: true },
    ],
  },
  {
    key: 'facts',
    label: 'Facts',
    items: [
      { key: 'legal_name', kind: 'fact', label: 'Legal name', why: 'Must match the license, the W-9 and Sunbiz exactly.', expires: false, renewalRule: null, perBid: false, notarized: false },
      { key: 'dba_name', kind: 'fact', label: 'DBA name', why: 'The name we trade under.', expires: false, renewalRule: null, perBid: false, notarized: false },
      { key: 'business_address', kind: 'fact', label: 'Business address', why: 'Physical office address; a P.O. box is not accepted.', expires: false, renewalRule: null, perBid: false, notarized: false },
      { key: 'mailing_address', kind: 'fact', label: 'Mailing address', why: 'Where the agency sends mail.', expires: false, renewalRule: null, perBid: false, notarized: false },
      { key: 'phone', kind: 'fact', label: 'Phone', why: 'Main number for the agency.', expires: false, renewalRule: null, perBid: false, notarized: false },
      { key: 'email', kind: 'fact', label: 'Email', why: 'Address the agency uses for notices and awards.', expires: false, renewalRule: null, perBid: false, notarized: false },
      { key: 'fdacs_license_number', kind: 'fact', label: 'FDACS license number', why: 'Every pest control bid asks for it.', expires: false, renewalRule: null, perBid: false, notarized: false },
      { key: 'office_opened_on', kind: 'fact', label: 'Date the office opened', why: 'Some forms ask how long the office has been open.', expires: false, renewalRule: null, perBid: false, notarized: false },
      { key: 'years_in_business', kind: 'fact', label: 'Years in business', why: 'A common question on the agency form.', expires: false, renewalRule: null, perBid: false, notarized: false },
      { key: 'nigp_codes', kind: 'fact', label: 'NIGP codes', why: 'State and county vendor registration asks for commodity codes.', expires: false, renewalRule: null, perBid: false, notarized: false },
      { key: 'naics_codes', kind: 'fact', label: 'NAICS codes', why: 'Federal and many state forms ask for them (561710 pest control).', expires: false, renewalRule: null, perBid: false, notarized: false },
      { key: 'sam_uei', kind: 'fact', label: 'SAM unique entity ID', why: 'Federal bids need it.', expires: false, renewalRule: null, perBid: false, notarized: false },
      { key: 'cage_code', kind: 'fact', label: 'CAGE code', why: 'Federal bids ask for it.', expires: false, renewalRule: null, perBid: false, notarized: false },
      { key: 'certified_operator_names', kind: 'fact', label: 'Certified operator names', why: 'Agencies ask who holds the certification.', expires: false, renewalRule: null, perBid: false, notarized: false },
      { key: 'employee_count', kind: 'fact', label: 'Employee count', why: 'Bid forms ask for the size of the company.', expires: false, renewalRule: null, perBid: false, notarized: false },
    ],
  },
];

// Custom rows (item_key 'custom') are the owner's own entries. They are listed in a last section.
const CUSTOM_KEY = 'custom';
const CUSTOM_SECTION = { key: 'other', label: 'Other', items: [] };

const KINDS = ['document', 'fact', 'reference'];

// Flat list, every item with its section key.
const ITEMS = SECTIONS.flatMap((section) => section.items.map((item) => ({ ...item, section: section.key })));
const ITEM_BY_KEY = Object.fromEntries(ITEMS.map((item) => [item.key, item]));
const catalogItem = (key) => ITEM_BY_KEY[key] || null;

// The catalog as the page reads it: sections in order, each item with its section key.
function catalogSections() {
  return SECTIONS.map((section) => ({ key: section.key, label: section.label, items: ITEMS.filter((item) => item.section === section.key) }));
}

// Insurance limits, whole dollars; workersComp is a word.
const LIMIT_DOLLAR_KEYS = ['glEachOccurrence', 'glAggregate', 'productsCompletedOps', 'autoCombinedSingle', 'employersLiability', 'umbrella', 'pollution'];
const LIMIT_KEYS = [...LIMIT_DOLLAR_KEYS, 'workersComp'];
const WORKERS_COMP_VALUES = ['statutory', 'exempt'];
const MAX_LIMIT_DOLLARS = 1000000000;

// A reference's details.
const REFERENCE_DETAIL_KEYS = ['entity', 'contactRole', 'phone', 'email', 'contractPeriod', 'scope', 'annualValue', 'publicOrPrivate'];
const PUBLIC_OR_PRIVATE = ['public', 'private'];

// Any change to one of these clears the sign-off in the SAME update.
const SUBSTANTIVE_FIELDS = ['value', 'file_s3_key', 'limits', 'details', 'source_document', 'checked_on', 'expires_on', 'permission_on'];
const EXPIRING_DAYS = 30;

// First match wins, in this order. "expiring" means complete and signed off, but expiring within 30 days: it is valid on a bid today.
const STATUS = {
  MISSING: 'missing', EXPIRED: 'expired', NEEDS_EXPIRY: 'needs_expiry', NEEDS_PERMISSION: 'needs_permission', UNATTESTED: 'unattested', EXPIRING: 'expiring', READY: 'ready',
};
const STATUS_ORDER = [STATUS.MISSING, STATUS.EXPIRED, STATUS.NEEDS_EXPIRY, STATUS.NEEDS_PERMISSION, STATUS.UNATTESTED, STATUS.EXPIRING, STATUS.READY];
const STATUS_LABEL = {
  missing: 'Missing', expired: 'Expired', needs_expiry: 'Add expiry date', needs_permission: 'Needs permission', unattested: 'Needs sign-off', expiring: 'Expiring soon', ready: 'Ready',
};
// Statuses that refuse a sign-off, with the plain words the owner reads.
const SIGN_OFF_REFUSAL = {
  missing: 'Add the file or value before you sign off.',
  expired: 'This item has expired. Replace it before you sign off.',
  needs_expiry: 'Add the expiry date first.',
};

// ---- tax IDs: ONE detector ----
// A tax ID or Social Security number is never stored: the W-9 file is the only place one lives. Every path asks this one
// function (typed fields, the merged-row pairs, reference details, uploaded file names, the signed-link name fallback).
//
// The text is read in one normal form first (screenText): compatibility forms folded (fullwidth digits and dashes, no-break
// spaces), every Unicode decimal digit read as its ASCII digit, every Unicode dash or minus read as a hyphen, every invisible
// format character, combining mark and stray control character removed, an underscore read as a space. A separator is then any run of characters that are not letters or digits
// (space, any dash, dot, slash, comma, colon, parentheses, brackets, plus ...), so no punctuation splits a tax ID apart.
// In typed text (a number counts as its digits),
// each field alone and each label/value pair read together, these are refused:
//   (A) the SSN shape: 3 digits, separator, 2 digits, separator, 4 digits, label or not;
//   (B) the EIN shape: 2 digits, separator, 7 digits, label or not;
//   (C) exactly nine contiguous digits that are not part of a longer digit run, label or not;
//   (D) nine digits in any other grouping ("1234 56789", "123.456.789"), when a tax phrase appears anywhere in the same text.
// There is no reach: a phrase before the digits, after them or far away all count. The phrases are EIN, FEIN, TIN, ITIN, SSN,
// taxpayer, tax id, tax identification, tax number, tax no, tax #, federal (or fed) id or tax, employer id, employer
// identification, social security, soc sec and W9, with any punctuation between or inside their words ("Tax-ID", "E.I.N.").
// Bare "tax" is no phrase ("Local business tax receipt" is fine).
// In a FILE NAME ({ fileName: true }) any nine-digit run in any grouping is refused, phrase or not.
// Not refused: runs of 8 digits or of 10 or more, dates, phone numbers, and a grouped number with no tax phrase.
// A run is a maximal chain of digit groups joined by separators; nine digits means some consecutive groups of the chain add up
// to exactly nine. The refusal never repeats the text.
const DASHES = /[\u2010-\u2015\u2043\u2212\u2E3A\u2E3B\uFE58\uFE63\uFF0D]/g;
// Every Unicode format character (zero-width spaces and joiners, bidi marks and isolates, soft hyphen, BOM ...), every
// combining mark, and every control character other than tab and line breaks.
const INVISIBLE = /[\p{Cf}\p{M}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
// Every Unicode decimal digit (Arabic-Indic, Devanagari, Thai ...) read as its ASCII digit. Unicode encodes decimal digits in
// contiguous runs of ten that start at zero, so a digit's value is its distance from the start of its run, modulo ten.
const OTHER_DIGIT = /(?![0-9])\p{Nd}/gu;
const isDecimalDigit = (cp) => /\p{Nd}/u.test(String.fromCodePoint(cp));
function asciiDigit(ch) {
  const cp = ch.codePointAt(0);
  let start = cp;
  while (start > 0 && isDecimalDigit(start - 1)) start -= 1;
  return String((cp - start) % 10);
}
const screenText = (text) => text.normalize('NFKC').replace(INVISIBLE, '').replace(OTHER_DIGIT, asciiDigit).replace(DASHES, '-').replace(/_/g, ' ');
const SEPARATOR = '[^\\p{L}\\p{N}]+';
const SSN_SHAPE = new RegExp(`(?<!\\d)\\d{3}${SEPARATOR}\\d{2}${SEPARATOR}\\d{4}(?!\\d)`, 'u');
const EIN_SHAPE = new RegExp(`(?<!\\d)\\d{2}${SEPARATOR}\\d{7}(?!\\d)`, 'u');
const NINE_CONTIGUOUS = /(?<!\d)\d{9}(?!\d)/;
const DIGIT_CHAIN = new RegExp(`\\d+(?:${SEPARATOR}\\d+)*`, 'gu');
// A tax phrase is matched on the words alone: lowercased, "#" read as "no", letters and digits split apart, and every other run
// of characters read as one space, so "Tax-ID", "Tax/ID", "tax_id", "Tax I.D.", "E.I.N." and "EIN1234" read as "tax id",
// "tax i d", "e i n" and "ein 1234".
const TAX_PHRASE = new RegExp(`(?:^| )(?:${[
  'f?ein', 'i?tin', 'ssn', 'f e i n', 'e i n', 'i t i n', 't i n', 's s n', 'w ?9', 'taxpayer', 'tax ?(?:id|i d)', 'tax identification',
  'tax number', 'tax no', 'fed(?:eral)? (?:id|i d|tax)', 'employer (?:id|i d|identification)', 'social security', 'soc(?:ial)? sec',
].join('|')})(?= |$)`);
const phraseText = (t) => t.toLowerCase().replace(/#/g, ' no ').replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const TAX_ID_REFUSED = 'That looks like a tax ID or Social Security number. These are never stored here; the W-9 file holds the tax ID. A nine-digit number with no letters cannot be stored: save it with its letters, or keep it in the file.';

// The digits are read with the W-9 token blanked ("W-9 12345678" holds eight digits, not nine); a phrase still sees it.
const W9_TOKEN = /\bw[^\p{L}\p{N}]*9(?!\d)/giu;
const digitText = (t) => t.replace(W9_TOKEN, ' ');
const sum = (groups) => groups.reduce((total, n) => total + n, 0);

// True when some consecutive digit groups of a separator-joined chain add up to exactly nine digits.
function hasNineDigitGrouping(text) {
  for (const chain of text.matchAll(DIGIT_CHAIN)) {
    const lengths = [...chain[0].matchAll(/\d+/g)].map((group) => group[0].length);
    for (let from = 0; from < lengths.length; from += 1) {
      let sum = 0;
      for (let to = from; to < lengths.length && sum < 9; to += 1) {
        sum += lengths[to];
        if (sum === 9) return true;
      }
    }
  }
  return false;
}

// True when the text holds a tax ID or an SSN, read in its normal form ("EIN_123456789.pdf" reads as "EIN 123456789",
// "123—45—6789" as "123-45-6789").
function detectTaxId(text, { fileName = false } = {}) {
  if (typeof text !== 'string') return false;
  const t = screenText(text);
  const d = digitText(t);
  if (SSN_SHAPE.test(d) || EIN_SHAPE.test(d) || NINE_CONTIGUOUS.test(d)) return true;
  if (!hasNineDigitGrouping(d)) return false;
  return fileName || TAX_PHRASE.test(phraseText(t));
}

// A whole item as it will be stored (stored values with an edit applied). Each text field is screened alone; then the row is
// screened as a whole, in ANY field order, because a person can split a number across fields: digits can run from the end of
// one field, through fields that hold only digits, into the start of another. Across fields these are refused: an SSN shape
// (3-2-4) or EIN shape (2-7) whose groups meet at field boundaries, label or not; and, when a tax phrase appears anywhere in
// the row (a field, a reference detail or the catalog label), nine digits in any grouping, inside one field or across several.
// A reference's details are fields too (a number counts as its digits), and so are the insurance dollar limits (below).
function rowHasTaxId(row) {
  const r = row || {};
  const details = r.details && typeof r.details === 'object' ? Object.values(r.details) : [];
  const parts = [r.label, r.value, r.source_document, r.notes, ...details]
    .map((part) => (typeof part === 'number' ? String(part) : part))
    .filter((part) => typeof part === 'string' && part.trim() !== '');
  if (parts.some((part) => detectTaxId(part))) return true;
  // Dollar limits are whole numbers: each is screened alone (nine digits is a tax ID, never a limit here) and, when a tax
  // phrase is in the row, with the row. They never join the label-free shapes across fields: a date in the notes followed by a
  // $1,000,000 limit would read as an EIN.
  const amounts = (r.limits && typeof r.limits === 'object' ? LIMIT_DOLLAR_KEYS.map((key) => r.limits[key]) : [])
    .filter((amount) => typeof amount === 'number' || (typeof amount === 'string' && amount.trim() !== '')).map(String);
  if (amounts.some((amount) => detectTaxId(amount))) return true;
  const texts = parts.map(screenText);
  const fields = texts.map(fieldDigits);
  if (shapeAcrossFields(fields)) return true;
  if (!texts.some((t) => TAX_PHRASE.test(phraseText(t)))) return false;
  if (texts.some((t) => hasNineDigitGrouping(digitText(t)))) return true;
  return nineAcrossFields([...fields, ...amounts.map(fieldDigits)]);
}

// A field's digit groups at its edges: `head` when it starts with digits, `tail` when it ends with them, `whole` when it holds
// no letter at all (then all its digits are one chain and it can sit between two other fields).
function fieldDigits(text) {
  const d = digitText(text);
  const chains = [...d.matchAll(DIGIT_CHAIN)].map((m) => [...m[0].matchAll(/\d+/g)].map((g) => g[0].length));
  if (!chains.length) return {};
  return {
    head: /^[^\p{L}\p{N}]*\d/u.test(d) ? chains[0] : null,
    tail: /\d[^\p{L}\p{N}]*$/u.test(d) ? chains[chains.length - 1] : null,
    whole: /\p{L}/u.test(d) ? null : chains[0],
  };
}

const endsWith = (groups, shape) => Boolean(groups) && groups.length >= shape.length && shape.every((n, k) => groups[groups.length - shape.length + k] === n);
const startsWith = (groups, shape) => Boolean(groups) && groups.length >= shape.length && shape.every((n, k) => groups[k] === n);

// An SSN or EIN whose groups meet at field boundaries: [2]|[7], [3]|[2,4], [3,2]|[4], or [3]|[2]|[4] through a field that
// holds exactly two digits.
function shapeAcrossFields(fields) {
  return fields.some((a, i) => fields.some((b, j) => {
    if (i === j || !a.tail || !b.head) return false;
    if (endsWith(a.tail, [2]) && startsWith(b.head, [7])) return true;
    if (endsWith(a.tail, [3]) && startsWith(b.head, [2, 4])) return true;
    if (endsWith(a.tail, [3, 2]) && startsWith(b.head, [4])) return true;
    return endsWith(a.tail, [3]) && startsWith(b.head, [4])
      && fields.some((m, k) => k !== i && k !== j && m.whole && m.whole.length === 1 && m.whole[0] === 2);
  }));
}

// Nine digits across two or more fields, in any order: the end of one field's tail, any digit-only fields whole, and the start
// of another field's head.
function nineAcrossFields(fields) {
  const suffixes = (groups) => (groups ? groups.map((_, k) => sum(groups.slice(k))) : []);
  const prefixes = (groups) => (groups ? groups.map((_, k) => sum(groups.slice(0, k + 1))) : []);
  const starts = [{ at: -1, sums: [0] }, ...fields.map((f, at) => ({ at, sums: suffixes(f.tail) }))];
  const ends = [{ at: -1, sums: [0] }, ...fields.map((f, at) => ({ at, sums: prefixes(f.head) }))];
  for (const start of starts) {
    for (const end of ends) {
      if (start.at !== -1 && start.at === end.at) continue;
      // Most digit-only fields that reach each total up to nine (more fields only makes "two or more" easier).
      const most = new Map([[0, 0]]);
      fields.forEach((f, at) => {
        if (!f.whole || at === start.at || at === end.at) return;
        const n = sum(f.whole);
        for (const [total, count] of [...most]) if (total + n <= 9 && (most.get(total + n) ?? -1) < count + 1) most.set(total + n, count + 1);
      });
      const edges = (start.at === -1 ? 0 : 1) + (end.at === -1 ? 0 : 1);
      for (const a of start.sums) {
        for (const b of end.sums) {
          const middle = most.get(9 - a - b);
          if (middle !== undefined && edges + middle >= 2) return true;
        }
      }
    }
  }
  return false;
}

// ---- dates (America/New_York) ----
const ET_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
// Today's Eastern calendar date as YYYY-MM-DD.
function etToday(now = new Date()) {
  const parts = Object.fromEntries(ET_DAY.formatToParts(now).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
// True when a calendar day (YYYY-MM-DD) is after today in America/New_York: a check or a permission cannot be dated ahead.
const isFutureDay = (day, today = etToday()) => { const d = dayText(day); return d !== null && d > today; };

// A DATE read back as text. A Date object is taken at its UTC calendar day (pg parses DATE at local midnight, so the
// server reads dates as text; this is the safe fallback for a Date at UTC midnight).
function dayText(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}
// Whole days from one YYYY-MM-DD to another (to minus from), calendar days, no clock involved.
function daysBetween(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

const present = (value) => typeof value === 'string' ? value.trim() !== '' : value != null;

// The status of one row. Pure: pass `today` (an Eastern YYYY-MM-DD) or `now`.
// First match wins, in this order: missing, expired, needs_expiry, needs_permission, unattested, expiring, ready.
// A document is "there" only when it has a FILE: the paper is the evidence, and a typed number alone is not (this holds for a
// custom document too). A fact is there only with a typed value (it takes no file), and a reference only with a value or when it names its
// entity (a file alone never makes a reference present: it carries no usable identity). A catalog item
// that expires (expires: true) and has no expiry date is needs_expiry; custom rows are not held to that.
function itemStatus(row, { today, now } = {}) {
  const day = today || etToday(now);
  const r = row || {};
  const hasFile = present(r.file_s3_key) || r.has_file === true;
  const hasValue = present(r.value);
  const hasEntity = r.kind === 'reference' && present(r.details && r.details.entity);
  const there = { document: hasFile, fact: hasValue, reference: hasValue || hasEntity }[r.kind] ?? false;
  if (!there) return STATUS.MISSING;
  const expires = dayText(r.expires_on);
  const left = expires ? daysBetween(day, expires) : null;
  if (left !== null && left < 0) return STATUS.EXPIRED;
  const entry = ITEM_BY_KEY[r.item_key];
  if (!expires && entry && entry.expires) return STATUS.NEEDS_EXPIRY;
  if (r.kind === 'reference' && !dayText(r.permission_on)) return STATUS.NEEDS_PERMISSION;
  if (!r.attested_at) return STATUS.UNATTESTED;
  if (left !== null && left <= EXPIRING_DAYS) return STATUS.EXPIRING;
  return STATUS.READY;
}

// `ready` counts ready and expiring together (both are valid on a bid today); `expiring` is the separate "expiring soon" count
// and is a part of `ready`, so the other statuses plus `ready` add up to `total`.
const emptyCounts = () => ({ total: 0, ready: 0, expiring: 0, missing: 0, expired: 0, needs_expiry: 0, needs_permission: 0, unattested: 0 });

// Sections in catalog order, each with its entries: a catalog item with its rows (a row's status is computed), or one
// virtual entry (row null, status missing) when an item has no row yet. A reference item holds many rows, and its
// virtual entry shows only while there are none. Custom rows fill the last section.
function buildChecklist(rows, opts = {}) {
  const day = opts.today || etToday(opts.now);
  const live = (rows || []).filter((row) => !row.archived_at);
  const sections = SECTIONS.map((section) => ({
    key: section.key,
    label: section.label,
    entries: section.items.flatMap((item) => {
      const mine = live.filter((row) => row.item_key === item.key && row.kind === item.kind);
      if (!mine.length) return [{ item, row: null, status: STATUS.MISSING }];
      return mine.map((row) => ({ item, row, status: itemStatus(row, { today: day }) }));
    }),
  }));
  const customs = live.filter((row) => row.item_key === CUSTOM_KEY);
  if (customs.length) {
    sections.push({
      key: CUSTOM_SECTION.key,
      label: CUSTOM_SECTION.label,
      entries: customs.map((row) => ({ item: { key: CUSTOM_KEY, kind: row.kind, label: row.label, section: CUSTOM_SECTION.key, expires: true, perBid: false, notarized: false }, row, status: itemStatus(row, { today: day }) })),
    });
  }
  return sections;
}

// Per-section and overall counts: { overall, sections: { [key]: counts } }.
function summarize(checklist) {
  const overall = emptyCounts();
  const sections = {};
  for (const section of checklist) {
    const counts = emptyCounts();
    for (const entry of section.entries) {
      counts.total += 1;
      counts[entry.status] += 1;
      if (entry.status === STATUS.EXPIRING) counts.ready += 1;
    }
    sections[section.key] = counts;
    for (const key of Object.keys(counts)) overall[key] += counts[key];
  }
  return { overall, sections };
}

// ---- change detection ----
const sameJson = (a, b) => JSON.stringify(sortKeys(a ?? null)) === JSON.stringify(sortKeys(b ?? null));
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  return value;
}
const blankToNull = (value) => (value === '' || value === undefined ? null : value);
// True when a patch changes one of the fields a sign-off covers, compared with the stored row.
function changesSubstance(row, patch) {
  // A custom item's label is the owner's own words about the paper, so a new label is a new claim and clears the sign-off. A
  // catalog item's label comes from the catalog.
  if (row.item_key === CUSTOM_KEY && 'label' in patch && blankToNull(row.label) !== blankToNull(patch.label)) return true;
  return SUBSTANTIVE_FIELDS.some((field) => {
    if (!(field in patch)) return false;
    if (field === 'limits' || field === 'details') return !sameJson(row[field], patch[field]);
    if (field === 'checked_on' || field === 'expires_on' || field === 'permission_on') return dayText(row[field]) !== dayText(patch[field]);
    return blankToNull(row[field]) !== blankToNull(patch[field]);
  });
}

module.exports = {
  SECTIONS, ITEMS, ITEM_BY_KEY, KINDS, CUSTOM_KEY, CUSTOM_SECTION,
  LIMIT_KEYS, LIMIT_DOLLAR_KEYS, WORKERS_COMP_VALUES, MAX_LIMIT_DOLLARS, REFERENCE_DETAIL_KEYS, PUBLIC_OR_PRIVATE,
  SUBSTANTIVE_FIELDS, EXPIRING_DAYS, STATUS, STATUS_ORDER, STATUS_LABEL, SIGN_OFF_REFUSAL,
  catalogItem, catalogSections, itemStatus, isFutureDay, buildChecklist, summarize, changesSubstance,
  TAX_ID_REFUSED, detectTaxId, rowHasTaxId, etToday, dayText, daysBetween,
};
