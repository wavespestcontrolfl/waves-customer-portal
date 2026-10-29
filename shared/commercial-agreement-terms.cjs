'use strict';

/**
 * The fixed terms of the Commercial Pest Service Agreement, in the exact texts the proposal builder prefills.
 * Online signing is offered only when every structured term on the proposal matches these
 * (server: commercial-proposal-agreement.js agreementTermsConflict), so the server check and the builder's
 * prefill (client: CommercialProposalPage.jsx, through the '@commercial-agreement-terms' alias) read ONE definition.
 */
const AGREEMENT_TERMS = Object.freeze({
  initialTermMonths: 12,
  renewal: 'Renews automatically for 12-month terms unless either party gives written notice at least 30 days before the term ends.',
  priceAdjustment: "Pricing may be adjusted at renewal or with at least 30 days' written notice.",
  cancellation: "Either party may cancel with 30 days' written notice. Charges for services already performed remain due.",
});

/**
 * The agreement's payment paragraph for each payment term it can carry, filled into the template's
 * {{agreement.payment_terms}} (template version 2). Auto Pay is the commercial default (owner 2026-10-24,
 * "autopay default", text approved verbatim; timing owner 2026-10-24 "after the service is completed", which is when
 * the completion auto-charge runs; GATE_COMMERCIAL_AUTOPAY). Net 30 is for a Bill-by-invoice proposal
 * (the 2026-06-24 text, the paragraph version 1 printed). Changing either text changes what a customer signs:
 * owner approval first.
 */
const AUTOPAY_PAYMENT_TERMS = 'autopay';
const INVOICE_PAYMENT_TERMS = 'net30';
const AGREEMENT_PAYMENT_TEXT = Object.freeze({
  [AUTOPAY_PAYMENT_TERMS]: "You authorize Waves to charge the card or bank account on file after each service is completed, plus applicable tax. You may change the payment method any time, and cancel autopay with 30 days' written notice, after which invoices are due Net 30.",
  [INVOICE_PAYMENT_TERMS]: 'Services are invoiced on Net 30 terms — payment is due within thirty (30) days of the invoice date. Past-due balances may be subject to a late fee and/or suspension of service until the account is brought current.',
});

/**
 * How a typed term compares with the agreement's text: case, whitespace and apostrophe style do not matter
 * ("30 days\u2019" typed on a phone equals "30 days'"). The signing check and the builder's Standard / Custom
 * choice both compare through this, so the builder never calls a term Custom that signing accepts as standard.
 */
const normalizeTermText = (value) => String(value).replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

module.exports = { AGREEMENT_TERMS, AUTOPAY_PAYMENT_TERMS, INVOICE_PAYMENT_TERMS, AGREEMENT_PAYMENT_TEXT, normalizeTermText };
