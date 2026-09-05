jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({ adminAuthenticate: (_req, _res, next) => next(), requireAdmin: (_req, _res, next) => next() }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn() }));
jest.mock('../services/seo/link-prospect-verifier', () => ({ reconcileOutreach: jest.fn() }));
const { runExclusive } = require('../utils/cron-lock');
const { reconcileOutreach } = require('../services/seo/link-prospect-verifier');
const router = require('../routes/admin-backlink-agent-v2');
const handler = router.stack.find((layer) => layer.route?.path === '/prospects/:id/reconcile-backlink').route.stack.at(-1).handle;
const prospectId = '00000000-0000-4000-8000-000000000001';
const backlinkId = '00000000-0000-4000-8000-000000000002';
const call = () => new Promise((resolve, reject) => handler({ params: { id: prospectId }, body: { backlink_id: backlinkId } }, {
  code: 200, status(code) { this.code = code; return this; }, json(body) { resolve({ code: this.code, body }); },
}, reject));
beforeEach(() => jest.clearAllMocks());
test('owner assignment refuses while the scan owns the evidence lease', async () => {
  runExclusive.mockResolvedValue({ skipped: true, reason: 'lease_held' });
  expect((await call()).code).toBe(409);
  expect(reconcileOutreach).not.toHaveBeenCalled();
});
test('owner assignment holds the scan lease through evidence revalidation and mutation', async () => {
  let held = false;
  runExclusive.mockImplementation(async (key, work, options) => {
    expect(key).toBe('backlink-scan'); expect(options).toEqual({ recordHealth: false });
    held = true; try { return await work(); } finally { held = false; }
  });
  reconcileOutreach.mockImplementation(async (args) => { expect(held).toBe(true); expect(args.ownerMatch).toMatchObject({ prospectId, backlinkId }); return { matched: 1, ambiguous: 0 }; });
  expect((await call()).code).toBe(200);
  expect(held).toBe(false);
});
