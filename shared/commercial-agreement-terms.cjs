'use strict';

/**
 * The fixed terms of the Commercial Pest Service Agreement, in the exact texts the proposal builder prefills.
 * Online signing is offered only when every structured term on the proposal matches these
 * (server: commercial-proposal-agreement.js agreementTermsConflict), so the server check and the builder's
 * prefill (client: CommercialProposalPage.jsx, through the '@commercial-agreement-terms' alias) read ONE definition.
 */
const AGREEMENT_TERMS = Object.freeze({
  paymentTerms: 'net30',
  initialTermMonths: 12,
  renewal: 'Renews automatically for 12-month terms unless either party gives written notice at least 30 days before the term ends.',
  priceAdjustment: "Pricing may be adjusted at renewal or with at least 30 days' written notice.",
  cancellation: "Either party may cancel with 30 days' written notice. Charges for services already performed remain due.",
});

module.exports = { AGREEMENT_TERMS };
