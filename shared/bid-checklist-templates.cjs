'use strict';

/**
 * Bid Desk checklist templates (GATE_BID_CHECKLIST). ONE place to edit the wording; the server copies these lines into a
 * bid's own checklist when the operator presses "Start checklist" (server/services/bid-desk/checklist.js), so a later
 * edit here never changes a list already started. "Add missing" adds only the lines a bid does not have yet, matched by
 * `key`.
 *
 * Order of a started list: the type's stop checks (go / no-go questions: if the answer is no, do not bid), then the
 * ten-line bid check every solicitation needs (Akros Strategy's ITB responsiveness check, in its order), then the type's
 * own lines. An RFQ (in these Florida agencies a request for quotes) uses the quote lines and an ITN uses the RFP lines;
 * a type with no lines of its own (other) gets the ten-line check only.
 *
 * Source of the wording: a 2026-10-23 harvest of 12 local pest solicitations (City of Sarasota ITB 25-32SP, Sarasota
 * County 252733CG and 262798MN, North Port RFQ PR27-02, Tampa, St. Petersburg, Okaloosa, Fort Myers Housing Authority)
 * and the written rejection reasons of Sarasota County Schools bid 24-0118 (3 of 5 bids out, the lowest among them,
 * for the five papers in the itb lines) and Hillsborough County ITB-26-00145 (a low bidder found not responsible).
 *
 * A key is stable and at most 48 characters; a label is plain office English.
 */

const BASE = [
  ['bid_form', 'Bid form used exactly as issued: latest addendum version, every line filled (0 where free), units as printed'],
  ['prices', 'Unit prices, extensions and totals reconciled; units and decimals checked; markups under any cap; no unbalanced lines'],
  ['addenda', 'Every addendum acknowledged where the agency asks (check the portal for late addenda)'],
  ['bid_security', 'Bid security in the required form, amount and delivery, or confirm none is required'],
  ['signer', 'Every signature page signed by a person who can bind the company; notarized where the form says so'],
  ['forms', 'Every mandatory form and affidavit completed on the agency\'s own paper (public entity crimes, scrutinized companies, E-Verify, drug-free, conflict of interest, anti-trafficking, foreign country of concern, lobbying, vendor information)'],
  ['licenses', 'License and registration copies current on the bid date (FDACS license, operator certificates with renewal, Sunbiz status, business tax receipt)'],
  ['subs', 'Subcontractor and participation listings completed, or "None" written'],
  ['submittals', 'Product data, SDS and labels attached where asked; any substitute product approved before the deadline'],
  ['submission', 'Submission method, file format, file names and deadline confirmed; uploaded at least one business day early; confirmation saved'],
];

// Go / no-go questions, listed before the ten-line check.
const STOPS = {
  quote: [
    ['license_type', 'Stop check: we hold the license category the work needs (structural, fumigation, or Ornamental & Turf for turf insects)'],
    ['experience', 'Stop check: we meet the experience minimum (years in business, references)'],
    ['price_cap', 'Stop check: our price fits any hard cap in the request'],
  ],
  itb: [
    ['local_office', 'Stop check: we meet any local-office or service-center rule'],
    ['license_staffing', 'Stop check: our license categories and number of certified operators meet the bid (some want all four FDACS categories across staff)'],
    ['reference_rules', 'Stop check: our references meet the count, recency, size and government-client rules'],
    ['prebid', 'Mandatory pre-bid meeting or site visit attended, if the bid has one'],
  ],
  rfp: [
    ['criteria_matrix', 'Stop check: every evaluation criterion and its points mapped to a section of our response'],
    ['participation', 'Stop check: we can meet any HUD, federal or participation requirement (Section 3, MBE plan or waiver)'],
  ],
  gc_subcontract: [
    ['gc_insurance', 'Stop check: our insurance can meet the GC\'s exhibit (limits, umbrella, no habitational exclusion)'],
    ['scope_fit', 'Stop check: the scope and warranty are work we can deliver at a price we can hold'],
  ],
  federal: [
    ['set_aside', 'Stop check: we are eligible for the set-aside (small business, veteran-owned, 8(a), HUBZone)'],
    ['sam_active', 'Stop check: SAM registration active on the offer date'],
  ],
};

