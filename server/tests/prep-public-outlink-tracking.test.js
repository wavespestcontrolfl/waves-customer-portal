/**
 * /api/public/prep/:token — GATE_OUTLINK_TRACKING wiring on the page payload.
 * Page blocks get /go links while the gate is on; the PDF twin's blocks are
 * the interpolated originals (direct links). Nothing is sent to a customer.
 */
const mockLinks = [];
jest.mock('../models/db', () => {
  const PROJECT = {
    id: 'p1', customer_id: '11111111-1111-4111-8111-111111111111', prep_template_key: 'prep.flea',
    project_type: 'other', project_date: '2026-08-01', prep_expires_at: null,
  };
  const fn = jest.fn((table) => {
    const q = {
      where: () => q,
      whereIn: () => q,
      first: async () => {
        if (table === 'projects') return PROJECT;
        if (table === 'customers') return { id: PROJECT.customer_id, first_name: 'Sam', last_name: 'Example' };
        return null;
      },
      select: async () => (table === 'outbound_links' ? mockLinks : []),
      update: async () => 1,
      insert: (rows) => {
        const list = Array.isArray(rows) ? rows : [rows];
        const run = () => { if (table === 'outbound_links') list.forEach((r) => { if (!mockLinks.some((x) => x.code === r.code)) mockLinks.push(r); }); };
        return {
          onConflict: () => ({ ignore: async () => run() }),
          then: (ok, err) => Promise.resolve().then(run).then(ok, err),
          catch: () => Promise.resolve(),
        };
      },
    };
    return q;
  });
  fn.raw = jest.fn((s) => s);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/project-email', () => ({ prepTemplateForProjectType: () => 'prep.flea' }));
jest.mock('../services/project-types', () => ({ getProjectType: () => ({ label: 'Flea Control' }) }));
jest.mock('../services/customer-contact', () => ({ getServiceContactSlots: () => [] }));

const AMAZON = 'https://www.amazon.com/dp/B004G6YL5E';
const OWN = 'https://www.wavespestcontrol.com/pest-control/fleas/';
jest.mock('../services/email-template-library', () => ({
  loadTemplateByKey: async () => ({
    activeVersion: {
      blocks: [
        { type: 'paragraph', content: 'Buy [Amazon](https://www.amazon.com/dp/B004G6YL5E), read [more](https://www.wavespestcontrol.com/pest-control/fleas/), call [us](tel:+19415550100).' },
      ],
    },
  }),
}));

const express = require('express');

const TOKEN = 'cd'.repeat(16);
let server;
let base;

beforeAll((done) => {
  process.env.JWT_SECRET = 'test-secret';
  process.env.PUBLIC_PORTAL_URL = 'https://portal.wavespestcontrol.com';
  const app = express();
  app.use('/api/public/prep', require('../routes/prep-public'));
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });
beforeEach(() => { mockLinks.length = 0; delete process.env.GATE_OUTLINK_TRACKING; });

describe('prep page payload', () => {
  test('gate off: blocks carry the original links', async () => {
    const body = await (await fetch(`${base}/api/public/prep/${TOKEN}`)).json();
    expect(body.blocks[0].content).toContain(AMAZON);
    expect(body.blocks[0].content).not.toContain('/go/');
    expect(mockLinks).toHaveLength(0);
  });

  test('gate on: outside link → /go/<code>; own-site and tel untouched; destination registered unchanged', async () => {
    process.env.GATE_OUTLINK_TRACKING = 'true';
    const body = await (await fetch(`${base}/api/public/prep/${TOKEN}`)).json();
    const content = body.blocks[0].content;
    expect(content).toMatch(/\[Amazon\]\(https:\/\/portal\.wavespestcontrol\.com\/go\/[a-f0-9]{20}\?/);
    expect(content).not.toContain('amazon.com');
    expect(content).toContain(`(${OWN})`);
    expect(content).toContain('(tel:+19415550100)');
    expect(mockLinks.map((r) => r.target_url)).toEqual([AMAZON]);
    expect(content).toContain(`t=${TOKEN}`);
    expect(content).toContain('s=page');
  });
});
