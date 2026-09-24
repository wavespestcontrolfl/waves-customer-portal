'use strict';

const { CHECK_NAMES } = require('./editorial-review-contracts');

function exactPassage(document, title, passage) {
  return typeof passage === 'string' && passage.trim().length > 0
    && (document.includes(passage) || passage === title);
}

function uniqueCoverage(items, key, expected) {
  if (!Array.isArray(items) || items.length !== expected.length) return false;
  const got = items.map((item) => item && item[key]);
  return new Set(got).size === got.length && expected.every((id) => got.includes(id));
}

function validSourceReference(sourceIndex, sourceQuote, sources) {
  return Number.isInteger(sourceIndex) && sourceIndex >= 0 && sourceIndex < sources.length
    && typeof sourceQuote === 'string' && sourceQuote.length > 0
    && sources[sourceIndex].excerpt.includes(sourceQuote);
}

function validateFindingItem(item, checkName, document, title, sources) {
  if (!exactPassage(document, title, item?.passage) || !String(item?.detail || '').trim() || !String(item?.action || '').trim()) return `finding_action:${checkName}`;
  if (!Array.isArray(item.sourceIndexes) || typeof item.sourceQuote !== 'string') return `finding_source_shape:${checkName}`;
  for (const index of item.sourceIndexes) if (!Number.isInteger(index) || index < 0 || index >= sources.length) return `finding_source_index:${checkName}`;
  if (item.sourceQuote && !item.sourceIndexes.some((index) => sources[index].excerpt.includes(item.sourceQuote))) return `finding_quote:${checkName}`;
  return null;
}

function validateChecks(checks, document, title, sources) {
  if (!Array.isArray(checks) || checks.length !== CHECK_NAMES.length) return 'checks_coverage';
  const names = checks.map((check) => check?.name);
  if (new Set(names).size !== CHECK_NAMES.length || !CHECK_NAMES.every((name) => names.includes(name))) return 'checks_coverage';
  for (const check of checks) {
    if (!['pass', 'fail'].includes(check.status) || !Array.isArray(check.findings)) return `check_shape:${check.name}`;
    if ((check.status === 'pass' && check.findings.length) || (check.status === 'fail' && !check.findings.length)) return `check_status:${check.name}`;
    for (const item of check.findings) {
      const error = validateFindingItem(item, check.name, document, title, sources);
      if (error) return error;
    }
  }
  return null;
}

