/**
 * Quiz answers from the marketing site's two quiz pages (/pest-control-quiz/
 * and /lawn-care-quiz/ on the hub). A quiz is the shared quote form with
 * three tap questions in front of the contact steps, and it posts to the same
 * lead webhook (routes/lead-webhook.js), so a quiz lead is a form lead first.
 *
 * This module is the server's allowlist for two of the three answers:
 * "What are you seeing?" and "What kind of property?". The third, "How
 * soon?", is the existing `timeline` field (lead-timeline.js).
 *
 * Every stored value is a fixed token from the lists below. Nothing a visitor
 * typed is stored, shown or logged from here, so the answers are safe in the
 * new-lead bell, the Customer 360 note and the Lead Response Agent's context.
 */
const QUIZ_SEEING = {
  pest: ['ants', 'roaches', 'spiders', 'rodents', 'termites', 'wasps', 'mosquitoes', 'bedbugs', 'unsure'],
  lawn: ['weeds', 'patches', 'thinning', 'yellowing', 'bugs', 'fungus', 'shrubs', 'palms', 'unsure'],
};
const QUIZ_PROPERTY = ['house', 'townhome', 'condo', 'business'];

const QUIZ_NAMES = { pest: 'Pest Quiz', lawn: 'Lawn Quiz' };
const SEEING_LABELS = {
  ants: 'Ants', roaches: 'Roaches', spiders: 'Spiders', rodents: 'Rodents', termites: 'Termites',
  wasps: 'Wasps', mosquitoes: 'Mosquitoes', bedbugs: 'Bed bugs',
  weeds: 'Weeds', patches: 'Patches', thinning: 'Thinning', yellowing: 'Yellowing', bugs: 'Lawn bugs',
  fungus: 'Fungus', shrubs: 'Shrubs', palms: 'Palms',
  unsure: 'Not sure',
};
// Keys are lead-timeline.js TIMELINE_VALUES.
const TIMELINE_PHRASES = {
  now: 'wants it today',
  this_week: 'wants it this week',
  this_month: 'wants it this month',
  browsing: 'just pricing',
};

const token = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

/**
 * The `quiz` object a quiz page posts, reduced to its allowlisted tokens:
 * { kind, seeing?, property? }. null unless `kind` names a quiz, so a body
 * with no quiz (every other form) and a malformed one read the same.
 */
function normalizeQuiz(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const kind = token(raw.kind);
  if (!Object.prototype.hasOwnProperty.call(QUIZ_SEEING, kind)) return null;
  const seeing = token(raw.seeing);
  const property = token(raw.property);
  return {
    kind,
    ...(QUIZ_SEEING[kind].includes(seeing) ? { seeing } : {}),
    ...(QUIZ_PROPERTY.includes(property) ? { property } : {}),
  };
}

/** "Pest Quiz" / "Lawn Quiz", or '' when the lead is not a quiz lead. */
function quizName(quiz) {
  return QUIZ_NAMES[quiz?.kind] || '';
}

/**
 * The answers as one staff line: "Roaches, condo, wants it today". `timeline`
 * is the normalized lead-timeline value. Unanswered parts are left out.
 */
function quizAnswersLine(quiz, timeline) {
  if (!quizName(quiz)) return '';
  return [
    SEEING_LABELS[quiz.seeing] || '',
    QUIZ_PROPERTY.includes(quiz.property) ? quiz.property : '',
    TIMELINE_PHRASES[timeline] || '',
  ].filter(Boolean).join(', ');
}

/**
 * The Customer 360 note line: "Pest Quiz: Roaches, condo, wants it today".
 * The quiz name alone when no answer is known; '' for a non-quiz lead.
 */
function quizNoteLine(quiz, timeline) {
  const name = quizName(quiz);
  if (!name) return '';
  const answers = quizAnswersLine(quiz, timeline);
  return answers ? `${name}: ${answers}` : name;
}

/**
 * True when the "What are you seeing?" answer names a problem: one of the
 * quiz's tiles other than "Not sure". Only then do the answers say what the
 * visitor wants, so only then may they stand in for the service line in the
 * new-lead bell.
 */
function quizNamesProblem(quiz) {
  return !!quizName(quiz) && quiz.seeing !== 'unsure' && QUIZ_SEEING[quiz.kind].includes(quiz.seeing);
}

/** "Business" on the property question: the lead is a commercial premises. */
function quizIsCommercial(quiz) {
  return quiz?.property === 'business';
}

module.exports = {
  QUIZ_SEEING,
  QUIZ_PROPERTY,
  normalizeQuiz,
  quizName,
  quizAnswersLine,
  quizNoteLine,
  quizNamesProblem,
  quizIsCommercial,
};
