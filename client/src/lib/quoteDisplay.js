function isPresent(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

export function humanizeQuoteReason(value) {
  if (!isPresent(value)) return "";
  const raw = String(value).trim();
  const looksLikeToken = raw.includes("_") || /^[A-Z0-9-]+$/.test(raw);
  if (!looksLikeToken) return raw;

  const sentence = raw
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return sentence ? sentence.charAt(0).toUpperCase() + sentence.slice(1) : "";
}

export function quoteRequiredReasonCandidates(item = {}) {
  if (!item || typeof item !== "object") return [];
  const candidates = [
    item.customQuoteReason,
    item.quoteRequiredReason,
    item.reason,
    item.warning,
    item.warningText,
    ...(Array.isArray(item.warnings) ? item.warnings : []),
    ...(Array.isArray(item.manualReviewReasons) ? item.manualReviewReasons : []),
    ...(Array.isArray(item.measurementWarnings) ? item.measurementWarnings : []),
  ];
  const seen = new Set();
  return candidates
    .map(humanizeQuoteReason)
    .filter(Boolean)
    .filter((reason) => {
      const key = reason.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function quoteRequiredReasonText(item = {}, fallback = "Requires review before final pricing.") {
  return quoteRequiredReasonCandidates(item)[0] || fallback;
}

export function quoteRequiredReasonNote(item = {}, existingText = "", fallback = "Requires review before final pricing.") {
  const reason = quoteRequiredReasonText(item, fallback);
  if (!reason) return "";
  const existing = String(existingText || "").toLowerCase();
  const normalizedExisting = humanizeQuoteReason(existingText).toLowerCase();
  const normalizedReason = reason.toLowerCase();
  return (existing && existing.includes(normalizedReason)) || normalizedExisting.includes(normalizedReason) ? "" : reason;
}
