const { _internals: grammar } = require('../services/eval/voice-relay-spoken-checks');

// Coordinated nominal lists share one treatment; separate actions retain
// their own products/targets, and respectively belongs to its own predicate.

test('an unrelated possibility does not govern an independent affirmative clause', () => {
  const text = 'There is a possibility that bait was placed indoors, but Talstar P was applied to the exterior perimeter.';
  const [start, end] = grammar.reportClauseBounds(text, text.indexOf('Talstar P'));
  expect(grammar.reportFindingIsUncertain(text.slice(start, end))).toBe(false);
});

test.each([
  ['Talstar P and bait were applied to the exterior perimeter.', 'Talstar P', true],
  ['We used Talstar P and drove to the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and then drove to the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and quickly walked to the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and then quickly returned to the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and walked to the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and went to the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and returned to the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and moved to the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and sat at the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and stood at the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and met the technician at the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and took equipment to the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and sent the technician to the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and then sat at the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and saw ants at the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and heard noises at the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and bought equipment at the exterior perimeter.', 'Talstar P', false],
  ['We applied Talstar P and freshly mixed bait to the exterior perimeter.', 'Talstar P', true],
  ['We applied Talstar P and suspend polyzone to the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and sprayed the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and applied bait to the exterior perimeter.', 'Talstar P', false],
  ['We used Talstar P and bait to the exterior perimeter.', 'Talstar P', true],
  ['We applied Talstar P and granular bait to the exterior perimeter.', 'Talstar P', true],
  ['We applied Talstar P and Suspend PolyZone to the exterior perimeter.', 'Talstar P', true],
  ['We applied Talstar P, bait, and dust to the exterior perimeter.', 'Talstar P', true],
  ['We applied Talstar P to the garage and exterior perimeter.', 'Talstar P', true],
  ['Talstar P and bait were applied to the exterior perimeter, and their amounts were 2 and 3 gallons, respectively.', 'Talstar P', true],
  ['Talstar P and bait were applied to the exterior perimeter, and their amounts were 2 and 3 gallons, respectively.', 'bait', true],
])('completed treatment and product ownership: %s / %s', (text, subject, completed) => {
  const verb = /\b(?:apply|applying|applied|place|placed|placing|use|used|using|treat|treated|treating|spray|sprayed|spraying|put|went|got|received)\b/i.exec(text);
  expect(grammar.reportHasCompletedFinding(text, text.indexOf(subject), subject.length,
    text.indexOf('exterior perimeter'), 18, verb)).toBe(completed);
});

test.each([
  'We applied Talstar P and bait respectively to the exterior perimeter and foundation.',
  'According to the report, Talstar P, bait, and dust were applied to the exterior perimeter, foundation and garage, respectively.',
  'Yesterday, according to the report, Talstar P, bait and dust were applied respectively to the exterior perimeter, foundation and garage.',
  'Talstar P, bait and dust were applied respectively to the exterior perimeter, foundation and garage, as recorded in the report.',
  'Talstar P, bait and dust were applied respectively to the exterior perimeter, foundation and garage, which the technician documented.',
  'Talstar P, bait and dust were applied respectively to the exterior perimeter, foundation and garage, yesterday morning.',
])('respectively retains supported introduction and target-list positions: %s', (text) => {
  const products = text.includes('dust') ? ['Talstar P', 'bait', 'dust'] : ['Talstar P', 'bait'];
  const locations = products.length === 3 ? ['exterior perimeter', 'foundation', 'garage'] : ['exterior perimeter', 'foundation'];
  products.forEach((product, productIndex) => locations.forEach((location, locationIndex) => {
    expect(grammar.reportHasCompletedFinding(text, text.indexOf(product), product.length,
      text.indexOf(location), location.length, /applied/.exec(text))).toBe(productIndex === locationIndex);
  }));
});

