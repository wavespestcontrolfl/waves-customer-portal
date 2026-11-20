'use strict';

// The per-section shape rules editorial-review.js reviewPlan applies before it
// calls a model (normalizePlanSections), as a pure check the terminal writer
// can run without loading the model layer. A plan that fails here fails in
// reviewPlan with no model, which reads as a reviewer outage, so the writer
// must see it as a rejected draft instead. editorial-review.test.js proves
// the two agree.
const { LIMITS } = require('./editorial-review-contracts');

const MAX_HEADING_CHARS = 500;
const MAX_QUESTION_CHARS = 1000;
const MAX_ANSWER_CHARS = 4000;

// Strings only: a number or an object is not section text (and String() can throw on a JSON object).
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const isObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value);

/** Why `sections` is not a usable plan, or null. */
function planSectionsProblem(sections) {
  if (!Array.isArray(sections) || !sections.length || sections.length > LIMITS.sections) {
    return `answer_plan.sections must hold one to ${LIMITS.sections} sections`;
  }
  for (let index = 0; index < sections.length; index += 1) {
    const section = isObject(sections[index]) ? sections[index] : {};
    const heading = text(section.heading);
    const question = text(section.question);
    const answer = text(section.answer);
    if (!heading || !question || !answer || heading.length > MAX_HEADING_CHARS || question.length > MAX_QUESTION_CHARS || answer.length > MAX_ANSWER_CHARS) {
      return `answer_plan section ${index + 1} needs a heading (up to ${MAX_HEADING_CHARS} characters), a question (up to ${MAX_QUESTION_CHARS}) and an answer (up to ${MAX_ANSWER_CHARS})`;
    }
  }
  return null;
}

module.exports = { planSectionsProblem };
