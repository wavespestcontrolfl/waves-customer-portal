process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockQuery = jest.fn();
const mockLookup = jest.fn();

jest.mock('../services/knowledge/wiki-qa', () => ({
  query: (...args) => mockQuery(...args),
  lookup: (...args) => mockLookup(...args),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Admin authentication required' });
    req.techRole = token;
    return next();
  },
  requireTechOrAdmin: (req, res, next) => (
    ['admin', 'technician'].includes(req.techRole)
      ? next()
      : res.status(403).json({ error: 'Staff access required' })
  ),
}));

const express = require('express');
const techKnowledgeRouter = require('../routes/tech-knowledge');

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/tech/knowledge', techKnowledgeRouter);
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('tech knowledge Staff authentication', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ answer: 'Use the label rate.', articleTitles: ['Label'] });
    mockLookup.mockResolvedValue('Reference content');
  });

  test.each([
    ['POST', '/query', { question: 'What rate?' }],
    ['GET', '/lookup?topic=rate', undefined],
  ])('%s %s rejects unauthenticated callers before querying the knowledge base', async (method, path, body) => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/tech/knowledge${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });

      expect(response.status).toBe(401);
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockLookup).not.toHaveBeenCalled();
    });
  });

  test('rejects an authenticated non-Staff role', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/tech/knowledge/lookup?topic=rate`, {
        headers: { Authorization: 'Bearer customer' },
      });

      expect(response.status).toBe(403);
      expect(mockLookup).not.toHaveBeenCalled();
    });
  });

  test.each(['admin', 'technician'])('allows the %s Staff role', async (role) => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/tech/knowledge/query`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${role}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ question: 'What rate?' }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        answer: 'Use the label rate.',
        sources: ['Label'],
      });
      expect(mockQuery).toHaveBeenCalledWith('What rate?', { source: 'tech_field' });
    });
  });
});