function deterministicClaimKind(passage) {
  const text = String(passage || '');
  const hasQuote = /["“][^"”]{3,}["”]/.test(text);
  if (hasQuote && /\b(?:said|says|stated|according to|wrote|called|described)\b/i.test(text)) return 'expert_quote';
  if (/(?:\$|%|\b\d+(?:[.,]\d+)?\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b)/i.test(text)) return 'quantitative';
  return null;
}

function exactQuotedPhrases(passage) {
  const phrases = [];
  for (const match of String(passage || '').matchAll(/["“]([^"”]{3,})["”]/g)) phrases.push(match[1]);
  return phrases;
}

function validateClaimEvidence(claim, sources) {
  const kinds = ['quantitative', 'expert_quote', 'named_example', 'general', 'non_external'];
  const suitability = ['primary_authoritative', 'suitable_secondary', 'unsuitable', 'not_applicable'];
  if (!kinds.includes(claim.claimKind)) return `claim_kind:${claim.claimId}`;
  if (!suitability.includes(claim.sourceSuitability)) return `claim_suitability:${claim.claimId}`;
  const deterministicKind = deterministicClaimKind(claim.passage);
  if (deterministicKind && claim.claimKind !== deterministicKind) return `claim_kind_mismatch:${claim.claimId}`;
  if (claim.verdict === 'supported') {
    if (!validSourceReference(claim.sourceIndex, claim.sourceQuote, sources)) return `claim_quote:${claim.claimId}`;
    if (claim.sourceSuitability === 'unsuitable' || claim.sourceSuitability === 'not_applicable') return `claim_unsuitable:${claim.claimId}`;
    if (['quantitative', 'expert_quote', 'named_example'].includes(claim.claimKind)
      && claim.sourceSuitability !== 'primary_authoritative') return `claim_primary_source_required:${claim.claimId}`;
    if (claim.claimKind === 'expert_quote'
      && exactQuotedPhrases(claim.passage).some((phrase) => !sources[claim.sourceIndex].excerpt.includes(phrase))) return `claim_attribution_quote:${claim.claimId}`;
  } else {
    if (claim.sourceIndex !== -1 || claim.sourceQuote !== '') return `claim_empty_source:${claim.claimId}`;
    if (claim.verdict === 'non_external' && (claim.claimKind !== 'non_external' || claim.sourceSuitability !== 'not_applicable')) return `claim_non_external_shape:${claim.claimId}`;
  }
  return null;
}

function validateClaims(claims, analysis, document, sources) {
  if (!Array.isArray(claims)) return 'claims_shape';
  const ids = claims.map((claim) => claim?.claimId);
  if (new Set(ids).size !== ids.length) return 'claims_duplicate';
  if (!analysis.claims.every((candidate) => ids.includes(candidate.id))) return 'claims_coverage';
  for (const claim of claims) {
    const seed = analysis.claims.find((candidate) => candidate.id === claim.claimId);
    if (!seed && !String(claim.claimId || '').startsWith('model:')) return 'claims_unknown_id';
    if (!exactPassage(document, '', claim.passage) || (seed && seed.passage !== claim.passage)) return `claim_passage:${claim.claimId}`;
    if (!['supported', 'unsupported', 'non_external'].includes(claim.verdict)) return `claim_verdict:${claim.claimId}`;
    const evidenceError = validateClaimEvidence(claim, sources);
    if (evidenceError) return evidenceError;
    if (claim.verdict === 'unsupported' && !String(claim.action || '').trim()) return `claim_action:${claim.claimId}`;
  }
  return null;
}

function validateReviewJson(json, analysis, document, title, sources) {
  if (!json || json.claimInventoryComplete !== true) return 'claim_inventory_incomplete';
  const checkError = validateChecks(json.checks, document, title, sources);
  if (checkError) return checkError;
  const claimError = validateClaims(json.claims, analysis, document, sources);
  if (claimError) return claimError;
  if (!uniqueCoverage(json.sectionCoverage, 'sectionId', analysis.sections.map((section) => section.id))) return 'section_coverage';
  if (!uniqueCoverage(json.passageCoverage, 'passageId', analysis.passages.map((passage) => passage.id))) return 'passage_coverage';
  const byName = Object.fromEntries(json.checks.map((check) => [check.name, check]));
  if (json.claims.some((claim) => claim.verdict === 'unsupported') && byName.source_support.status !== 'fail') return 'unsupported_claim_check_mismatch';
  if (json.sectionCoverage.some((item) => item.status === 'fail') && byName.answer_first.status !== 'fail') return 'section_check_mismatch';
  if (json.passageCoverage.some((item) => item.status === 'fail') && byName.standalone_passages.status !== 'fail') return 'passage_check_mismatch';
  const sourcePassages = new Set(byName.source_support.findings.map((item) => item.passage));
  if (json.claims.some((claim) => claim.verdict === 'unsupported' && !sourcePassages.has(claim.passage))) return 'unsupported_claim_finding_missing';
  const answerPassages = new Set(byName.answer_first.findings.map((item) => item.passage));
  if (json.sectionCoverage.some((item) => {
    if (item.status !== 'fail') return false;
    const section = analysis.sections.find((candidate) => candidate.id === item.sectionId);
    return section && !answerPassages.has(section.lead) && !answerPassages.has(section.heading);
  })) return 'section_finding_missing';
  const standalonePassages = new Set(byName.standalone_passages.findings.map((item) => item.passage));
  if (json.passageCoverage.some((item) => item.status === 'fail'
    && !standalonePassages.has(analysis.passages.find((passage) => passage.id === item.passageId)?.text))) return 'passage_finding_missing';
  return null;
}

function validatePlanJson(json, sections) {
  if (!json || typeof json.pass !== 'boolean' || !Array.isArray(json.findings)) return 'plan_shape';
  const indexes = sections.map((section) => section.sectionIndex);
  if (!uniqueCoverage(json.sectionCoverage, 'sectionIndex', indexes)) return 'plan_coverage';
  if ((json.pass && json.findings.length) || (!json.pass && !json.findings.length)) return 'plan_status';
  if (json.sectionCoverage.some((item) => item.status === 'fail') === json.pass) return 'plan_coverage_status';
  for (const item of json.findings) {
    const section = sections[item?.sectionIndex];
    if (!section || item.passage !== section.answer || !String(item.detail || '').trim() || !String(item.action || '').trim()) return 'plan_finding';
    if (!json.sectionCoverage.some((entry) => entry.sectionIndex === item.sectionIndex && entry.status === 'fail')) return 'plan_finding_coverage';
  }
  return null;
}

module.exports = { validatePlanJson, validateReviewJson };

