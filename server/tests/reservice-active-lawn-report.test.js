// isActiveLawnReport (owner ruling 2026-10-02): an active lawn problem, read from
// the same clauses as the pest test (questions, negated, resolved and historical
// clauses out). Used by the portal assistant's free re-service offer.
const { isActiveLawnReport } = require('../services/reservice-scheduler');

test.each([
  'weeds all over my lawn',
  'Weeds are coming back all over the lawn',
  'the weeds are back again',
  'the grass is looking bad again',
  'the lawn is brown and patchy',
  'brown spots all over the grass',
  'my grass is dying',
  'my yard treatment did not work',
  "the weed control isn't working",
  'the lawn treatment stopped working',
  'chinch bugs are back in the lawn',
  'the chinch bugs are killing my grass',
  'my yard is brown',
  'the yard is looking awful',
  'the weeds returned',
  'the grass is brown and not getting better',
])('active: %s', (text) => {
  expect(isActiveLawnReport(text)).toBe(true);
});

test.each([
  'Tell me about lawn care',
  'Do you treat weeds?',
  'Is my grass going brown?',
  'how often do you fertilize the lawn',
  "the grass isn't brown",
  'no weeds this year',
  "the weeds aren't back",
  'the weeds are gone',
  'last year the weeds were all over the lawn',
  'my lawn looks great',
  'ants are back in the yard',
  'the grass was brown but it is green now',
  'the lawn was patchy, now it looks good',
  "The weeds were back, but they aren't anymore",
  // A complaint word: the portal assistant hands it to the team first.
  'the yard is looking terrible',
  '',
])('not active: %s', (text) => {
  expect(isActiveLawnReport(text)).toBe(false);
});
