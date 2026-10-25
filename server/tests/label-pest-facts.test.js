// GATE_PEST_LABEL_FACTS (owner 2026-10-24, "labels go"): which pests the
// technician named today, and what a product's reviewed label list lets the
// writer say about them. Synthetic notes only.

const {
  pestsNamedToday, labelFactPests, displayTerm, joinTerms, SPECIES,
} = require('../services/service-report/label-pest-facts');

describe('pestsNamedToday', () => {
  test('reads species and groups from the note, the observations and the product tags', () => {
    expect(pestsNamedToday({
      texts: ['Found a German cockroach under the sink. A few ghost ants on the slider.', 'Webs on the lanai screen, spiders in the corners'],
      targets: ['Mud daubers'],
    })).toEqual({
      species: ['Ghost ants', 'German cockroaches', 'Mud daubers'],
      groups: ['spiders'],
    });
  });

  test('a group word inside a species name is not a second mention; one standing apart is', () => {
    expect(pestsNamedToday({ texts: ['Pharaoh ants in the kitchen'] })).toEqual({ species: ['Pharaoh ants'], groups: [] });
    expect(pestsNamedToday({ texts: ['Pharaoh ants in the kitchen, other ants outside'] }))
      .toEqual({ species: ['Pharaoh ants'], groups: ['ants'] });
  });

  test('whole words only, singular or plural, any case', () => {
    expect(pestsNamedToday({ texts: ['Plants by the pool, pants on the line, a butterfly'] })).toEqual({ species: [], groups: [] });
    expect(pestsNamedToday({ texts: ['ROACHES in the garage; one earwig; Silverfish'] }).groups).toEqual(['cockroaches', 'silverfish', 'earwigs']);
    expect(pestsNamedToday({ texts: ['yellow jackets by the shed'] }).groups).toEqual(['wasps']);
  });

  test('termites, mosquitoes, bed bugs, fleas, ticks and rodents are never read as a pest', () => {
    expect(pestsNamedToday({ texts: ['Mosquitoes, termite mud tubes, bed bugs, fleas on the dog, a tick, rats and mice'] }))
      .toEqual({ species: [], groups: [] });
    expect(SPECIES.map((entry) => entry.term).join(' ')).not.toMatch(/termite|mosquito|bed bug|flea|tick|rat|mice/i);
  });

  test('nothing named, or no input', () => {
    expect(pestsNamedToday({ texts: ['Quarterly. Very low activity. Sprayed around the house.'] })).toEqual({ species: [], groups: [] });
    expect(pestsNamedToday()).toEqual({ species: [], groups: [] });
  });
});

describe('labelFactPests', () => {
  const named = (text) => pestsNamedToday({ texts: [text] });

  test('a species the label names is said as the species', () => {
    expect(labelFactPests(['German cockroaches', 'American cockroaches', 'ants'], named('A German cockroach in the kitchen')))
      .toEqual(['German cockroaches']);
  });

  test('a species the label covers only as a group is said as the group', () => {
    expect(labelFactPests(['cockroaches', 'ants'], named('A German cockroach and a few ghost ants'))).toEqual(['ants', 'cockroaches']);
  });

  test('a group named in the note needs the group on the label', () => {
    expect(labelFactPests(['German cockroaches'], named('Roaches in the garage'))).toEqual([]);
    expect(labelFactPests(['cockroaches'], named('Roaches in the garage'))).toEqual(['cockroaches']);
  });

  test('only pests named today, never the rest of the label', () => {
    expect(labelFactPests(['ants', 'spiders', 'crickets', 'silverfish'], named('Ants on the walk'))).toEqual(['ants']);
    expect(labelFactPests(['ants', 'spiders'], named('Quiet visit'))).toEqual([]);
  });

  test('an excluded pest never comes out, even when the label lists it', () => {
    expect(labelFactPests(['mosquitoes', 'termites', 'fleas', 'ants'], named('Mosquitoes, termites, fleas and ants'))).toEqual(['ants']);
  });

  test('no label list or no named pests: nothing', () => {
    expect(labelFactPests(undefined, named('Ants'))).toEqual([]);
    expect(labelFactPests(['ants'], null)).toEqual([]);
  });
});

test('displayTerm keeps a proper first word and lowers the rest; joinTerms reads as a list', () => {
  // owner 2026-10-25, "dont capitalize German"
  expect(displayTerm('German cockroaches')).toBe('german cockroaches');
  expect(displayTerm('American cockroaches')).toBe('American cockroaches');
  expect(displayTerm('Ghost ants')).toBe('ghost ants');
  expect(displayTerm('ants')).toBe('ants');
  expect(joinTerms(['ants'])).toBe('ants');
  expect(joinTerms(['ants', 'spiders'])).toBe('ants and spiders');
  expect(joinTerms(['ants', 'spiders', 'german cockroaches'])).toBe('ants, spiders and german cockroaches');
});
