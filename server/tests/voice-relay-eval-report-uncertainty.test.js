const { SPOKEN_CHECK_RUNNERS, SPOKEN_CHECK_VALUE_RULES, _internals: grammar } = require('../services/eval/voice-relay-spoken-checks');

// Each classifier receives bounded evidence selected by its consumer. Passing
// completion alone does not confirm a product, target, date or report readback.

test('report grammar has no runner or value-rule registration', () => {
  expect(SPOKEN_CHECK_RUNNERS).not.toHaveProperty('report_readback_confirms');
  expect(SPOKEN_CHECK_VALUE_RULES).not.toHaveProperty('report_readback_confirms');
});

test.each([
  ['There is a possibility that Talstar P was applied to the exterior perimeter.', true],
  ["There's a possibility Talstar P was applied to the exterior perimeter.", true],
  ['There is a chance that Talstar P was applied to the exterior perimeter.', true],
  ['It is possible that Talstar P was applied to the exterior perimeter.', true],
  ['Talstar P was allegedly applied to the exterior perimeter.', true],
  ['It is likely that Talstar P was applied to the exterior perimeter.', true],
  ['Talstar P was likely applied to the exterior perimeter.', true],
  ['Talstar P likely was applied to the exterior perimeter.', true],
  ['Talstar P has likely been applied to the exterior perimeter.', true],
  ['The technician Will applied Talstar P to the exterior perimeter.', false],
  ['The technician May applied Talstar P to the exterior perimeter.', false],
  ['The technician Will may have applied Talstar P to the exterior perimeter.', true],
  ['The technician May will apply Talstar P to the exterior perimeter.', true],
  ['Talstar P could already have been applied to the exterior perimeter.', true],
  ['Talstar P should be applied to the exterior perimeter.', true],
  ['The report might show that Talstar P was applied to the exterior perimeter.', true],
  ['We pretended that Talstar P was applied to the exterior perimeter.', true],
  ['Talstar P was applied tomorrow to the exterior perimeter.', true],
  ['Talstar P was applied yesterday to the exterior perimeter.', false],
  ['Talstar P was applied to the exterior perimeter.', false],
])('scoped report uncertainty: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  'Talstar P appears to have been applied to the exterior perimeter.',
  'Talstar P seems to have been applied to the exterior perimeter.',
  'Talstar P is believed to have been applied to the exterior perimeter.',
  'Talstar P was thought to have been applied to the exterior perimeter.',
  'Talstar P is assumed to have been applied to the exterior perimeter.',
])('epistemic raising does not establish definite treatment: %s', (text) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(true);
});

test.each([
  ['It is possible Talstar P was applied to the exterior perimeter.', true],
  ['It is possible that Talstar P was applied to the exterior perimeter.', true],
  ['We think that Talstar P was applied to the exterior perimeter.', true],
  ['We believe Talstar P was applied to the exterior perimeter.', true],
  ['We confirm that Talstar P was applied to the exterior perimeter.', false],
  ['Talstar P was applied to the exterior perimeter.', false],
])('uncertainty does not require an explicit that complement: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  'The technician imagined that Talstar P was applied to the exterior perimeter.',
  'We imagine that Talstar P was applied to the exterior perimeter.',
])('imagined assertions retain uncertainty: %s', (text) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(true);
});

test.each([
  ['Talstar P might get applied to the exterior perimeter.', 'Talstar P did get applied to the exterior perimeter.'],
  ['It is unlikely that Talstar P was applied to the exterior perimeter.', 'It is confirmed that Talstar P was applied to the exterior perimeter.'],
  ['We thought Talstar P was applied to the exterior perimeter.', 'We confirmed Talstar P was applied to the exterior perimeter.'],
])('uncertain construction differs from definite evidence: %s', (uncertain, definite) => {
  expect(grammar.reportFindingIsUncertain(uncertain)).toBe(true);
  expect(grammar.reportFindingIsUncertain(definite)).toBe(false);
});

