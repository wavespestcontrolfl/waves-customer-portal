/**
 * The automation preview serves stored step HTML from the portal origin, so
 * every response carries `Content-Security-Policy: sandbox` with no allow-*
 * token: no script, no same-origin access. Plain email HTML still renders.
 * Handler is driven directly (no supertest in this repo).
 */
const mockDb = jest.fn();
jest.mock('../models/db', () => mockDb);

const preview = require('../routes/public-automation-preview');

const layer = preview.stack.find((l) => l.route && l.route.path === '/:stepId/:token' && l.route.methods.get);
const handler = layer.route.stack[0].handle;

function installRows({ step, template }) {
  mockDb.mockImplementation((table) => {
    const chain = {
      where: jest.fn(() => chain),
      first: jest.fn(async () => (table === 'automation_steps' ? step : template)),
    };
    return chain;
  });
}

async function drive() {
  const headers = {};
  const res = {
    statusCode: 200,
    body: undefined,
    set(name, value) { headers[String(name).toLowerCase()] = value; return res; },
    status(code) { res.statusCode = code; return res; },
    type() { return res; },
    send(body) { res.body = body; return res; },
  };
  await handler({ params: { stepId: 'step-1', token: 'tok' } }, res);
  return { res, headers };
}

describe('public automation preview — sandbox CSP', () => {
  const STORED = '<h1>Hi {{first_name}}</h1><script>fetch("/api/x")</script><img src="x" onerror="alert(1)"><p style="color:#111">Plain <a href="https://example.com">link</a></p>';

  test('a found step sends CSP sandbox with no allow-scripts or allow-same-origin', async () => {
    installRows({
      step: { id: 'step-1', template_key: 't', subject: 'Hello', html_body: STORED, step_order: 0, delay_hours: 0 },
      template: { name: 'Welcome' },
    });
    const { res, headers } = await drive();
    expect(res.statusCode).toBe(200);
    expect(headers['content-security-policy']).toBe('sandbox');
    expect(headers['content-security-policy']).not.toMatch(/allow-/);
    // Plain email HTML is passed through unchanged apart from the sample fill.
    expect(res.body).toContain('<h1>Hi Friend</h1>');
    expect(res.body).toContain('<p style="color:#111">Plain <a href="https://example.com">link</a></p>');
  });

  test('the not-found and error responses are sandboxed too', async () => {
    installRows({ step: undefined, template: undefined });
    const missing = await drive();
    expect(missing.res.statusCode).toBe(404);
    expect(missing.headers['content-security-policy']).toBe('sandbox');

    mockDb.mockImplementation(() => { throw new Error('db down'); });
    const failed = await drive();
    expect(failed.res.statusCode).toBe(500);
    expect(failed.headers['content-security-policy']).toBe('sandbox');
  });
});
