'use strict';

const { CHECK_NAMES } = require('./editorial-review-contracts');

function exactPassage(document, title, passage) {
  return typeof passage === 'string' && passage.trim().length > 0
    && (document.includes(passage) || passage === title);
}

function uniqueCoverage(items, key, expected) {
  if (!Array.isArray(items) || items.length !== expected.length
    || items.some((item) => !['pass', 'fail'].includes(item?.status))) return false;
  const got = items.map((item) => item && item[key]);
  return new Set(got).size === got.length && expected.every((id) => got.includes(id));
}

function validSourceReference(sourceIndex, sourceQuote, sources) {
  return Number.isInteger(sourceIndex) && sourceIndex >= 0 && sourceIndex < sources.length
    && typeof sourceQuote === 'string' && sourceQuote.trim().length >= 8
    && (sourceQuote.match(/[A-Za-z0-9]+/g) || []).length >= 2
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

// UF/IFAS EDIS publication numbers (EENY-514, ENY-228, ENH5, LH010, SL21, IN917, CIR1234) name a source;
// their digits are not figures. Only these prefixes: a rating such as MERV-13 or SEER-16 is a figure. They
// are removed for the figure test only: an attributed quote is detected on the passage as written.
const DOCUMENT_CODE_RE = /\b(?:EENY|ENY|ENH|LH|SL|IN|CIR)-?\d+[A-Z]?\b/g;
const FIGURE_RE = /(?:\$|%|\b\d+(?:[.,]\d+)?\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b)/i;
// A link's destination is not read as prose ("[guide](/pest-control/2026-roach-guide/)"); its text is.
const LINK_DESTINATION_RE = /\]\([^)\s]*(?:\([^)\s]*\)[^)\s]*)*(?:\s+"[^"]*")?\)/g;
const BARE_URL_RE = /https?:\/\/\S+/g;
function deterministicClaimKind(passage) {
  const text = String(passage || '');
  const hasQuote = /["“][^"”]{3,}["”]/.test(text);
  if (hasQuote && /\b(?:said|says|stated|according to|wrote|called|described)\b/i.test(text)) return 'expert_quote';
  const prose = text.replace(LINK_DESTINATION_RE, '] ').replace(BARE_URL_RE, ' ').replace(DOCUMENT_CODE_RE, ' ');
  if (FIGURE_RE.test(prose)) return 'quantitative';
  return null;
}

function exactQuotedPhrases(passage) {
  const phrases = [];
  for (const match of String(passage || '').matchAll(/["“]([^"”]{3,})["”]/g)) phrases.push(match[1]);
  return phrases;
}

// An instruction whose only number counts places the reader checks ("Check 2 traps by the door"): the
// number sits right after the verb and counts one of a closed list of places, never a time, a size, an
// amount or a package ("Look for larvae that hatch in 3 days", "Remove 2 ounces of bait", "2 bags"), and
// no other figure follows in the sentence. A missed form costs a repair, not the review: see
// holdUnsourcedFigures.
const COUNT_INSTRUCTION_RE = /^(?:check|empty|inspect|look at|remove|walk)\s+(?:(?:the|your|all|each|at least|about)\s+)?\d+\s+(?:traps?|stations?|spots?|areas?|corners?|rooms?|doors?|windows?|sides?|pots?|saucers?|drains?|vents?|plants?|gutters?)\b/i;
function isTrivialNumericInstruction(passage) {
  const text = String(passage || '').trim();
  const match = text.match(COUNT_INSTRUCTION_RE);
  return Boolean(match) && !FIGURE_RE.test(text.slice(match[0].length).replace(DOCUMENT_CODE_RE, ' '));
}

// A non_external passage may carry a number only where the number makes no outside claim: a trivial
// instruction, or the visible "Last updated: Month Year" line every brief asks for (content-brief-builder).
// Any other figure, link text included, is held to the deterministic kind.
const DATE_STAMP_RE = /^[*_\s]*(?:last\s+)?(?:updated|reviewed)[*_\s]*:?[*_\s]*(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}[.\s*_]*$/i;
function numericNonExternalAllowed(passage) {
  const text = String(passage || '').trim();
  return isTrivialNumericInstruction(text) || DATE_STAMP_RE.test(text);
}

// A supported claim meets the rules of BOTH its label and the deterministic kind, so a wrong label
// cannot loosen anything (Mac test 2026-11-19: a supported nickname quote labeled "general" used to
// reject a whole 89-claim answer).
function supportedClaimError(claim, kinds, sources) {
  if (!validSourceReference(claim.sourceIndex, claim.sourceQuote, sources)) return `claim_quote:${claim.claimId}`;
  if (claim.sourceSuitability === 'unsuitable' || claim.sourceSuitability === 'not_applicable') return `claim_unsuitable:${claim.claimId}`;
  if (['quantitative', 'expert_quote', 'named_example'].some((kind) => kinds.has(kind))
    && claim.sourceSuitability !== 'primary_authoritative') return `claim_primary_source_required:${claim.claimId}`;
  if (kinds.has('expert_quote')
    && exactQuotedPhrases(claim.passage).some((phrase) => !sources[claim.sourceIndex].excerpt.includes(phrase))) return `claim_attribution_quote:${claim.claimId}`;
  return null;
}

function validateClaimEvidence(claim, sources) {
  const kinds = ['quantitative', 'expert_quote', 'named_example', 'general', 'non_external'];
  const suitability = ['primary_authoritative', 'suitable_secondary', 'unsuitable', 'not_applicable'];
  if (!kinds.includes(claim.claimKind)) return `claim_kind:${claim.claimId}`;
  if (!suitability.includes(claim.sourceSuitability)) return `claim_suitability:${claim.claimId}`;
  const deterministicKind = deterministicClaimKind(claim.passage);
  if (claim.verdict === 'supported') return supportedClaimError(claim, new Set([claim.claimKind, deterministicKind].filter(Boolean)), sources);
  if (claim.sourceIndex !== -1 || claim.sourceQuote !== '') return `claim_empty_source:${claim.claimId}`;
  // An unsupported claim fails source support whatever its label. A figure or an attributed quote marked
  // non_external would skip the source rules, so that stays a hard reject.
  if (claim.verdict !== 'non_external') return null;
  const allowedNumber = deterministicKind === 'quantitative' && numericNonExternalAllowed(claim.passage);
  if (deterministicKind && !allowedNumber) return `claim_kind_mismatch:${claim.claimId}`;
  if (claim.claimKind !== 'non_external' || claim.sourceSuitability !== 'not_applicable') return `claim_non_external_shape:${claim.claimId}`;
  return null;
}

// A figure or an attributed quote the model marked non_external has no source behind it. That used to
// fail the whole answer (claim_kind_mismatch), so one label lost a complete review (Mac test 2026-11-19).
// Such a claim is now held as unsupported, with a source_support finding on its exact passage: the review
// fails on it, and the repair step gets the passage to cite or remove. It only ever makes a review
// stricter. Runs before validateReviewJson, which still rejects a mislabel it did not convert.
const UNSOURCED_ACTION = 'Cite a fetched source that states this figure or quote, or remove it.';
function holdUnsourcedFigures(json) {
  if (!json || !Array.isArray(json.claims) || !Array.isArray(json.checks)) return json;
  const held = json.claims.filter((claim) => {
    if (claim?.verdict !== 'non_external') return false;
    const kind = deterministicClaimKind(claim.passage);
    return Boolean(kind) && !(kind === 'quantitative' && numericNonExternalAllowed(claim.passage));
  });
  if (!held.length) return json;
  const heldIds = new Set(held.map((claim) => claim.claimId));
  const claims = json.claims.map((claim) => (!heldIds.has(claim.claimId) ? claim : {
    ...claim, verdict: 'unsupported', claimKind: deterministicClaimKind(claim.passage),
    sourceSuitability: 'unsuitable', sourceIndex: -1, sourceQuote: '', action: UNSOURCED_ACTION,
  }));
  const checks = json.checks.map((check) => {
    if (check?.name !== 'source_support' || !Array.isArray(check.findings)) return check;
    const passages = new Set(check.findings.map((item) => item?.passage));
    const added = [];
    for (const claim of held) {
      if (passages.has(claim.passage)) continue;
      passages.add(claim.passage);
      added.push({ passage: claim.passage, detail: 'This passage states a figure or an attributed quote with no fetched source behind it.',
        action: UNSOURCED_ACTION, sourceIndexes: [], sourceQuote: '' });
    }
    return { ...check, status: 'fail', findings: [...check.findings, ...added] };
  });
  return { ...json, claims, checks };
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
  const findingIndexes = new Set(json.findings.map((item) => item.sectionIndex));
  if (json.sectionCoverage.some((item) => item.status === 'fail' && !findingIndexes.has(item.sectionIndex))) return 'plan_finding_missing';
  return null;
}

module.exports = { validatePlanJson, validateReviewJson, holdUnsourcedFigures };