test.each(['exterior perimeter', 'garage'])('location-first coordination targets %s', (location) => {
  for (const text of ['The exterior perimeter and garage were treated with Talstar P.', 'We treated the exterior perimeter and garage using Talstar P.']) {
    expect(grammar.reportHasCompletedFinding(text, text.indexOf('Talstar P'), 9,
      text.indexOf(location), location.length, /treated/.exec(text))).toBe(true);
  }
  const text = 'The exterior perimeter and equipment stored in the garage were treated with Talstar P.';
  expect(grammar.reportHasCompletedFinding(text, text.indexOf('Talstar P'), 9,
    text.indexOf(location), location.length, /treated/.exec(text))).toBe(false);
});

test.each(['The exterior perimeter and garage were treated with', 'We treated the exterior perimeter and garage using'])('location-first respectively maps both lists: %s', (frame) => {
  for (const [suffix, paired] of [['Talstar P and bait, respectively.', true], ['Talstar P and bait.', false], ['Talstar P and bait, and their amounts were 2 and 3 gallons, respectively.', false]]) {
    const text = `${frame} ${suffix}`;
    ['Talstar P', 'bait'].forEach((product, productIndex) => ['exterior perimeter', 'garage'].forEach((location, locationIndex) => {
      expect(grammar.reportHasCompletedFinding(text, text.indexOf(product), product.length,
        text.indexOf(location), location.length, /treated/.exec(text))).toBe(!paired || productIndex === locationIndex);
    }));
  }
});

test.each(['Talstar P', 'bait'])('location-first passive shared lists retain bounds for %s', (product) => {
  const text = 'The exterior perimeter and garage were treated with Talstar P and bait.';
  expect(grammar.reportClauseBounds(text, text.indexOf(product))).toEqual([0, text.length - 1]);
});

test.each([['Talstar P', 'exterior perimeter', true], ['Talstar P', 'garage', false], ['bait', 'garage', true], ['bait', 'exterior perimeter', false]])('active respectively pairs %s with %s', (subject, location, completed) => {
  const text = 'We applied Talstar P and bait to the exterior perimeter and garage, respectively.';
  expect(grammar.reportHasCompletedFinding(text, text.indexOf(subject), subject.length,
    text.indexOf(location), location.length, /applied/.exec(text))).toBe(completed);
});

test('unrelated likelihood remains outside a definite finding clause', () => {
  const text = 'Bait was likely placed indoors, but Talstar P was applied to the exterior perimeter.';
  const [start, end] = grammar.reportClauseBounds(text, text.indexOf('Talstar P'));
  expect(grammar.reportFindingIsUncertain(text.slice(start, end))).toBe(false);
});

test('a later instruction is outside the treatment evidence span', () => {
  const text = 'Talstar P was applied to the exterior perimeter, confirm the invoice.';
  expect(grammar.reportFindingIsInstruction(text, 0, text.indexOf('exterior perimeter'),
    /applied/.exec(text), text.indexOf(','))).toBe(false);
});

test('coordinated products preserve their respective treatment location', () => {
  const text = 'We applied Talstar P and bait to the exterior perimeter and garage, respectively.';
  expect(grammar.reportHasCompletedFinding(text, text.indexOf('Talstar P'), 9,
    text.indexOf('exterior perimeter'), 18, /applied/.exec(text))).toBe(true);
});

test.each([
  ['around', 'along', 'Talstar P', 'exterior perimeter', true], ['around', 'along', 'Talstar P', 'garage', false],
  ['around', 'along', 'bait', 'garage', true], ['around', 'along', 'bait', 'exterior perimeter', false],
  ['along', 'around', 'Talstar P', 'exterior perimeter', true], ['along', 'around', 'Talstar P', 'garage', false],
])('respectively maps %s / %s: %s to %s', (first, second, subject, location, completed) => {
  const text = `Talstar P and bait were applied ${first} the exterior perimeter and ${second} the garage, respectively.`;
  expect(grammar.reportHasCompletedFinding(text, text.indexOf(subject), subject.length,
    text.indexOf(location), location.length, /applied/.exec(text))).toBe(completed);
});

test.each(['as well as', 'plus'])('respectively pairing keeps list order with %s', (separator) => {
  const text = `Talstar P ${separator} bait were applied to the garage and exterior perimeter, respectively.`;
  expect(grammar.reportRespectivelyPairsFinding(text, 0, text.indexOf('exterior perimeter'), /applied/.exec(text))).toBe(false);
  expect(grammar.reportRespectivelyPairsFinding(text, 0, text.indexOf('garage'), /applied/.exec(text))).toBe(true);
});

