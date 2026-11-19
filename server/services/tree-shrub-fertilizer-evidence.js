'use strict';

// NutriRoot is a 2-2-3 liquid fertilizer whose guaranteed analysis lists all
// nitrogen as soluble. It is not an ordinance-safe generic root stimulant:
// Sarasota/Venice and North Port require at least 50% slow-release nitrogen,
// Manatee requires a soil test showing a phosphorus deficiency, and the
// Sarasota/Manatee N/P blackout still applies June 1 through September 30.
//
// A tech who discovers that it was already applied must still be able to make
// a truthful application record. That explicit choice completes with an
// office-review warning/advisory; it never turns the application into an
// approved recommendation.
const EVIDENCE = require('../../shared/tree-shrub-fertilizer-evidence.json');

const NUTRIROOT_PRODUCT = new RegExp(EVIDENCE.nutriRoot.namePattern, 'i');
const NUTRIROOT_SOIL_TEST_BASIS = EVIDENCE.nutriRoot.soilTestBasis;
const NUTRIROOT_ALREADY_APPLIED_BASIS = EVIDENCE.nutriRoot.alreadyAppliedBasis;
const NUTRIROOT_FIELD = 'nutriroot_application_basis';
const NUTRIROOT_SOIL_TEST_REFERENCE_FIELD = 'nutriroot_soil_test_reference';
const NUTRIROOT_REVIEW_LIMIT_TYPE = 'nutriroot_compliance_review';

const isNutriRootName = (value) => NUTRIROOT_PRODUCT.test(String(value || ''));
const hasNutriRoot = (names) => (names || []).some(isNutriRootName);

function serviceDayParts(serviceDate) {
  const match = String(serviceDate instanceof Date && !Number.isNaN(serviceDate.getTime()) ? serviceDate.toISOString() : serviceDate || '')
    .slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day, 12));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) return false;
  return { year, month, day };
}

function isSummerBlackoutForZone(serviceDate, zone) {
  if (!['sarasota_venice', 'manatee_parrish', 'other_unknown'].includes(zone)) return false;
  const parts = serviceDayParts(serviceDate);
  if (!parts) return false;
  const { month, day } = parts;
  return (month > 6 || (month === 6 && day >= 1)) && (month < 9 || (month === 9 && day <= 30));
}

function normalizeBasis(value) {
  const basis = String(value || '').trim();
  return [NUTRIROOT_SOIL_TEST_BASIS, NUTRIROOT_ALREADY_APPLIED_BASIS].includes(basis) ? basis : '';
}

function nutriRootHoldReason({ zone = 'other_unknown', serviceDate } = {}) {
  if (zone === 'manatee_parrish') {
    if (!serviceDayParts(serviceDate)) return 'Confirm the visit date before applying NutriRoot 2-2-3';
    if (isSummerBlackoutForZone(serviceDate, zone)) {
      return 'NutriRoot 2-2-3 contains nitrogen and phosphorus and is not allowed June 1 through September 30';
    }
    return 'NutriRoot 2-2-3 contains phosphorus; use requires a soil test documenting phosphorus-deficient soil';
  }
  if (zone === 'sarasota_venice' || zone === 'north_port') {
    return "NutriRoot 2-2-3 has all-soluble nitrogen and does not meet this zone's 50% slow-release nitrogen rule";
  }
  return 'Confirm the ordinance zone before applying NutriRoot 2-2-3';
}

// Pure policy decision for every product-entry surface. `eligible` is the one
// ordinary application: Manatee, outside the blackout, with a documented
// P-deficient soil test. `review` is only the explicit truthful already-applied
// exception. Everything else stays held.
function nutriRootDecision({ zone = 'other_unknown', serviceDate, basis } = {}) {
  const normalized = normalizeBasis(basis);
  const reason = nutriRootHoldReason({ zone, serviceDate });
  if (normalized === NUTRIROOT_ALREADY_APPLIED_BASIS) {
    return { state: 'review', basis: normalized, reason };
  }
  if (
    zone === 'manatee_parrish'
    && serviceDayParts(serviceDate)
    && !isSummerBlackoutForZone(serviceDate, zone)
    && normalized === NUTRIROOT_SOIL_TEST_BASIS
  ) {
    return { state: 'eligible', basis: normalized, reason: '' };
  }
  return { state: 'held', basis: normalized, reason };
}

function nutriRootPickerEvidence({ zone, serviceDate }) {
  return {
    nutriRootHoldReason: nutriRootHoldReason({ zone, serviceDate }),
    nutriRootSoilTestEligible: nutriRootDecision({ zone, serviceDate, basis: NUTRIROOT_SOIL_TEST_BASIS }).state === 'eligible',
  };
}

