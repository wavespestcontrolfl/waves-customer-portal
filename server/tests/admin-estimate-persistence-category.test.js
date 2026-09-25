/**
 * estimates.category persistence (owner ruling 2026-09-25,
 * server/services/commercial-suite-size/ follow-on): the manual admin-tool
 * save path never wrote estimates.category, so every commercial estimate
 * saved through EstimateToolViewV2 kept the migration column default
 * RESIDENTIAL — which let a commercial row pass the AGENTS.md P0
 * "Estimate service-mix rail member exclusion" guard's
 * `category !== 'RESIDENTIAL'` check by accident. buildEstimatePersistenceFields
 * now stamps the column on every save (create AND revise both funnel
 * through it — see resolveEstimateWritePayload).
 */

const { buildEstimatePersistenceFields } = require('../services/admin-estimate-persistence');

const baseBody = {
  address: '123 Palm Ave',
  customerName: 'Van Lee',
  customerPhone: '(941) 555-0101',
  customerEmail: 'van@example.com',
  leadId: 'lead-1',
  customerId: null,
  monthlyTotal: 125,
  annualTotal: 1500,
  onetimeTotal: 0,
  waveguardTier: null,
  notes: '',
  satelliteUrl: null,
  showOneTimeOption: false,
  billByInvoice: false,
};

describe('buildEstimatePersistenceFields — category', () => {
  test('a residential payload persists category RESIDENTIAL', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      estimateData: { inputs: { address: '123 Palm Ave' }, result: { total: 125 } },
    });
    expect(fields.category).toBe('RESIDENTIAL');
  });

  test('a commercial payload (isCommercial flag) persists category COMMERCIAL', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      estimateData: { inputs: { isCommercial: true, address: '4400 Test Commons Pkwy E #102' }, result: { total: 103 } },
    });
    expect(fields.category).toBe('COMMERCIAL');
  });

  test('a commercial payload identified only by a commercial_ service line still persists COMMERCIAL', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      estimateData: {
        result: { recurring: { services: [{ service: 'commercial_pest', name: 'Commercial Pest Control', mo: 103 }] } },
      },
    });
    expect(fields.category).toBe('COMMERCIAL');
  });

  test('a commercial payload identified by commercialSubtype persists COMMERCIAL', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      estimateData: { inputs: { commercialSubtype: 'restaurant' } },
    });
    expect(fields.category).toBe('COMMERCIAL');
  });

  test('no estimateData at all falls back to RESIDENTIAL (the migration default), never throws', () => {
    const fields = buildEstimatePersistenceFields({ ...baseBody, estimateData: null });
    expect(fields.category).toBe('RESIDENTIAL');
  });
});
