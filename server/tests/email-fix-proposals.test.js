// Sunday email fix proposals (proposeEmailFixes): the same proposer as calls,
// on area 'email' with the unversioned cohort.
jest.mock('../services/ai-incidents/fix-proposals', () => ({ proposeFromIncidents: jest.fn(async () => ({ proposed: 0 })) }));

const { proposeFromIncidents } = require('../services/ai-incidents/fix-proposals');
const { proposeEmailFixes } = require('../services/email/email-reclassify-incident');

afterEach(() => {
  delete process.env.EMAIL_FIX_PROPOSAL_MIN;
  proposeFromIncidents.mockClear();
});

test('proposes from area email, unversioned, with the calls defaults', async () => {
  const dbi = {};
  const now = new Date('2026-11-08T09:55:00Z');
  await proposeEmailFixes({ dbi, now });
  expect(proposeFromIncidents).toHaveBeenCalledWith({ dbi, area: 'email', promptVersion: null, minEvidence: 5, maxCells: 3, now });
});

test('the evidence minimum follows EMAIL_FIX_PROPOSAL_MIN', async () => {
  process.env.EMAIL_FIX_PROPOSAL_MIN = '3';
  await proposeEmailFixes({ dbi: {} });
  expect(proposeFromIncidents.mock.calls[0][0].minEvidence).toBe(3);
});
