/**
 * Tech-reviewed AI report copy → customer report summary.
 *
 * The completion form's "Generate AI report" writes a fixed two-section
 * customer-facing draft (WHAT WE DID / WHAT WE FOUND) into the notes box for
 * the tech to review. These tests pin the trust boundary:
 *  - only notes carrying that exact shape parse as customer copy — free-form
 *    notes, prefixed/appended internal text, extra paragraphs, or
 *    half-shapes never do;
 *  - banned customer wording (hand edits) drops the copy, including the
 *    summary pipeline's forbidden-language list;
 *  - the typed snapshot uses the copy in the generic non-gauge default
 *    composition, every gauge lane, and the knockdown/one-time-mosquito
 *    story branches (which keep their mandated disclosure sentences) —
 *    zero states and the remaining owner-specified story branches (rodent
 *    exclusion/inspection, flea, tree & shrub) keep approved wording;
 *  - template-only output is byte-identical to before (no bodySource key).
 */

const { spawnSync } = require('node:child_process');

const {
  technicianReportCustomerCopy,
  summaryCopySignature,
  MAX_REPORT_CHARS,
  MAX_CUSTOMER_COPY_SCREEN_CHARS,
  containsReportAccessCode,
  customerCopyViolations,
} = require('../services/service-report/technician-report-copy');
const {
  buildTodaysResult,
  buildTypedReportSnapshot,
  NEXT_STEP_CHIPS,
} = require('../services/service-report/activity-indicators');

const AI_REPORT = [
  'WHAT WE DID',
  '',
  'A full exterior perimeter application targeted the foundation line, door thresholds, and garage entry where ant trailing was documented. A non-repellent residual was applied to the plumbing penetrations under the kitchen sink.',
  '',
  'WHAT WE FOUND',
  '',
  'Ant activity was concentrated along the front walkway expansion joint, with light trailing near the garage. Activity typically tapers over the next one to two weeks as the product transfers through the colony.',
].join('\n');

const AI_BODY = 'A full exterior perimeter application targeted the foundation line, door thresholds, and garage entry where ant trailing was documented. A non-repellent residual was applied to the plumbing penetrations under the kitchen sink. Ant activity was concentrated along the front walkway expansion joint, with light trailing near the garage. Activity typically tapers over the next one to two weeks as the product transfers through the colony.';

