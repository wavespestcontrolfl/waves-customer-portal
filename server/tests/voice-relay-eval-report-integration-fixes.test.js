const { SPOKEN_CHECK_RUNNERS: checks } = require('../services/eval/voice-relay-spoken-checks');
const report = { subject: 'talstar p', location: 'exterior perimeter' };
test.each([
  ['Monday, September 7', 'September 7', 'fail'],
  ['Monday September 7', 'September 7', 'fail'],
  ['Monday, September 7', 'Monday, September 7', 'fail'],
  ['Monday, September 7', 'September 8', 'pass'],
  ['Monday, September 7', 'Tuesday, September 8', 'pass'],
  ['September 7', 'Monday, September 7', 'fail'],
])('redundant weekday date scope: %s / %s', (date, deniedDate, status) => {
  expect(checks.report_readback_confirms(report, {}, { spoken: [
    `Talstar P was applied to the exterior perimeter on ${date}. Actually, it was not applied there on ${deniedDate}.`,
  ] })[0]).toBe(status);
});
test.each(['I take that back', 'Scratch that', 'Disregard that'])('immediate explicit retraction: %s', tail => {
  const finding = 'Talstar P was applied to the exterior perimeter';
  for (const spoken of [[`${finding}. ${tail}.`], [finding, `${tail}.`], [`${finding}, but ${tail}.`]]) {
    expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe('fail');
  }
});
test.each([
  'I take that back, sorry',
  'I take that back, my mistake',
  'I take that back, my apologies',
  'Scratch that, sorry',
  'Scratch that, my mistake',
  'Scratch that, my apologies',
  'Disregard that, sorry',
  'Disregard that, my mistake',
  'Disregard that, my apologies',
])('immediate retraction retains its apology suffix: %s', tail => {
  const finding = 'Talstar P was applied to the exterior perimeter';
  for (const spoken of [[`${finding}. ${tail}.`], [finding, `${tail}.`], [`${finding}, but ${tail}.`]]) {
    expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe('fail');
  }
});
test.each([
  'I take the appointment back, my mistake',
  'Scratch the garage, sorry',
  'Disregard the estimate, my apologies',
  'The technician was late, sorry',
  'Sorry, the estimate was wrong',
])('unrelated apology leaves the finding confirmed: %s', tail => {
  const finding = 'Talstar P was applied to the exterior perimeter';
  for (const spoken of [[`${finding}. ${tail}.`], [finding, `${tail}.`]]) {
    expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe('pass');
  }
});
test.each(['I take the appointment back', 'Scratch the garage', 'Disregard the estimate'])('unrelated retraction: %s', tail => {
  expect(checks.report_readback_confirms(report, {}, { spoken: [`Talstar P was applied to the exterior perimeter. ${tail}.`] })[0]).toBe('pass');
});
test.each([
  ['exterior perimeter', 'talstar p', 'pass'],
  ['garage', 'bait', 'pass'],
  ['garage', 'talstar p', 'fail'],
  ['exterior perimeter', 'bait', 'fail'],
])('shared object respectively ownership: %s / %s', (location, subject, status) => {
  expect(checks.report_readback_confirms({ subject, location }, {}, { spoken: [
    'We treated the exterior perimeter and garage using Talstar P and bait, respectively.',
  ] })[0]).toBe(status);
});
test.each([
  ['Talstar P, not bait, was applied to the exterior perimeter.', 'talstar p', 'pass'],
  ['Talstar P, not bait, was applied to the exterior perimeter.', 'bait', 'fail'],
  ['Bait, not Talstar P, was applied to the exterior perimeter.', 'talstar p', 'fail'],
  ['Talstar P was applied to the exterior perimeter, not indoors.', 'talstar p', 'pass'],
  ['Talstar P, not bait, was not applied to the exterior perimeter.', 'talstar p', 'fail'],
])('nominal contrast runner integration: %s / %s', (text, subject, status) => {
  expect(checks.report_readback_confirms({ ...report, subject }, {}, { spoken: [text] })[0]).toBe(status);
});