test.each([
  'We applied Talstar P and bait and dust to the exterior perimeter and foundation and garage.',
  'Talstar P and bait and dust were applied to the exterior perimeter and foundation and garage.',
  'The exterior perimeter and foundation and garage were treated with Talstar P and bait and dust.',
  'We treated the exterior perimeter and foundation and garage using Talstar P and bait and dust.',
])('repeated and lists share one bounded treatment predicate: %s', (text) => {
  for (const product of ['Talstar P', 'bait', 'dust']) {
    for (const location of ['exterior perimeter', 'foundation', 'garage']) {
      expect(grammar.reportHasCompletedFinding(text, text.indexOf(product), product.length,
        text.indexOf(location), location.length, /\b(?:applied|treated)\b/.exec(text))).toBe(true);
    }
    expect(grammar.reportClauseBounds(text, text.indexOf(product))).toEqual([0, text.length - 1]);
  }
});

test.each([
  'We applied Talstar P and bait and dust to the exterior perimeter and foundation and garage, respectively.',
  'Talstar P and bait and dust were applied respectively around the exterior perimeter and along the foundation and outside the garage.',
  'The exterior perimeter and foundation and garage were treated with Talstar P and bait and dust, respectively.',
])('respectively maps repeated and lists without crossing pairs: %s', (text) => {
  ['Talstar P', 'bait', 'dust'].forEach((product, productIndex) => {
    ['exterior perimeter', 'foundation', 'garage'].forEach((location, locationIndex) => {
      expect(grammar.reportHasCompletedFinding(text, text.indexOf(product), product.length,
        text.indexOf(location), location.length, /\b(?:applied|treated)\b/.exec(text))).toBe(productIndex === locationIndex);
    });
  });
});

test.each([
  ['equal', 'amounts', 'gallons'], ['totaled', 'amounts', 'gallons'], ['measured', 'volumes', 'gallons'],
  ['reach', 'weights', 'pounds'], ['weigh', 'amounts', 'pounds'],
])('later quantity predicate %s owns its respectively marker', (predicate, quantity, unit) => {
  for (const frame of [
    'Talstar P and bait were applied to the exterior perimeter and garage',
    'The exterior perimeter and garage were treated with Talstar P and bait',
  ]) {
    const text = `${frame}, and their ${quantity} ${predicate} 2 and 3 ${unit}, respectively.`;
    for (const product of ['Talstar P', 'bait']) {
      for (const location of ['exterior perimeter', 'garage']) {
        const verb = /\b(?:applied|treated)\b/.exec(text);
        expect(grammar.reportRespectivelyPairsFinding(text, text.indexOf(product), text.indexOf(location), verb)).toBe(true);
        expect(grammar.reportHasCompletedFinding(text, text.indexOf(product), product.length,
          text.indexOf(location), location.length, verb)).toBe(true);
      }
    }
  }
});

test('a treatment marker remains paired before a later quantity marker', () => {
  const text = 'Talstar P and bait were applied to the exterior perimeter and garage, respectively, and their amounts totaled 2 and 3 gallons, respectively.';
  expect(grammar.reportHasCompletedFinding(text, text.indexOf('Talstar P'), 9,
    text.indexOf('garage'), 6, /applied/.exec(text))).toBe(false);
});

test('a treatment adjunct preserves respectively pairing across the target list', () => {
  const text = 'Talstar P and bait were applied to the exterior perimeter and garage by hand, respectively.';
  for (const [product, location, completed] of [
    ['Talstar P', 'exterior perimeter', true], ['bait', 'garage', true],
    ['Talstar P', 'garage', false], ['bait', 'exterior perimeter', false],
  ]) {
    expect(grammar.reportHasCompletedFinding(text, text.indexOf(product), product.length,
      text.indexOf(location), location.length, /applied/.exec(text))).toBe(completed);
  }
});