const CREDENTIAL_CASES = {
  validatorOnly: [
    'Opened side gate with 2468',
    'Unlocked rear door using 2468',
    'Accessed garage with 2468',
    'rear gate 2468',
    'rear gate #2468',
    'rear gate *2468',
    'rear gate A2468',
    'Opened side gate with A2468',
    'rear gate 2468A',
    'rear gate: AB2468',
    'Rear gate: 2-4-6-8',
    'Rear gate: 24-68',
    'Rear gate: 24–68',
    'Opened side gate with 24 68',
    'Rear gate #24-68',
    'Used gate code 2468ft for entry',
    'Gate code is 2468ml',
    'Used gate code 2468oz for entry',
    'Gate code is 1 2 3 4ft',
    'Gate code is 2-4-6-8ml',
    'Gate PIN AB24 68oz',
    'rear gate AB24-68',
    'rear gate AB-2468',
    'rear gate #AB-2468',
    'Gate2468',
    'RearGATE2468',
    'Rear-GATE2468',
    'rear gate AB 2468',
    'rear gate 2468-AB',
    'rear gate A2B4-68',
    'rear gate A2B4-6C8D',
    'rear gate A24-68',
    'rear gate 24-68A',
    'Opened rear gate with #AB24–68C*',
    'side gate: 2468',
    'Open side gate with 2468 in the morning',
    'Opened side gate with 2468 in the morning',
    'rear gate 2468 in the morning',
    'Gate code is 24-0-11 fertilizer',
    'Opened rear gate with 24-0-11. Applied fertilizer to turf.',
    '24-0-11 is the gate code. Applied fertilizer.',
    '24-0-11 fertilizer is the gate code',
    '24-0-11 fertilizer opens the rear gate',
    'The gate opens with 24-0-11 fertilizer',
    'Rear gate is 24-0-11 fertilizer',
    'Opened rear gate with #24-0-11 fertilizer',
    'Opened rear gate with 2-4-6-8 and applied fertilizer',
    'Use 24-68-xy to open the side gate',
    'Unlocked rear door using 2468ft',
    'Enter 2468ml at the side keypad',
    'The gate opens with 2468oz',
    'Rear gate AB-24-0-11 fertilizer',
    'Rear gate is AB-24-0-11 fertilizer',
    'Rear gate #AB-24-0-11 fertilizer',
    'Rear gate AB-CD-24-0-11 fertilizer',
    'Rear gate A2B-XY-24-0-11-ZZ fertilizer',
    'Rear gate ab 24-0-11 fertilizer',
    'Rear gate 24-0-11-AB fertilizer',
    'Applied Lesco and opened rear gate with 24-0-11',
    'Applied Lesco, then opened rear gate with 24-0-11',
    'Broadcast granular before unlocking rear gate with 24-0-11',
  ],
  shared: [
    'Use ABCDEFGHIJKL2468MNOPQRSTUVWX to open the gate',
    `Gate code ${'1234567890'.repeat(6)}ft`,
    'Gate code 1234ft 5678ft 9012ft',
    'Gate code 1234ft 5678ft 9ft',
    'Gate PIN AB1234ml 5678ml 9012ml',
    'Gate passcode is 123456789ft',
    '1234ft 5678ft 9012ft is the gate code',
    '1234ml 5678ml 9012ml remains the keypad',
    'Use 2468 AT THE SIDE GATE',
    'USE 24-68 AT THE GATE',
    'USE 2468 TO OPEN THE GATE',
    'USE AB-24-68-XY AT THE SIDE GATE',
    'USE AB-24-68-XY TO OPEN THE GATE',
    'Use 24-68-ab at the side gate',
    'Use 24-68-in at the side gate',
    'Use 24-68-to at the side gate',
    'Opened side gate with 2468ml',
    'Use 2468ft to open the gate',
    'Use 2468 ft to open the gate',
    'Use 2468 square feet to unlock the rear gate',
    'Enter 2468 ml at the side gate',
    'Use 24-68 fl. oz to open the side gate',
    'Applied override 24-0-11 to open the rear gate',
    'Applied override 24-0-11 opens the rear gate',
    'Applied override 24-0-11 unlocks the rear gate',
    'Applied override 24-0-11 opened the rear gate',
    'Broadcast granular 24-0-11 unlocked the side gate',
    'Broadcast granular 24-0-11 to unlock the side gate',
    'Opened the rear gate this morning with 2468 ml',
    'Unlocked the side door earlier today using 8842 oz',
    'Using 100 ml to open the rear gate',
    'Using 100 ml at the rear gate to unlock it',
    'Opened rear gate on 2468',
    'Opened rear gate on 9/27/2026 with code 2468',
    'Use unit2468 at the rear gate',
    'USE 24-0-11-BEFORE AT THE REAR GATE',
    'Opened rear gate using unit2468',
    'The gate opens with unit2468',
    'Use unit2468 to open the rear gate',
    'Opened rear gate on 24-68',
    'Opened rear gate on AB2468',
    'Opened rear gate on 2 4 6 8',
    'Opened rear gate on 9/27/2026, checked the hinges, and opened the side door on 2468',
    'Opened rear gate on 24-68-24',
    'Opened rear gate on 24-68-99',
    'Opened rear gate on 02/30/2026',
    'Opened rear gate by entering 2468 ml',
    'Unlocked side door after typing 8842 oz',
    'Unlocked side door after typing AB8842 oz',
    'Unlocked side door after typing 88-42 oz',
    'Opened rear gate after entering 24-68 ml',
    'Opened rear gate after entering 09/27/2026',
    'Opened rear gate with 09/27/2026',
    'Opened rear gate using 2026-09-27',
    'Opened rear gate with 09/27/26',
    'Opened rear gate and found 100 ants, then entered 8842 at the keypad',
    'Opened rear gate and found 100 German cockroaches, then entered 8842 at the keypad',
    'The rear gate is 2468 ml',
    'Opened rear gate and found 100 dead ants, then entered 8842 at the keypad',
    'Opened the gate and removed 100 ants, then entered 8842 at the keypad',
    'Opened the gate and installed 100 traps, then used code 2468 at the keypad',
    'Use 2468 ft as the gate code',
    'Enter AB24-68 ml as the side door PIN',
    'Applied 24-0-11 to open turf near the rear gate, then used 24-0-11 to unlock the side door',
    '2468 ft will open the rear gate',
    '2468 ml can unlock the side door',
    '2468 oz should still access the garage entry',
    'Opened gate and inspected 100 bait stations, then entered 8842 at the keypad',
    'Opened rear gate and checked 120 traps, then used code 2468 at the keypad',
    'Opened gate and serviced 100 bait stations, then unlocked the side door with 8842',
    'Inspected the keypad and entered 2468 ml for access',
    'Inspected the keypad and treated the surrounding 100 square feet, then entered 8842 at the keypad',
    'Serviced the lockbox and applied 100 ml, then typed 8842 at the keypad',
    'Enter 2468 ml before unlocking the door',
    'Type 8842 oz after opening the side gate',
    'Input 2468 ft when we access the garage',
    'Press 8842 ml, then unlock the rear door',
    'Use 2468 ml, and then open the gate',
    'Enter 2468 ft and unlock the gate',
    'Enter 2468 ft and you can now unlock the gate',
    'Use 2468 ft then we can still open the gate',
    'Type AB24-68 ml, and then you will now open the side door',
    'Use 2468 ft and unlock the gate',
    'Type AB24-68 ml and open the side door',
    'Use 24-0-11 and open the rear gate',
    'Enter 2468 ft, and unlock the gate',
    'Enter 2468 ft and you can unlock the gate',
    'Use 2468 ft then we can open the gate',
    'Enter 2468 ft, and then you can unlock the gate',
    'Use 2468 ft and we unlock the gate',
    'Enter 100 ml of lubricant and open the gate',
    'Use AB100 ml of lubricant and open the gate',
    'Use AB24-0-11 fertilizer and open the gate',
    'Use 100 ml of lubricant as the gate code and open the gate',
    'Use 100 ml of lubricant and open the gate, then enter 2468 at the keypad',
    'Use 24-0-11 fertilizer and open the gate, then enter 2468 at the keypad',
    'Using 8842 oz before unlocking the side door',
    'Provide 2468 ft when accessing the garage',
    'Give 8842 grams after opening the rear gate',
    'Say 2468 ml, then enter the garage',
    'Use 2468ft at the keypad to get inside',
    'Using 8842 ml on the lockbox to gain entry',
    'Used 2468 oz at the keypad',
    'Use 2468ft at the keypad to get inside, then treated the hinge',
    'Use 2468 ft at the keypad to treat the mounting plate, then gain entry',
    'Opened the rear gate this morning with 24-68 ml',
    'Opened the rear gate this morning with 09/27/2026',
    'The rear gate was opened by using 2468 ml',
    'Opened rear gate: 2468 ft',
    'Opened rear gate: 24-68 feet',
    'Opened rear gate=2468 ft',
    'Opened rear gate: 2468 square feet',
    'Opened rear gate on 2468 before treating ants',
    'Opened rear gate on 2468 and saw ants',
    'Opened rear gate on 2468 then found ants',
    'Opened rear gate on 2468 to inspect ants',
    'Opened rear gate on 2468 to treat ants',
    'Opened rear gate on 2468 because ants were present',
    'Opened rear gate this morning : 2468 ft',
    'Opened rear gate this morning =2468 ft',
    'Use 2468 ft for gate code',
    'Use 2468 feet for the PIN',
    '24-68oz = the keypad PIN',
    'Use 2468 ft for the keypad',
    'Enter 2468 ml for treatment near keypad',
    'Applied 100 ml for treating the keypad to gain access',
    'Applied 100 ml for the keypad code',
    'Enter 2468 ml for spraying around keypad',
    'Applied 100 ml for spraying around keypad to gain access',
    '2468 ft is still the gate code',
    '2468 ml will remain the keypad PIN',
    '2468 oz has now become the lockbox code',
    '2468 grams continues to be the rear gate PIN',
    '2468 ft is going to remain the gate code',
    'Use 24-68 ml at the keypad',
    'Use AB24-68 ml at the keypad',
    'Use 2468 ml so you can open the gate',
    'Use 2468 ml if you need to open the gate',
    'Enter 2468 ml whenever you open the gate',
    'Use 2468 ml if you ever need to open the gate',
    'Use 2468 ml so you are able to open the gate',
    'Use 2468 ml so you can easily open the gate',
    'Use 24-68 ml so you can open the gate',
    'Use AB24-68 ml if you need to open the gate',
    'Enter 24-68-AB ml whenever you open the gate',
    'Use 2468 ml at the pedestrian keypad',
    'Use 2468 ml at the pool keypad',
    'Use 2468 ml at the exterior lockbox',
    'Use 2468 ml at the main entry keypad',
    'Use 2468 feet to manually open the gate',
    '2468 feet will let you open the gate',
    'Use AB24-68 feet to manually unlock the side gate',
    '24-68 feet can directly open the garage door',
    '2468 feet lets you access the garage',
    '2468 feet will allow the technician to unlock the side door',
    '2468 feet will let you easily open the gate',
    'Use 2468 feet to allow you to open the gate',
    '2468 feet will easily let you open the gate',
    'Use AB24-68 feet to allow you to open the gate',
    'Opening the gate requires 2468 ml',
    'Opening the gate takes 2468 ml',
    'Unlocking the side door needs AB24-68 ml',
    'Accessing the garage requires typing 24-68 ml',
    'Entering the rear gate took 2468 feet',
    'Opening the gate requires 24-0-11 fertilizer',
    'Sprayed 24-0-11 to unlock the rear gate',
    'Used 24-0-11 to open the rear gate',
    'Mixed 24-0-11 then used it as the gate code',
    'Mixed 24-0-11 then used it to open the gate',
    'Used24-0-11 then entered it to unlock the rear gate',
    'Mixed 24-0-11 and then used it as the gate code',
    'Mixed 24-0-11, then used it as the gate code',
    'Mixed 24-0-11 before using it as the gate code',
    'Mixed AB24-68 ml, then used it to open the side gate',
    'Opening the gate requires mixing 100 ml of treatment, then entering 2468',
    'Opening the gate requires applying 0.5 ml of lubricant, then entering 2468',
    'Opening the gate requires mixing 10.5 ml of treatment, then entering 2468',
    'Opening the gate requires typing 2468 ml of lubricant',
    'Opening the gate requires entering AB24-68 ml of product',
    'Opening the gate required inspecting 100 feet of fence on 2026-09-28, then entering 2468',
  ],
};

