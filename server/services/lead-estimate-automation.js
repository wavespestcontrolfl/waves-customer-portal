const CONFIDENCE_RANK = {
  low: 1,
  medium: 2,
  high: 3,
};

const MIN_AUTOMATION_CONFIDENCE = 'medium';

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const str = String(value).trim();
    if (str) return str;
  }
  return '';
}

function confidenceMeetsMinimum(confidence, minimum = MIN_AUTOMATION_CONFIDENCE) {
  return (CONFIDENCE_RANK[confidence] || 0) >= (CONFIDENCE_RANK[minimum] || 0);
}

function hasConcreteServiceInterest(serviceInterest) {
  const text = firstNonEmpty(serviceInterest).toLowerCase();
  if (!text) return false;
  if (/\bconsultation\b/.test(text)) return false;
  if (/\bnot\s+sure\b/.test(text)) return false;
  if (/\b(other services?|something else)\b/.test(text)) return false;
  return true;
}

function normalizeAddressPieces({ intake = {}, customer = {} } = {}) {
  const normalizedAddress = intake.normalizedAddress || {};
  const line1 = firstNonEmpty(
    normalizedAddress.line1,
    intake.address,
    customer.address_line1,
    customer.address
  );
  const fullAddress = firstNonEmpty(
    normalizedAddress.fullAddress,
    intake.fullAddress,
    line1
  );
  const city = firstNonEmpty(normalizedAddress.city, customer.city);
  const state = firstNonEmpty(normalizedAddress.state, customer.state);
  const zip = firstNonEmpty(normalizedAddress.zip, customer.zip);
  return { line1, fullAddress, city, state, zip };
}

function evaluateLeadEstimateAutomationReadiness({
  intake = {},
  customer = {},
  phone,
  serviceInterest,
  minimumConfidence = MIN_AUTOMATION_CONFIDENCE,
} = {}) {
  const address = normalizeAddressPieces({ intake, customer });
  const resolvedPhone = firstNonEmpty(phone, intake.rawPhone, customer.phone);
  const resolvedServiceInterest = firstNonEmpty(serviceInterest, intake.serviceInterest, customer.service_interest);
  const missing = [];
  const review = [];

  if (!resolvedPhone) missing.push('phone');
  if (!address.line1 || !/\d/.test(address.line1)) missing.push('street_address');
  if (!hasConcreteServiceInterest(resolvedServiceInterest)) missing.push('specific_service');

  if (!address.city && !address.zip) review.push('city_or_zip_missing');
  if (!firstNonEmpty(intake.email, customer.email)) review.push('email_missing_sms_only');

  let confidence = 'high';
  if (review.length > 0) confidence = 'medium';
  if (missing.length > 0) confidence = 'low';

  const ready = missing.length === 0 && confidenceMeetsMinimum(confidence, minimumConfidence);
  const status = ready ? 'ready' : 'blocked';

  return {
    status,
    ready,
    confidence,
    minimumConfidence,
    missing,
    review,
    serviceInterest: resolvedServiceInterest || null,
    address: {
      line1: address.line1 || null,
      city: address.city || null,
      state: address.state || null,
      zip: address.zip || null,
    },
  };
}

function automationNote(readiness) {
  if (!readiness || typeof readiness !== 'object') return 'Automation gate: unavailable.';
  const bits = [
    `Automation gate: ${readiness.status}`,
    `confidence=${readiness.confidence}`,
    `minimum=${readiness.minimumConfidence}`,
  ];
  if (readiness.missing?.length) bits.push(`missing=${readiness.missing.join(',')}`);
  if (readiness.review?.length) bits.push(`review=${readiness.review.join(',')}`);
  return `${bits.join(' | ')}.`;
}

module.exports = {
  MIN_AUTOMATION_CONFIDENCE,
  confidenceMeetsMinimum,
  evaluateLeadEstimateAutomationReadiness,
  automationNote,
  hasConcreteServiceInterest,
};