test.each(["would've", "could've", "might've", 'would’ve', 'could’ve', 'might’ve'])('contracted modal perfect %s remains uncertain', (modal) => {
  const hypothetical = `We ${modal} applied Talstar P to the exterior perimeter.`;
  expect(grammar.reportFindingIsUncertain(hypothetical)).toBe(true);

  const definite = 'We have applied Talstar P to the exterior perimeter.';
  expect(grammar.reportFindingIsUncertain(definite)).toBe(false);
});

test.each(['assume', 'assumed'])('active %s attribution remains uncertain', (assumption) => {
  const uncertain = `We ${assumption} that Talstar P was applied to the exterior perimeter.`;
  expect(grammar.reportFindingIsUncertain(uncertain)).toBe(true);

  const definite = 'We confirmed that Talstar P was applied to the exterior perimeter.';
  expect(grammar.reportFindingIsUncertain(definite)).toBe(false);
});

test('future successful resultative is uncertain rather than completed evidence', () => {
  const future = 'We will manage to apply Talstar P to the exterior perimeter.';
  expect(grammar.reportFindingIsUncertain(future)).toBe(true);

  const completed = 'We managed to apply Talstar P to the exterior perimeter.';
  expect(grammar.reportFindingIsUncertain(completed)).toBe(false);
});

test('future successful gerund is uncertain rather than completed evidence', () => {
  const future = 'We will succeed in applying Talstar P to the exterior perimeter.';
  expect(grammar.reportFindingIsUncertain(future)).toBe(true);

  const completed = 'We succeeded in applying Talstar P to the exterior perimeter.';
  expect(grammar.reportFindingIsUncertain(completed)).toBe(false);
});

test.each([
  ['The technician Will put Talstar P around the exterior perimeter.', false],
  ['The technician May put Talstar P around the exterior perimeter.', false],
  ['The technician Will may put Talstar P around the exterior perimeter.', true],
  ['The technician May will put Talstar P around the exterior perimeter.', true],
  ['The technician will put Talstar P around the exterior perimeter.', true],
  ['The technician may put Talstar P around the exterior perimeter.', true],
  ['We will put Talstar P around the exterior perimeter.', true],
  ['We may put Talstar P around the exterior perimeter.', true],
])('modal put preserves technician-name tense: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['We can confirm that Talstar P was applied to the exterior perimeter.', false],
  ['I can verify that Talstar P was applied to the exterior perimeter.', false],
  ['We might confirm that Talstar P was applied to the exterior perimeter.', true],
  ['I might verify that Talstar P was applied to the exterior perimeter.', true],
  ['We can confirm that Talstar P might have been applied to the exterior perimeter.', true],
])('affirmative can-confirm differs from speculative confirmation: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  'We hope we can confirm that Talstar P was applied to the exterior perimeter.',
  'I hope I can verify that Talstar P was applied to the exterior perimeter.',
  'We are hoping we can confirm that Talstar P was applied to the exterior perimeter.',
])('tentative governors retain can-confirm uncertainty: %s', (text) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(true);
});

test.each(['Yes, ', 'Okay, ', 'Certainly, ', 'Absolutely, '])('affirmative discourse prefix %s retains explicit confirmation', (prefix) => {
  expect(grammar.reportFindingIsUncertain(`${prefix}we can confirm that Talstar P was applied to the exterior perimeter.`)).toBe(false);
});

test.each([
  ['We can definitely confirm that Talstar P was applied to the exterior perimeter.', false],
  ['We can now confirm that Talstar P was applied to the exterior perimeter.', false],
  ['I can confidently verify that Talstar P was applied to the exterior perimeter.', false],
  ['We can possibly confirm that Talstar P was applied to the exterior perimeter.', true],
  ['I can probably confirm that Talstar P was applied to the exterior perimeter.', true],
  ['We hope we can definitely confirm that Talstar P was applied to the exterior perimeter.', true],
  ['We can definitely confirm that Talstar P might have been applied to the exterior perimeter.', true],
])('adverbial can-confirm preserves certainty scope: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['falsely', 'shows'],
  ['incorrectly', 'lists'],
  ['mistakenly', 'documents'],
  ['erroneously', 'records'],
])('%s documented treatment differs from a positive %s record', (falsity, recordVerb) => {
  const falseRecord = `The report ${falsity} ${recordVerb} Talstar P was applied to the exterior perimeter.`;
  expect(grammar.reportFindingIsUncertain(falseRecord)).toBe(true);

  const positiveRecord = `The report ${recordVerb} Talstar P was applied to the exterior perimeter.`;
  expect(grammar.reportFindingIsUncertain(positiveRecord)).toBe(false);
});