const LEGITIMATE_CASES = {
  validatorOnly: [
    'Inspected 120 linear feet around the garage',
    'Inspected the rear gate 120 feet from the lanai',
    'Opened the gate onto 400 square feet of treated turf',
    'Opened the gate onto 400.5 square feet of treated turf',
    'Inspected the rear gate 120.5 feet from the lanai',
    'Inspected gatehouse #2468 and treated 120 linear feet',
    'Gatehouse #2468 inspected and treated',
    'Gatehouse #2468 was inspected; treated 120 linear feet',
    'Doorway #2468 was inspected; treated 120 linear feet',
    'Opened the gate onto 400 sqft of treated turf',
    'Opened rear gate, applied 100 ml around hinges',
    'Opened rear gate, applied 100ml around hinges',
    'Inspected the rear gate 120–150 feet from the lanai',
    'Opened rear gate, applied 24-68ml around hinges',
    'Applied 24-0-11 near the rear gate',
    'APPLIED 24-0-11 NEAR THE REAR GATE',
    'OPENED THE GATE ONTO 400 SQUARE FEET OF TREATED TURF',
    'OPENED REAR GATE, APPLIED 100 ML AROUND HINGES',
    'Near the rear gate, applied 24-0-11',
    'Applied fertilizer 24-0-11 near the rear gate',
    'Applied 24-0-11 fertilizer near the rear gate',
    '24-0-11 fertilizer was applied near the rear gate',
    'Opened rear gate, applied 24-0-11 fertilizer',
    'Applied 24-0-11 fertilizer after opening the rear gate',
    'Spread slow-release granular 24-0-11 near the rear gate',
  ],
  sharedFertilizer: [
    'Applied Lesco 24-0-11 near the rear gate',
    'Applied Lesco 24-0-11, then opened the rear gate',
    'Applied Lesco 24-0-11 and opened the rear gate',
    'APPLIED LESCO 24-0-11 AND OPENED THE REAR GATE',
    'APPLIED LESCO 24-0-11 THEN UNLOCKED THE REAR GATE',
    'Broadcast granular 24-0-11 near the rear gate',
    'APPLIED LESCO 24-0-11 ADJACENT TO THE REAR GATE',
    'APPLIED LESCO 24-0-11 CLOSE TO THE REAR GATE',
    'APPLIED LESCO 24-0-11 NEXT TO THE REAR GATE',
    'Sprayed 24-0-11 near the rear gate',
    'Used 24-0-11 near the rear gate',
    'Mixed 24-0-11 near the rear gate',
    'SPRAYED LESCO 24-0-11 NEXT TO THE REAR GATE',
    '24-0-11 was mixed near the rear gate',
    'Mixed24-0-11 then used it to treat soil near the gate',
  ],
  sharedWork: [
    'Inspected the keypad and treated 1234ft 5678ft 9012ft of the surrounding fence',
    'Serviced the lockbox and applied 123456789 ml around the mounting plate',
    'Using 100 ml at the rear gate, we treated the hinge area',
    'Using 100ml at the rear gate, we treated the hinge area',
    'Opened rear gate on 9/27/2026',
    'Opened rear gate on 2026-09-27',
    'Opened gate and treated unit 2468',
    'Opened gate and treated unit2468',
    'APPLIED LESCO 24-0-11 BEFORE OPENING THE REAR GATE',
    'APPLIED LESCO 24-0-11 AFTER OPENING THE REAR GATE',
    'APPLIED LESCO 24-0-11 WHILE OPENING THE REAR GATE',
    'Using 100 ml at the rear gate before opening it, we treated the hinge area',
    'Opened rear gate and sprayed with 100 ml',
    'Opened rear gate and dusted with 100 grams',
    'Opened rear gate and cleaned with 100 ml',
    'Opened rear gate, applied 24-0-7 fertilizer',
    'Opened rear gate, applied 0-0-7 fertilizer',
    'Opened rear gate on 2026 - 09 - 27',
    'Opened rear gate on 09 - 27 - 2026',
    'Opened rear gate on 02/29/2024',
    'Opened rear gate and found 100 ants',
    'Opened rear gate and found 100 German cockroaches',
    'Opened rear gate and found 100 fire ants',
    'Opened rear gate and observed 200 ants',
    'Opened rear gate and treated station 2468',
    'Opened rear gate and serviced station 2468',
    'Unlocked side door on 09/27/2026',
    'Unlocked side door after servicing station 8842',
    'Opened rear gate by using 2 hands',
    'Opened rear gate after using 2 oz around the hinge',
    'Opened rear gate and found 100 dead ants',
    'Opened the gate and removed 100 ants',
    'Opened the gate and installed 100 traps',
    'The rear gate is 100 feet from the lanai',
    'Use 2468 ft as the treated perimeter length',
    'Applied 24-0-11 to open turf near the rear gate',
    '2468 ft will cover open turf near the rear gate',
    'Use 100 feet to manually inspect the gate hinges',
    '2468 feet will let you treat open turf near the rear gate',
    '2468 feet will allow you to cover open turf near the rear gate',
    'Applied 2468 feet to manually open turf near the rear gate',
    '2468 feet will enable you to inspect the garage perimeter',
    'Use 100 feet to allow you to treat soil before opening the gate',
    '100 feet will easily let you treat soil before opening the gate',
    'Opening the gate requires spraying 100 ml around its hinges',
    'Opening the gate takes inspecting 100 feet of fence',
    'Opening the gate requires removing 100 ants from the latch',
    'Opening the gate requires mixing 100 ml of treatment for its hinges',
    'Opening the gate requires mixing 100ml of treatment for its hinges',
    'Opening the gate requires installing 100 feet of seal along its frame',
    'Opening the gate requires installing 100feet of seal along its frame',
    'Opening the gate requires 100 ml of lubricant on the hinges',
    'Opening the gate requires 100ml of lubricant on the hinges',
    'Opening the gate requires removing 100 ants and installing 100 traps',
    'Opening the gate requires spraying 100.5 ml around its hinges',
    'Opening the gate requires applying 0.5 ml of lubricant',
    'Opening the gate required inspecting 100 feet of fence on 2026-09-28',
    '2468 ml can treat the hinge beside the side door',
    'Opened gate and inspected 100 bait stations',
    'Opened rear gate and checked 120 traps',
    'Opened gate and serviced 100 bait stations',
    'Opened gate and replaced 120 traps',
    'Opened gate and treated 100 stations',
    'Opened gate and applied 100 product units',
    'Opened gate and found 100 empty traps',
    'Opened rear gate and saw 100 ants',
    'Opened rear gate and saw 100 German cockroaches',
    'Opened rear gate and counted 100 fire ants',
    'Opened rear gate and spread fertilizer using 100 ml',
    'Opened rear gate and spread bait using 100 grams',
    'Opened rear gate and broadcast granules using 100 grams',
    'Opened rear gate and distributed bait using 100 grams',
    'Opened rear gate on 09/27/2026 and saw 100 ants',
    'Inspected the keypad and treated the surrounding 100 square feet',
    'Inspected the keypad and treated 100 square feet',
    'Serviced the lockbox and applied 100 ml around the mounting plate',
    'Enter 100 ml in the application log before treating around the rear door',
    'Input 100 ml in the service record, then treated the hinge near the side gate',
    'Type 100 ml into the service note after applying product near the garage door',
    'Use 100 ml, and then treat the hinge near the rear gate',
    'Provide 100 ml before treating around the side door',
    'Say 100 ml, then record the application near the garage door',
    'Use 100 ml at the keypad to treat the surrounding turf',
    'Using 100 ml near the keypad, treated the mounting plate',
    'Used 100 ml by the lockbox to treat the hinge',
    'Use 2468 ft for the treated perimeter length',
    'Use 100 ml for the application rate near the gate',
    'Applied 100 ml for treating the keypad',
    'Applied 100 ml for treatment near keypad',
    'Applied 100 ml for treating the lockbox',
    'Applied 100 ml for spraying around keypad',
    'Applied 100 ml for cleaning the keypad',
    'Applied 100 grams for dusting around lockbox',
    '2468 ft is still the treated perimeter length',
    '100 ml will remain the application amount near keypad',
    'Use 100 ml to treat soil, then open the gate',
    'Use 100 ml to treat soil and open the gate',
    'Use 100 ml of lubricant then we can still open the gate',
    'Use 100 ml of lubricant and open the gate',
    'Use 24-0-11 fertilizer and open the gate',
    'Use 24-68 ml to treat soil, then open the gate',
    'Use 100 ml if treating soil before opening the gate',
    'Use 100 ml at the pedestrian keypad to treat the surrounding turf',
    'Use 100 ml if you ever need to treat soil before opening the gate',
    'Use 100 ml so you are able to treat soil before opening the gate',
    'Use 100 ml so you can easily treat soil before opening the gate',
  ],
};