// The type's own lines, listed after the ten-line check.
const OVERLAYS = {
  quote: [
    ['written_quote', 'Written quote on the agency\'s own form'],
    ['references', 'References listed on the agency\'s form, with e-mail addresses'],
    ['insurance_certificate', 'Insurance broker can issue the certificate with the agency as additional insured; workers\' comp proof or exemption attached where asked'],
    ['public_records', 'Public-records exemption question answered (a redacted copy only if we claim one)'],
    ['no_contact', 'Only the named buyer contacted until award'],
  ],
  // The five papers Sarasota County Schools rejected bids for with bid 24-0118 come first.
  itb: [
    ['business_license', 'Copy of the business license'],
    ['operator_certificate', 'Certified operator certificate and its current renewal'],
    ['operator_statement', 'Notarized statement that the certified operator works full-time for the bidder'],
    ['employee_ids', 'Employee ID cards'],
    ['product_list', 'Product list with EPA registration numbers'],
    ['references_form', 'References on the agency\'s form, with e-mail addresses (some agencies survey them and reject a bid when surveys do not come back)'],
    ['local_preference', 'Local-preference claim decided; its form, tax receipt and notary only if we qualify'],
    ['post_opening', 'Post-opening deadlines diarized (license proof often within 5 business days, insurance within 10)'],
    ['responsibility', 'Responsibility evidence ready: service-center address and photos, equipment and staff list, references of equal or larger size'],
    ['protest_window', 'Protest window noted (24 hours to 5 business days, by agency)'],
    ['no_contact', 'Only the named procurement contact contacted until award'],
  ],
  rfp: [
    ['section_order', 'Response follows the agency\'s section order and headings'],
    ['criteria_pages', 'Every evaluation criterion answered, with a page reference'],
    ['page_limits', 'Page limits and format met'],
    ['separate_price', 'Price in the separate file or envelope, if one is required'],
    ['reference_surveys', 'References ready and willing to answer the agency\'s survey'],
    ['narrative', 'Narrative written to the criteria: staff with license numbers, IPM approach, sample service report, training, guarantee'],
    ['similar_contracts', 'Three recent similar contracts described'],
    ['presentation', 'Team ready for an oral presentation; price-negotiation limits set'],
    ['no_contact', 'Only the named procurement contact contacted until award'],
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
    ['past_performance', 'Past-performance references, or key-personnel experience, ready (no federal record rates neutral)'],
  ],
};

// A type that uses another type's lines.
const OVERLAY_ALIAS = { rfq: 'quote', itn: 'rfp' };

const SECTION_STOP = 'stop';
const SECTION_BASE = 'base';
const SECTION_CUSTOM = 'custom';

const row = (section, [key, label]) => ({ template_key: `${section}.${key}`, section, label, required: true });

/** The template lines for a solicitation type (stop checks, then the ten-line check, then the type's own), in order. */
function templateRows(type) {
  const own = OVERLAY_ALIAS[type] || type;
  return [
    ...((STOPS[own] || []).map((entry) => row(SECTION_STOP, entry))),
    ...BASE.map((entry) => row(SECTION_BASE, entry)),
    ...((OVERLAYS[own] || []).map((entry) => row(own, entry))),
  ];
}

// Every type that gets lines beyond the ten-line check.
const TEMPLATE_TYPES = [...Object.keys(OVERLAYS), ...Object.keys(OVERLAY_ALIAS)];

module.exports = { templateRows, TEMPLATE_TYPES, SECTION_STOP, SECTION_BASE, SECTION_CUSTOM };
