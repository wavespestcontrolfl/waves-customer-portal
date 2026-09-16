const { SPOKEN_CHECK_RUNNERS: checks } = require('../services/eval/voice-relay-spoken-checks');
const report = { subject: 'talstar p', location: 'exterior perimeter' };

test.each([
  ['We treated the exterior perimeter with Talstar P.', 'pass'],
  ['The technician sprayed the exterior perimeter with Talstar P.', 'pass'],
  ['The exterior perimeter was treated with Talstar P.', 'pass'],
  ['The claim that Talstar P was applied to the exterior perimeter is false.', 'fail'],
  ['The claim that we applied Talstar P to the exterior perimeter is false.', 'fail'],
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
