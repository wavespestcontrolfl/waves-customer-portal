const { _test } = require('../services/property-lookup/ai-property-lookup');

describe('AI property lookup lot-size normalization', () => {
  const { coerceLotSize } = _test;

  test('parses acreage values tied to acre units', () => {
    expect(coerceLotSize('Lot 13, Block 2, 0.23 acres')).toBe(10019);
    expect(coerceLotSize('.2 acres')).toBe(8712);
    expect(coerceLotSize('AC 0.25')).toBe(10890);
    expect(coerceLotSize('Lot Size Acres: 0.25')).toBe(10890);
    expect(coerceLotSize('Lot 13, Block 2, Acres: 0.25')).toBe(10890);
    expect(coerceLotSize('Lot 13 AC 0.25')).toBe(10890);
    expect(coerceLotSize('Lot 13 AC 0.25 acres')).toBe(10890);
    expect(coerceLotSize('Lot 4 AC 0.25')).toBe(10890);
    expect(coerceLotSize('Lot 1 AC 2')).toBe(87120);
    expect(coerceLotSize('Lot 4 AC 5')).toBe(200000);
    expect(coerceLotSize('Lot 13 AC 0.02')).toBeNull();
    expect(coerceLotSize('Acreage: 5')).toBe(200000);
    expect(coerceLotSize('4 acres 2 parcels')).toBe(174240);
    expect(coerceLotSize('1 acre 2024 tax record')).toBe(43560);
  });

  test('parses fractional acreage formats before decimal fallback', () => {
    expect(coerceLotSize('1-1/2 acres')).toBe(65340);
    expect(coerceLotSize('1 / 2 acre')).toBe(21780);
    expect(coerceLotSize('Lot 13 - 1/2 acre')).toBe(21780);
    expect(coerceLotSize('Lot 13-1/2 acre')).toBe(21780);
    expect(coerceLotSize('Lot #13 1/2 acre')).toBe(21780);
  });

  test('recognizes acre and square-foot abbreviations without using unrelated numbers', () => {
    expect(coerceLotSize('LOT 13 (0.23 AC - 10,000 SF)')).toBe(10000);
    expect(coerceLotSize('0.25 acres 10,890 sqft')).toBe(10890);
    expect(coerceLotSize('Lot 13 AC 0.25 SF 10,890')).toBe(10890);
    expect(coerceLotSize('AC 5 SF 217,800')).toBe(200000);
    expect(coerceLotSize('SECTION 22 LOT 13')).toBeNull();
    expect(coerceLotSize('BLOCK 30 LOT 13 AC ADJ REF PLAT')).toBeNull();
    expect(coerceLotSize('Lot size 999999')).toBeNull();
    expect(coerceLotSize('Lot size 260,924')).toBe(200000);
    expect(coerceLotSize(260924)).toBe(200000);
    expect(coerceLotSize('260924')).toBe(200000);
    expect(coerceLotSize('260,924')).toBe(200000);
  });
});
