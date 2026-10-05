// N-P-K fertilizer analysis reader, shared by the Intelligence Bar procurement matcher and
// the Price Match scan name check (one parser for separator variants, mixed dashes and
// cued dates). Moved verbatim from services/intelligence-bar/procurement-tools.js.
//
// An N-P-K fertilizer analysis (three 1-2 digit numbers, each with an
// optional one-decimal fraction, joined by -, –, —, or / with optional
// spaces around the separators) is an identity qualifier exactly like a
// concentration or formulation code — a seeded alias "K-Flow" mapping to
// "LESCO K-Flow 0-0-25" must not ground "We bought K-Flow 0-0-20". Checked
// over the WHOLE raw text, not just adjacent to a matched span, because the
// analysis reads as the product's own identity wherever it sits in the
// sentence ("K-Flow — we bought 0-0-20 of it" is still a mismatch).
//
// A REAL analysis uses the SAME separator twice ("0-0-25", "0/0/20") — a
// mixed number like "1-1/2" (gallons) uses TWO DIFFERENT separators ("-"
// then "/") and must never read as one (Codex round-13 P2: "We bought
// Taurus SC, 1-1/2 gallons" misread "1-1/2" as an analysis and refused a
// product with no analysis in its identity at all). \1 backreferences the
// first separator so the second must match it exactly. –/— are normalized
// to a plain "-" first (each is one code unit, same as "-", so match
// indices against the original text are unaffected) so "0–0—25" still
// reads as one analysis with the separator repeated, rather than as two
// different separators that would now fail the backreference.
const ANALYSIS_RE = /\b\d{1,2}(?:\.\d)?\s*([-/])\s*\d{1,2}(?:\.\d)?\s*\1\s*\d{1,2}(?:\.\d)?\b/g;
function normalizeAnalysis(raw) {
  return String(raw).replace(/\s+/g, '').replace(/[–—/]/g, '-');
}
// A deadline date is not an analysis (Codex round-12 P2: "Please buy two
// bottles of Taurus SC by 9/27/26" refused as an 9-27-26 mismatch). A triple
// counts as a date only when a date word introduces it AND it reads as a
// real month/day — "10-10-10" is a common fertilizer grade, so a bare
// date-shaped triple ("Lesco, the 10-10-10") stays an identity qualifier.
const DATE_CUE_BEFORE_RE = /\b(?:by|on|for|before|after|until|till|due|from|since|dated)\s+$/i;
function isCuedDate(text, match) {
  const [month, day] = match[0].split(/\s*[-–—/]\s*/).map(Number);
  const realMonthDay = Number.isInteger(month) && Number.isInteger(day) && month >= 1 && month <= 12 && day >= 1 && day <= 31;
  return realMonthDay && DATE_CUE_BEFORE_RE.test(text.slice(0, match.index));
}
function analysesIn(text) {
  const raw = String(text);
  // Normalize –/— to a plain "-" (same code-unit length, so match.index
  // still lines up with `raw` for isCuedDate's look-back) before matching,
  // so the backreference reads a triple that mixes dash STYLES ("0–0—25")
  // as one repeated separator rather than two different ones.
  const normalized = raw.replace(/[–—]/g, '-');
  return [...normalized.matchAll(ANALYSIS_RE)].filter((m) => !isCuedDate(raw, m)).map((m) => normalizeAnalysis(m[0]));
}

module.exports = { analysesIn };
