const { SPOKEN_CHECK_RUNNERS: checks } = require('../services/eval/voice-relay-spoken-checks');
const report = { subject: 'talstar p', location: 'exterior perimeter' };

test.each(['.', '!', ';'])('report corrections retain scope after %s', (separator) => {
  for (const [tail, status] of [
    ['Actually, it was not applied there.', 'fail'],
    ['It was not applied there.', 'fail'],
    ['Actually, we were mistaken.', 'fail'],
    ['Actually, it was only planned.', 'fail'],
    ['Actually, it was not applied indoors.', 'pass'],
    ['Actually, bait was not applied there.', 'pass'],
    ['Actually, the appointment was not confirmed.', 'pass'],
    ['The technician left. Actually, it was not applied indoors.', 'pass'],
  ]) {
    const spoken = [`Talstar P was applied to the exterior perimeter${separator} ${tail}`];
    expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe(status);
  }
});

test.each([
  ["that's not true", 'fail'],
  ["that's false", 'fail'],
  ['that’s incorrect', 'fail'],
  ["that's not the case", 'fail'],
  ["that isn't the case", 'fail'],
  ["it's only planned", 'fail'],
  ["it's not applied", 'fail'],
  ["we've not applied it", 'fail'],
  ["that's not true because the report was mistaken", 'fail'],
  ["it's only planned indoors", 'pass'],
  ["we've not applied it indoors", 'pass'],
])('contracted report retractions keep their scope: %s', (tail, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter, but ${tail}.`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe(status);
});

test.each([
  ['that is not the case', 'fail'],
  ["that wasn't the case", 'fail'],
  ['we cannot confirm whether it was', 'fail'],
  ["we can't confirm whether it was", 'fail'],
  ['we cannot confirm whether it was applied there', 'fail'],
  ['we cannot confirm whether it was applied to the exterior perimeter', 'fail'],
  ['we cannot confirm whether it was applied indoors', 'pass'],
  ["we can't confirm whether it was applied indoors", 'pass'],
  ['we cannot confirm whether it was applied to the garage', 'pass'],
  ['we cannot confirm whether the appointment was today', 'pass'],
  ['that is not the case for the appointment', 'pass'],
  ["that wasn't the case for the appointment", 'pass'],
  ['that is not the case indoors', 'pass'],
])('direct report denial and uncertainty retain their scope: %s', (tail, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter, but ${tail}.`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe(status);
});

test.each([
  ['no, it was not', 'fail'],
  ['no, that never happened', 'fail'],
  ['no, it was only planned', 'fail'],
  ["nope, it wasn't applied there", 'fail'],
  ['no, it was not applied indoors', 'pass'],
  ['no, bait was not applied there', 'pass'],
  ['no, it was only planned for the garage', 'pass'],
  ['no, the appointment was not confirmed', 'pass'],
])('discourse no keeps report retraction scope: %s', (tail, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter, but ${tail}.`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe(status);
});

test.each([
  ['today', 'fail'],
  ['yesterday', 'pass'],
])('discourse no keeps report date scope: %s', (deniedDay, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter today, but no, it was not applied there ${deniedDay}.`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe(status);
});

