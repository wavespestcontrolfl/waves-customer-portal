// The completion picker's suggestion lists live in client code
// (client/src/pages/admin/SchedulePage.jsx) and server code must never
// import client code, so server/config/treatment-target-vocabulary.js is a
// hand-kept copy. This test parses the client file's own `_TARGET_SUGGESTIONS`
// arrays and asserts the server copy matches them exactly, so the two arrays
// cannot silently drift apart (codex round 9 P2 on #5164).
const fs = require('fs');
const path = require('path');
const vocabulary = require('../config/treatment-target-vocabulary');
const { canonicalTargetVocabulary } = require('../services/email-division/area-intel');

// The lawn and nutrition lists moved to client/src/lib/lawn-targets.js (shared
// by SchedulePage and the lawn re-service Fast Complete sheet); the pest and
// ornamental lists stay in SchedulePage. Parse both as one source.
const schedulePage = ['../../client/src/pages/admin/SchedulePage.jsx', '../../client/src/lib/lawn-targets.js']
  .map((file) => fs.readFileSync(path.join(__dirname, file), 'utf8'))
  .join('\n');

// Every `const XYZ_TARGET_SUGGESTIONS = [ ... ];` array in the file, parsed
// as {name -> string[]}.
function parseClientSuggestionLists(source) {
  const lists = {};
  const arrayRe = /const (\w*_TARGET_SUGGESTIONS) = \[([\s\S]*?)\];/g;
  let match;
  while ((match = arrayRe.exec(source))) {
    const [, name, body] = match;
    lists[name] = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  }
  return lists;
}

describe('treatment-target-vocabulary mirrors SchedulePage.jsx exactly', () => {
  const clientLists = parseClientSuggestionLists(schedulePage);

  test('the client file actually defines every suggestion list this module expects (a rename/removal must fail loudly, not silently pass an empty diff)', () => {
    expect(Object.keys(clientLists).sort()).toEqual([
      'LAWN_TARGET_SUGGESTIONS', 'NUTRITION_TARGET_SUGGESTIONS', 'ORNAMENTAL_TARGET_SUGGESTIONS', 'PEST_TARGET_SUGGESTIONS',
    ].sort());
    for (const list of Object.values(clientLists)) expect(list.length).toBeGreaterThan(5);
  });

  test.each(Object.keys(vocabulary))('%s matches the client array exactly, in order', (name) => {
    expect(clientLists[name]).toEqual(vocabulary[name]);
  });
});

// Minimal knex-shaped stub: conn('products_catalog').select(...) -> rows.
function stubConn(catalogRows) {
  return (table) => {
    expect(table).toBe('products_catalog');
    return { select: async () => catalogRows };
  };
}

describe('canonicalTargetVocabulary (area-intel.js): the picker lists union products_catalog.target_pests', () => {
  test('a picker-suggestion target and a catalog-only target (never on any picker list) are both in the vocabulary, case-/space-insensitively', async () => {
    const vocab = await canonicalTargetVocabulary(stubConn([
      { target_pests: ['roaches', 'turf disease'] }, // never on any picker list
      { target_pests: [] }, { target_pests: null },
    ]));
    expect(vocab.has('fire ants')).toBe(true); // PEST_TARGET_SUGGESTIONS
    expect(vocab.has('crabgrass')).toBe(true); // LAWN_TARGET_SUGGESTIONS
    expect(vocab.has('roaches')).toBe(true); // catalog-only
    expect(vocab.has(' Roaches ')).toBe(false); // the caller must normalise first, same as treatmentTargetKey
    expect(vocab.has('technicians treated no pests - prevention')).toBe(false); // a free-text chip
  });

  test('a catalog with no rows still returns the full static picker vocabulary', async () => {
    const vocab = await canonicalTargetVocabulary(stubConn([]));
    expect(vocab.has('fire ants')).toBe(true);
    expect(vocab.has('ghost ants')).toBe(true);
  });
});
