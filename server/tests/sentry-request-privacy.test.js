const mockInit = jest.fn();
const mockRequestDataIntegration = jest.fn(({ include }) => ({
  name: 'RequestData',
  include,
}));

jest.mock('@sentry/node', () => ({
  init: mockInit,
  requestDataIntegration: mockRequestDataIntegration,
}));

const {
  DISABLED_AI_INTEGRATIONS,
  REQUEST_DATA_INCLUDE,
  buildSentryOptions,
  stripSentryRequestData,
} = require('../instrument');

describe('Sentry request privacy', () => {
  test('disables default PII and replaces RequestData with method-only capture', () => {
    const options = buildSentryOptions();
    expect(options.sendDefaultPii).toBe(false);
    expect(options.tracesSampleRate).toBe(0);
    expect(options.profilesSampleRate).toBe(0);

    const integrations = options.integrations([
      { name: 'Http' },
      { name: 'RequestData', old: true },
      { name: 'OpenAI' },
      { name: 'Anthropic_AI' },
      { name: 'Google_GenAI' },
    ]);
    expect(integrations).toEqual([
      { name: 'Http' },
      { name: 'RequestData', include: REQUEST_DATA_INCLUDE },
    ]);
    expect(REQUEST_DATA_INCLUDE).toEqual({
      cookies: false,
      data: false,
      headers: false,
      ip: false,
      query_string: false,
      url: false,
    });
    expect([...DISABLED_AI_INTEGRATIONS]).toEqual(['OpenAI', 'Anthropic_AI', 'Google_GenAI']);
  });

  test('removes credentials from synthetic error and transaction events', () => {
    const secret = 'staff-reset-token-secret';
    const event = {
      request: {
        method: 'POST',
        url: `https://portal.test/admin/reset?token=${secret}`,
        query_string: `token=${secret}`,
        headers: { authorization: `Bearer ${secret}`, cookie: `session=${secret}` },
        cookies: { session: secret },
        data: { currentPassword: secret, newPassword: secret, token: secret },
      },
      breadcrumbs: [
        { category: 'http', data: { url: `https://portal.test/?token=${secret}` } },
        { category: 'app', message: 'credential rotation started' },
      ],
      transaction: `/api/report/${secret}`,
      spans: [{ description: `GET /api/report/${secret}`, data: { 'url.full': secret } }],
    };

    const sanitizedError = stripSentryRequestData(structuredClone(event));
    expect(sanitizedError.request).toEqual({ method: 'POST' });
    expect(sanitizedError.breadcrumbs).toEqual([
      { category: 'app', message: 'credential rotation started' },
    ]);
    expect(JSON.stringify(sanitizedError.request)).not.toContain(secret);

    const sanitizedTransaction = buildSentryOptions()
      .beforeSendTransaction(structuredClone(event));
    expect(sanitizedTransaction.request).toEqual({ method: 'POST' });
    expect(sanitizedTransaction.transaction).toBe('http.request');
    expect(sanitizedTransaction.spans).toEqual([]);
    expect(JSON.stringify(sanitizedTransaction)).not.toContain(secret);
  });

  test('scrubs PII out of exception values (Knex/provider error messages)', () => {
    // Defense-in-depth backstop: PII-risky call sites scrub before capture,
    // but any OTHER captureException in the app flows through beforeSend —
    // exception values must never carry emails/phones/SQL literals outward.
    const event = {
      exception: {
        values: [
          {
            type: 'Error',
            value: "insert into \"customers\" (\"name\") values ('Jane Q Fixture') - duplicate key; contact jane.fixture@example.com or +1 (941) 555-0100",
          },
          { type: 'Error', value: 42 }, // non-string value left untouched
        ],
      },
    };
    const sanitized = stripSentryRequestData(event);
    const text = sanitized.exception.values[0].value;
    expect(text).not.toContain('Jane Q Fixture');
    expect(text).not.toContain('jane.fixture@example.com');
    expect(text).not.toContain('555-0100');
    expect(text).toContain('[redacted');
    expect(sanitized.exception.values[1].value).toBe(42);
  });

  test('initializes Sentry with the hardened options', () => {
    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockInit.mock.calls[0][0]).toMatchObject({
      sendDefaultPii: false,
      tracesSampleRate: 0,
      profilesSampleRate: 0,
    });
  });
});
