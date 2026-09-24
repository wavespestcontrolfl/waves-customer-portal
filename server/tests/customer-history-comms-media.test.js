// mapCommsMessage returns raw stored media (key/contentType, no url) — it
// stays a pure sync mapper so its existing tests (customer-history-sms-
// response-flags.test.js) don't need to become async. signCommsMedia is the
// separate async pass, applied to both `comms` and `composerComms` in
// listCustomerComms, that signs that raw media the same way the general
// /admin/communications/log inbox does (services/sms-media's
// signMediaForClient) — without it, Customer 360's comms history and its
// embedded SMS composer (and the Analyze-photos flow built on top of it)
// would see stored media with no usable url.

const mockSignMediaForClient = jest.fn();
jest.mock('../services/sms-media', () => ({
  signMediaForClient: (...args) => mockSignMediaForClient(...args),
}));

const { _private: { signCommsMedia } } = require('../services/customer-history');

beforeEach(() => {
  mockSignMediaForClient.mockReset();
});

test('signs each mapped message\'s media via signMediaForClient, leaving every other field untouched', async () => {
  mockSignMediaForClient
    .mockResolvedValueOnce([{ key: 'sms-media/inbound/a', url: 'https://signed.example/a' }])
    .mockResolvedValueOnce([]);

  const mapped = [
    { id: 'm1', body: 'hi', media: [{ key: 'sms-media/inbound/a' }] },
    { id: 'm2', body: 'bye', media: [] },
  ];
  const signed = await signCommsMedia(mapped);

  expect(mockSignMediaForClient).toHaveBeenCalledTimes(2);
  expect(mockSignMediaForClient).toHaveBeenNthCalledWith(1, mapped[0].media);
  expect(mockSignMediaForClient).toHaveBeenNthCalledWith(2, mapped[1].media);
  expect(signed[0]).toMatchObject({ id: 'm1', body: 'hi', media: [{ key: 'sms-media/inbound/a', url: 'https://signed.example/a' }] });
  expect(signed[1]).toMatchObject({ id: 'm2', body: 'bye', media: [] });
});

test('an empty list resolves to an empty list without calling the signer', async () => {
  const signed = await signCommsMedia([]);
  expect(signed).toEqual([]);
  expect(mockSignMediaForClient).not.toHaveBeenCalled();
});