describe('custom action credential screening', () => {
  test.each([
    ...CREDENTIAL_CASES.validatorOnly,
    ...CREDENTIAL_CASES.shared,
  ])('rejects recorded access credentials: %s', (action) => {
    expect(customerCopyViolations(action)).toContain('access_code');
  });

  test.each([
    ...LEGITIMATE_CASES.validatorOnly,
    ...LEGITIMATE_CASES.sharedFertilizer,
    ...LEGITIMATE_CASES.sharedWork,
  ])('preserves dimensional work details: %s', (action) => {
    expect(customerCopyViolations(action)).toEqual([]);
  });

  test('bounds adversarial mixed credential groups before shared copy screening', () => {
    const adversarial = `Use ${'AB-'.repeat(2000)}2468-${'XY-'.repeat(2000)}ordinary at the gate`;
    const started = performance.now();
    expect(customerCopyViolations(adversarial)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test.each([
    ['a long compact affixed credential', 'affixed', true],
    ['a long compact numeric credential', 'digits', true],
    ['long compact ordinary copy', 'ordinary', false],
  ])('bounds %s in an isolated scanner process', (_label, kind, expected) => {
    const probe = [
      "const { containsReportAccessCode } = require(process.argv[1]);",
      "const kind = process.argv[2];",
      "const samples = {",
      "  affixed: `Use ${'A'.repeat(7900)}2468${'B'.repeat(7900)} to open the gate`,",
      "  digits: `Use ${'1'.repeat(15970)} to open the gate`,",
      "  ordinary: `Applied ${'A'.repeat(15000)} around the exterior`,",
      "};",
      "process.stdout.write(String(containsReportAccessCode(samples[kind])));",
    ].join('\n');
    const result = spawnSync(
      process.execPath,
      ['-e', probe, require.resolve('../services/service-report/technician-report-copy'), kind],
      { encoding: 'utf8', env: process.env, timeout: 1500 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(String(expected));
  });

  test('fails closed before regex screening on implausibly large direct-caller values', () => {
    const overLimit = 'ordinary service detail '.repeat(Math.ceil(MAX_CUSTOMER_COPY_SCREEN_CHARS / 24) + 1);
    expect(overLimit.length).toBeGreaterThan(MAX_CUSTOMER_COPY_SCREEN_CHARS);
    expect(customerCopyViolations(overLimit)).toEqual(['too_long']);
    expect(containsReportAccessCode(overLimit)).toBe(true);
  });
});

describe('technicianReportCustomerCopy — shape parsing', () => {
  test.each(CREDENTIAL_CASES.shared)('does not publish disguised access instructions: %s', (instruction) => {
    const parsed = technicianReportCustomerCopy(`WHAT WE DID\n${instruction}.\nWHAT WE FOUND\nLight activity near the lanai.`);
    expect(parsed.body).toBeNull();
    expect(parsed.violations).toContain('access_code');
  });

  test('parses the generate-report two-section shape into a single customer body', () => {
    const parsed = technicianReportCustomerCopy(AI_REPORT);
    expect(parsed).not.toBeNull();
    expect(parsed.whatWeDid).toMatch(/^A full exterior perimeter application/);
    expect(parsed.whatWeFound).toMatch(/^Ant activity was concentrated/);
    expect(parsed.body).toBe(AI_BODY);
    expect(parsed.violations).toEqual([]);
  });

  test.each(LEGITIMATE_CASES.sharedFertilizer)('publishes a qualified fertilizer analysis in reviewed report copy: %s', (action) => {
    const parsed = technicianReportCustomerCopy(`WHAT WE DID\n${action}.\nWHAT WE FOUND\nLight activity near the lanai.`);
    expect(parsed.body).toContain(action);
    expect(parsed.violations).toEqual([]);
  });

  test.each(LEGITIMATE_CASES.sharedWork)('publishes bounded material, date, unit-id, and fertilizer details: %s', (action) => {
    const parsed = technicianReportCustomerCopy(`WHAT WE DID\n${action}.\nWHAT WE FOUND\nLight activity near the lanai.`);
    expect(parsed.body).toContain(action);
    expect(parsed.violations).toEqual([]);
  });

  test('tolerates trailing colons on the headers', () => {
    const parsed = technicianReportCustomerCopy(
      'WHAT WE DID:\nTreated the exterior perimeter.\nWHAT WE FOUND:\nLight activity near the lanai.'
    );
    expect(parsed?.body).toBe('Treated the exterior perimeter. Light activity near the lanai.');
  });

  test('free-form notes (no headers) parse to null', () => {
    expect(technicianReportCustomerCopy('Treated perimeter, wiped webs, customer happy.')).toBeNull();
  });

  test('one header alone is not the report shape', () => {
    expect(technicianReportCustomerCopy('WHAT WE DID\nTreated the perimeter.')).toBeNull();
  });

  test('out-of-order headers parse to null', () => {
    expect(technicianReportCustomerCopy(
      'WHAT WE FOUND\nSome activity.\nWHAT WE DID\nTreated it.'
    )).toBeNull();
  });

  test('internal text ABOVE the report keeps the whole blob off the customer surface', () => {
    expect(technicianReportCustomerCopy(
      `gate code 4411, dog in yard\n${AI_REPORT}`
    )).toBeNull();
  });

  test('an internal note appended AFTER the report keeps the whole blob off the customer surface', () => {
    expect(technicianReportCustomerCopy(
      `${AI_REPORT}\n\ngate code 4411 — bill the property manager, office to follow up`
    )).toBeNull();
  });

  test('an appended note WITHOUT a blank line also rejects — it must never join the paragraph (Codex P1)', () => {
    expect(technicianReportCustomerCopy(
      `${AI_REPORT}\ngate code 4411`
    )).toBeNull();
  });

  test('an unquoted hyphenated word credential inside the body rejects (codex r70)', () => {
    const parsed = technicianReportCustomerCopy(
      'WHAT WE DID\n\nServiced all stations; the gate code is blue-waves.\n\nWHAT WE FOUND\n\nLight activity near the lanai.'
    );
    expect(parsed.body).toBeNull();
    expect(parsed.violations).toContain('access_code');
  });

  test('a second paragraph inside a section is unreviewed free text — parses to null', () => {
    expect(technicianReportCustomerCopy(
      'WHAT WE DID\n\nTreated the perimeter.\n\nAlso replaced the bait stations.\n\nWHAT WE FOUND\n\nLight activity near the lanai.'
    )).toBeNull();
  });

  test('any newline inside a section rejects — sections are exactly one prose line', () => {
    expect(technicianReportCustomerCopy(
      'WHAT WE DID\n\nTreated the exterior perimeter\nand the garage entry.\n\nWHAT WE FOUND\n\nLight activity near the lanai.'
    )).toBeNull();
  });

  test('an empty section parses to null', () => {
    expect(technicianReportCustomerCopy('WHAT WE DID\n\nWHAT WE FOUND\nActivity noted.')).toBeNull();
    expect(technicianReportCustomerCopy('WHAT WE DID\nTreated.\nWHAT WE FOUND\n\n')).toBeNull();
  });

  test('over-length text is not treated as the drafted report', () => {
    const padded = AI_REPORT.replace(
      'Activity typically tapers',
      `${'Detail sentence repeated. '.repeat(80)}Activity typically tapers`
    );
    expect(padded.length).toBeGreaterThan(MAX_REPORT_CHARS);
    expect(technicianReportCustomerCopy(padded)).toBeNull();
  });

  test('empty / null notes parse to null', () => {
    expect(technicianReportCustomerCopy('')).toBeNull();
    expect(technicianReportCustomerCopy(null)).toBeNull();
    expect(technicianReportCustomerCopy(undefined)).toBeNull();
  });

  test('banned customer wording nulls the body and reports the violations', () => {
    const parsed = technicianReportCustomerCopy(
      'WHAT WE DID\nWe eliminated the ant colony.\nWHAT WE FOUND\nYour home is now guaranteed pest-free.'
    );
    expect(parsed).not.toBeNull();
    expect(parsed.body).toBeNull();
    expect(parsed.violations.length).toBeGreaterThan(0);
  });

  test('the summary pipeline forbidden-language list applies too (bare "infestation")', () => {
    const parsed = technicianReportCustomerCopy(
      'WHAT WE DID\nTreated the kitchen for the active roach infestation.\nWHAT WE FOUND\nActivity should taper over the next week.'
    );
    expect(parsed).not.toBeNull();
    expect(parsed.body).toBeNull();
    expect(parsed.violations.length).toBeGreaterThan(0);
  });

  test('the narrative EXTRA_FORBIDDEN vocabulary applies ("safe", "solved", plural "infestations")', () => {
    const safeParsed = technicianReportCustomerCopy(
      'WHAT WE DID\nTreated the baseboards.\nWHAT WE FOUND\nThe treated areas are safe for pets right away.'
    );
    expect(safeParsed.body).toBeNull();
    expect(safeParsed.violations).toContain('safe');

    const solvedParsed = technicianReportCustomerCopy(
      'WHAT WE DID\nTreated the baseboards.\nWHAT WE FOUND\nThe ant issue is solved.'
    );
    expect(solvedParsed.body).toBeNull();
    expect(solvedParsed.violations).toContain('solved');

    const pluralParsed = technicianReportCustomerCopy(
      'WHAT WE DID\nTreated the baseboards.\nWHAT WE FOUND\nWe stopped two infestations this visit.'
    );
    expect(pluralParsed.body).toBeNull();
    expect(pluralParsed.violations).toContain('infestations');
  });

  test('"safety" wording stays legal (the ban is \\bsafe\\b, not safety)', () => {
    const parsed = technicianReportCustomerCopy(
      'WHAT WE DID\nTreated the baseboards.\nWHAT WE FOUND\nAs a safety step, keep pets off treated areas until dry.'
    );
    expect(parsed?.body).toBeTruthy();
    expect(parsed.violations).toEqual([]);
  });
});

describe('summaryCopySignature — PDF cache-key component', () => {
  test('empty for recap-driven records so existing cached PDF keys stay valid', () => {
    expect(summaryCopySignature({ technician_notes: 'wiped webs, treated perimeter' })).toBe('');
    expect(summaryCopySignature({})).toBe('');
  });

  test('content-hashed suffix when the technician report drives a non-typed summary', () => {
    const sig = summaryCopySignature({ technician_notes: AI_REPORT });
    expect(sig).toMatch(/^-tr[0-9a-f]{8}$/);
    // Deterministic for the same record, different for different copy.
    expect(summaryCopySignature({ technician_notes: AI_REPORT })).toBe(sig);
    const other = summaryCopySignature({
      technician_notes: 'WHAT WE DID\nTreated the lanai.\nWHAT WE FOUND\nLight ant trailing.',
    });
    expect(other).toMatch(/^-tr[0-9a-f]{8}$/);
    expect(other).not.toBe(sig);
  });

  test('typed records suffix only when the frozen snapshot body came from the technician report', () => {
    const withTechBody = {
      technician_notes: AI_REPORT,
      service_data: JSON.stringify({
        typedReportSnapshot: { type: 'one_time_pest_treatment', todaysResult: { bodySource: 'technician_report' } },
      }),
    };
    expect(summaryCopySignature(withTechBody)).toMatch(/^-tr[0-9a-f]{8}$/);

    const templateBody = {
      technician_notes: AI_REPORT,
      service_data: JSON.stringify({
        typedReportSnapshot: { type: 'one_time_pest_treatment', todaysResult: {} },
      }),
    };
    expect(summaryCopySignature(templateBody)).toBe('');
  });
});

describe('typed snapshot — technician report body in the generic tail compositions', () => {
  const chips = ['Monitor activity'];
  const chipSentence = NEXT_STEP_CHIPS['Monitor activity'];

  test('one-time pest default branch: body is the reviewed report + next step, headline stays deterministic', () => {
    const snapshot = buildTypedReportSnapshot({
      projectType: 'one_time_pest_treatment',
      values: { activity_level: 'Moderate' },
      nextStepChips: chips,
      serviceLabel: 'Pest Control Re-Service',
      technicianReportBody: AI_BODY,
    });
    // No trailing period — headlines aren't sentences (owner 2026-07-21).
    expect(snapshot.todaysResult.headline).toBe('Pest Control Re-Service completed today');
    expect(snapshot.todaysResult.body).toBe(`${AI_BODY} ${chipSentence}`);
    expect(snapshot.todaysResult.bodySource).toBe('technician_report');
    // v5: every gauge lane plus the knockdown and one-time mosquito story
    // branches joined the technician-report lane (owner 2026-08-11 — the
    // cockroach report dropped the generated copy). v4 added rodent
    // trapping + the declared setup/re-check composition (#3159).
    expect(snapshot.summaryTemplateVersion).toBe(6);
  });

  test('one-time pest zero state keeps the template body — a body drafted pre-zero-flip must not contradict the headline (Codex P2)', () => {
    const result = buildTodaysResult({
      projectType: 'one_time_pest_treatment',
      reportTypeLabel: 'Pest Control Re-Service Summary',
      values: { activity_level: 'None observed' },
      chips,
      technicianReportBody: AI_BODY,
    });
    expect(result.headline).toBe('No active signs of pest activity observed today.');
    expect(result.body).toBe('We completed the scheduled service. Continue monitoring and contact us if activity returns.');
    expect(result).not.toHaveProperty('bodySource');
  });

  test('without a technician report the template output is unchanged and unstamped', () => {
    const snapshot = buildTypedReportSnapshot({
      projectType: 'one_time_pest_treatment',
      values: { activity_level: 'Moderate' },
      nextStepChips: chips,
      serviceLabel: 'Pest Control Re-Service',
    });
    expect(snapshot.todaysResult.body).toBe(`We completed the scheduled service. ${chipSentence}`);
    expect(snapshot.todaysResult).not.toHaveProperty('bodySource');
  });

  test('the reviewed report also beats a typed-field first sentence in the tail branch', () => {
    const snapshot = buildTypedReportSnapshot({
      projectType: 'one_time_pest_treatment',
      values: { activity_level: 'Moderate', treatment_performed: 'Spot treated the kitchen.' },
      nextStepChips: chips,
      technicianReportBody: AI_BODY,
    });
    expect(snapshot.todaysResult.body.startsWith(AI_BODY)).toBe(true);
  });

  // Summary template v5 (owner 2026-08-11): the drop was collective — every
  // gauge lane now accepts the reviewed body, and the knockdown/one-time
  // mosquito stories swap their intro for it while keeping the mandated
  // disclosure/follow-up sentences.
  test('cockroach gauge branch: body is the reviewed report, headline stays gauge-driven', () => {
    const result = buildTodaysResult({
      projectType: 'cockroach',
      reportTypeLabel: 'Cockroach Treatment Summary',
      values: { activity_level: 'Moderate' },
      chips,
      activity: { score: 3 },
      visitSequence: 1,
      technicianReportBody: AI_BODY,
    });
    expect(result.headline).toBe('Cockroach activity was moderate today.');
    expect(result.body).toContain(AI_BODY);
    expect(result.bodySource).toBe('technician_report');
  });

  test('cockroach zero gauge keeps the template body — a draft must not outrank a typed zero', () => {
    const result = buildTodaysResult({
      projectType: 'cockroach',
      reportTypeLabel: 'Cockroach Treatment Summary',
      values: { activity_level: 'None observed' },
      chips,
      activity: { score: 0 },
      visitSequence: 1,
      technicianReportBody: AI_BODY,
    });
    expect(result.body).not.toContain(AI_BODY);
    expect(result).not.toHaveProperty('bodySource');
  });

  test('termite treatment gauge branch accepts the reviewed body (pretreatment with a pinned score)', () => {
    const result = buildTodaysResult({
      projectType: 'termite_treatment',
      reportTypeLabel: 'Termite Pretreatment Summary',
      values: { termite_activity: 'Suspected activity' },
      chips,
      activity: { score: 2 },
      visitSequence: 1,
      technicianReportBody: AI_BODY,
    });
    expect(result.body).toContain(AI_BODY);
    expect(result.bodySource).toBe('technician_report');
  });

  test('palmetto knockdown swaps the intro for the reviewed body and keeps the flush disclosure', () => {
    const result = buildTodaysResult({
      projectType: 'palmetto_roach_knockdown',
      reportTypeLabel: 'Large-Roach Knockdown Summary',
      values: { activity_level: 'Moderate' },
      chips,
      activity: { score: 3 },
      visitSequence: 1,
      technicianReportBody: AI_BODY,
    });
    expect(result.headline).toBe('Large-roach activity was moderate today.');
    expect(result.body).toContain(AI_BODY);
    // The mandated palmetto flush disclosure survives the swap.
    expect(result.body).toContain('flushed from hiding areas');
    expect(result.bodySource).toBe('technician_report');
  });

  test('German knockdown keeps the bait-cooperation guidance and follow-up line alongside the reviewed body', () => {
    const result = buildTodaysResult({
      projectType: 'german_roach_knockdown',
      reportTypeLabel: 'German Roach Knockdown Summary',
      values: {
        activity_level: 'Heavy',
        rooms_treated: 'Kitchen and both bathrooms',
        followup_required: 'Yes',
        followup_window: '10–14 days',
      },
      chips,
      activity: { score: 4 },
      visitSequence: 1,
      technicianReportBody: AI_BODY,
    });
    expect(result.body).toContain(AI_BODY);
    // Owner-critical German bait guidance survives the swap.
    expect(result.body).toContain('keep bait placements undisturbed');
    expect(result.body).toContain('Follow-up service is recommended in 10–14 days.');
    expect(result.bodySource).toBe('technician_report');
  });

  test('knockdown cleared state keeps the template body — a pre-zero draft must not outrank it', () => {
    const result = buildTodaysResult({
      projectType: 'palmetto_roach_knockdown',
      reportTypeLabel: 'Large-Roach Knockdown Summary',
      values: { activity_level: 'None observed' },
      chips,
      activity: { score: 0 },
      visitSequence: 1,
      technicianReportBody: AI_BODY,
    });
    expect(result.body).not.toContain(AI_BODY);
    expect(result).not.toHaveProperty('bodySource');
  });

  test('one-time mosquito swaps the body on an observed level and keeps the level headline', () => {
    const result = buildTodaysResult({
      projectType: 'mosquito_event',
      reportTypeLabel: 'Mosquito Treatment Summary',
      values: { activity_level: 'Light' },
      chips,
      visitSequence: 1,
      technicianReportBody: AI_BODY,
    });
    expect(result.headline).toBe('Mosquito activity was light today.');
    expect(result.body).toBe(`${AI_BODY} ${chipSentence}`);
    expect(result.bodySource).toBe('technician_report');
  });

  test('one-time mosquito "None observed" keeps the template body', () => {
    const result = buildTodaysResult({
      projectType: 'mosquito_event',
      reportTypeLabel: 'Mosquito Treatment Summary',
      values: { activity_level: 'None observed' },
      chips,
      visitSequence: 1,
      technicianReportBody: AI_BODY,
    });
    expect(result.body).not.toContain(AI_BODY);
    expect(result).not.toHaveProperty('bodySource');
  });

  // Activity-level claim screen (codex P1 on #3354): a draft written while
  // the gauge read Heavy must not ride under a re-pinned "low" headline —
  // the nonzero mirror of the zero-state rule.
  const HEAVY_DRAFT = 'Cockroach activity was heavy in the kitchen today. '
    + 'We applied gel bait to the harborage points behind the appliances.';

  test('a draft claiming the opposite level family is refused on the gauge lanes', () => {
    const result = buildTodaysResult({
      projectType: 'cockroach',
      reportTypeLabel: 'Cockroach Treatment Summary',
      values: { activity_level: 'Low' },
      chips,
      activity: { score: 1 },
      visitSequence: 1,
      technicianReportBody: HEAVY_DRAFT,
    });
    expect(result.body).not.toContain('heavy');
    expect(result).not.toHaveProperty('bodySource');
    // Headline stays gauge-driven either way.
    expect(result.headline).toBe('Cockroach activity was very low today.');
  });

  test('a matching-family draft is kept; adjacent-band drift does not refuse', () => {
    const kept = buildTodaysResult({
      projectType: 'cockroach',
      reportTypeLabel: 'Cockroach Treatment Summary',
      values: { activity_level: 'Heavy' },
      chips,
      activity: { score: 4 },
      visitSequence: 1,
      technicianReportBody: HEAVY_DRAFT,
    });
    expect(kept.body).toContain(HEAVY_DRAFT);
    expect(kept.bodySource).toBe('technician_report');
    // Moderate final (band 2) vs heavy claim (band 3): adjacent, kept.
    const adjacent = buildTodaysResult({
      projectType: 'cockroach',
      reportTypeLabel: 'Cockroach Treatment Summary',
      values: { activity_level: 'Moderate' },
      chips,
      activity: { score: 3 },
      visitSequence: 1,
      technicianReportBody: HEAVY_DRAFT,
    });
    expect(adjacent.bodySource).toBe('technician_report');
  });

  test('an exemption word AFTER the claim does not launder it (codex P1 r2)', () => {
    const result = buildTodaysResult({
      projectType: 'cockroach',
      reportTypeLabel: 'Cockroach Treatment Summary',
      values: { activity_level: 'Low' },
      chips,
      activity: { score: 1 },
      visitSequence: 1,
      technicianReportBody: 'Cockroach activity was heavy today and can continue between visits without treatment. '
        + 'We applied gel bait behind the appliances.',
    });
    expect(result.body).not.toContain('heavy');
    expect(result).not.toHaveProperty('bodySource');
  });

  test('an intent marker governing a DIFFERENT predicate does not exempt the claim (codex P1 r3)', () => {
    const result = buildTodaysResult({
      projectType: 'cockroach',
      reportTypeLabel: 'Cockroach Treatment Summary',
      values: { activity_level: 'Low' },
      chips,
      activity: { score: 1 },
      visitSequence: 1,
      // 'may' governs "decrease", not the heavy claim — the stale Heavy
      // body must not publish beneath the Low headline.
      technicianReportBody: 'Activity may decrease from the heavy activity observed today. '
        + 'We applied gel bait behind the appliances.',
    });
    expect(result.body).not.toContain('heavy');
    expect(result).not.toHaveProperty('bodySource');
  });

  test('bait-station drafts reconcile station counts before publishing (codex P1 r3)', () => {
    const base = {
      projectType: 'termite_bait_station',
      reportTypeLabel: 'Termite Bait Station Summary',
      chips,
      activity: { score: 2 },
      visitSequence: 2,
    };
    // Stale roster: draft says 12, final typed value says 10 → refused.
    // (Location-free phrasing: a trailing location preposition is a
    // subset qualifier since codex r6 and voids the claim — the
    // location-tailed stale roster is an accepted leak under the ruling.)
    const staleRoster = buildTodaysResult({
      ...base,
      values: { stations_checked: '10', bait_consumption: 'Light' },
      technicianReportBody: 'We checked 12 bait stations and refreshed the bait. '
        + 'Light feeding was noted.',
    });
    expect(staleRoster.body).not.toContain('12 bait stations');
    expect(staleRoster).not.toHaveProperty('bodySource');
    // Matching roster publishes.
    const matching = buildTodaysResult({
      ...base,
      values: { stations_checked: '12', bait_consumption: 'Light' },
      technicianReportBody: 'We checked 12 bait stations and refreshed the bait. '
        + 'Light feeding was noted.',
    });
    expect(matching.bodySource).toBe('technician_report');
    // Stale activity subset: draft claims feeding at 3 stations, final says 1.
    const staleActivity = buildTodaysResult({
      ...base,
      values: { stations_checked: '12', stations_with_activity: '1', bait_consumption: 'Light' },
      technicianReportBody: 'We found feeding at 3 stations along the back fence line. '
        + 'Bait was refreshed at every station.',
    });
    expect(staleActivity.body).not.toContain('feeding at 3 stations');
    expect(staleActivity).not.toHaveProperty('bodySource');
    // Partitive phrasing claims NOTHING (codex on #3358): "3 of the 12
    // stations were checked" names the roster denominator, and reading 12
    // as the checked count would drop legitimate copy against a typed
    // stations_checked of 3.
    const partitive = buildTodaysResult({
      ...base,
      values: { stations_checked: '3', stations_with_activity: '1', bait_consumption: 'Light' },
      technicianReportBody: '3 of the 12 stations were checked on this visit, and 1 of the 12 stations '
        + 'had light feeding. Bait was refreshed where needed.',
    });
    expect(partitive.bodySource).toBe('technician_report');
  });

  // The eight #3358 review findings, pinned: the station guard must not
  // drop truthful copy (negation, partitives, clause boundaries, subset
  // actions) and must not miss stale counts the natural wordings carry
  // (adverbs, the repo's own noun phrase, totals, inaccessible counts).
  test('station guard: truthful copy publishes; stale natural wordings are caught (codex #3358)', () => {
    const base = {
      projectType: 'termite_bait_station',
      reportTypeLabel: 'Termite Bait Station Summary',
      chips,
      activity: { score: 2 },
      visitSequence: 2,
    };
    const publish = (values, body) => buildTodaysResult({ ...base, values, technicianReportBody: body });
    // Truthful copy publishes:
    expect(publish(
      { stations_checked: '12', stations_with_activity: '1', bait_consumption: 'Light' },
      'Feeding was light; bait at 3 stations was refreshed. We checked 12 bait stations.',
    ).bodySource).toBe('technician_report');
    expect(publish(
      { stations_checked: '12', stations_with_activity: '0', bait_consumption: 'None — bait intact' },
      'We checked 12 bait stations and 3 bait stations had no activity signs at all.',
    ).bodySource).toBe('technician_report');
    expect(publish(
      { stations_checked: '12', bait_consumption: 'Light' },
      'We serviced 3 bait stations with damaged lids and checked 12 bait stations in total.',
    ).bodySource).toBe('technician_report');
    expect(publish(
      { stations_checked: '10', bait_consumption: 'Light' },
      'Only 10 of the 12 bait stations were inspected today; two sat behind a locked gate.',
    ).bodySource).toBe('technician_report');
    // Stale counts refuse:
    expect(publish(
      { stations_checked: '10', bait_consumption: 'Light' },
      '12 bait stations were thoroughly inspected on this visit.',
    )).not.toHaveProperty('bodySource');
    expect(publish(
      { stations_checked: '10', bait_consumption: 'Light' },
      'We checked 12 exterior rodent bait stations today.',
    )).not.toHaveProperty('bodySource');
    expect(publish(
      { stations_checked: '12', total_stations: '18', bait_consumption: 'Light' },
      'There are 20 stations on the property protecting the structure.',
    )).not.toHaveProperty('bodySource');
    expect(publish(
      { stations_checked: '12', stations_inaccessible: '1', bait_consumption: 'Light' },
      'Two stations were inaccessible behind the locked side gate.',
    )).not.toHaveProperty('bodySource');
  });

  // Round-3 #3358 findings, pinned as a matrix straight on the guards.
  test('station guard round 3: locations, totals, evidence forms, scope, and active inaccessible (codex #3358 r3)', () => {
    const { countContradictions } = require('../services/service-report/activity-indicators');
    const silent = [
      ['Feeding was found at 2 bait stations on the property line.', { total_stations: '12', stations_with_activity: '2' }],
      ['We refreshed bait at 4 stations around the property perimeter.', { total_stations: '12' }],
      ['10 of the 12 bait stations were checked.', { stations_checked: '10' }],
      ['3 bait stations showed no signs of activity.', { stations_with_activity: '0' }],
      ['We will continue monitoring activity at 3 bait stations.', { stations_with_activity: '1' }],
      ['No signs of termite activity were found at 3 bait stations.', { stations_with_activity: '0' }],
    ];
    for (const [text, values] of silent) {
      expect(countContradictions(text, values)).toEqual([]);
    }
    const claims = [
      ['A total of 12 bait stations were checked today.', { stations_checked: '10' }],
      ['3 bait stations showed signs of activity.', { stations_with_activity: '1' }],
      ['3 bait stations had evidence of termite activity.', { stations_with_activity: '1' }],
      ['We could not access 2 bait stations today.', { stations_inaccessible: '1' }],
      ['We were unable to reach 2 bait stations.', { stations_inaccessible: '1' }],
    ];
    for (const [text, values] of claims) {
      expect(countContradictions(text, values)).not.toEqual([]);
    }
  });

  test('intent scoping round 3: causal due-to refused, band transitions governed (codex #3358 r3)', () => {
    const { activityLevelContradictions } = require('../services/service-report/activity-indicators');
    // "due to moisture" is causal — the sentence asserts current heavy.
    expect(activityLevelContradictions('Heavy activity due to moisture was observed today.', 1))
      .not.toEqual([]);
    // Transition modals whose result is the band stay governed…
    expect(activityLevelContradictions('Activity may reach heavy levels without continued treatment.', 1))
      .toEqual([]);
    expect(activityLevelContradictions('Roach activity could escalate to heavy levels if untreated.', 1))
      .toEqual([]);
    // …while the current-state "from" reference stays refused.
    expect(activityLevelContradictions('Activity may decrease from the heavy activity observed today.', 1))
      .not.toEqual([]);
  });

  // Round-4 #3358 (owner-accepted scope 2026-08-11): level words bind to
  // the noun they qualify, and roster totals require an explicit
  // assertion — locations never claim.
  test('level words bind to their noun — locations never claim a level (codex #3358 r4)', () => {
    const { activityLevelContradictions } = require('../services/service-report/activity-indicators');
    // "light fixture" / "high ceiling" are locations, not level claims.
    expect(activityLevelContradictions('Heavy activity was observed near the light fixture.', 3))
      .toEqual([]);
    expect(activityLevelContradictions('Low activity was observed near the high ceiling.', 1))
      .toEqual([]);
    // The bound claim itself still screens under an opposite pin.
    expect(activityLevelContradictions('Heavy activity was observed near the light fixture.', 1))
      .not.toEqual([]);
    // consumption/feeding drive the bait-station and mosquito scores and
    // participate in the reconciliation.
    expect(activityLevelContradictions('Bait consumption was heavy today.', 1))
      .not.toEqual([]);
    expect(activityLevelContradictions('We found heavy feeding at the back stations.', 1))
      .not.toEqual([]);
  });

  // r79 (#3420): absence scoped to a subset location is a subset report,
  // not a whole-visit denial — property-level nouns still deny.
  test('location-scoped absence beside a nonzero gauge stays legal; whole-visit denials refuse', () => {
    const { activityLevelContradictions } = require('../services/service-report/activity-indicators');
    expect(activityLevelContradictions(
      'We found no activity at the front stations, but moderate activity at station 7.', 2,
    )).toEqual([]);
    expect(activityLevelContradictions('There was no activity in the attic.', 2)).toEqual([]);
    expect(activityLevelContradictions('We found no activity at the property.', 2))
      .toContain('level_claim_mismatch:none');
    expect(activityLevelContradictions('No activity was observed today.', 2))
      .toContain('level_claim_mismatch:none');
    // r87: generic sweep nouns only narrow scope when actually qualified —
    // "areas inspected" and the bare perimeter describe the whole visit
    expect(activityLevelContradictions('No activity was observed in areas inspected today.', 2))
      .toContain('level_claim_mismatch:none');
    expect(activityLevelContradictions('No activity was observed around the perimeter.', 2))
      .toContain('level_claim_mismatch:none');
    expect(activityLevelContradictions('No activity was observed at the rear perimeter.', 2))
      .toEqual([]);
  });

  test('roster totals require an explicit assertion — a location phrase never claims (codex #3358 r4)', () => {
    const { countContradictions } = require('../services/service-report/activity-indicators');
    expect(countContradictions(
      'Activity was observed at 2 bait stations on the property.',
      { total_stations: '12', stations_with_activity: '2' },
    )).toEqual([]);
    expect(countContradictions(
      'There are 20 stations on the property.',
      { total_stations: '18' },
    )).not.toEqual([]);
    expect(countContradictions(
      '12 bait stations are installed around the home.',
      { total_stations: '10' },
    )).not.toEqual([]);
  });

  // Round-5 #3358 — all four findings were copy-dropping false positives,
  // the fix-on-sight class under the accepted-scope ruling.
  test('qualified subsets, split hundreds, and scope compounds never claim (codex #3358 r5)', () => {
    const { countContradictions } = require('../services/service-report/activity-indicators');
    const silent = [
      // "with activity" restricts the existential to the active subset.
      ['There are 2 bait stations with activity on the property.', { total_stations: '12', stations_with_activity: '2' }],
      // "with damaged lids" restricts the inspection to a subset.
      ['We inspected 2 bait stations with damaged lids and checked the remaining stations.', { stations_checked: '12' }],
      // normalizeWordNumbers splits "one hundred twenty" into "1 100 20" —
      // a number adjacent to another number claims nothing.
      ['1 100 20 bait stations were inspected.', { stations_checked: '120' }],
      // "activity checks" is the work's scope, not an observed subset.
      ['Termite activity checks were completed at 12 bait stations; no activity was observed.', { stations_checked: '12', stations_with_activity: '0' }],
    ];
    for (const [text, values] of silent) {
      expect(countContradictions(text, values)).toEqual([]);
    }
    // The unqualified forms still claim.
    expect(countContradictions('There are 20 stations on the property.', { total_stations: '18' }))
      .not.toEqual([]);
    expect(countContradictions('We checked 12 bait stations.', { stations_checked: '10' }))
      .not.toEqual([]);
  });

  // Round-6 #3358 (owner: "fix 5, freeze, merge") — the final hardening
  // round before the guard freeze; all five were copy-dropping false
  // positives.
  test('round 6: negated observations, location subsets, prior visits, work stoppages, and conditionals never claim', () => {
    const { activityLevelContradictions, countContradictions } = require('../services/service-report/activity-indicators');
    // Directly negated level observations are truthful zero-findings.
    expect(activityLevelContradictions('No heavy activity was observed today.', 1)).toEqual([]);
    expect(activityLevelContradictions('Heavy activity was not observed today.', 1)).toEqual([]);
    // A conditional opener governs its whole clause.
    expect(activityLevelContradictions('If conditions worsen heavy activity is possible.', 1)).toEqual([]);
    // Location-qualified inspections are subsets, not the checked total.
    expect(countContradictions(
      'We inspected 2 bait stations near the garage and checked the other stations.',
      { stations_checked: '12' },
    )).toEqual([]);
    // Prior-visit counts are trend copy, not today's claim.
    expect(countContradictions(
      'At the last service, we inspected 12 bait stations; this visit a locked gate limited us.',
      { stations_checked: '10' },
    )).toEqual([]);
    // A work stoppage is not an access failure.
    expect(countContradictions(
      'We were unable to service 2 bait stations before rain forced us to stop.',
      { stations_inaccessible: '0' },
    )).toEqual([]);
    // The unnegated, unqualified, current-visit claims still screen.
    expect(activityLevelContradictions('Cockroach activity was heavy in the kitchen today.', 1)).not.toEqual([]);
    expect(countContradictions('We checked 12 bait stations.', { stations_checked: '10' })).not.toEqual([]);
    expect(countContradictions('We could not access 2 bait stations today.', { stations_inaccessible: '1' })).not.toEqual([]);
  });

  test('negated and subject-position intent qualifiers stay governed (codex #3358)', () => {
    const base = {
      projectType: 'cockroach',
      reportTypeLabel: 'Cockroach Treatment Summary',
      values: { activity_level: 'Low' },
      chips,
      activity: { score: 1 },
      visitSequence: 1,
    };
    expect(buildTodaysResult({
      ...base,
      technicianReportBody: 'Activity may not be heavy going forward. We applied gel bait behind the appliances.',
    }).bodySource).toBe('technician_report');
    expect(buildTodaysResult({
      ...base,
      technicianReportBody: 'Typically, heavy activity may be seen in summer. We applied gel bait behind the appliances.',
    }).bodySource).toBe('technician_report');
  });

  test('an intent marker BEFORE the claim still exempts it', () => {
    const result = buildTodaysResult({
      projectType: 'cockroach',
      reportTypeLabel: 'Cockroach Treatment Summary',
      values: { activity_level: 'Low' },
      chips,
      activity: { score: 1 },
      visitSequence: 1,
      technicianReportBody: 'Without continued treatment, activity may become heavy again. '
        + 'We applied gel bait behind the appliances.',
    });
    expect(result.bodySource).toBe('technician_report');
  });

  test('prior-visit and conditional level references are exempt from the screen', () => {
    const result = buildTodaysResult({
      projectType: 'cockroach',
      reportTypeLabel: 'Cockroach Treatment Summary',
      values: { activity_level: 'Low' },
      chips,
      activity: { score: 1 },
      visitSequence: 1,
      technicianReportBody: 'Activity was heavy at our last visit and has dropped sharply. '
        + 'We refreshed the bait placements in the kitchen.',
    });
    expect(result.bodySource).toBe('technician_report');
  });

  test('the confirmed reconciliation prompt overrides the level screen', () => {
    const result = buildTodaysResult({
      projectType: 'cockroach',
      reportTypeLabel: 'Cockroach Treatment Summary',
      values: { activity_level: 'Low' },
      chips,
      activity: { score: 1 },
      visitSequence: 1,
      technicianReportBody: HEAVY_DRAFT,
      reconcileConfirmed: true,
    });
    expect(result.body).toContain(HEAVY_DRAFT);
    expect(result.bodySource).toBe('technician_report');
  });

  test('knockdown and one-time mosquito refuse an opposite-family draft the same way', () => {
    const knockdown = buildTodaysResult({
      projectType: 'palmetto_roach_knockdown',
      reportTypeLabel: 'Large-Roach Knockdown Summary',
      values: { activity_level: 'Low' },
      chips,
      activity: { score: 1 },
      visitSequence: 1,
      technicianReportBody: 'Roach activity was severe around the garage today. We treated the exterior.',
    });
    expect(knockdown.body).not.toContain('severe');
    expect(knockdown).not.toHaveProperty('bodySource');
    // The mandated flush disclosure still composes on the template path.
    expect(knockdown.body).toContain('flushed from hiding areas');

    const mosquito = buildTodaysResult({
      projectType: 'mosquito_event',
      reportTypeLabel: 'Mosquito Treatment Summary',
      values: { activity_level: 'Light' },
      chips,
      visitSequence: 1,
      technicianReportBody: 'Mosquito activity was heavy near the beds. We applied a barrier treatment.',
    });
    expect(mosquito.body).not.toContain('heavy');
    expect(mosquito).not.toHaveProperty('bodySource');
  });

  test('owner-story branches consume the technician report while keeping their approved framing (r24 #3420)', () => {
    // Superseded pin: pre-unified-AI, rodent exclusion ignored the report
    // body (it was only generated for pest/mosquito/knockdown lanes). The
    // unified Generate action reaches every typed panel, so the reviewed
    // draft now replaces the repair-story narrative — while the OWNER-
    // approved headline and the remaining-concerns disclosure still carry.
    const result = buildTodaysResult({
      projectType: 'rodent_exclusion',
      reportTypeLabel: 'Rodent Exclusion Summary',
      values: {
        exclusion_work_completed: 'Sealed gaps',
        exclusion_areas: 'Garage',
        remaining_concerns: 'No remaining concerns observed',
      },
      chips: [],
      technicianReportBody: AI_BODY,
    });
    expect(result.headline).toBe('Exclusion repairs were completed to reduce rodent access and help prevent re-entry.');
    expect(result.body).toContain(AI_BODY);
    expect(result.body).toContain('No remaining concerns were observed today.');
    expect(result.bodySource).toBe('technician_report');
  });
});