test.each([
  [
    'We hope that Talstar P was applied to the exterior perimeter.',
    'We confirmed that Talstar P was applied to the exterior perimeter.',
  ],
  [
    'We hoped that Talstar P was applied to the exterior perimeter.',
    'We documented that Talstar P was applied to the exterior perimeter.',
  ],
  [
    'Hopefully, Talstar P was applied to the exterior perimeter.',
    'Talstar P was applied to the exterior perimeter.',
  ],
])('hopeful completed-treatment assertion differs from definite evidence: %s', (hopeful, definite) => {
  expect(grammar.reportFindingIsUncertain(hopeful)).toBe(true);
  expect(grammar.reportFindingIsUncertain(definite)).toBe(false);
});

test.each([
  ['The technician Hope applied Talstar P to the exterior perimeter.', false],
  ['The technician Hope may have applied Talstar P to the exterior perimeter.', true],
])('technician Hope retains name scope: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['Talstar P might still have been applied to the exterior perimeter.', true],
  ['Talstar P may well have been applied to the exterior perimeter.', true],
  ['Talstar P has been applied to the exterior perimeter.', false],
])('modal adverbs preserve completed-treatment uncertainty: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['Talstar P was applied as intended.', false],
  ['Talstar P was intended to be applied.', true],
])('completed as-intended treatment differs from intended-to treatment: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['I can confirm Talstar P was applied.', false],
  ['Yes, we can verify Talstar P was applied.', false],
  ['We can confirm whether Talstar P was applied.', true],
  ['We can verify if Talstar P was applied.', true],
])('affirmative can-confirm permits an omitted that complement: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['We applied Talstar P as you wished.', false],
  ['We wish that Talstar P was applied.', true],
  ['We wish we had applied Talstar P.', true],
  ['We wish Talstar P had been applied.', true],
  ['We wished Talstar P had been applied.', true],
])('fulfilled wishes differ from wished-for treatment: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['Based on the report, we can confirm that Talstar P was applied.', false],
  ['Hopefully, based on the report, we can confirm that Talstar P was applied.', true],
  ['If the report is accurate, we can confirm that Talstar P was applied.', true],
])('evidence-prefixed can-confirm retains hopeful and conditional scope: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['The technician May have applied Talstar P.', true],
  ['The technician May applied Talstar P.', false],
  ['The technician Will apply Talstar P.', true],
  ['The technician Will applied Talstar P.', false],
])('technician May and Will distinguish modal syntax from names: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ["We'll apply Talstar P.", true],
  ["I'll treat with Talstar P.", true],
  ["We'd have applied Talstar P.", true],
  ["We'd applied Talstar P.", false],
  ['We’ll apply Talstar P.', true],
  ['I’ll treat with Talstar P.', true],
  ['We’d have applied Talstar P.', true],
  ['We’d applied Talstar P.', false],
])('contracted modal %s retains future and perfect scope', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['Talstar P was supposed to have been applied.', true],
  ['Talstar P was expected to have been applied.', true],
  ['Talstar P was applied.', false],
])('passive expectation differs from completed treatment: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['We applied Talstar P as you had wished.', false],
  ['We applied Talstar P as the customer wished.', false],
  ['We wished that Talstar P was applied.', true],
])('fulfilled past wishes differ from a wish complement: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['We can verify from the report if Talstar P was applied.', true],
  ['We can verify from the report that Talstar P was applied.', false],
  ['We can verify from the report Talstar P was applied.', false],
])('report-grounded verification retains conditional scope: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['Only if the report is accurate, we can confirm that Talstar P was applied.', true],
  ['Assuming the report is accurate, we can confirm that Talstar P was applied.', true],
  ['Based on the report, we can confirm that Talstar P was applied.', false],
])('conditional lead-ins differ from an evidentiary confirmation lead-in: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['The technician Will already put Talstar P around the exterior perimeter.', false],
  ['The technician Will may already put Talstar P around the exterior perimeter.', true],
])('technician Will with put distinguishes a name from a following modal: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ["We'd put Talstar P around the exterior perimeter yesterday.", false],
  ["We'd have put Talstar P around the exterior perimeter yesterday.", true],
  ["We'd already put Talstar P around the exterior perimeter before you arrived.", false],
  ["We'd already have put Talstar P around the exterior perimeter before you arrived.", true],
])('contracted would-have differs from contracted had completion: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['As you know we wish Talstar P had been applied.', true],
  ['As technicians we wish Talstar P had been applied.', true],
  ['Talstar P was applied as you had wished.', false],
])('wish complements survive discourse prefixes without matching fulfilled wishes: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['Talstar P was applied, if the report is accurate.', true],
  ["We'd put Talstar P around the perimeter today if needed.", true],
  ['Talstar P was applied, unless the report is mistaken.', true],
  ['Talstar P was applied today.', false],
])('trailing conditions preserve bounded evidence uncertainty: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ["We'd put Talstar P around the perimeter tonight.", true],
  ["We'd put Talstar P around the perimeter at 3 pm.", true],
  ["We'd put Talstar P around the perimeter today.", true],
  ["We'd put Talstar P around the perimeter yesterday.", false],
])('had-put expansion requires explicit past evidence: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ["We'd put Talstar P around the perimeter tonight, as discussed yesterday.", true],
  ["We'd put Talstar P around the perimeter yesterday.", false],
  ["We'd put 0.5 ounces of Talstar P around the perimeter yesterday.", false],
  ["We'd put 0.5 ounces of Talstar P around the perimeter tonight, as discussed yesterday.", true],
])('4043636444 past disambiguation stays in the put clause: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['Talstar P was applied as if ants were present.', false],
  ['It looks as if Talstar P was applied.', true],
  ['It looked as if Talstar P was applied.', true],
  ['It sounds as if Talstar P was applied.', true],
  ['It is as if Talstar P was applied.', true],
  ['Talstar P was applied, if ants were present.', true],
  ['Talstar P was applied, unless ants were present.', true],
])('4043636447 manner as-if differs from a treatment condition: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['We are hoping Talstar P was applied.', true],
  ['I was hoping Talstar P was applied.', true],
  ['Talstar P was applied.', false],
])('4043636451 progressive hope governs completed-treatment evidence: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['The report might indicate that Talstar P was applied.', true],
  ['The report might suggest that Talstar P was applied.', true],
  ['The report indicated that Talstar P was applied.', false],
])('4043636454 speculative report indication remains uncertain: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['It appears Talstar P was applied.', true],
  ['That appears Talstar P was applied.', true],
  ['It seems Talstar P was applied.', true],
  ['We applied Talstar P at the rate that appears on the label.', false],
  ['We applied Talstar P at the rate that appeared on the label.', false],
  ['Talstar P was applied.', false],
])('4043636460 epistemic appearance permits an omitted that: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['Talstar P was scheduled to be applied.', true],
  ['Talstar P was applied as scheduled.', false],
])('4043636466 scheduled treatment differs from completed-as-scheduled evidence: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['Talstar P was applied yesterday, not tomorrow.', false],
  ['Talstar P was applied yesterday, rather than tomorrow.', false],
  ['Talstar P was applied tomorrow.', true],
])('4043636467 contrasted tomorrow does not make past treatment future: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['It was possible that Talstar P was applied.', true],
  ['There was a chance that Talstar P was applied.', true],
  ['It was confirmed that Talstar P was applied.', false],
  ['There was confirmation that Talstar P was applied.', false],
])('4043636473 past possibility remains uncertain: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['We are not sure Talstar P was applied.', true],
  ["We're unsure Talstar P was applied.", true],
  ['It is uncertain that Talstar P was applied.', true],
  ['I am not quite certain Talstar P was applied.', true],
  ['We are sure Talstar P was applied.', false],
  ['I am certain Talstar P was applied.', false],
])('explicit uncertainty differs from definite assurance: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ["We can't confirm that Talstar P was applied.", true],
  ['We can’t confirm that Talstar P was applied.', true],
  ['We cannot confirm that Talstar P was applied.', true],
  ['We can confirm that Talstar P was applied.', false],
])('4043744101 inability to confirm remains uncertain: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['The report suggests that Talstar P was applied.', true],
  ['The report suggested that Talstar P was applied.', true],
  ['We applied Talstar P as the report suggests.', false],
  ['We applied Talstar P as the report suggested.', false],
  ['The report shows that Talstar P was applied.', false],
])('4043744105 report suggestion differs from a positive report: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['We can clearly confirm that Talstar P was applied.', false],
  ['We can conclusively verify that Talstar P was applied.', false],
  ['We can possibly confirm that Talstar P was applied.', true],
  ['We can probably verify that Talstar P was applied.', true],
])('4043744107 conclusive can-confirm adverbs retain definite scope: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['Talstar P was applied with equipment that can be used outdoors.', false],
  ['Talstar P was applied by a technician who can verify the label.', false],
  ['Talstar P is the product that may have been applied.', true],
  ['The technician who can verify the label might have applied Talstar P.', true],
  ['Talstar P can be applied outdoors.', true],
  ['That can be applied outdoors.', true],
  ['The report might show that Talstar P was applied.', true],
])('4043744112 relative modal does not govern completed treatment: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['The technician believes that Talstar P was applied.', true],
  ['The customer thinks Talstar P was applied.', true],
  ['The technician confirmed that Talstar P was applied.', false],
])('4043744115 third-person belief remains tentative: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each(["'", '’'])('negative contractions retain uncertainty with %s apostrophe', (apostrophe) => {
  expect(grammar.reportFindingIsUncertain(`We couldn${apostrophe}t confirm that Talstar P was applied.`)).toBe(true);
  expect(grammar.reportFindingIsUncertain(`We aren${apostrophe}t sure Talstar P was applied.`)).toBe(true);
  expect(grammar.reportFindingIsUncertain(`Talstar P wouldn${apostrophe}t have been applied.`)).toBe(true);
  expect(grammar.reportFindingIsUncertain(`Talstar P won${apostrophe}t be applied.`)).toBe(true);
  expect(grammar.reportFindingIsUncertain('We could not confirm that Talstar P was applied.')).toBe(true);
  expect(grammar.reportFindingIsUncertain('We are sure Talstar P was applied.')).toBe(false);
});

