/**
 * Quiz answers (services/lead-quiz.js) — the server allowlist for the two
 * tap answers a quiz page posts with its lead, and the staff line built from
 * them. Every stored or shown value must be a fixed token.
 */
const {
  QUIZ_SEEING, QUIZ_PROPERTY, normalizeQuiz, quizName, quizAnswersLine, quizNoteLine, quizNamesProblem, quizNamesRequest, quizIsCommercial,
  quizContinuesToPrice,
} = require('../services/lead-quiz');
const { TIMELINE_VALUES } = require('../services/lead-timeline');

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

  test('the answers name the problem for every tile but "Not sure"', () => {
    for (const kind of Object.keys(QUIZ_SEEING)) {
      for (const seeing of QUIZ_SEEING[kind]) {
        expect({ kind, seeing, names: quizNamesProblem({ kind, seeing }) }).toEqual({ kind, seeing, names: seeing !== 'unsure' });
      }
    }
    // An unanswered question, another quiz's tile and a non-quiz lead name nothing.
    expect(quizNamesProblem({ kind: 'pest', property: 'condo' })).toBe(false);
    expect(quizNamesProblem({ kind: 'pest', seeing: 'weeds' })).toBe(false);
    expect(quizNamesProblem({ kind: 'tree', seeing: 'ants' })).toBe(false);
    expect(quizNamesProblem(null)).toBe(false);
  });

  test('the answers name the request only when all three are known and name a problem', () => {
    const full = { kind: 'pest', seeing: 'ants', property: 'house' };
    for (const timeline of ['now', 'this_week', 'this_month', 'browsing']) expect(quizNamesRequest(full, timeline)).toBe(true);
    expect(quizNamesRequest({ kind: 'lawn', seeing: 'palms', property: 'business' }, 'now')).toBe(true);
    // A named problem with a missing property or timing is a partial quiz.
    expect(quizNamesRequest({ kind: 'pest', seeing: 'ants' }, 'now')).toBe(false);
    expect(quizNamesRequest(full, null)).toBe(false);
    expect(quizNamesRequest(full, undefined)).toBe(false);
    expect(quizNamesRequest(full, 'someday')).toBe(false);
    expect(quizNamesRequest(full, 'constructor')).toBe(false);
    expect(quizNamesRequest({ kind: 'pest', seeing: 'ants', property: 'castle' }, 'now')).toBe(false);
    // "Not sure" and a non-quiz lead never do.
    expect(quizNamesRequest({ kind: 'pest', seeing: 'unsure', property: 'house' }, 'now')).toBe(false);
    expect(quizNamesRequest({ kind: 'pest', property: 'house' }, 'now')).toBe(false);
    expect(quizNamesRequest(null, 'now')).toBe(false);
  });

  test('only "business" is commercial', () => {
    expect(quizIsCommercial({ kind: 'pest', property: 'business' })).toBe(true);
    for (const property of ['house', 'townhome', 'condo']) expect(quizIsCommercial({ kind: 'pest', property })).toBe(false);
    expect(quizIsCommercial({ kind: 'pest' })).toBe(false);
    expect(quizIsCommercial(null)).toBe(false);
  });
});

describe('quizContinuesToPrice: which answers end on a price page', () => {
  const HOME_QUIZ = { kind: 'pest', seeing: 'roaches', property: 'condo' };

  test('every named problem, at a home, that can wait', () => {
    for (const kind of Object.keys(QUIZ_SEEING)) {
      for (const seeing of QUIZ_SEEING[kind].filter((tile) => tile !== 'unsure')) {
        for (const property of ['house', 'townhome', 'condo']) {
          for (const timeline of ['this_week', 'this_month', 'browsing']) {
            expect({ kind, seeing, property, timeline, ok: quizContinuesToPrice({ kind, seeing, property }, timeline) })
              .toEqual({ kind, seeing, property, timeline, ok: true });
          }
        }
      }
    }
  });

  test('"Today" ends on a call, "Business" on a commercial call-back, "Unsure" on an office review', () => {
    expect(quizContinuesToPrice(HOME_QUIZ, 'now')).toBe(false);
    expect(quizContinuesToPrice({ ...HOME_QUIZ, property: 'business' }, 'this_week')).toBe(false);
    expect(quizContinuesToPrice({ ...HOME_QUIZ, seeing: 'unsure' }, 'this_week')).toBe(false);
    expect(quizContinuesToPrice({ kind: 'lawn', seeing: 'unsure', property: 'house' }, 'browsing')).toBe(false);
  });

  test('an unanswered question is not a yes', () => {
    expect(quizContinuesToPrice({ kind: 'pest', seeing: 'roaches' }, 'this_week')).toBe(false);
    expect(quizContinuesToPrice({ kind: 'pest', property: 'condo' }, 'this_week')).toBe(false);
    expect(quizContinuesToPrice(HOME_QUIZ, null)).toBe(false);
    expect(quizContinuesToPrice(HOME_QUIZ, undefined)).toBe(false);
    expect(quizContinuesToPrice(HOME_QUIZ, 'someday')).toBe(false);
    expect(quizContinuesToPrice(null, 'this_week')).toBe(false);
    expect(quizContinuesToPrice({ kind: 'tree', seeing: 'roaches', property: 'condo' }, 'this_week')).toBe(false);
  });

  test('every declared timeline is decided: only "now" is refused', () => {
    expect(TIMELINE_VALUES.filter((timeline) => !quizContinuesToPrice(HOME_QUIZ, timeline))).toEqual(['now']);
  });
});
