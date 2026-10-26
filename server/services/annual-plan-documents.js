const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { dateOnlyString, formatDateOnly } = require('../utils/date-only');
const {
  coverageAwaitsInstallation,
  isCoveredTerm,
  isPaidDecidedLapseTerm,
  termiteDeclineBlockedReason,
  termPropertyLabelsForCustomer,
  whereTermCurrentOrAwaitingInstallation,
} = require('./annual-prepay-renewals');

const DOCUMENT_ID_PREFIX = 'annual_plan_';

class AnnualPlanLabelsUnavailableError extends Error {
  constructor() {
    super('Annual plan property labels are unavailable');
    this.name = 'AnnualPlanLabelsUnavailableError';
    this.code = 'labels_unavailable';
  }
}

// Multi-term labels are part of the authorization-safe projection: a
// customer must be able to tell which plan a record describes. This is the
// same disambiguation the My Plan card has always used.
function distinctTermLabels(rows, labels) {
  const labelFor = (entry) => (entry && (rows.length < 2 || entry.termTied) ? entry.label : null);
  const out = new Map(rows.map((term) => [term.id, labelFor(labels.get(term.id))]));
  if (rows.length < 2) return out;

  const tally = () => {
    const counts = new Map();
    for (const label of out.values()) if (label) counts.set(label, (counts.get(label) || 0) + 1);
    return counts;
  };

  const first = tally();
  for (const term of rows) {
    const label = out.get(term.id);
    const termEnd = dateOnlyString(term.term_end);
    if (!label || !(first.get(label) > 1)) continue;
    if (coverageAwaitsInstallation(term)) out.set(term.id, `${label} (awaiting installation)`);
    else if (termEnd) out.set(term.id, `${label} (renews ${formatDateOnly(termEnd)})`);
  }

  const second = tally();
  for (const term of rows) {
    const label = out.get(term.id);
    if (!label || second.get(label) > 1) out.set(term.id, null);
  }
  return out;
}

async function eligibleAnnualPlanRows(customerId, { conn = db, today = etDateString() } = {}) {
  if (!customerId) return [];

  const rows = await conn('annual_prepay_terms')
    .where({ customer_id: customerId })
    // This is the durable signed-plan marker. It deliberately does not read
    // the later issue gates: an existing agreement remains readable after a
    // gate is turned off.
    .whereNotNull('annual_plan_version')
    .where((current) => whereTermCurrentOrAwaitingInstallation(current, today))
    .where(function applicableTermState() {
      this.whereIn('status', ['active', 'renewal_pending', 'payment_pending'])
        .orWhere(function decidedLapse() {
          this.where('status', 'cancelled').andWhere('renewal_decision', 'cancel');
        })
        .orWhere(function unprocessedRenew() {
          this.where('status', 'renewed').andWhere('renewal_decision', 'renew')
            .whereNotExists(function noSuccessorTerm() {
              this.select(conn.raw('1')).from('annual_prepay_terms as successor')
                .whereRaw('successor.renewed_from_term_id = annual_prepay_terms.id');
            });
        });
    })
    .orderBy('term_end', 'asc')
    .select(
      'id', 'term_end', 'prepay_amount', 'status', 'renewal_decision',
      'annual_plan_version', 'renewed_from_term_id', 'installation_anchored_at',
      'created_at',
    );

  const applicableRows = [];
  for (const term of rows) {
    if (term.status === 'cancelled' && term.renewal_decision === 'cancel') {
      if (!(await isPaidDecidedLapseTerm(term, conn))) continue;
    } else if (term.status === 'renewed') {
      if (!(await isCoveredTerm(term.id, conn))) continue;
    }
    applicableRows.push(term);
  }
  if (!applicableRows.length) return [];

  let propertyLabels = new Map();
  try {
    propertyLabels = await termPropertyLabelsForCustomer(customerId, applicableRows.map((term) => term.id), conn);
  } catch (err) {
    logger.warn(`[annual-plan-documents] property labels failed for customer ${customerId}: ${err.message}`);
    if (applicableRows.length > 1) throw new AnnualPlanLabelsUnavailableError();
  }

  const labels = distinctTermLabels(applicableRows, propertyLabels);
  return applicableRows.map((term) => ({ term, propertyLabel: labels.get(term.id) }));
}

function portalTermProjection({ term, propertyLabel }, today, multiple) {
  const declined = term.renewal_decision === 'cancel';
  const eligible = !declined && !termiteDeclineBlockedReason(term, today, { hasSuccessor: false });
  const propertyUnclear = eligible && multiple && !propertyLabel;
  return {
    id: term.id,
    propertyLabel,
    termEnd: dateOnlyString(term.term_end),
    awaitsInstallation: coverageAwaitsInstallation(term),
    prepayAmount: term.prepay_amount != null ? Number(term.prepay_amount) : null,
    declined,
    canDecline: eligible && !propertyUnclear,
    ...(term.status === 'payment_pending' ? { unpaid: true } : {}),
    ...(propertyUnclear ? { propertyUnclear: true } : {}),
  };
}

async function listAnnualPlanTermsForCustomer(customerId, options = {}) {
  const today = options.today || etDateString();
  const rows = await eligibleAnnualPlanRows(customerId, { ...options, today });
  const multiple = rows.length > 1;
  return rows.map((row) => portalTermProjection(row, today, multiple));
}

function documentIdForTerm(termId) {
  return `${DOCUMENT_ID_PREFIX}${termId}`;
}

function documentProjection({ term, propertyLabel }) {
  const awaitsInstallation = coverageAwaitsInstallation(term);
  const declined = term.renewal_decision === 'cancel';
  const unpaid = term.status === 'payment_pending';
  const currentTermEnds = awaitsInstallation ? null : dateOnlyString(term.term_end);
  const id = documentIdForTerm(term.id);
  const datePart = currentTermEnds || 'current';
  return {
    id,
    documentType: 'annual_summary',
    title: 'Annual plan renewal',
    description: propertyLabel ? `Renewal details for ${propertyLabel}` : 'Renewal details for your current annual plan',
    fileName: `Annual_Plan_Renewal_${datePart}.pdf`,
    uploadedBy: 'auto_generated',
    createdAt: term.created_at || null,
    isAutoGenerated: true,
    downloadUrl: `/api/documents/annual-plan/${encodeURIComponent(id)}`,
    shareable: false,
    facts: {
      propertyLabel: propertyLabel || null,
      currentPlanAmount: term.prepay_amount != null ? Number(term.prepay_amount) : null,
      currentTermEnds,
      awaitsInstallation,
      declined,
      unpaid,
    },
  };
}

async function listAnnualPlanDocumentsForCustomer(customerId, options = {}) {
  const rows = await eligibleAnnualPlanRows(customerId, options);
  return rows.map(documentProjection);
}

async function getAnnualPlanDocumentForCustomer(customerId, documentId, options = {}) {
  if (typeof documentId !== 'string' || !documentId.startsWith(DOCUMENT_ID_PREFIX)) return null;
  const documents = await listAnnualPlanDocumentsForCustomer(customerId, options);
  return documents.find((document) => document.id === documentId) || null;
}

module.exports = {
  AnnualPlanLabelsUnavailableError,
  DOCUMENT_ID_PREFIX,
  getAnnualPlanDocumentForCustomer,
  listAnnualPlanDocumentsForCustomer,
  listAnnualPlanTermsForCustomer,
  _private: {
    distinctTermLabels,
    documentIdForTerm,
    documentProjection,
  },
};
