jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { hasUnconfirmedCountyEvidence, canonicalLookupAddress, _private: helpers } = require('../services/property-lookup/ai-property-lookup');
const ADDRESS = '200 Example Way, Bradenton, FL 34203';
const facts = { squareFootage: 2400, lotSize: 10000, stories: 2, propertyType: 'Single Family', confidence: 'high' };

describe('county evidence requires a retrieved record', () => {
  test.each(['https://www.manateepao.gov/', 'https://www.manateepao.gov/parcel/?parid=123456'])('%s cannot turn AI claims into verified county facts', (source) => {
    const record = helpers.shapeAsPropertyRecord({ ...facts, source }, ADDRESS, 'openai');
    const merged = helpers.mergePropertyRecords([record], ADDRESS);
    expect(merged._dataQuality.verifiedCriticalFields).toBe(0);
    expect(merged._dataQuality.score).toBe(0);
    expect(merged._fieldEvidence.squareFootage.fieldVerify).toBe(true);
    expect(merged._fieldEvidence.squareFootage.sourceType).not.toBe('county');
  });

  test('the direct county adapter still supplies authoritative facts', () => {
    const record = helpers.shapeAsPropertyRecord({ ...facts, source: 'https://www.manateepao.gov/parcel/?parid=123456' }, ADDRESS, 'manatee_pao');
    const merged = helpers.mergePropertyRecords([record], ADDRESS);
    expect(merged._dataQuality.verifiedCriticalFields).toBe(4);
    expect(merged._fieldEvidence.squareFootage.sourceType).toBe('county');
  });

  test('a county URL does not hide a different house in the listing citations', () => {
    const record = helpers.shapeAsPropertyRecord({ ...facts, source: 'https://www.manateepao.gov/' }, ADDRESS, 'openai');
    record._aiSources.push({ url: 'https://www.redfin.com/FL/Bradenton/100-Example-Way-34203/home/123456' });
    expect(helpers.aiRecordHouseNumberMismatch(record, ADDRESS)).toBe(true);
  });

  test('old cached AI claims are detected without rejecting direct county evidence', () => {
    const evidence = (provider) => ({ _fieldEvidence: { squareFootage: { evidence: [{ provider, sourceType: 'county' }] } } });
    expect(hasUnconfirmedCountyEvidence(evidence('openai'))).toBe(true);
    expect(hasUnconfirmedCountyEvidence(evidence('manatee_pao'))).toBe(false);
  });

  test('a geocoder-supplied different house number cannot replace the requested property', () => {
    expect(canonicalLookupAddress(ADDRESS, {
      formattedAddress: '100 Example Way, Bradenton, FL 34203, USA', partialMatch: false,
    })).toBe(ADDRESS);
  });
});
