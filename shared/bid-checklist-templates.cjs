'use strict';

/**
 * Bid Desk checklist templates (GATE_BID_CHECKLIST). ONE place to edit the wording; the server copies these lines into a
 * bid's own checklist when the operator presses "Start checklist" (server/services/bid-desk/checklist.js), so a later
 * edit here never changes a list already started. "Add missing" adds only the lines a bid does not have yet, matched by
 * `key`.
 *
 * The base list is the ten-line bid-form check every invitation to bid (ITB) needs. A solicitation type adds its own
 * lines after the base. An RFQ (in these Florida agencies a request for quotes) uses the quote lines and an ITN uses the
 * RFP lines; a type with no overlay (other) gets the base list only. The wording will be refined later from a harvest
 * of real solicitation requirements.
 *
 * A key is stable and at most 48 characters; a label is plain office English.
 */

const BASE = [
  ['bid_form', 'Bid form used exactly as issued, every line filled in'],
  ['prices', 'Unit prices, extensions and totals reconciled'],
  ['addenda', 'Every addendum acknowledged and signed'],
  ['bid_security', 'Bid security in the required form and amount, or confirm none is required'],
  ['signer', 'Signer can bind the company, notarized where required'],
  ['forms', 'All mandatory forms and affidavits completed and signed'],
  ['licenses', 'Licenses and registrations current on the bid date'],
  ['subs', 'Subcontractor and participation listings, or confirm none'],
  ['submittals', 'Product data and substitution submittals'],
  ['submission', 'Submission method, format, file names and deadline confirmed'],
];

// The five papers Sarasota County Schools asked for with bid 24-0118 are the model for the itb overlay.
const OVERLAYS = {
  quote: [
    ['written_quote', 'Written quote on the agency\'s own form'],
    ['references', 'References listed'],
    ['insurance_certificate', 'Certificate of insurance'],
  ],
  itb: [
    ['business_license', 'Copy of the business license'],
    ['operator_certificate', 'Certified operator certificate and its current renewal'],
    ['operator_statement', 'Notarized statement that the certified operator works full-time for the bidder'],
    ['employee_ids', 'Employee ID cards'],
    ['product_list', 'Product list with EPA registration numbers'],
  ],
  rfp: [
    ['section_order', 'Response follows the agency\'s section order and headings'],
    ['criteria_pages', 'Every evaluation criterion answered, with a page reference'],
    ['page_limits', 'Page limits and format met'],
    ['separate_price', 'Price in the separate file or envelope, if one is required'],
    ['reference_surveys', 'References ready and willing to answer the agency\'s survey'],
  ],
  // Most bid invites are general-contractor invites (BuildingConnected, Procore); the model is the Cove + Willoughby
  // termite package.
  gc_subcontract: [
    ['gc_bid_form', 'The GC\'s bid form completed, every acknowledgment line initialed (escalation, price hold period, sales tax, addenda listed)'],
    ['prequalification', 'The GC\'s prequalification form'],
    ['insurance_exhibit', 'Insurance meets the GC\'s insurance exhibit: limits, endorsements, every additional insured named, no exclusion the exhibit bans'],
    ['price_hold', 'Price hold period stated and met'],
    ['alternates', 'Alternates and deducts priced when asked'],
    ['warranty_terms', 'Warranty terms match the specification; any conflict between spec sections and drawings flagged before bidding'],
  ],
  federal: [
    ['sam_registration', 'SAM registration active'],
    ['reps_certs', 'Representations and certifications completed'],
    ['sf1449', 'SF 1449 signed'],
    ['wage_determination', 'Wage determination built into the price'],
  ],
};

// A type that uses another type's lines.
const OVERLAY_ALIAS = { rfq: 'quote', itn: 'rfp' };

const SECTION_BASE = 'base';
const SECTION_CUSTOM = 'custom';

const row = (section, [key, label]) => ({ template_key: `${section}.${key}`, section, label, required: true });

/** The template lines for a solicitation type (base first, then the type's own), in order. */
function templateRows(type) {
  return [
    ...BASE.map((entry) => row(SECTION_BASE, entry)),
    ...((OVERLAYS[OVERLAY_ALIAS[type] || type] || []).map((entry) => row(OVERLAY_ALIAS[type] || type, entry))),
  ];
}

// Every type that gets lines beyond the base list.
const TEMPLATE_TYPES = [...Object.keys(OVERLAYS), ...Object.keys(OVERLAY_ALIAS)];

module.exports = { templateRows, TEMPLATE_TYPES, SECTION_BASE, SECTION_CUSTOM };