test.each([
  ['We doubt that Talstar P was applied.', true],
  ['It is unclear whether Talstar P was applied.', true],
  ['We do not know whether Talstar P was applied.', true],
  ["We don't know whether Talstar P was applied.", true],
  ['We don’t know whether Talstar P was applied.', true],
  ['Without a doubt, Talstar P was applied.', false],
  ['There is no doubt Talstar P was applied.', false],
  ['We know Talstar P was applied.', false],
])('shared epistemic vocabulary retains report certainty scope: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['4043879184', 'Talstar P was applied yesterday, not next week.', false],
  ['4043879184', 'Talstar P was applied yesterday, rather than next month.', false],
  ['4043879184', 'Talstar P was applied yesterday, not next Friday.', false],
  ['4043879184', 'Talstar P will be applied next week.', true],
  ['4043879191', 'Based on the report we can confirm that Talstar P was applied.', false],
  ['4043879191', 'Hopefully, based on the report we can confirm that Talstar P was applied.', true],
  ['4043879191', 'If the report is accurate, we can confirm that Talstar P was applied.', true],
  ['4043879194', 'Talstar P is about to be applied.', true],
  ['4043879194', 'Talstar P is to be applied later today.', true],
  ['past-plan', 'Talstar P was about to be applied.', true],
  ['past-plan', 'Talstar P was to be applied.', true],
  ['4043879194', 'Talstar P was applied earlier today.', false],
  ['4043879197', 'There is some chance Talstar P was applied.', true],
  ['4043879197', 'There is a good chance that Talstar P was applied.', true],
  ['4043879197', 'There remains a possibility Talstar P was applied.', true],
  ['4043879197', 'There is confirmation Talstar P was applied.', false],
  ['4043879202', 'The technician assumes Talstar P was applied.', true],
  ['4043879202', 'The technician supposes Talstar P was applied.', true],
  ['4043879202', 'The technician expects Talstar P was applied.', true],
  ['4043879202', 'The technician suspects Talstar P was applied.', true],
  ['4043879202', 'The technician confirmed Talstar P was applied.', false],
  ['4043879204', 'Talstar P cannot have been applied.', true],
  ['4043879204', 'Talstar P has been applied.', false],
  ['4043879207', 'It is unconfirmed that Talstar P was applied.', true],
  ['4043879207', 'It remains unverified whether Talstar P was applied.', true],
  ['4043879207', 'It is unknown whether Talstar P was applied.', true],
  ['4043879207', 'It is confirmed that Talstar P was applied.', false],
  ['4043879210', "We can't rule out that Talstar P was applied.", true],
  ['4043879210', 'We cannot exclude that Talstar P was applied.', true],
  ['4043879210', 'We can confirm that Talstar P was applied.', false],
  ['4043879213', 'It would seem that Talstar P was applied.', true],
  ['4043879213', 'It may appear Talstar P was applied.', true],
  ['4043879213', "It'd seem that Talstar P was applied.", true],
  ['4043879213', 'Talstar P was applied.', false],
  ['4043879217', 'Talstar P was applied as we expected.', false],
  ['4043879217', 'Talstar P was applied as we hoped.', false],
  ['4043879217', 'Talstar P was applied as the technician expected.', false],
  ['4043879217', 'Talstar P was applied as the customer expected.', false],
  ['4043879217', 'As we expected Talstar P to have been applied, we requested verification.', true],
  ['4043879217', 'As we hoped that Talstar P had been applied, we requested verification.', true],
  ['4043879217', 'We expected Talstar P was applied.', true],
  ['4043879217', 'We hoped Talstar P was applied.', true],
])('round-four report uncertainty %s: %s', (_finding, text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['4043973800', 'It was unconfirmed that Talstar P was applied.', true],
  ['4043973800', 'It is still unconfirmed that Talstar P was applied.', true],
  ['4043973800', 'It is confirmed that Talstar P was applied.', false],
  ['4043973804', "We couldn't rule out that Talstar P was applied.", true],
  ['4043973804', 'We could not exclude that Talstar P was applied.', true],
  ['4043973804', 'We can confirm that Talstar P was applied.', false],
  ['4043973808', 'It might seem that Talstar P was applied.', true],
  ['4043973808', 'It could appear Talstar P was applied.', true],
  ['4043973808', 'Talstar P was applied.', false],
  ['4043973812', 'Talstar P ought to have been applied.', true],
  ['4043973812', 'Talstar P was applied.', false],
])('round-five report uncertainty %s: %s', (_finding, text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each(["'", '’'])('affirmative contractions retain report scope with %s apostrophe', (apostrophe) => {
  expect(grammar.reportFindingIsUncertain(`We${apostrophe}re hoping Talstar P was applied.`)).toBe(true);
  expect(grammar.reportFindingIsUncertain(`It${apostrophe}s unconfirmed that Talstar P was applied.`)).toBe(true);
  expect(grammar.reportFindingIsUncertain(`We${apostrophe}re not confident that Talstar P was applied.`)).toBe(true);
  expect(grammar.reportFindingIsUncertain(`I${apostrophe}m fairly sure Talstar P was applied.`)).toBe(true);
  expect(grammar.reportFindingIsUncertain(`I${apostrophe}m almost certain Talstar P was applied.`)).toBe(true);
  expect(grammar.reportFindingIsUncertain(`It${apostrophe}s still possible Talstar P was applied.`)).toBe(true);
  expect(grammar.reportFindingIsUncertain(`We${apostrophe}re sure Talstar P was applied.`)).toBe(false);
  expect(grammar.reportFindingIsUncertain(`I${apostrophe}m certain Talstar P was applied.`)).toBe(false);
  expect(grammar.reportFindingIsUncertain(`It${apostrophe}s confirmed that Talstar P was applied.`)).toBe(false);
});

test.each([
  ['4044118309', ['Talstar P is suspected to have been applied.'], 'Talstar P is confirmed to have been applied.'],
  ['4044118313', ['It remains possible that Talstar P was applied.', 'It is still possible that Talstar P was applied.'], 'It is confirmed that Talstar P was applied.'],
  ['4044118319', ['The report appears to indicate that Talstar P was applied.', 'The report seems to show that Talstar P was applied.'], 'The report shows that Talstar P was applied.'],
  ['4044118324', ['It remains to be seen whether Talstar P was applied.', 'We wonder whether Talstar P was applied.'], 'We know Talstar P was applied.'],
  ['4044118330', ['Presumably, Talstar P was applied.', 'Conceivably, Talstar P was applied.', 'In all likelihood, Talstar P was applied.'], 'Talstar P was applied.'],
  ['4044118333', ['As far as we know, Talstar P was applied.', 'As far as I can tell, Talstar P was applied.', 'To the best of my knowledge, Talstar P was applied.'], 'Talstar P was applied.'],
  ['4044118337', ['We are not confident that Talstar P was applied.', 'I am fairly sure Talstar P was applied.', 'I am almost certain Talstar P was applied.'], 'We are confident that Talstar P was applied.'],
])('round-six report uncertainty %s', (_finding, uncertainCases, definite) => {
  uncertainCases.forEach((text) => expect(grammar.reportFindingIsUncertain(text)).toBe(true));
  expect(grammar.reportFindingIsUncertain(definite)).toBe(false);
});

test.each([
  ['4044238375', ['It looks as though Talstar P was applied.', 'It sounds as though Talstar P was applied.'], 'Talstar P was applied as though ants were present.'],
  ['4044238382', ['There is no confirmation that Talstar P was applied.', 'There is no evidence that Talstar P was applied.', "There's no evidence that Talstar P was applied.", 'There’s no confirmation that Talstar P was applied.'], 'There is confirmation that Talstar P was applied.'],
  ['4044238391', ['Talstar P was not necessarily applied.', "Talstar P hasn't necessarily been applied."], 'Talstar P was necessarily applied.'],
])('round-seven report uncertainty %s', (_finding, uncertainCases, definite) => {
  uncertainCases.forEach((text) => expect(grammar.reportFindingIsUncertain(text)).toBe(true));
  expect(grammar.reportFindingIsUncertain(definite)).toBe(false);
});

test.each([
  ['Well, there is no evidence that Talstar P was applied.', true],
  ['Well, there is confirmation that Talstar P was applied.', false],
  ['Talstar P was applied where there is no evidence that ants were present.', false],
  ['Talstar P was applied, as far as we know.', true],
  ['Talstar P was applied, to the best of my knowledge.', true],
  ['Talstar P was applied at 0.06 percent, as far as we know.', true],
  ['We used 0.5 ounces of Talstar P, to the best of my knowledge.', true],
  ['Talstar P was applied at 0.06 percent. As far as we know, ants were present.', false],
  ['Talstar P was applied along the fence as far as we know.', false],
])('pre-push bounded governor scope: %s', (text, uncertain) => {
  expect(grammar.reportFindingIsUncertain(text)).toBe(uncertain);
});

test.each([
  ['4044395299', ['Talstar P is alleged to have been applied.', 'Talstar P was presumed to have been applied.'], 'Talstar P is confirmed to have been applied.'],
  ['4044395303', ['There is no evidence Talstar P was applied.', "There's no confirmation Talstar P was applied.", 'There is no evidence we applied Talstar P.', "There's no confirmation the technician applied Talstar P."], 'There is no evidence about ants Talstar P was applied.'],
])('round-eight report uncertainty %s', (_finding, uncertainCases, definite) => {
  uncertainCases.forEach((text) => expect(grammar.reportFindingIsUncertain(text)).toBe(true));
  expect(grammar.reportFindingIsUncertain(definite)).toBe(false);
});
