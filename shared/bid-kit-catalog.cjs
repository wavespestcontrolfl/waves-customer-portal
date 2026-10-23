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

// Tax IDs are never stored. Refused in any typed text: a hyphenated EIN (12-3456789), a hyphenated SSN (123-45-6789), and a
// nine-digit run that follows a label (EIN, FEIN, TIN, SSN, "tax id", "taxpayer") by at most 12 characters. A bare nine-digit
// number with no such label (an insurance policy number) is fine. The message never repeats the text.
const TAX_ID_PATTERN = /(?<!\d)(?:\d{2}-\d{7}|\d{3}-\d{2}-\d{4})(?!\d)|(?:\b(?:EIN|FEIN|TIN|SSN)\b|tax\s*id|taxpayer)[\s\S]{0,12}?(?<!\d)\d{9}(?!\d)/i;
const looksLikeTaxId = (text) => typeof text === 'string' && TAX_ID_PATTERN.test(text);
function containsTaxId(value) {
  if (value == null) return false;
  if (typeof value === 'string') return looksLikeTaxId(value);
  if (Array.isArray(value)) return value.some(containsTaxId);
  if (typeof value === 'object') return Object.values(value).some(containsTaxId);
  return false;
}

// ---- dates (America/New_York) ----
const ET_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
// Today's Eastern calendar date as YYYY-MM-DD.
function etToday(now = new Date()) {
  const parts = Object.fromEntries(ET_DAY.formatToParts(now).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
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
// A row is "there" when it has a file or a value; a reference also counts when it names its entity. A catalog item that expires (expires: true) and has
// no expiry date is needs_expiry; custom rows are not held to that.
function itemStatus(row, { today, now } = {}) {
  const day = today || etToday(now);
  const r = row || {};
  const hasFile = present(r.file_s3_key) || r.has_file === true;
  const hasValue = present(r.value);
  const hasEntity = r.kind === 'reference' && present(r.details && r.details.entity);
  if (!hasFile && !hasValue && !hasEntity) return STATUS.MISSING;
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
  catalogItem, catalogSections, itemStatus, buildChecklist, summarize, changesSubstance,
  looksLikeTaxId, containsTaxId, etToday, dayText, daysBetween,
};
