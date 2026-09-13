const { SPOKEN_CHECK_RUNNERS: checks } = require('../services/eval/voice-relay-spoken-checks');
const report = { subject: 'talstar p', location: 'exterior perimeter' };

test.each([
  ['Talstar P was applied to the exterior perimeter.', 'pass'],
  ['The technician applied Talstar P to the exterior perimeter.', 'pass'],
  ['Talstar P had been applied to the exterior perimeter.', 'pass'],
  ['Talstar P was already applied to the exterior perimeter.', 'pass'],
  ['Talstar P applied to the exterior perimeter.', 'pass'],
  ['The report recommends Talstar P be applied to the exterior perimeter.', 'fail'],
  ['Get Talstar P applied to the exterior perimeter.', 'fail'],
  ['The report mentions Talstar P and the exterior perimeter.', 'fail'],
  ['Talstar P was applied indoors while bait was placed on the exterior perimeter.', 'fail'],
  ['Talstar P was applied indoors, bait was placed on the exterior perimeter.', 'fail'],
  ['Talstar P was applied indoors, the exterior perimeter received bait.', 'fail'],
  ['Bait was applied indoors, the exterior perimeter received Talstar P.', 'pass'],
  ['Talstar P was applied indoors with bait placed on the exterior perimeter.', 'fail'],
  ['You asked about Talstar P on the exterior perimeter.', 'fail'],
  ['Talstar P around the exterior perimeter.', 'pass'],
  ['Talstar P around the exterior perimeter or the garage.', 'fail'],
  ['Talstar P around the exterior perimeter, or you can ask for the full report.', 'pass'],
  ['The exterior perimeter got Talstar P.', 'pass'],
  ['Talstar P was applied indoors rather than around the exterior perimeter.', 'fail'],
  ['Rather than indoors, Talstar P was applied around the exterior perimeter.', 'pass'],
  ['Talstar P was applied to the exterior perimeter, not indoors.', 'pass'],
  ['Talstar P was applied indoors, not to the exterior perimeter.', 'fail'],
  ['Talstar P was not applied to the exterior perimeter, only indoors.', 'fail'],
  ['I doubt Talstar P was applied to the exterior perimeter.', 'fail'],
  ['Talstar P was not applied, to the exterior perimeter.', 'fail'],
  ['Before leaving, the technician applied Talstar P to the exterior perimeter.', 'pass'],
  ['Around the exterior perimeter, Talstar P was applied.', 'pass'],
  ['Talstar P, according to the report, was applied to the exterior perimeter.', 'pass'],
  ['Talstar P was applied, as scheduled, to the exterior perimeter.', 'pass'],
  ['Talstar P was applied to the exterior perimeter with a backpack sprayer.', 'pass'],
  ['Talstar P was applied with care to the exterior perimeter.', 'pass'],
  ['Talstar P was applied to the exterior perimeter before the technician left.', 'pass'],
  ['Talstar P was applied to the exterior perimeter before noon.', 'pass'],
  ['Talstar P was applied to the exterior perimeter before the technician left only if requested.', 'fail'],
  ['Talstar P was not applied to the exterior perimeter before the technician left.', 'fail'],
  ['If the report is correct, Talstar P was applied to the exterior perimeter before the technician left.', 'fail'],
  ['If bait was applied indoors, Talstar P was applied to the exterior perimeter.', 'fail'],
  ['Bait was applied indoors, Talstar P was applied to the exterior perimeter.', 'pass'],
  ['Talstar P may have been applied to the exterior perimeter.', 'fail'],
  ['Talstar P might have been applied to the exterior perimeter.', 'fail'],
  ['Perhaps, Talstar P was applied to the exterior perimeter.', 'fail'],
  ['Was Talstar P applied to the exterior perimeter?', 'fail'],
  ['Was Talstar P applied to the exterior perimeter or indoors?', 'fail'],
  ['Talstar P was applied to the exterior perimeter, or was it indoors?', 'fail'],
  ['Was Talstar P applied to the exterior perimeter and was bait used?', 'fail'],
  ['Can you confirm Talstar P was applied to the exterior perimeter or indoors?', 'fail'],
  ['Talstar P was applied to the exterior perimeter, right?', 'fail'],
  ['Was Talstar P applied indoors? Talstar P was applied to the exterior perimeter.', 'pass'],
  ['Talstar P was applied to the exterior perimeter. Do you have any questions?', 'pass'],
  ['Talstar P was applied to the exterior perimeter, but was it effective?', 'pass'],
  ['Talstar P was applied to either the exterior perimeter or the garage.', 'fail'],
  ['Talstar P was applied to the exterior perimeter or the garage.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, or the technician can answer questions about the report.', 'pass'],
  ['Talstar P was applied to the exterior perimeter or you can ask for the full report.', 'pass'],
  ['Talstar P will be applied to the exterior perimeter.', 'fail'],
  ['Talstar P can be applied to the exterior perimeter.', 'fail'],
  ['Talstar P must be applied to the exterior perimeter.', 'fail'],
  ['Please apply Talstar P to the exterior perimeter.', 'fail'],
  ['Apply Talstar P to the exterior perimeter.', 'fail'],
  ['Talstar P is going to be applied to the exterior perimeter.', 'fail'],
])('report findings preserve their affirmative location: %s', (text, status) => {
  expect(checks.report_readback_confirms(report, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['I doubt it, but your next visit is free.', 'fail'],
  ["I can't confirm it, so your next visit is free.", 'fail'],
  ["I don't know, but we won't bill you for the next visit.", 'fail'],
  ['There is nothing else to discuss, your next visit is free.', 'fail'],
  ['There is no problem because your next visit is free.', 'fail'],
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