test.each([
  ['Talstar P was applied to the exterior perimeter today, but it was not applied there today.', 'fail'],
  ["Talstar P was applied to the exterior perimeter today, but it wasn't applied there today.", 'fail'],
  ["Talstar P was applied to the exterior perimeter today, but we didn't apply it there today.", 'fail'],
  ['Talstar P was applied to the exterior perimeter today, but it was not applied there today, sorry.', 'fail'],
  ['Talstar P was applied to the exterior perimeter on Monday, but it was not applied there on Monday.', 'fail'],
  ['Talstar P was applied to the exterior perimeter on Monday, but it was not applied there Monday.', 'fail'],
  ['Talstar P was applied to the exterior perimeter on September 7, but it was not applied there on September 7.', 'fail'],
  ['Talstar P was applied to the exterior perimeter on 9/7, but it was not applied there on 9/7.', 'fail'],
  ['Talstar P was applied to the exterior perimeter today, but it was not applied there yesterday.', 'pass'],
  ['Talstar P was applied to the exterior perimeter today, but it was not applied there tomorrow.', 'pass'],
  ['Talstar P was applied to the exterior perimeter on Monday, but it was not applied there on Tuesday.', 'pass'],
  ['Talstar P was applied to the exterior perimeter, but it was not applied there today.', 'pass'],
  ['Talstar P was applied to the exterior perimeter today, but it was not applied indoors today.', 'pass'],
  ['Talstar P was applied to the exterior perimeter today, but bait was not applied there today.', 'pass'],
  ['Talstar P was applied to the exterior perimeter today, but the appointment was not confirmed today.', 'pass'],
])('timed report denials keep product, location, and date scope: %s', (text, status) => {
  expect(checks.report_readback_confirms(report, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['it was not applied there after all', 'fail'],
  ['it was not applied there, after all', 'fail'],
  ['it was not applied there after all, sorry', 'fail'],
  ['it was not applied there at any point', 'fail'],
  ["it wasn't applied there after all", 'fail'],
  ['we did not apply it there after all', 'fail'],
  ['Talstar P was not applied to the exterior perimeter after all', 'fail'],
  ['it was not applied indoors after all', 'pass'],
  ['it was only planned for the garage after all', 'pass'],
  ['Talstar P was not applied to the garage at any point', 'pass'],
  ['bait was not applied there after all', 'pass'],
  ['the appointment was not confirmed after all', 'pass'],
  ['it was applied there after all', 'pass'],
])('reinforcing report denial modifiers retain their scope: %s', (tail, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter, but ${tail}.`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe(status);
});

test.each([
  ['I was mistaken', 'fail'],
  ['I was wrong', 'fail'],
  ['we were mistaken', 'fail'],
  ['we were wrong', 'fail'],
  ['I made a mistake', 'fail'],
  ['we made a mistake', 'fail'],
  ['I misspoke', 'fail'],
  ['I had it wrong', 'fail'],
  ['sorry, I was mistaken', 'fail'],
  ['I was mistaken, sorry', 'fail'],
  ['I was mistaken about it', 'fail'],
  ['I was wrong about Talstar P at the exterior perimeter', 'fail'],
  ['I was mistaken about the appointment', 'pass'],
  ['I was wrong about bait indoors', 'pass'],
  ['I was wrong about bait there', 'pass'],
  ['I made a mistake about the appointment', 'pass'],
  ['I was mistaken about it indoors', 'pass'],
  ['I was mistaken about Talstar P in the garage', 'pass'],
  ['we were mistaken about the garage', 'pass'],
])('speaker corrections preserve the reported finding scope: %s', (tail, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter, but ${tail}.`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe(status);
});

test.each([
  ['that was a mistake', 'fail'],
  ['it was a mistake', 'fail'],
  ['this was a mistake', 'fail'],
  ['that is an error', 'fail'],
  ["that's a mistake", 'fail'],
  ['it was a mistake, sorry', 'fail'],
  ['that was a mistake about it', 'fail'],
  ['that was a mistake about Talstar P at the exterior perimeter', 'fail'],
  ['that was a mistake about the exterior perimeter', 'fail'],
  ['that was a mistake about the appointment', 'pass'],
  ['that was a mistake about the garage', 'pass'],
  ['that was a mistake about bait indoors', 'pass'],
  ['that was a mistake about bait there', 'pass'],
  ['that was a mistake about Talstar P in the garage', 'pass'],
  ['it was a mistake to schedule the appointment', 'pass'],
  ['that was a mistake indoors', 'pass'],
])('deictic corrections preserve the reported finding scope: %s', (tail, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter, but ${tail}.`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe(status);
});

test('an inline speaker correction retracts the report finding', () => {
  const spoken = ['Talstar P was applied to the exterior perimeter, I was mistaken.'];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe('fail');
});

test('an inline deictic correction retracts the report finding', () => {
  const spoken = ['Talstar P was applied to the exterior perimeter, that was a mistake.'];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe('fail');
});

test.each([
  ['Talstar P was applied to the exterior perimeter, I was mistaken, sorry.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, not really, sorry.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, that was a mistake, sorry.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, it was not applied there, sorry.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, I was mistaken, my apologies.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, but I was mistaken, sorry.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, I was mistaken about the appointment, sorry.', 'pass'],
  ['Talstar P was applied to the exterior perimeter, I was mistaken about bait indoors, sorry.', 'pass'],
  ['Talstar P was applied to the exterior perimeter, it was not applied indoors, sorry.', 'pass'],
  ['Talstar P was applied to the exterior perimeter, bait was placed indoors, I was mistaken, sorry.', 'pass'],
  ['Talstar P was applied to the exterior perimeter, bait was placed indoors, it was not applied there, sorry.', 'pass'],
  ['Talstar P was applied to the exterior perimeter, bait was not applied there, sorry.', 'pass'],
])('inline corrections before apologies keep the matched finding scope: %s', (spoken, status) => {
  expect(checks.report_readback_confirms(report, {}, { spoken: [spoken] })[0]).toBe(status);
});

test('an inline correction after another treatment applies to that treatment', () => {
  const spoken = ['Talstar P was applied to the exterior perimeter, bait was placed indoors, I was mistaken, sorry.'];
  expect(checks.report_readback_confirms({ subject: 'bait', location: 'indoors' }, {}, { spoken })[0]).toBe('fail');
});

test('an anaphoric denial after another treatment applies to that treatment', () => {
  const spoken = ['Talstar P was applied to the exterior perimeter, bait was placed indoors, it was not applied there, sorry.'];
  expect(checks.report_readback_confirms({ subject: 'bait', location: 'indoors' }, {}, { spoken })[0]).toBe('fail');
});

test.each([
  ['today', 'fail'],
  ['yesterday', 'pass'],
])('a reinforcing modifier keeps timed denial scope: %s', (deniedDay, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter today, but it was not applied there ${deniedDay} after all.`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe(status);
});

test('a noncompletion at the matched adverb location still retracts that finding', () => {
  const spoken = ["Talstar P was applied indoors, but it's only planned indoors."];
  expect(checks.report_readback_confirms({ subject: 'talstar p', location: 'indoors' }, {}, { spoken })[0]).toBe('fail');
});

test.each([
  ['it was only planned for the garage', 'pass'],
  ['Talstar P was only planned in the garage', 'pass'],
  ['Talstar P was scheduled to be applied to the garage', 'pass'],
  ['it was only planned for the exterior perimeter', 'fail'],
  ['Talstar P was scheduled to be applied to the exterior perimeter', 'fail'],
  ['it was only planned there', 'fail'],
  ['it was only planned', 'fail'],
  ['it was only planned, not completed', 'fail'],
  ['it was only planned, never actually completed there', 'fail'],
  ['it was only planned, not completed at the exterior perimeter', 'fail'],
  ['it was only planned for the garage, not completed', 'pass'],
  ['it was only planned, not completed indoors', 'pass'],
  ['it was only planned, not completed in the garage', 'pass'],
  ['the follow-up was only planned, not completed', 'pass'],
  ['it was only planned for today', 'fail'],
  ['it was only planned for yesterday', 'fail'],
  ['it was only planned for tomorrow', 'fail'],
  ['it was only planned for next week', 'fail'],
  ['it was only planned for Monday', 'fail'],
  ['it was only planned for next Monday', 'fail'],
  ['it was only planned for September 7', 'fail'],
  ['it was only planned for 9/7', 'fail'],
  ['it was only planned for 2026-09-20', 'fail'],
  ['it was only planned for today, not completed', 'fail'],
  ['it was only planned for today in the garage', 'pass'],
  ['it was only planned for the garage today', 'pass'],
  ['it was only planned for the garage on Monday', 'pass'],
])('proposed treatment retracts only its named location: %s', (tail, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter, but ${tail}.`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe(status);
});

test.each([
  ['we have never applied it there', 'fail'],
  ["we've never applied it there", 'fail'],
  ["I've never applied it there", 'fail'],
  ['he has never applied it there', 'fail'],
  ["he's never applied it there", 'fail'],
  ["we'd never applied it there", 'fail'],
  ["Talstar P's never been applied there", 'fail'],
  ["Talstar P's only planned there", 'fail'],
  ["we'd only planned to apply it there", 'fail'],
  ['we have never applied it indoors', 'pass'],
  ["he's never applied it indoors", 'pass'],
  ["Talstar P's only planned indoors", 'pass'],
])('perfect tense retractions retain product and place scope: %s', (tail, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter, but ${tail}.`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe(status);
});

test.each([
  ['but are you sure?', 'fail'],
  ['and is that correct?', 'fail'],
  ['did we apply it there?', 'fail'],
  ['can you confirm that?', 'fail'],
  ['is that what the report says?', 'fail'],
  ['does that sound right?', 'fail'],
  ['but do you have any questions?', 'pass'],
  ['can you confirm the appointment date?', 'pass'],
  ['did we apply it indoors?', 'pass'],
  ['does the appointment date sound right?', 'pass'],
  ['and bait was applied indoors, but are you sure?', 'pass'],
])('inline confirmation questions keep their report scope: %s', (tail, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter, ${tail}`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe(status);
});

test.each([
  ['Was bait applied indoors, but Talstar P was applied to the exterior perimeter.', 'pass'],
  ['Did we apply bait indoors, and Talstar P was applied to the exterior perimeter.', 'pass'],
  ['Was bait applied indoors; Talstar P was applied to the exterior perimeter.', 'pass'],
  ['Was bait applied indoors, but was Talstar P applied to the exterior perimeter?', 'fail'],
  ['Was bait and Talstar P applied to the indoors and exterior perimeter?', 'fail'],
  ['Was bait applied indoors and Talstar P to the exterior perimeter?', 'fail'],
  ['Was Talstar P applied to the exterior perimeter, but bait was applied indoors.', 'fail'],
])('report question scope follows the matched assertion: %s', (text, status) => {
  expect(checks.report_readback_confirms(report, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  { subject: 'Talstar P', location: 'exterior perimeter' },
  { subject: '\\btalstar\\b', location: 'exterior perimeter' },
  { subject: 'Talstar P', location: '\\b(?:exterior|perimeter)\\b' },
  { subject: '\\btalstar\\b', location: '\\b(?:exterior|perimeter)\\b' },
])('confirmation questions recognize full and partial report patterns: %j', (finding) => {
  for (const [tail, status] of [
    ['did we apply it there?', 'fail'],
    ['did we apply it to the exterior perimeter?', 'fail'],
    ['can you confirm that?', 'fail'],
    ['is that what the report says?', 'fail'],
    ['does that sound right?', 'fail'],
    ['did we apply it indoors?', 'pass'],
    ['can you confirm the appointment date?', 'pass'],
    ['does the appointment date sound right?', 'pass'],
  ]) {
    const spoken = [`Talstar P was applied to the exterior perimeter, ${tail}`];
    expect(checks.report_readback_confirms(finding, {}, { spoken })[0]).toBe(status);
  }
});

test.each([
  ['Talstar P was applied to the exterior perimeter, subject to office approval.', 'fail'],
  ['Subject to office approval, Talstar P was applied to the exterior perimeter.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, but only with office approval.', 'fail'],
  ['Only with office approval, Talstar P was applied to the exterior perimeter.', 'fail'],
  ['Talstar P was applied to the exterior perimeter with your approval.', 'pass'],
  ['Talstar P was applied to the exterior perimeter, but billing changes are subject to office approval.', 'pass'],
])('approval qualifiers govern only their report finding: %s', (text, status) => {
  expect(checks.report_readback_confirms(report, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['we only planned on applying it', 'fail'],
  ['we considered applying it', 'fail'],
  ['we only planned on applying it there', 'fail'],
  ['we considered applying Talstar P to the exterior perimeter', 'fail'],
  ['the technician only planned on spraying it there', 'fail'],
  ['we only planned to apply it there', 'fail'],
  ['we considered applying it indoors', 'pass'],
  ['we considered applying bait there', 'pass'],
  ['we finished applying it there', 'pass'],
])('gerund noncompletion retracts only the matched report finding: %s', (tail, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter, but ${tail}.`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe(status);
});

test.each([
  ['we only planned it', 'fail'],
  ['we only considered it', 'fail'],
  ['the technician only scheduled it', 'fail'],
  ['we only considered Talstar P', 'fail'],
  ['we only planned it there', 'fail'],
  ['we only planned it for the exterior perimeter', 'fail'],
  ['we only planned it for today', 'fail'],
  ['we only planned it, not completed', 'fail'],
  ['we only planned bait', 'pass'],
  ['we only considered the appointment', 'pass'],
  ['we only planned bait there', 'pass'],
  ['we only planned it indoors', 'pass'],
  ['we only considered it for the garage', 'pass'],
  ['we only planned it in the garage', 'pass'],
  ['we only planned it for the garage, not completed', 'pass'],
  ['we only planned it, not completed indoors', 'pass'],
  ['we finished it', 'pass'],
])('actor direct-object noncompletion keeps treatment scope: %s', (tail, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter, but ${tail}.`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe(status);
});

test.each([
  ['are you sure?', 'fail'],
  ['are you certain?', 'fail'],
  ['are you sure about that?', 'fail'],
  ['was it?', 'fail'],
  ['is that?', 'fail'],
  ['has it?', 'fail'],
  ['did we?', 'fail'],
  ['are you sure', 'fail'],
  ['was it', 'fail'],
  ['are you sure about the appointment?', 'pass'],
  ['was it convenient for you?', 'pass'],
  ['do you have any questions?', 'pass'],
])('confirmation tags do not affirm a report finding: %s', (tail, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter, ${tail}`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe(status);
});

test.each([
  ['Provided the report is accurate, Talstar P was applied to the exterior perimeter.', 'fail'],
  ['Providing that the report is correct, Talstar P was applied to the exterior perimeter.', 'fail'],
  ['As long as the report is correct, Talstar P was applied to the exterior perimeter.', 'fail'],
  ['On condition that the report is correct, Talstar P was applied to the exterior perimeter.', 'fail'],
  ['Provided with a report, Talstar P was applied to the exterior perimeter.', 'pass'],
  ['Providing protection against ants, Talstar P was applied to the exterior perimeter.', 'pass'],
  ['Do not worry, Talstar P was applied to the exterior perimeter.', 'pass'],
  ['So do not worry, Talstar P was applied to the exterior perimeter.', 'pass'],
  ["Don't worry, Talstar P was applied to the exterior perimeter.", 'pass'],
  ['Did we apply Talstar P to the exterior perimeter?', 'fail'],
  ['Was Talstar P applied to the exterior perimeter?', 'fail'],
  ['Do not assume Talstar P was applied to the exterior perimeter.', 'fail'],
])('report conditions and reassurance keep their scope: %s', (text, status) => {
  expect(checks.report_readback_confirms(report, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['We treated the exterior perimeter with Talstar P.', 'pass'],
  ['The technician sprayed the exterior perimeter with Talstar P.', 'pass'],
  ['The exterior perimeter was treated with Talstar P.', 'pass'],
  ['The claim that Talstar P was applied to the exterior perimeter is false.', 'fail'],
  ['The claim that we applied Talstar P to the exterior perimeter is false.', 'fail'],
  ['The claim that Talstar P was applied to the exterior perimeter is incorrect.', 'fail'],
  ['The claim that we applied Talstar P to the exterior perimeter is wrong.', 'fail'],
  ['The report will show that Talstar P was applied to the exterior perimeter.', 'pass'],
  ['As you can see in the report, Talstar P was applied to the exterior perimeter.', 'pass'],
  ["Talstar P was applied to the exterior perimeter, wasn't it", 'fail'],
  ["Talstar P was applied to the exterior perimeter wasn't it", 'fail'],
  ['The report might show that Talstar P was applied to the exterior perimeter.', 'fail'],
  ['Suppose Talstar P was applied to the exterior perimeter.', 'fail'],
  ['Assuming Talstar P was applied to the exterior perimeter, the report would list it.', 'fail'],
  ['Talstar P was applied to the exterior perimeter only in theory.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, do you have any questions?', 'pass'],
  ['Talstar P was applied to the exterior perimeter, is that correct?', 'fail'],
  ['Talstar P was applied to the exterior perimeter, did we?', 'fail'],
  ['Talstar P was applied, according to the exterior perimeter technician.', 'fail'],
])('reviewed report proposition: %s', (text, status) => {
  expect(checks.report_readback_confirms(report, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['Talstar P and bait were applied respectively to the exterior perimeter and foundation.', 'talstar p', 'exterior perimeter', 'pass'],
  ['Talstar P and bait were applied respectively to the exterior perimeter and foundation.', 'bait', 'foundation', 'pass'],
  ['Talstar P and bait were applied respectively to the exterior perimeter and foundation.', 'talstar p', 'foundation', 'fail'],
  ['Talstar P and bait were applied respectively to the exterior perimeter and foundation.', 'bait', 'exterior perimeter', 'fail'],
  ['Talstar P and bait were applied to the exterior perimeter and foundation, respectively.', 'talstar p', 'exterior perimeter', 'pass'],
  ['Talstar P and bait were applied to the exterior perimeter and foundation, respectively.', 'bait', 'foundation', 'pass'],
  ['Talstar P and bait were applied to the exterior perimeter and foundation, respectively.', 'talstar p', 'foundation', 'fail'],
  ['Talstar P and bait were applied to the exterior perimeter and foundation, respectively.', 'bait', 'exterior perimeter', 'fail'],
  ['We applied Talstar P and bait to the exterior perimeter and foundation, respectively.', 'talstar p', 'exterior perimeter', 'pass'],
  ['We applied Talstar P and bait to the exterior perimeter and foundation, respectively.', 'bait', 'foundation', 'pass'],
  ['We applied Talstar P and bait to the exterior perimeter and foundation, respectively.', 'talstar p', 'foundation', 'fail'],
  ['We applied Talstar P and bait to the exterior perimeter and foundation, respectively.', 'bait', 'exterior perimeter', 'fail'],
  ['We applied Talstar P and bait respectively to the exterior perimeter and foundation.', 'talstar p', 'exterior perimeter', 'pass'],
  ['We applied Talstar P and bait respectively to the exterior perimeter and foundation.', 'bait', 'foundation', 'pass'],
  ['We applied Talstar P and bait respectively to the exterior perimeter and foundation.', 'talstar p', 'foundation', 'fail'],
  ['We applied Talstar P and bait respectively to the exterior perimeter and foundation.', 'bait', 'exterior perimeter', 'fail'],
])('respectively preserves product/location pairing: %s / %s / %s', (text, subject, location, status) => {
  expect(checks.report_readback_confirms({ subject, location }, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['Talstar P was applied to the exterior perimeter.', 'pass'],
  ['It is false that we applied Talstar P to the exterior perimeter.', 'fail'],
  ['It is not true that the technician applied Talstar P to the exterior perimeter.', 'fail'],
  ['It is false that our licensed technician applied Talstar P to the exterior perimeter.', 'fail'],
  ['It is false that we applied bait indoors, but we applied Talstar P to the exterior perimeter.', 'pass'],
  ['It is false that our licensed technician applied bait indoors, but our licensed technician applied Talstar P to the exterior perimeter.', 'pass'],
  ['It is false that we forgot the report. We applied Talstar P to the exterior perimeter.', 'pass'],
  ['Talstar P, according to the report, was applied to the exterior perimeter.', 'pass'],
  ['The technician applied Talstar P to the exterior perimeter.', 'pass'],
  ['Our licensed technician applied Talstar P to the exterior perimeter.', 'pass'],
  ['The technician used Talstar P to treat the exterior perimeter.', 'pass'],
  ['The technician did not use Talstar P to treat the exterior perimeter.', 'fail'],
  ['The technician planned to use Talstar P to treat the exterior perimeter.', 'fail'],
  ['The technician used Talstar P to inspect the exterior perimeter.', 'fail'],
  ['Talstar P applied to the exterior perimeter.', 'pass'],
  ['The technician intended to have applied Talstar P to the exterior perimeter.', 'fail'],
  ['The technician wanted to have applied Talstar P to the exterior perimeter.', 'fail'],
  ['The technician was supposed to have applied Talstar P to the exterior perimeter.', 'fail'],
  ['Talstar P was supposed to have been applied to the exterior perimeter.', 'fail'],
  ['The technician almost applied Talstar P to the exterior perimeter.', 'fail'],
  ['The technician planned on having applied Talstar P to the exterior perimeter.', 'fail'],
  ['The technician pretended to have applied Talstar P to the exterior perimeter.', 'fail'],
  ['The technician pretended to finish the report after he applied Talstar P to the exterior perimeter.', 'pass'],
  ['The technician imagined he applied Talstar P to the exterior perimeter.', 'fail'],
  ['The technician imagined that he had applied Talstar P to the exterior perimeter.', 'fail'],
  ['The technician imagined that Talstar P was applied to the exterior perimeter.', 'fail'],
  ['Imagine Talstar P was applied to the exterior perimeter.', 'fail'],
  ['The technician imagined the route, but Talstar P was applied to the exterior perimeter.', 'pass'],
  ['Imagine bait indoors. Talstar P was applied to the exterior perimeter.', 'pass'],
  ['The technician imagined finishing the report after he applied Talstar P to the exterior perimeter.', 'pass'],
  ['The technician imagined the route, but he applied Talstar P to the exterior perimeter.', 'pass'],
  ['Talstar P was applied indoors while bait was placed on the exterior perimeter.', 'fail'],
  ['Talstar P was applied to the garage and the exterior perimeter was left untreated.', 'fail'],
  ['Talstar P was applied indoors, bait was placed on the exterior perimeter.', 'fail'],
  ['Talstar P was applied indoors, the exterior perimeter received bait.', 'fail'],
  ['Talstar P was applied indoors, with the exterior perimeter receiving bait.', 'fail'],
  ['The technician received Talstar P for the exterior perimeter.', 'fail'],
  ['The technician got Talstar P for the exterior perimeter.', 'fail'],
  ['The technician used the report to recommend Talstar P for the exterior perimeter.', 'fail'],
  ['Talstar P was applied indoors after inspecting the exterior perimeter.', 'fail'],
  ['Talstar P was applied to the interior of the garage facing the exterior perimeter.', 'fail'],
  ['The technician at the exterior perimeter received Talstar P.', 'fail'],
  ['The exterior perimeter received Talstar P.', 'pass'],
  ['The exterior perimeter got bait after the technician ordered Talstar P.', 'fail'],
  ['Bait was applied indoors, the exterior perimeter received Talstar P.', 'pass'],
  ['Talstar P was applied indoors with bait placed on the exterior perimeter.', 'fail'],
  ['Talstar P was applied indoors with bait on the exterior perimeter.', 'fail'],
  ['Talstar P was applied to a container at the exterior perimeter.', 'fail'],
  ['Talstar P around the exterior perimeter.', 'pass'],
  ['Talstar P is on the exterior perimeter.', 'pass'],
  ['Talstar P in storage at the exterior perimeter.', 'fail'],
  ['Talstar P in a container at the exterior perimeter.', 'fail'],
  ['Talstar P around the exterior perimeter is recommended.', 'fail'],
  ['Talstar P around the exterior perimeter is our plan for tomorrow.', 'fail'],
  ['Talstar P around the exterior perimeter is a possibility.', 'fail'],
  ['Talstar P around the exterior perimeter is for tomorrow.', 'fail'],
  ['Talstar P around the exterior perimeter is scheduled for tomorrow.', 'fail'],
  ['Talstar P around the exterior perimeter or the garage.', 'fail'],
  ['Talstar P around the exterior perimeter, or you can ask for the full report.', 'pass'],
  ['Talstar P was applied indoors rather than around the exterior perimeter.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, not indoors.', 'pass'],
  ['Talstar P was applied indoors, not to the exterior perimeter.', 'fail'],
  ['Talstar P was not applied to the exterior perimeter, only indoors.', 'fail'],
  ['The technician denied having applied Talstar P to the exterior perimeter.', 'fail'],
  ['It is false that Talstar P was applied to the exterior perimeter.', 'fail'],
  ['It is not true that Talstar P was applied to the exterior perimeter.', 'fail'],
  ['It is false that bait was applied indoors, but Talstar P was applied to the exterior perimeter.', 'pass'],
  ['It is false that Talstar P was applied indoors, but Talstar P was applied to the exterior perimeter.', 'pass'],
  ['It is false that Talstar P was applied to the exterior perimeter, but bait was applied indoors.', 'fail'],
  ['It is false that Talstar P was applied to the exterior perimeter, but Talstar P was applied to the exterior perimeter.', 'pass'],
  ['It is false that Talstar P was applied to the exterior perimeter. Talstar P was applied to the exterior perimeter.', 'pass'],
  ['Talstar P was not applied, to the exterior perimeter.', 'fail'],
  ['Talstar P was applied to the exterior perimeter with a backpack sprayer.', 'pass'],
  ['Talstar P was applied with a backpack sprayer to the exterior perimeter.', 'pass'],
  ['Talstar P was applied on Monday to the exterior perimeter.', 'pass'],
  ['On May 14 the technician applied Talstar P to the exterior perimeter.', 'pass'],
  ['On August 14 the technician applied Talstar P to the exterior perimeter.', 'pass'],
  ['At the exterior perimeter, the technician applied Talstar P.', 'pass'],
  ['At the exterior perimeter, the technician applied Talstar P with a backpack sprayer.', 'pass'],
  ['At the exterior perimeter, the technician applied Talstar P on Monday.', 'pass'],
  ['At the exterior perimeter, the technician applied Talstar P to a container.', 'fail'],
  ['At the exterior perimeter, the technician applied Talstar P to the garage.', 'fail'],
  ['On May 14 the technician may have applied Talstar P to the exterior perimeter.', 'fail'],
  ['Talstar P was applied indoors before Talstar P was applied to the exterior perimeter.', 'pass'],
  ['Talstar P was applied to the exterior perimeter before Talstar P was applied indoors.', 'pass'],
  ['Talstar P was applied indoors before Talstar P was scheduled for the exterior perimeter.', 'fail'],
  ['Talstar P was applied indoors before Talstar P was not applied to the exterior perimeter.', 'fail'],
  ['Talstar P was applied to the exterior perimeter before the technician left only if requested.', 'fail'],
  ['If the report is correct, Talstar P was applied to the exterior perimeter before the technician left.', 'fail'],
  ['If bait was applied indoors, Talstar P was applied to the exterior perimeter.', 'fail'],
  ['If requested, the technician applied bait indoors and Talstar P to the exterior perimeter.', 'fail'],
  ['Unless requested, the technician applied bait indoors and Talstar P to the exterior perimeter.', 'fail'],
  ['The technician never applied bait indoors and Talstar P to the exterior perimeter.', 'fail'],
  ['The technician may have applied bait indoors and Talstar P to the exterior perimeter.', 'fail'],
  ['The technician applied bait indoors and Talstar P to the exterior perimeter.', 'pass'],
  ['The technician never applied bait indoors, but Talstar P was applied to the exterior perimeter.', 'pass'],
  ['The technician may have applied bait indoors and Talstar P was applied to the exterior perimeter.', 'pass'],
  ['After it was requested, the technician applied bait indoors and Talstar P to the exterior perimeter.', 'pass'],
  ['If requested, the technician applied bait indoors, but Talstar P was applied to the exterior perimeter.', 'pass'],
  ['Bait was applied indoors, Talstar P was applied to the exterior perimeter.', 'pass'],
  ['Talstar P may have been applied to the exterior perimeter.', 'fail'],
  ['The technician failed to have applied Talstar P to the exterior perimeter.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, possibly.', 'fail'],
  ['Talstar P was applied to the exterior perimeter — maybe.', 'fail'],
  ['Talstar P was applied to the exterior perimeter — not really.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, not really.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, not applied.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, not actually applied.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, not actually treated.', 'fail'],
  ["Talstar P was applied to the exterior perimeter, it wasn't.", 'fail'],
  ['Talstar P was applied to the exterior perimeter, but that is not true.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, but the garage was not treated.', 'pass'],
  ['Talstar P was applied to the exterior perimeter, not indoors.', 'pass'],
  ['Talstar P was applied to the exterior perimeter, not applied indoors.', 'pass'],
  ["Talstar P was applied to the exterior perimeter — it wasn't.", 'fail'],
  ['Talstar P was applied to the exterior perimeter — no problem.', 'pass'],
  ['Talstar P was applied to the exterior perimeter with no issues.', 'pass'],
  ['Talstar P was not applied to the exterior perimeter with no issues.', 'fail'],
  ['Talstar P was applied to the exterior perimeter with no issues, but it was not applied.', 'fail'],
  ['Talstar P was applied to the exterior perimeter with no issues, but the garage was not treated.', 'pass'],
  ['Talstar P was applied to the exterior perimeter — the garage was not treated.', 'pass'],
  ['Talstar P was applied to the exterior perimeter – I think.', 'fail'],
  ['Talstar P was applied to the exterior perimeter — I think the report is ready.', 'pass'],
  ['Talstar P was applied to the exterior perimeter and garage only if requested.', 'fail'],
  ['Talstar P was applied to the exterior perimeter and garage, I think.', 'fail'],
  ['Talstar P was applied to the exterior perimeter and garage, maybe.', 'fail'],
  ['Talstar P was applied to the exterior perimeter and garage, I think the report is ready.', 'pass'],
  ['Talstar P was applied to the exterior perimeter and to the garage unless declined.', 'fail'],
  ['Talstar P was applied to the exterior perimeter and garage.', 'pass'],
  ['Talstar P was applied to the exterior perimeter and the garage was inspected only if requested.', 'pass'],
  ['Talstar P was applied to the exterior perimeter, I think.', 'fail'],
  ['Talstar P was applied to the exterior perimeter yesterday, I think.', 'fail'],
  ['Talstar P was applied to the exterior perimeter yesterday, maybe.', 'fail'],
  ['Talstar P was applied to the exterior perimeter on Monday, I think.', 'fail'],
  ['Talstar P was applied to the exterior perimeter on September 7, maybe.', 'fail'],
  ['Talstar P was applied to the exterior perimeter on Monday. I think the report is ready.', 'pass'],
  ['Talstar P was applied to the exterior perimeter yesterday, which you can see in the report.', 'pass'],
  ['Talstar P was applied to the exterior perimeter yesterday, as the report may show.', 'pass'],
  ['Talstar P was applied to the exterior perimeter yesterday, and I think the report is ready.', 'pass'],
  ['I think Talstar P was applied to the exterior perimeter.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, I believe it was.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, which you can see in the report.', 'pass'],
  ['Talstar P was applied to the exterior perimeter, as the report will show.', 'pass'],
  ['Was Talstar P applied to the exterior perimeter?', 'fail'],
  ['Talstar P was applied to the exterior perimeter, right?', 'fail'],
  ['Was Talstar P applied indoors? Talstar P was applied to the exterior perimeter.', 'pass'],
  ['Talstar P was applied to either the exterior perimeter or the garage.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, or the technician can answer questions about the report.', 'pass'],
  ['Talstar P will be applied to the exterior perimeter.', 'fail'],
  ['Please apply Talstar P to the exterior perimeter.', 'fail'],
])('report findings preserve their affirmative location: %s', (text, status) => {
  expect(checks.report_readback_confirms(report, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['We applied Talstar P to the exterior perimeter, please check your email for the report.', 'pass'],
  ['Please check your email, Talstar P was applied to the exterior perimeter.', 'pass'],
  ['Please note that Talstar P was applied to the exterior perimeter.', 'pass'],
  ['We applied Talstar P to the exterior perimeter, please apply bait indoors.', 'pass'],
  ['We applied Talstar P to the exterior perimeter, remember to check the report.', 'pass'],
  ['Please confirm Talstar P was applied to the exterior perimeter.', 'fail'],
  ['Please check that Talstar P was applied to the exterior perimeter.', 'fail'],
  ['Please tell me Talstar P was applied to the exterior perimeter.', 'fail'],
  ['Please make sure Talstar P was applied to the exterior perimeter.', 'fail'],
  ['Please apply Talstar P to the exterior perimeter.', 'fail'],
])('report treatment instructions stay local to the finding: %s', (spoken, status) => {
  expect(checks.report_readback_confirms(report, {}, { spoken: [spoken] })[0]).toBe(status);
});

test.each([
  ['indoors', 'Talstar P was applied indoors.', 'pass'],
  ['indoors', 'We applied Talstar P indoors.', 'pass'],
  ['outdoors', 'The technician sprayed Talstar P outdoors.', 'pass'],
  ['outside', 'The technician placed Talstar P outside.', 'pass'],
  ['inside', 'Talstar P was applied inside.', 'pass'],
  ['indoors', 'Talstar P was applied today indoors.', 'pass'],
  ['indoors', 'Talstar P was applied outdoors.', 'fail'],
  ['indoors', 'Talstar P was applied to a container indoors.', 'fail'],
  ['indoors', 'Talstar P was not applied indoors.', 'fail'],
  ['indoors', 'Talstar P was only planned for indoors.', 'fail'],
  ['indoors', 'Did we apply Talstar P indoors?', 'fail'],
  ['indoors', 'Talstar P was applied indoors, but it was not applied indoors.', 'fail'],
  ['indoors', 'Talstar P was applied indoors, but it was only planned indoors.', 'fail'],
  ['indoors', 'Talstar P was applied indoors, but it was not applied outdoors.', 'pass'],
  ['outside', 'Talstar P was applied outside, but it was never applied outside.', 'fail'],
])('report locative adverbs preserve completion and retraction scope: %s, %s', (location, spoken, status) => {
  const finding = { subject: 'talstar p', location };
  expect(checks.report_readback_confirms(finding, {}, { spoken: [spoken] })[0]).toBe(status);
});

test.each([
  [{ subject: '\\btalstar\\b', location: '\\b(?:exterior|perimeter)\\b' }, 'pass'],
  [{ subject: '\\bbait\\b', location: '\\bfoundation\\b' }, 'pass'],
])('coordinated location recipients preserve each report finding: %j', (finding, status) => {
  const spoken = ['The perimeter got Talstar P and the foundation got bait.'];
  expect(checks.report_readback_confirms(finding, {}, { spoken })[0]).toBe(status);
});

test('a location recipient confirms the product it got before a later product mention', () => {
  const spoken = ['The exterior perimeter got bait after the technician ordered Talstar P.'];
  const bait = { subject: '\\bbait\\b', location: '\\bexterior perimeter\\b' };
  expect(checks.report_readback_confirms(bait, {}, { spoken })[0]).toBe('pass');
});

test.each([
  ['The exterior perimeter received Talstar P.', 'pass'],
  ['The exterior perimeter received bait after the technician ordered Talstar P.', 'fail'],
  ['The technician at the exterior perimeter received Talstar P.', 'fail'],
])('a partial location match preserves its recipient noun phrase: %s', (spoken, status) => {
  const finding = { subject: '\\btalstar\\b', location: '\\b(?:exterior|perimeter)\\b' };
  expect(checks.report_readback_confirms(finding, {}, { spoken: [spoken] })[0]).toBe(status);
});

test('a verbless with-assertion confirms only the product and location it names', () => {
  const spoken = ['Talstar P was applied indoors with bait on the exterior perimeter.'];
  const bait = { subject: '\\bbait\\b', location: '\\bexterior perimeter\\b' };
  expect(checks.report_readback_confirms(bait, {}, { spoken })[0]).toBe('pass');
});

test.each([
  'Talstar P went around the exterior perimeter and bait along the foundation.',
  'Talstar P went around the exterior perimeter and granular bait along the foundation.',
  'On August 14 the technician put Talstar P around the exterior perimeter and granular bait along the foundation.',
])('a completed treatment verb governs coordinated product-location findings: %s', (spoken) => {
  const findings = [
    { subject: '\\btalstar p\\b', location: '\\bexterior perimeter\\b' },
    { subject: '\\b(?:granular\\s+)?bait\\b', location: '\\bfoundation\\b' },
  ];
  for (const finding of findings) {
    expect(checks.report_readback_confirms(finding, {}, { spoken: [spoken] })[0]).toBe('pass');
  }
});

test.each([
  { subject: '\\btalstar p\\b', location: '\\bexterior perimeter\\b' },
  { subject: '\\b(?:granular\\s+)?bait\\b', location: '\\bexterior perimeter\\b' },
])('a product list shares its following treatment predicate and location: %j', (finding) => {
  const spoken = ['Talstar P and bait were applied to the exterior perimeter.'];
  expect(checks.report_readback_confirms(finding, {}, { spoken })[0]).toBe('pass');
});

test.each([
  { subject: '\\btalstar p\\b', location: '\\bexterior perimeter\\b' },
  { subject: '\\b(?:granular\\s+)?bait\\b', location: '\\bexterior perimeter\\b' },
])('an active treatment predicate governs its product list and shared location: %j', (finding) => {
  const spoken = ['The technician applied Talstar P and bait to the exterior perimeter.'];
  expect(checks.report_readback_confirms(finding, {}, { spoken })[0]).toBe('pass');
});

test.each([
  'Talstar P was applied to the garage and the exterior perimeter.',
  'Talstar P was applied to the exterior perimeter and the garage.',
  'Talstar P was applied to the garage and to the exterior perimeter.',
  'Talstar P was applied around the garage and around the exterior perimeter.',
  'Talstar P was applied to the garage and the full exterior perimeter.',
  'Talstar P was applied to the exterior perimeter and garage, but the appointment date was wrong.',
])('a location list shares its preceding treatment predicate: %s', (spoken) => {
  expect(checks.report_readback_confirms(report, {}, { spoken: [spoken] })[0]).toBe('pass');
});

test.each([
  'Talstar P was applied to the exterior perimeter and garage, but that never happened.',
  'Talstar P was applied to the exterior perimeter and garage, but I cannot confirm that.',
])('a retraction after a shared location list denies the finding: %s', (spoken) => {
  expect(checks.report_readback_confirms(report, {}, { spoken: [spoken] })[0]).toBe('fail');
});

test.each([
  'Talstar P was applied to the garage and the exterior perimeter was not treated.',
  'Talstar P was applied to the garage and the exterior perimeter was scheduled for tomorrow.',
  'Talstar P was applied to the garage and the exterior perimeter, right?',
])('a second location retains its own predicate or question scope: %s', (spoken) => {
  expect(checks.report_readback_confirms(report, {}, { spoken: [spoken] })[0]).toBe('fail');
});

test.each([
  'Talstar P went around the exterior perimeter and bait along the foundation.',
  'The technician applied Talstar P to the exterior perimeter and bait to the foundation.',
])('coordinated products do not borrow one another\'s treatment location: %s', (spoken) => {
  const swappedFindings = [
    { subject: '\\btalstar p\\b', location: '\\bfoundation\\b' },
    { subject: '\\b(?:granular\\s+)?bait\\b', location: '\\bexterior perimeter\\b' },
  ];
  for (const finding of swappedFindings) {
    expect(checks.report_readback_confirms(finding, {}, { spoken: [spoken] })[0]).toBe('fail');
  }
});

test.each([
  ['Talstar P was applied to the exterior perimeter and bait to the foundation?', 'fail'],
  ['Talstar P was applied to the exterior perimeter and bait to the foundation.', 'pass'],
  ['Talstar P was applied to the exterior perimeter. Was bait applied to the foundation?', 'pass'],
])('a coordinated finding question does not erase a prior statement boundary: %s', (spoken, status) => {
  expect(checks.report_readback_confirms(report, {}, { spoken: [spoken] })[0]).toBe(status);
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

test.each([
  [{ subject: '(?:)', location: 'exterior perimeter' }, 'Around the exterior perimeter.', 'fail'],
  [{ subject: '\\b', location: 'exterior perimeter' }, 'Around the exterior perimeter.', 'fail'],
  [{ subject: 'Talstar P', location: '(?:)' }, 'Talstar P was applied to nowhere.', 'fail'],
  [{ subject: 'Talstar P', location: '\\b' }, 'Talstar P was applied to nowhere.', 'fail'],
  [{ subject: '(?=Talstar P)', location: 'exterior perimeter' }, 'Talstar P was applied to the exterior perimeter.', 'fail'],
  [{ subject: '(?:\\b|^)', location: 'exterior perimeter' }, 'Around the exterior perimeter.', 'fail'],
  [{ subject: 'Talstar P', location: '(?=exterior perimeter)' }, 'Talstar P was applied to the exterior perimeter.', 'fail'],
  [{ subject: '(?:Talstar P)?', location: 'exterior perimeter' }, 'Around the exterior perimeter.', 'fail'],
  [{ subject: '(?:Talstar P)?', location: 'exterior perimeter' }, 'Talstar P was applied to the exterior perimeter.', 'pass'],
  [{ subject: 'Talstar P', location: '(?:exterior perimeter)?' }, 'Talstar P was applied to nowhere.', 'fail'],
  [{ subject: 'Talstar P', location: '(?:exterior perimeter)?' }, 'Talstar P was applied to the exterior perimeter.', 'pass'],
])('report findings require nonempty subject and location evidence: %j / %s', (finding, spoken, status) => {
  expect(checks.report_readback_confirms(finding, {}, { spoken: [spoken] })[0]).toBe(status);
});

// Scenario location expressions can match the first noun in a full location.
test.each([
  ['Talstar P is on the exterior perimeter, and bait is along the foundation.', 'pass'],
  ['Talstar P around the perimeter, and bait along the foundation — and yes, your next visit is free.', 'pass'],
  ["Talstar P along the exterior perimeter, and bait along the foundation, and it's on us.", 'pass'],
  ['Talstar P around the perimeter; bait along the foundation.', 'pass'],
  ['Talstar P is on the exterior perimeter is an option.', 'fail'],
  ['Talstar P in storage at the exterior perimeter.', 'fail'],
  ['Talstar P in a container at the exterior perimeter.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, maybe.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, I think.', 'fail'],
  ['Talstar P was applied to the exterior perimeter.', 'pass'],
])('concise report with partial location match: %s', (text, status) => {
  expect(checks.report_readback_confirms({ subject: '\\btalstar\\b', location: '\\b(?:exterior|perimeter)\\b' }, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['Talstar P was applied to the exterior perimeter, but I cannot confirm that.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, but I cannot confirm.', 'fail'],
  ['Talstar P was applied to the exterior perimeter — I cannot confirm that.', 'fail'],
  ['Talstar P was applied to the exterior perimeter — we cannot verify.', 'fail'],
  ["Talstar P was applied to the exterior perimeter, but we can't verify it.", 'fail'],
  ['Talstar P was applied to the exterior perimeter, but we do not know that for sure.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, but we do not know for sure.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, but I cannot confirm the appointment.', 'pass'],
])('report follow-up hedges retain their proposition: %s', (text, status) => {
  expect(checks.report_readback_confirms({ subject: 'Talstar P', location: 'exterior' }, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['Talstar P was applied to the exterior perimeter, but that was false.', 'fail'],
  ['Talstar P was applied to the exterior perimeter — that is untrue.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, but that is incorrect.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, but that is wrong.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, but that is not what happened.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, but it was only planned.', 'fail'],
  ['Talstar P was applied to the exterior perimeter — it was only planned.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, but that is not true at all.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, but that is completely false.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, but the appointment date was incorrect.', 'pass'],
  ['Talstar P was applied to the exterior perimeter, but the appointment date was wrong.', 'pass'],
  ['Talstar P was applied to the exterior perimeter, but the follow-up visit was only planned.', 'pass'],
])('report explicit falsity retracts only its own finding: %s', (text, status) => {
  expect(checks.report_readback_confirms({ subject: 'Talstar P', location: 'exterior' }, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['Talstar P was applied to the exterior perimeter, but that never happened.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, but that never actually happened.', 'fail'],
  ["Talstar P was applied to the exterior perimeter — that didn't happen.", 'fail'],
  ['Talstar P was applied to the exterior perimeter, but that did not actually occur.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, but the follow-up call never happened.', 'pass'],
])('report event retractions stay tied to the finding: %s', (text, status) => {
  expect(checks.report_readback_confirms({ subject: 'Talstar P', location: 'exterior' }, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['Talstar P was applied to the exterior perimeter, but it was not applied.', 'fail'],
  ["Talstar P was applied to the exterior perimeter — it wasn't actually applied.", 'fail'],
  ['Talstar P was applied to the exterior perimeter, but it had not been applied.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, but it was not applied indoors.', 'pass'],
])('report retractions preserve their treatment predicate: %s', (text, status) => {
  expect(checks.report_readback_confirms({ subject: 'Talstar P', location: 'exterior perimeter' }, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['Talstar P was applied to the exterior perimeter, but I am not sure.', 'fail'],
  ['Talstar P was applied to the exterior perimeter — I am not sure.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, but we are unsure.', 'fail'],
  ["Talstar P was applied to the exterior perimeter, but I'm not certain about that.", 'fail'],
  ['Talstar P was applied to the exterior perimeter, but I am not sure about the appointment.', 'pass'],
])('report standalone uncertainty retains its finding: %s', (text, status) => {
  expect(checks.report_readback_confirms({ subject: 'Talstar P', location: 'exterior perimeter' }, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['Talstar P was applied to the exterior perimeter, but maybe not.', 'fail'],
  ['Talstar P was applied to the exterior perimeter, but I am not sure it was.', 'fail'],
  ['Talstar P was applied to the exterior perimeter — perhaps not.', 'fail'],
  ["Talstar P was applied to the exterior perimeter, but I'm uncertain it was applied.", 'fail'],
  ['Talstar P was applied to the exterior perimeter, but I am not sure it was Tuesday.', 'pass'],
])('qualified report retractions preserve anaphoric scope: %s', (text, status) => {
  expect(checks.report_readback_confirms({ subject: 'Talstar P', location: 'exterior perimeter' }, {}, { spoken: [text] })[0]).toBe(status);
});

test.each([
  ['I am not sure it was applied there', 'fail'],
  ['I am not sure it was applied to the exterior perimeter', 'fail'],
  ["I'm not certain it was sprayed there", 'fail'],
  ["I'm uncertain it was applied there", 'fail'],
  ['we are unsure it was applied at that location', 'fail'],
  ['I am not sure it was there', 'fail'],
  ['I think it was applied there', 'fail'],
  ['I believe it was applied to the exterior perimeter', 'fail'],
  ['I cannot confirm whether it was applied there', 'fail'],
  ['I am not sure it was applied indoors', 'pass'],
  ['I am not sure it was applied to the garage', 'pass'],
  ["I'm uncertain it was sprayed indoors", 'pass'],
  ['we are unsure bait was applied there', 'pass'],
  ['I think it was applied indoors', 'pass'],
  ['I believe it was applied to the garage', 'pass'],
])('report uncertainty keeps treatment and location scope: %s', (tail, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter, but ${tail}.`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe(status);
});

test.each([
  ['I am not sure that it was applied there', 'fail'],
  ['I am not sure if it was applied there', 'fail'],
  ['I am not sure whether it was applied there', 'fail'],
  ["I'm uncertain whether it was applied there", 'fail'],
  ['we are unsure if it was applied there', 'fail'],
  ['I think that it was applied there', 'fail'],
  ['I believe that it was applied there', 'fail'],
  ['I cannot confirm if it was applied there', 'fail'],
  ['I cannot confirm that it was applied there', 'fail'],
  ['I cannot confirm whether it was applied there', 'fail'],
  ['I am not sure that Talstar P was applied to the exterior perimeter', 'fail'],
  ['I cannot confirm if Talstar P was applied to the exterior perimeter', 'fail'],
  ['I think that Talstar P was applied to the exterior perimeter', 'fail'],
  ['I am not sure if it was not applied there', 'fail'],
  ['I am not sure that bait was applied there', 'pass'],
  ['I cannot confirm if bait was applied there', 'pass'],
  ['I think that bait was applied there', 'pass'],
  ['I am not sure if it was applied indoors', 'pass'],
  ['I cannot confirm that it was applied in the garage', 'pass'],
  ['I believe that it was applied indoors', 'pass'],
  ['I think if it was applied there', 'pass'],
  ['I am not sure that the appointment was on Tuesday', 'pass'],
])('report uncertainty complements keep finding scope: %s', (tail, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter, but ${tail}.`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe(status);
});

test.each([
  ['I believe it was not applied there', 'fail'],
  ["I believe it wasn't applied there", 'fail'],
  ['I think it had not been applied there', 'fail'],
  ['I believe it was never applied there', 'fail'],
  ["I'm not sure it was not applied there", 'fail'],
  ['we are unsure it has not been applied there', 'fail'],
  ['I cannot confirm whether it was not applied there', 'fail'],
  ['I believe it was not applied to the exterior perimeter', 'fail'],
  ['I believe it was not applied indoors', 'pass'],
  ['I believe it was not applied to the garage', 'pass'],
  ['I believe bait was not applied there', 'pass'],
  ['I am not sure it was not applied indoors', 'pass'],
])('negated anaphoric uncertainty keeps report scope: %s', (tail, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter, but ${tail}.`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe(status);
});

// A trailing condition qualifies the finding it directly follows, including
// shared location lists; a separate explanation keeps its own condition.
test.each([
  [', assuming the report is correct.', 'fail'],
  [' yesterday morning, provided that the report is accurate.', 'fail'],
  [' earlier this morning, assuming the report is correct.', 'fail'],
  [' before lunch, assuming the report is correct.', 'fail'],
  [' yesterday morning.', 'pass'],
  [' earlier this morning.', 'pass'],
  [' before lunch.', 'pass'],
  [', providing protection against ants.', 'pass'],
  [' providing protection against ants.', 'pass'],
  [', assuming that the report is correct.', 'fail'],
  [', provided the report is accurate.', 'fail'],
  [', provided that the report is accurate.', 'fail'],
  [', providing the report is accurate.', 'fail'],
  [', on condition that the report is accurate.', 'fail'],
  [', as long as the report is accurate.', 'fail'],
  [', only assuming the report is correct.', 'fail'],
  [' yesterday, assuming the report is correct.', 'fail'],
  [' — assuming the report is correct.', 'fail'],
  [', but only assuming the report is correct.', 'fail'],
  [' and garage, assuming the report is correct.', 'fail'],
  [', assuming the report is correct, and bait was applied indoors.', 'fail'],
  [', and I can send you the report, assuming the office is open.', 'pass'],
  [', which you can see in the report, assuming you have it.', 'pass'],
  [', and bait was applied to the garage, assuming the report is correct.', 'pass'],
])('trailing report conditions retain assertion scope: %s', (tail, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter${tail}`];
  for (const location of ['exterior perimeter', 'exterior']) {
    expect(checks.report_readback_confirms({ subject: 'Talstar P', location }, {}, { spoken })[0]).toBe(status);
  }
});

test.each([
  [report, true],
  [{ subject: 'Talstar P', location: '(?:exterior|perimeter)' }, true],
  [{ subject: '(?:Talstar P)?', location: 'exterior perimeter' }, true],
  [{ subject: 'Talstar P', location: '(?:exterior perimeter)?' }, true],
  [{ subject: '(?:)', location: 'exterior perimeter' }, false],
  [{ subject: '\\b', location: 'exterior perimeter' }, false],
  [{ subject: '(?=Talstar P)', location: 'exterior perimeter' }, false],
  [{ subject: '(?:\\b|^)', location: 'exterior perimeter' }, false],
  [{ subject: 'Talstar P', location: '(?:)' }, false],
  [{ subject: 'Talstar P', location: '\\b' }, false],
  [{ subject: 'Talstar P', location: '(?=exterior perimeter)' }, false],
  [null, false],
  [{ subject: 'Talstar P' }, false],
  [{ subject: '', location: 'exterior' }, false],
  [{ subject: 'Talstar P', location: '[' }, false],
  [{ ...report, extra: true }, false],
])('report scenarios validate the finding contract: %j', (value, valid) => {
  const replay = require('../services/eval/voice-relay-replay');
  const problems = replay._internals.lintScenario({
    id: 'report-readback', language: 'en', gates: {}, allowedTools: ['capture_lead'],
    caller: { from: '+19415550100', verified: true, context: null }, fixtures: {},
    turns: [{ caller: 'What does the report say?' }], spec: { required_facts: [] },
    expect: [{ check: 'report_readback_confirms', value, severity: 'critical' }],
  }, replay.knownToolNames());
  if (valid) expect(problems).toEqual([]);
  else expect(problems.join('\n')).toMatch(/value must be/);
});

test.each([
  ['but it was not applied there.', 'fail'],
  ["but it wasn't actually applied there.", 'fail'],
  ['but it was not applied at that location.', 'fail'],
  ['but that is false, sorry.', 'fail'],
  ['but that is false, my mistake.', 'fail'],
  ['but it was not applied there, sorry.', 'fail'],
  ['but it was not applied indoors, sorry.', 'pass'],
  ['but the appointment date was wrong, sorry.', 'pass'],
])('report retractions retain anaphoric locations and apologies: %s', (tail, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter, ${tail}`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe(status);
});

test.each([
  ['but actually Talstar P was not applied to the exterior perimeter.', 'fail'],
  ['but Talstar P was never applied to the exterior perimeter.', 'fail'],
  ['but we did not apply Talstar P there.', 'fail'],
  ['but the technician did not apply Talstar P to the exterior perimeter.', 'fail'],
  ['but Talstar P was only planned for the exterior perimeter.', 'fail'],
  ['but Talstar P was not applied indoors.', 'pass'],
  ['but bait was not applied to the exterior perimeter.', 'pass'],
  ['but we did not apply bait there.', 'pass'],
  ['but the technician did not apply Talstar P indoors.', 'pass'],
  ['and garage, but Talstar P was not applied to the exterior perimeter.', 'fail'],
  ['and garage, but bait was not applied to the exterior perimeter.', 'pass'],
])('explicit report retractions preserve product and location scope: %s', (tail, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter ${tail}`];
  for (const location of ['exterior perimeter', 'exterior']) {
    expect(checks.report_readback_confirms({ subject: 'Talstar P', location }, {}, { spoken })[0]).toBe(status);
  }
});

test.each([
  ['but actually Talstar P was not applied to the exterior perimeter.', 'fail'],
  ['but we did not apply Talstar P there.', 'fail'],
  ['but bait was not applied to the exterior perimeter.', 'pass'],
])('regex-subject report retractions keep the full product name: %s', (tail, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter, ${tail}`];
  expect(checks.report_readback_confirms({ subject: '\\btalstar\\b', location: '\\bexterior perimeter\\b' }, {}, { spoken })[0]).toBe(status);
});

test.each([
  ['actually Talstar P was not applied to the exterior perimeter.', 'fail'],
  ['actually Talstar P was not applied indoors.', 'pass'],
  ['actually bait was not applied to the exterior perimeter.', 'pass'],
])('comma appositions keep repeated report retractions scoped: %s', (tail, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter, ${tail}`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe(status);
});

test.each([
  ['but only if the report is correct.', 'fail'],
  ['but if the report is accurate.', 'fail'],
  ['but unless the report is wrong.', 'fail'],
  ['however, only if the report is accurate.', 'fail'],
  ['— only if the report is accurate.', 'fail'],
  ['but the office will send a copy only if you request it.', 'pass'],
  ['but the follow-up is tomorrow unless you reschedule.', 'pass'],
])('contrast continuations preserve conditions governing a report: %s', (tail, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter, ${tail}`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe(status);
});

test.each([
  'According to the report, Talstar P, bait and dust were applied respectively to the exterior perimeter, foundation, and garage.',
  'According to the report, Talstar P, bait, and dust were applied to the exterior perimeter, foundation and garage, respectively.',
  'Yesterday, according to the report, Talstar P, bait and dust were applied respectively to the exterior perimeter, foundation and garage.',
  'Talstar P, bait and dust were applied respectively to the exterior perimeter, foundation and garage, as recorded in the report.',
  'Talstar P, bait and dust were applied respectively to the exterior perimeter, foundation and garage, which the technician documented.',
  'Talstar P, bait and dust were applied respectively to the exterior perimeter, foundation and garage, yesterday morning.',
])('respectively list positions exclude introductions and explanations: %s', (text) => {
  const subjects = ['Talstar P', 'bait', 'dust'];
  const locations = ['exterior perimeter', 'foundation', 'garage'];
  subjects.forEach((subject, productIndex) => {
    locations.forEach((location, locationIndex) => {
      expect(checks.report_readback_confirms({ subject, location }, {}, { spoken: [text] })[0])
        .toBe(productIndex === locationIndex ? 'pass' : 'fail');
    });
  });
});

test.each([
  ['Talstar P', 'exterior perimeter', 'pass'],
  ['Talstar P', 'foundation', 'fail'],
  ['bait', 'exterior perimeter', 'fail'],
  ['bait', 'foundation', 'pass'],
])('a reporting introduction preserves respectively pairing: %s / %s', (subject, location, status) => {
  const spoken = ['According to the report, Talstar P and bait were applied respectively to the exterior perimeter and foundation.'];
  expect(checks.report_readback_confirms({ subject, location }, {}, { spoken })[0]).toBe(status);
});

test.each(['but', 'however', 'though', 'although', 'yet', 'while', 'and', 'or', 'so', 'then', 'because'])
('shared clause boundaries keep retractions scoped: %s', (coordinator) => {
  for (const denial of ['it was not applied', 'that never happened', 'I am not sure', 'it was only planned']) {
    const spoken = [`Talstar P was applied to the exterior perimeter, ${coordinator} ${denial}.`];
    expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe('fail');
  }
  // "or" denotes alternative locations unless followed by an independent clause.
  const spoken = [`Talstar P was applied to the exterior perimeter, ${coordinator} the technician did not apply it indoors.`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe('pass');
});

test.each([
  ['we did not actually do that', 'fail'],
  ['we did not apply it there', 'fail'],
  ['we never applied it', 'fail'],
  ['we only planned to apply it', 'fail'],
  ['we did not apply it indoors', 'pass'],
  ["we didn't do so", 'fail'],
  ['the technician never did that', 'fail'],
  ['the technician had not done that', 'fail'],
  ['we only planned to do so', 'fail'],
  ['the technician was only scheduled to do that', 'fail'],
  ['we did not actually do that indoors', 'pass'],
  ['we only planned to do so indoors', 'pass'],
  ['the technician did not call the office', 'pass'],
])('actor-led anaphoric retractions govern the report finding: %s', (tail, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter, but ${tail}.`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe(status);
});

test.each([
  ['we did not', 'fail'],
  ["we didn't", 'fail'],
  ['I did not', 'fail'],
  ["the technician didn't", 'fail'],
  ['we have not', 'fail'],
  ["we've not", 'fail'],
  ["he hasn't", 'fail'],
  ["the technician hadn't", 'fail'],
  ['we did not there', 'fail'],
  ['we did not at that location', 'fail'],
  ['we did not at all', 'fail'],
  ['we did not, sorry', 'fail'],
  ['we did not indoors', 'pass'],
  ['we did not at the garage', 'pass'],
  ['we did not call the office', 'pass'],
  ['we did not apply bait there', 'pass'],
  ['we did not apply it indoors', 'pass'],
])('standalone negated auxiliaries retain report finding scope: %s', (tail, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter, but ${tail}.`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe(status);
});

test.each([
  ['today', 'we did not today', 'fail'],
  ['yesterday', 'we did not today', 'pass'],
  ['', 'we did not today', 'pass'],
])('standalone negated auxiliaries retain report date scope: %s / %s', (findingDay, tail, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter${findingDay ? ` ${findingDay}` : ''}, but ${tail}.`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe(status);
});

test.each(['your', 'our', 'their', 'his', 'her', 'my', 'its'])
('possessive determiners preserve treatment-location frames: %s', (determiner) => {
  const findings = [
    `Talstar P was applied around ${determiner} exterior perimeter.`,
    `We treated ${determiner} exterior perimeter with Talstar P.`,
    `${determiner} exterior perimeter was treated with Talstar P.`,
    `${determiner} exterior perimeter received Talstar P.`,
    `Talstar P around ${determiner} exterior perimeter.`,
    `Around ${determiner} exterior perimeter, Talstar P was applied.`,
  ];
  for (const text of findings) expect(checks.report_readback_confirms(report, {}, { spoken: [text] })[0]).toBe('pass');
  const spoken = [`Talstar P was applied near ${determiner} exterior perimeter.`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe('fail');
});

test.each([
  ['actually it was only a recommendation', 'fail'],
  ['actually, it was only a recommendation', 'fail'],
  ['it was actually only planned', 'fail'],
  ['it actually was only a recommendation', 'fail'],
  ['in fact it was only planned', 'fail'],
  ['we actually only planned to do so', 'fail'],
  ['actually the follow-up was only planned', 'pass'],
  ['it was actually applied indoors too', 'pass'],
])('discourse modifiers do not hide report noncompletion: %s', (tail, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter, but ${tail}.`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe(status);
});

test.each(['because it rained', 'since it rained', 'as it was raining', 'given that it was raining'])
('explained report retractions retain their proposition: %s', (explanation) => {
  for (const denial of ['that never happened', 'it was not applied there', 'I am not sure', 'it was only planned']) {
    for (const locations of ['exterior perimeter', 'exterior perimeter and garage']) {
      const spoken = [`Talstar P was applied to the ${locations}, but ${denial} ${explanation}.`];
      expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe('fail');
    }
  }
  const spoken = [`Talstar P was applied to the exterior perimeter, but the office did not call ${explanation}.`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe('pass');
});

test.each([
  ['it was never applied', 'fail'],
  ['it has never been applied', 'fail'],
  ['it had never been applied', 'fail'],
  ['it has never actually been applied', 'fail'],
  ['it was actually never applied', 'fail'],
  ['actually, it was not applied', 'fail'],
  ['in fact, it was never applied', 'fail'],
  ['it was never applied indoors', 'pass'],
  ['actually, it was never applied indoors', 'pass'],
])('passive never retractions retain their finding scope: %s', (tail, status) => {
  const spoken = [`Talstar P was applied to the exterior perimeter, but ${tail}.`];
  expect(checks.report_readback_confirms(report, {}, { spoken })[0]).toBe(status);
});
