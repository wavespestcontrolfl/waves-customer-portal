const SERVICE_ID = '11111111-1111-4111-8111-111111111111';
const mockProvider = jest.fn(async () => ({ ok: true, text: 'WHAT WE DID\n\nReviewed the submitted tree photographs.\n\nWHAT WE FOUND\n\nThe reviewed photos show sparse foliage.' }));
jest.mock('../services/llm/call', () => ({ callOpenAI: (...args) => mockProvider(...args), callAnthropic: (...args) => mockProvider(...args) }));
jest.mock('../services/pest-pressure/store', () => ({ loadActiveConfig: async () => null }));
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: async () => ({ serviceKey: 'tree_shrub_program', findingsType: 'tree_shrub' }),
}));
jest.mock('../services/service-report/report-copy-context', () => ({
  buildReportCopyContext: async ({ treeShrubReviewGrounding }) => ({
    contextText: `\nTREE & SHRUB REVIEWED PHOTO SIGNALS: ${JSON.stringify(treeShrubReviewGrounding)}`,
    signals: { hasTreeShrubReviewedPhotoSignals: true },
  }),
}));
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const chain = {};
    for (const name of ['where', 'whereIn', 'select', 'orderBy', 'limit', 'leftJoin']) chain[name] = () => chain;
    chain.first = async () => table === 'scheduled_services'
      ? { id: '11111111-1111-4111-8111-111111111111', service_type: 'Tree and Shrub Care', customer_id: 'customer-1' } : null;
    chain.then = (resolve) => Promise.resolve([]).then(resolve);
    return chain;
  });
  db.raw = jest.fn();
  db.fn = { now: () => new Date() };
  return db;
});

const router = require('../routes/admin-schedule');
const { treeShrubPhotosHash, treeShrubReviewSignature } = require('../services/tree-shrub-assessment');

test('the provider receives permission to use signed tree signals only with their visual provenance', async () => {
  const scores = { foliageFullness: 50, leafColorVigor: 70, pestActivity: 80, diseaseLeafSpot: 90, waterHeatStress: 80, overallScore: 74 };
  const photosHash = treeShrubPhotosHash(['data:image/jpeg;base64,YQ==']);
  const observations = 'Sparse foliage is visible.';
  const treeShrubReview = { scores, photosHash, observations, photoCount: 1, scoredCount: 1, confirmed: true, decisions: [] };
  treeShrubReview.signature = treeShrubReviewSignature(scores, 1, SERVICE_ID, photosHash, observations);
  const route = router.stack.find((layer) => layer.route?.path === '/generate-report').route;
  const handler = route.stack.at(-1).handle;
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json: jest.fn() };
  await handler({ techRole: 'admin', body: { scheduledServiceId: SERVICE_ID, serviceType: 'Tree and Shrub Care', treeShrubReview, photoCount: 1 } }, res);
  expect(res.statusCode).toBe(200);
  expect(mockProvider).toHaveBeenCalled();
  const supplied = mockProvider.mock.calls[0][0];
  expect(supplied.system).toContain('TREE & SHRUB REVIEWED PHOTO SIGNALS may describe reviewed visual appearances only');
  expect(supplied.system).toContain('never establish a diagnosis');
  expect(supplied.system).not.toContain('ONE exception:');
  expect(supplied.text).toContain('a count alone supplies no visual facts');
  expect(supplied.text).toContain('Sparse foliage is visible.');
});
