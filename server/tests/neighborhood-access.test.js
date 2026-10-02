// All names, addresses and codes here are synthetic; they only reproduce the
// shapes the county rolls return (plat suffixes, book references, situs lines
// that run on into the city).
const {
  neighborhoodNameFromSubdivision, isKeypadCode, matchKey, parcelMatchesProperty,
} = require('../services/neighborhood-access');

describe('neighborhoodNameFromSubdivision', () => {
  test.each([
    ['OAKWOOD GLEN PH IV SUBPH 4A & 4B PB66/57', 'Oakwood Glen'],
    ['HERON POINTE AT CEDAR RANCH PH IV SUBPH 4A & 4B PB72/26', 'Heron Pointe at Cedar Ranch'],
    ['LAUREL NORTH AT MAPLE LAKES SUBPH IA IB & II PB73/165', 'Laurel North at Maple Lakes'],
    ['BLUE TERN LAGOONS AT CEDAR RANCH CB34/1', 'Blue Tern Lagoons at Cedar Ranch'],
    ['FERNLEAF HOLLOW A REPLAT OF A PORTION OF PHASE II PB71/176', 'Fernleaf Hollow'],
    ['ASHBY A SUBDIVISION PB32/76', 'Ashby'],
    ['PINEBROOK VILLAGE SP BB UN 2 PB41/142', 'Pinebrook Village'],
    ['MEADOW AT CEDAR RANCH PH II SUBPH A & B PB60/1', 'Meadow at Cedar Ranch'],
    ['WILLOW GRANDE PB59/115', 'Willow Grande'],
    ['STONEFIELD PHASE I PB51/178', 'Stonefield'],
  ])('%s → %s', (raw, name) => {
    expect(neighborhoodNameFromSubdivision(raw)).toBe(name);
  });

  test('phases of one development collapse to the same name', () => {
    expect(neighborhoodNameFromSubdivision('OAKWOOD GLEN PH II PB60/1'))
      .toBe(neighborhoodNameFromSubdivision('OAKWOOD GLEN PH IV SUBPH 4A & 4B PB66/57'));
  });

  // Sarasota's layer returns a numeric code; these must stay unlinked for
  // the office to pick (owner D3), never become a neighborhood called "1234".
  test.each(['1234', 'NOT IN SUBDIVISION 0/0', '', null, '  '])('%p is not a neighborhood', (raw) => {
    expect(neighborhoodNameFromSubdivision(raw)).toBeNull();
  });
});

describe('isKeypadCode', () => {
  test.each(['12345', '#1111', '2222#', '*0123', '# 3333', '555'])('%p is a keypad code', (v) => {
    expect(isKeypadCode(v)).toBe(true);
  });
  test.each([
    'Text the owner on arrival; north gate only',
    'Visitor pass is set up, no code needed',
    '12',
    '',
  ])('%p is not', (v) => {
    expect(isKeypadCode(v)).toBe(false);
  });
});

test('matchKey separates the same name in different counties', () => {
  expect(matchKey('Manatee', 'Oakwood Glen')).not.toBe(matchKey('Sarasota', 'Oakwood Glen'));
  expect(matchKey('Manatee', 'Oakwood Glen')).toBe(matchKey('manatee', 'OAKWOOD GLEN'));
});

describe('parcelMatchesProperty', () => {
  const property = { address_line1: '100 Example Pl', zip: '34202' };
  test('own parcel: house number and ZIP agree', () => {
    expect(parcelMatchesProperty({ situsAddress: '100 EXAMPLE PL', situsZip: '34202' }, property)).toBe(true);
  });
  test('spelled-out suffix and directional still match', () => {
    expect(parcelMatchesProperty({ situsAddress: '100 EXAMPLE PLACE', situsZip: '34202' }, property)).toBe(true);
    expect(parcelMatchesProperty({ situsAddress: '200 SAMPLE TER E', situsZip: '34202' }, { address_line1: '200 Sample Terrace East', zip: '34202' })).toBe(true);
  });
  test('a situs that runs on into the city matches', () => {
    expect(parcelMatchesProperty({ situsAddress: '300 TEST CT SARASOTA FL, 34232', situsCity: 'SARASOTA', situsZip: '34232' }, { address_line1: '300 Test Ct', zip: '34232' })).toBe(true);
    expect(parcelMatchesProperty({ situsAddress: '400 FIXTURE TRL VENICE FL, 34285', situsZip: '34285' }, { address_line1: '400 Fixture Trl', city: 'Venice', zip: '34285' })).toBe(true);
  });
  test('a directional the property record omits still matches', () => {
    expect(parcelMatchesProperty({ situsAddress: '500 10TH TER E', situsZip: '34219' }, { address_line1: '500 10th Ter', zip: '34219' })).toBe(true);
    expect(parcelMatchesProperty({ situsAddress: '600 20TH STREET CIR E', situsZip: '34219' }, { address_line1: '600 20th St Cir', zip: '34219' })).toBe(true);
  });
  test('a stacked condo parcel matches on any unit line', () => {
    expect(parcelMatchesProperty({ situsLines: ['98 EXAMPLE PL', '100 EXAMPLE PL'], situsZip: '34202' }, property)).toBe(true);
  });
  test.each([
    ['another house under the pin', { situsAddress: '700 OTHER DR', situsZip: '34202' }],
    ['same number and ZIP, different street', { situsAddress: '100 OTHER RD', situsZip: '34202' }],
    ['same address, different ZIP', { situsAddress: '100 EXAMPLE PL', situsZip: '34243' }],
    ['same name, different suffix', { situsAddress: '100 EXAMPLE CT', situsZip: '34202' }],
    ['longer street that starts the same', { situsAddress: '100 EXAMPLE PL RIDGE', situsZip: '34202' }],
    ['parcel with no situs', {}],
    ['parcel with no ZIP', { situsAddress: '100 EXAMPLE PL' }],
  ])('%s does not match', (_label, parcel) => {
    expect(parcelMatchesProperty(parcel, property)).toBe(false);
  });
  test.each([
    ['100 Oak Dr', '100 OAK RIDGE DR'],
    ['100 Main St E', '100 MAIN ST W'],
    ['100 Oak Dr', '100 OAK CT'],
  ])('%s does not match %s', (line, situs) => {
    expect(parcelMatchesProperty({ situsAddress: situs, situsZip: '34202' }, { address_line1: line, zip: '34202' })).toBe(false);
  });
  test('a property with no ZIP never matches', () => {
    expect(parcelMatchesProperty({ situsAddress: '100 EXAMPLE PL', situsZip: '34202' }, { address_line1: '100 Example Pl' })).toBe(false);
  });
  test('a property with no house number never matches', () => {
    expect(parcelMatchesProperty({ situsAddress: '100 EXAMPLE PL' }, { address_line1: 'Example Pl' })).toBe(false);
  });
});
