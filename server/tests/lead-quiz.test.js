/**
 * Quiz answers (services/lead-quiz.js) — the server allowlist for the two
 * tap answers a quiz page posts with its lead, and the staff line built from
 * them. Every stored or shown value must be a fixed token.
 */
const {
  QUIZ_SEEING, QUIZ_PROPERTY, normalizeQuiz, quizName, quizAnswersLine, quizNoteLine, quizIsCommercial,
} = require('../services/lead-quiz');

describe('normalizeQuiz', () => {
  test('keeps the allowlisted tokens of a quiz the site posts', () => {
    expect(normalizeQuiz({ kind: 'pest', seeing: 'roaches', property: 'condo' }))
      .toEqual({ kind: 'pest', seeing: 'roaches', property: 'condo' });
    expect(normalizeQuiz({ kind: ' Lawn ', seeing: 'WEEDS', property: 'House' }))
      .toEqual({ kind: 'lawn', seeing: 'weeds', property: 'house' });
  });

  test('every tile of both quizzes is accepted', () => {
    for (const kind of Object.keys(QUIZ_SEEING)) {
      for (const seeing of QUIZ_SEEING[kind]) {
        for (const property of QUIZ_PROPERTY) {
          expect(normalizeQuiz({ kind, seeing, property })).toEqual({ kind, seeing, property });
        }
      }
    }
  });

  test('an answer from the other quiz, an unknown answer or typed text is dropped, never stored', () => {
    expect(normalizeQuiz({ kind: 'pest', seeing: 'weeds', property: 'condo' })).toEqual({ kind: 'pest', property: 'condo' });
    expect(normalizeQuiz({ kind: 'lawn', seeing: 'ants' })).toEqual({ kind: 'lawn' });
    expect(normalizeQuiz({ kind: 'pest', seeing: '<script>x</script>', property: 'castle' })).toEqual({ kind: 'pest' });
    expect(normalizeQuiz({ kind: 'pest', seeing: { a: 1 }, property: ['house'] })).toEqual({ kind: 'pest' });
    // Keys the site never sends do not ride along.
    expect(normalizeQuiz({ kind: 'pest', seeing: 'ants', note: 'call me', timeline: 'now' })).toEqual({ kind: 'pest', seeing: 'ants' });
  });

  test('no quiz, an unknown quiz or a non-object is null', () => {
    expect(normalizeQuiz(undefined)).toBeNull();
    expect(normalizeQuiz(null)).toBeNull();
    expect(normalizeQuiz('pest')).toBeNull();
    expect(normalizeQuiz(['pest'])).toBeNull();
    expect(normalizeQuiz({})).toBeNull();
    expect(normalizeQuiz({ kind: 'tree', seeing: 'ants' })).toBeNull();
    expect(normalizeQuiz({ kind: 'constructor', seeing: 'ants' })).toBeNull();
    expect(normalizeQuiz({ kind: '__proto__' })).toBeNull();
  });
});

describe('staff wording', () => {
  test('names the quiz', () => {
    expect(quizName({ kind: 'pest' })).toBe('Pest Quiz');
    expect(quizName({ kind: 'lawn' })).toBe('Lawn Quiz');
    expect(quizName(null)).toBe('');
    expect(quizName({ kind: 'tree' })).toBe('');
  });

  test('joins the three answers into one line', () => {
    expect(quizAnswersLine({ kind: 'pest', seeing: 'roaches', property: 'condo' }, 'now')).toBe('Roaches, condo, wants it today');
    expect(quizAnswersLine({ kind: 'lawn', seeing: 'bugs', property: 'business' }, 'this_week')).toBe('Lawn bugs, business, wants it this week');
    expect(quizAnswersLine({ kind: 'pest', seeing: 'unsure', property: 'house' }, 'browsing')).toBe('Not sure, house, just pricing');
    expect(quizAnswersLine({ kind: 'lawn', seeing: 'palms', property: 'townhome' }, 'this_month')).toBe('Palms, townhome, wants it this month');
  });

  test('leaves out an unanswered part and says nothing for a non-quiz lead', () => {
    expect(quizAnswersLine({ kind: 'pest', seeing: 'ants' }, null)).toBe('Ants');
    expect(quizAnswersLine({ kind: 'pest' }, 'now')).toBe('wants it today');
    expect(quizAnswersLine({ kind: 'pest' }, 'someday')).toBe('');
    expect(quizAnswersLine(null, 'now')).toBe('');
  });

  test('the Customer 360 note line names the quiz, then the answers', () => {
    expect(quizNoteLine({ kind: 'pest', seeing: 'roaches', property: 'condo' }, 'now')).toBe('Pest Quiz: Roaches, condo, wants it today');
    expect(quizNoteLine({ kind: 'lawn' }, null)).toBe('Lawn Quiz');
    expect(quizNoteLine(null, 'now')).toBe('');
    expect(quizNoteLine({ kind: 'tree', seeing: 'ants' }, 'now')).toBe('');
  });

  test('only "business" is commercial', () => {
    expect(quizIsCommercial({ kind: 'pest', property: 'business' })).toBe(true);
    for (const property of ['house', 'townhome', 'condo']) expect(quizIsCommercial({ kind: 'pest', property })).toBe(false);
    expect(quizIsCommercial({ kind: 'pest' })).toBe(false);
    expect(quizIsCommercial(null)).toBe(false);
  });
});