test.each([['suspend polyzone', false], ['Suspend PolyZone', true]])('an unsupported terminal product %s cannot discard its treatment marker', (product, supported) => {
  const text = `The exterior perimeter and garage were treated with Talstar P and ${product}, respectively.`;
  const [start, end] = grammar.reportClauseBounds(text, text.indexOf('Talstar P'));
  expect(text.slice(start, end)).toContain('respectively');
  expect(grammar.reportHasCompletedFinding(text, text.indexOf('Talstar P'), 9,
    text.indexOf('exterior perimeter'), 18, /treated/.exec(text))).toBe(supported);
  expect(grammar.reportHasCompletedFinding(text, text.indexOf('Talstar P'), 9,
    text.indexOf('garage'), 6, /treated/.exec(text))).toBe(false);
});

test('an incomplete quantity nominal cannot own a later respectively marker', () => {
  const text = 'Talstar P and bait were applied to the exterior perimeter and garage and their weights, respectively.';
  expect(grammar.reportHasCompletedFinding(text, text.indexOf('bait'), 4,
    text.indexOf('exterior perimeter'), 18, /applied/.exec(text))).toBe(false);
});

test.each([
  'If requested, the technician applied bait indoors and ',
  'Unless requested, the technician applied bait indoors and ',
  'The technician never applied bait indoors and ',
  'The technician may have applied bait indoors and ',
])('shared prefix governor remains owned by a concise coordinated finding: %s', (preceding) => {
  const finding = 'Talstar P around the exterior perimeter';
  expect(grammar.reportClaimIsDenied(finding, finding, 0, finding.indexOf('exterior perimeter'), null, preceding)).toBe(true);
});

test.each([
  ['If requested, we would apply bait indoors, but yesterday we applied dust to the garage and ', false],
  ['If requested, yesterday we applied dust to the garage and ', true],
  ['We never applied bait indoors, but yesterday we applied dust to the garage and ', false],
  ['If requested, we would apply bait indoors, but yesterday we never applied dust to the garage and ', true],
])('an independent contrast bounds the shared concise governor: %s', (preceding, denied) => {
  const finding = 'Talstar P around the exterior perimeter';
  expect(grammar.reportClaimIsDenied(finding, finding, 0, finding.indexOf('exterior perimeter'), null, preceding)).toBe(denied);
});

test.each([
  'We applied Talstar P to the garage and used bait around the exterior perimeter.',
  'Talstar P was applied in the garage, and bait was used around the exterior perimeter.',
  'We used Talstar P and equipment stored at the exterior perimeter.',
  'We used Talstar P and then applied bait around the exterior perimeter.',
])('independent actions and objects cannot lend a target: %s', (text) => {
  expect(grammar.reportHasCompletedFinding(text, text.indexOf('Talstar P'), 9,
    text.indexOf('exterior perimeter'), 18, /\b(?:applied|used)\b/.exec(text))).toBe(false);
});

test.each([
  'Talstar P went around the exterior perimeter and bait along the foundation.',
  'Talstar P went around the exterior perimeter and granular bait along the foundation.',
  'On August 14 the technician put Talstar P around the exterior perimeter and granular bait along the foundation.',
])('elided pair retains its product, target and shared completed predicate: %s', (text) => {
  const bait = text.includes('granular bait') ? 'granular bait' : 'bait';
  for (const [product, location, completed] of [
    ['Talstar P', 'exterior perimeter', true], [bait, 'foundation', true],
    ['Talstar P', 'foundation', false], [bait, 'exterior perimeter', false],
  ]) {
    expect(grammar.reportHasCompletedFinding(text, text.indexOf(product), product.length,
      text.indexOf(location), location.length, /\b(?:went|put)\b/.exec(text))).toBe(completed);
  }
});

test.each([
  'Talstar P went around the exterior perimeter and bait was applied along the foundation.',
  'The technician put Talstar P around the exterior perimeter and then applied bait along the foundation.',
])('later explicit action cannot borrow an earlier completed predicate: %s', (text) => {
  expect(grammar.reportHasCompletedFinding(text, text.indexOf('bait'), 4,
    text.indexOf('foundation'), 10, /\b(?:went|put)\b/.exec(text))).toBe(false);
});
