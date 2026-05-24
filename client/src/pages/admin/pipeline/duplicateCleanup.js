function phoneDigits(value) {
  return String(value || "").replace(/\D/g, "").slice(-10);
}

function normalizedEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizedAddress(value) {
  return String(value || "").trim().toLowerCase();
}

export function scoreCandidateMatch(estimate, candidate) {
  const estimatePhone = phoneDigits(estimate?.phone);
  const candidatePhone = phoneDigits(candidate?.phone);
  const exactPhone = estimatePhone.length === 10 && candidatePhone.length === 10 && estimatePhone === candidatePhone;
  const exactEmail = Boolean(normalizedEmail(estimate?.email) && normalizedEmail(estimate?.email) === normalizedEmail(candidate?.email));
  const exactAddress = Boolean(normalizedAddress(estimate?.address) && normalizedAddress(estimate?.address) === normalizedAddress(candidate?.address));
  const alreadyLinked = Boolean(candidate?.estimateId);

  let score = 0;
  if (exactPhone) score += 4;
  if (exactEmail) score += 4;
  if (exactAddress) score += 2;
  if (alreadyLinked) score -= 8;

  return {
    score,
    exactPhone,
    exactEmail,
    exactAddress,
    alreadyLinked,
    highConfidence: !alreadyLinked && (exactPhone || exactEmail) && score >= 4,
  };
}

export function rankCandidateMatches(estimate, candidates = []) {
  return [...candidates]
    .map((candidate) => ({
      ...candidate,
      match: scoreCandidateMatch(estimate, candidate),
    }))
    .sort((a, b) => b.match.score - a.match.score);
}

export function defaultCandidateId(estimate, candidates = []) {
  return rankCandidateMatches(estimate, candidates).find((candidate) => candidate.match.highConfidence)?.leadId || "";
}