function validateNutriRootEvidence(values, { zone, serviceDate, productNames = [] } = {}) {
  if (!hasNutriRoot(productNames)) return { blocks: [], warnings: [], decision: null };
  const decision = nutriRootDecision({ zone, serviceDate, basis: values?.[NUTRIROOT_FIELD] });
  const field = NUTRIROOT_FIELD;
  if (decision.state === 'eligible') {
    const reference = String(values?.[NUTRIROOT_SOIL_TEST_REFERENCE_FIELD] || '').trim().slice(0, 240);
    if (reference) return { blocks: [], warnings: [], decision: { ...decision, soilTestReference: reference } };
    return {
      blocks: [{
        code: 'tree_shrub_nutriroot_soil_test_reference_required',
        field: NUTRIROOT_SOIL_TEST_REFERENCE_FIELD,
        message: 'Enter the P-deficient soil-test report date or file reference before recording NutriRoot in Manatee.',
      }],
      warnings: [],
      decision,
    };
  }
  if (decision.state === 'review') {
    return {
      blocks: [],
      warnings: [{
        code: 'tree_shrub_nutriroot_already_applied_review',
        field,
        message: `Recorded as already applied. The office will review NutriRoot: ${decision.reason}.`,
      }],
      decision,
    };
  }
  return {
    blocks: [{
      code: 'tree_shrub_nutriroot_evidence_required',
      field,
      message: `${decision.reason}. Remove NutriRoot, document the eligible Manatee soil-test basis, or choose “${NUTRIROOT_ALREADY_APPLIED_BASIS}” to preserve a truthful application record for office review.`,
    }],
    warnings: [],
    decision,
  };
}

function nutriRootReviewFinding({ productId = null, productName = 'NutriRoot', zone, serviceDate, basis } = {}) {
  const decision = nutriRootDecision({ zone, serviceDate, basis });
  if (decision.state !== 'review') return null;
  return {
    code: 'application_limit_exceeded',
    limitType: NUTRIROOT_REVIEW_LIMIT_TYPE,
    productId,
    productName,
    reason: decision.reason,
    current: null,
    max: null,
    message: `Recorded. The office will review: ${productName}: ${decision.reason}.`,
  };
}

// Post-save review for the explicit already-applied exception. The row has
// already reached the application ledger, so this never blocks or removes it;
// it adds the completion advisory and the same office notification used by
// other after-the-fact product-limit reviews.
async function flagNutriRootApplication({
  svc, record, database, advisory, notify, basis, zone, submittedProductNames = [],
} = {}) {
  if (!record?.id || normalizeBasis(basis) !== NUTRIROOT_ALREADY_APPLIED_BASIS) return advisory;
  let applied = [];
  try {
    const rows = await database('service_products as sp')
      .leftJoin('products_catalog as pc', 'pc.id', 'sp.product_id')
      .where('sp.service_record_id', record.id)
      .select('sp.product_id', database.raw('COALESCE(sp.product_name, pc.name) as product_name'));
    applied = rows.filter((row) => isNutriRootName(row.product_name));
  } catch {
    applied = (submittedProductNames || []).filter(isNutriRootName)
      .map((productName) => ({ product_id: null, product_name: productName }));
  }
  if (!applied.length) return advisory;
  const finding = nutriRootReviewFinding({
    productId: applied[0].product_id,
    productName: applied[0].product_name,
    zone,
    serviceDate: record.service_date || svc?.scheduled_date,
    basis,
  });
  if (!finding) return advisory;
  await notify({ svc, record, findings: [finding] });
  return {
    advisory: true,
    blocks: [...(advisory?.blocks || []), {
      code: finding.code,
      message: finding.message,
      productId: finding.productId,
    }],
  };
}

module.exports = {
  NUTRIROOT_PRODUCT,
  NUTRIROOT_FIELD,
  NUTRIROOT_SOIL_TEST_REFERENCE_FIELD,
  NUTRIROOT_SOIL_TEST_BASIS,
  NUTRIROOT_ALREADY_APPLIED_BASIS,
  NUTRIROOT_REVIEW_LIMIT_TYPE,
  isNutriRootName,
  hasNutriRoot,
  normalizeBasis,
  nutriRootHoldReason,
  nutriRootDecision,
  nutriRootPickerEvidence,
  validateNutriRootEvidence,
  nutriRootReviewFinding,
  flagNutriRootApplication,
};
