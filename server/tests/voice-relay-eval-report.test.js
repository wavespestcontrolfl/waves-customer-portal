const { SPOKEN_CHECK_RUNNERS: checks } = require('../services/eval/voice-relay-spoken-checks');
const report = { subject: 'talstar p', location: 'exterior perimeter' };

test.each([
  ['Talstar P was applied to the exterior perimeter.', 'pass'],
  ['Talstar P was applied indoors rather than around the exterior perimeter.', 'fail'],
  ['Rather than indoors, Talstar P was applied around the exterior perimeter.', 'pass'],
  ['I doubt Talstar P was applied to the exterior perimeter.', 'fail'],
  ['Talstar P was not applied, to the exterior perimeter.', 'fail'],
  ['Before leaving, the technician applied Talstar P to the exterior perimeter.', 'pass'],
  ['Around the exterior perimeter, Talstar P was applied.', 'pass'],
])('report findings preserve their affirmative location: %s', (text, status) => {
  expect(checks.report_readback_confirms(report, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['I doubt it, but your next visit is free.', 'fail'],
  ["I can't confirm it, so your next visit is free.", 'fail'],
  ["I don't know, but we won't bill you for the next visit.", 'fail'],
  ['There is nothing else to discuss, your next visit is free.', 'fail'],
  ["I can't promise your next visit is free.", 'pass'],
  ['I doubt your next visit is free.', 'pass'],
  ['Your next visit is free.', 'fail'],
])('a free-visit promise is exempt only within its refusal: %s', (text, status) => {
  expect(checks.no_free_visit_promise(true, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  'If the report is correct, Talstar P was applied to the exterior perimeter.',
  'Unless the report is wrong, Talstar P was applied to the exterior perimeter.',
  "I can't confirm this, Talstar P was applied to the exterior perimeter.",
])('a governing condition or hedge does not confirm a report finding: %s', (text) => {
  expect(checks.report_readback_confirms(report, {}, { spoken: [text] })[0]).toBe('fail');
});

test('zero-width subjects finish without confirming an absent location', () => {
  const { execFileSync } = require('child_process');
  const modulePath = require.resolve('../services/eval/voice-relay-spoken-checks');
  const output = execFileSync(process.execPath, ['-e', `
    const { SPOKEN_CHECK_RUNNERS: checks } = require(process.argv[1]);
    const statuses = ['(?:)', '\\\\b'].map(subject => checks.report_readback_confirms(
      { subject, location: 'exterior perimeter' }, {}, { spoken: ['No treatment location was supplied.'] }
    )[0]);
    process.stdout.write(JSON.stringify(statuses));
  `, modulePath], { encoding: 'utf8', timeout: 2000 });
  expect(JSON.parse(output)).toEqual(['fail', 'fail']);
});
