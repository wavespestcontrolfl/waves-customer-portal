// loadLinkedTreeShrubAssessment({ strict }): the PDF cache key must tell "this
// visit has no assessment" from "the lookup failed". Default behavior (a failed
// read reads as no assessment) is unchanged. Synthetic data only.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { loadLinkedTreeShrubAssessment } = require('../services/tree-shrub-assessment');

const SERVICE = { id: 'sr-1', customer_id: 'c1', scheduled_service_id: 'ss-1' };

const knexWith = (first) => () => {
  const q = {};
  ['where', 'orderBy'].forEach((m) => { q[m] = () => q; });
  q.first = first;
  return q;
};
const knexFailing = () => knexWith(() => Promise.reject(new Error('db down')));
const knexEmpty = () => knexWith(() => Promise.resolve(undefined));

test('default: a failed read is "no assessment" (unchanged)', async () => {
  expect(await loadLinkedTreeShrubAssessment(SERVICE, knexFailing())).toBeNull();
});

test('strict: a failed read throws; a clean miss is still null', async () => {
  await expect(loadLinkedTreeShrubAssessment(SERVICE, knexFailing(), { strict: true })).rejects.toThrow('db down');
  expect(await loadLinkedTreeShrubAssessment(SERVICE, knexEmpty(), { strict: true })).toBeNull();
});
