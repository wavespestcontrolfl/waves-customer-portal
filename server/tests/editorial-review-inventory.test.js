'use strict';

const { analyzeDocument } = require('../services/content/editorial-review-inventory');

describe('editorial review document inventory', () => {
  test('exempts CTA, navigation, and decorative sections from semantic coverage inventories', () => {
    const doc = '# Guide\n\nUseful introduction.\n\n## Related guides\n\n[Ant guide](/ants/)\n\n## Contact\n\nCall today for a quote.';
    const analysis = analyzeDocument(doc, 'Guide');
    expect(analysis.sections.map((section) => section.heading)).not.toEqual(expect.arrayContaining(['Related guides', 'Contact']));
    expect(analysis.passages.map((passage) => passage.text)).not.toEqual(expect.arrayContaining(['[Ant guide](/ants/)', 'Call today for a quote.']));
  });

  test('includes informational prose nested inside MDX components', () => {
    const doc = '# Guide\n\n## Identification\n\n<Callout kind="fact">\nAedes mosquitoes can breed in small containers.\n</Callout>';
    const analysis = analyzeDocument(doc, 'Guide');
    expect(analysis.passages).toEqual([expect.objectContaining({ text: 'Aedes mosquitoes can breed in small containers.' })]);
    expect(analysis.claims).toEqual([expect.objectContaining({ passage: 'Aedes mosquitoes can breed in small containers.' })]);
  });

  test('inventories prose immediately following a heading with no blank line', () => {
    const doc = '# Guide\n## Identification\nAedes mosquitoes breed in standing water.\n## Prevention\nEmpty containers every week.';
    const analysis = analyzeDocument(doc, 'Guide');
    expect(analysis.sections).toEqual([
      expect.objectContaining({ heading: 'Identification', lead: 'Aedes mosquitoes breed in standing water.' }),
      expect.objectContaining({ heading: 'Prevention', lead: 'Empty containers every week.' }),
    ]);
    expect(analysis.passages.map((passage) => passage.text)).toEqual([
      'Aedes mosquitoes breed in standing water.',
      'Empty containers every week.',
    ]);
  });
});

 test('preserves decimals, attributed names, and closing quotation marks in claim passages', () => {
   const passages = ['Exactly 97.3% of surveyed homes have door gaps.', 'University researcher Dr. Maria Example said, “Every home has seven gaps.”'];
   const analysis = analyzeDocument('## Findings\n' + passages.join('\n\n'), 'Findings');
   expect(analysis.claims.map((claim) => claim.passage)).toEqual(passages);
 });

