/**
 * The optional drawn signature on POST /api/contracts/:token/sign and the shared validator behind it
 * (services/signature-image.js, also the WDO licensee pad's). Invariants: a typed signature alone still signs
 * exactly as before (no image stored, no new key in the public payload); a drawn PNG with ink is stored on the row
 * and noted in the signed event; a blank, oversized, mistyped or non-image body is refused BEFORE any lock or write
 * with the WDO route's wording; the public payload never carries the image. Synthetic data only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const mockState = { row: null, peekRow: undefined, updates: [], events: [], locks: 0 };
jest.mock('../models/db', () => {
  const make = (table) => {
    const q = {};
    const chain = {
      leftJoin: () => chain, select: () => chain, whereIn: () => chain, whereNull: () => chain, orWhere: () => chain,
      where(obj, ...rest) { if (typeof obj === 'object') Object.assign(q, obj); else if (typeof obj === 'function') obj(chain); else q[obj] = rest[rest.length - 1]; return chain; },
      forUpdate: () => { mockState.locks += 1; return chain; },
      async first(...columns) {
        if (table === 'customers') return { id: 'cust-1', active: true, deleted_at: null };
        if (String(table).startsWith('customer_contracts')) {
          // A lookup by link hash finds the row only for its own link (an unknown token finds nothing).
          if (q.share_token_hash !== undefined && q.share_token_hash !== mockState.row?.share_token_hash) return null;
          // The route's unlocked liveness peek (it reads the expiry) can be made to see another row than the locked path.
          if (columns.includes('share_token_expires_at') && mockState.peekRow !== undefined) return mockState.peekRow;
          return mockState.row;
        }
        return null;
      },
      async update(payload) { mockState.updates.push({ table, payload }); Object.assign(mockState.row, payload); return 1; },
      async insert(payload) { mockState.events.push({ table, payload }); return [1]; },
    };
    return chain;
  };
  const fn = jest.fn((table) => make(table));
  fn.raw = jest.fn((s) => s);
  fn.transaction = async (cb) => cb(fn);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn() }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendAutopayEnabled: jest.fn() }));
jest.mock('../services/contract-signed-email', () => ({ sendSignedContractCopy: jest.fn(async () => undefined) }));
jest.mock('../services/termite-annual-activation', () => ({ ANNUAL_TEMPLATE_KEY: 'service_agreement.termite_annual_protection' }));
// Every limiter becomes a pass-through (this suite signs the same link more often than the real budget allows) and its
// options are kept so the drawing budget can be asserted directly.
const mockLimiterOptions = [];
jest.mock('express-rate-limit', () => (options) => {
  mockLimiterOptions.push(options);
  return (_req, _res, next) => next();
});

const express = require('express');
const sharp = require('sharp');
const { hashContractToken } = require('../services/contracts');
const { parseSignatureImage, signatureImageBuffer, MAX_CONCURRENT_DECODES, MAX_WAITING_DECODES } = require('../services/signature-image');
const contractsPublic = require('../routes/contracts-public');

const TOKEN = 'b'.repeat(48);
const freshRow = () => ({
  id: 'contract-1', customer_id: 'cust-1', contract_type: 'document_template', status: 'viewed', title: 'Lawn & Ornamental Service Agreement',
  recipient_name: 'Pat Owner', document_template_key: 'service_agreement.lawn_ornamental', contract_text_snapshot: 'agreement text',
  document_template_requires_signature: true, requires_signature_snapshot: true, share_token_hash: hashContractToken(TOKEN),
  share_token_expires_at: new Date(Date.now() + 86400000), document_variables_snapshot: { estimate: { id: 'est-1', source: 'estimate_service_agreement' } },
});

const png = async ({ ink = true, width = 240, height = 64 } = {}) => {
  let image = sharp({ create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } });
  if (ink) image = image.composite([{ input: { create: { width: Math.floor(width / 2), height: 6, channels: 4, background: { r: 27, g: 44, b: 91, alpha: 1 } } }, left: 20, top: 30 }]);
  return `data:image/png;base64,${(await image.png().toBuffer()).toString('base64')}`;
};

// Incompressible pixels: a 600×300 RGBA PNG of random bytes lands near 700KB.
const noisePng = async () => {
  const raw = require('crypto').randomBytes(600 * 300 * 4);
  const buf = await sharp(raw, { raw: { width: 600, height: 300, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer();
  return `data:image/png;base64,${buf.toString('base64')}`;
};

async function sign(body, token = TOKEN) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/contracts', contractsPublic);
  // Surface the route's own error (never HTML) so a failing case names it.
  app.use((err, _req, res, _next) => { res.status(err.status || err.statusCode || 500).json({ error: err.message, where: String(err.stack || '').split('\n').slice(1, 3).join(' ') }); });
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/contracts/${token}/sign`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 400) }; }
    return { status: res.status, body: parsed };
  } finally {
    server.close();
  }
}
const typed = { signedName: 'Pat Owner', initials: 'PO', agreeElectronic: true, agreeDocumentTerms: true };

beforeEach(() => {
  mockState.row = freshRow();
  mockState.peekRow = undefined;
  mockState.updates.length = 0;
  mockState.events.length = 0;
  mockState.locks = 0;
});

describe('parseSignatureImage (shared with the WDO licensee pad)', () => {
  test('a PNG with ink is accepted with its bytes and type', async () => {
    const dataUrl = await png();
    const parsed = await parseSignatureImage(dataUrl);
    expect(parsed).toMatchObject({ ok: true, image: dataUrl, contentType: 'image/png' });
    expect(parsed.buffer.equals(signatureImageBuffer(dataUrl))).toBe(true);
  });

  test.each([
    ['not a data URL', 'hello', { status: 400, error: 'signature must be a PNG or JPEG data URL' }],
    ['a GIF data URL', 'data:image/gif;base64,R0lGODlh', { status: 400, error: 'signature must be a PNG or JPEG data URL' }],
    ['PNG-labelled bytes that are not a PNG', `data:image/png;base64,${Buffer.from('plain text').toString('base64')}`, { status: 400, error: 'signature image is not a valid PNG or JPEG' }],
  ])('%s is refused', async (_label, value, expected) => {
    expect(await parseSignatureImage(value)).toMatchObject({ ok: false, ...expected });
  });

  test('a blank pad is refused as signature_blank', async () => {
    expect(await parseSignatureImage(await png({ ink: false }))).toMatchObject({ ok: false, status: 400, code: 'signature_blank' });
  });

  test('the size cap is the caller\'s', async () => {
    const dataUrl = await png();
    expect(await parseSignatureImage(dataUrl, { maxBytes: 16, maxLabel: '16 bytes' })).toMatchObject({ ok: false, status: 413, error: 'Signature image too large (max 16 bytes)' });
  });

  test.each([
    ['wider than 8192px', { width: 9000, height: 40 }],
    ['taller than 8192px', { width: 40, height: 9000 }],
    ['over 8 megapixels', { width: 2900, height: 2900 }],
  ])('a pad image %s is refused from its header, under the byte cap (a small PNG can declare a huge bitmap)', async (_label, dims) => {
    const dataUrl = await png(dims);
    expect(Math.floor((dataUrl.length * 3) / 4)).toBeLessThan(512 * 1024);
    expect(await parseSignatureImage(dataUrl, { maxBytes: 512 * 1024, maxLabel: '512KB' })).toMatchObject({
      ok: false, status: 413, error: 'Signature image is too large. Please clear the pad and sign again.',
    });
  });

  test('a real pad export (the customer pad\'s 1200px cap, the WDO pad on a wide screen) is inside the bounds', async () => {
    expect(await parseSignatureImage(await png({ width: 1200, height: 450 }))).toMatchObject({ ok: true });
    expect(await parseSignatureImage(await png({ width: 7680, height: 320 }))).toMatchObject({ ok: true });
  });

  test('the caller\'s pixel bounds apply (the signing page passes its pad\'s real output, tighter than the WDO defaults)', async () => {
    const limits = { maxWidth: 1600, maxHeight: 1000, maxPixels: 1200 * 1000 };
    expect(await parseSignatureImage(await png({ width: 1200, height: 450 }), limits)).toMatchObject({ ok: true });
    expect(await parseSignatureImage(await png({ width: 1700, height: 100 }), limits)).toMatchObject({ ok: false, status: 413 });
    expect(await parseSignatureImage(await png({ width: 1300, height: 1000 }), limits)).toMatchObject({ ok: false, status: 413 });
  });

  test('decodes share a small process-wide budget: past the queue a check is refused (503, try again), and the slots free afterwards', async () => {
    const dataUrl = await png();
    const burst = MAX_CONCURRENT_DECODES + MAX_WAITING_DECODES + 3;
    const results = await Promise.all(Array.from({ length: burst }, () => parseSignatureImage(dataUrl)));
    expect(results.filter((r) => r.ok)).toHaveLength(MAX_CONCURRENT_DECODES + MAX_WAITING_DECODES);
    expect(results.filter((r) => !r.ok)).toEqual(Array(3).fill(expect.objectContaining({ status: 503, code: 'signature_busy' })));
    // Every slot was released: a later check runs at once.
    expect(await parseSignatureImage(dataUrl)).toMatchObject({ ok: true });
  });

  test('signatureImageBuffer reads only a data URL', () => {
    expect(signatureImageBuffer('nope')).toBeNull();
    expect(signatureImageBuffer(null)).toBeNull();
  });
});

describe('POST /api/contracts/:token/sign with a drawn signature', () => {
  test('typed only: signs as before, stores no image, and the payload carries no image key', async () => {
    const res = await sign(typed);
    expect(res.status).toBe(200);
    expect(res.body.signed).toBe(true);
    const update = mockState.updates.find((u) => u.table === 'customer_contracts');
    expect(update.payload).toMatchObject({ status: 'signed', signed_name: 'Pat Owner', recipient_initials: 'PO' });
    expect(update.payload).not.toHaveProperty('signature_image');
    const signedEvent = mockState.events.find((e) => e.table === 'customer_contract_events');
    expect(JSON.parse(signedEvent.payload.metadata)).toMatchObject({ drawnSignature: false });
    expect(JSON.stringify(res.body)).not.toMatch(/signature_image|signatureImage|hasDrawnSignature/);
  });

  test('a drawn PNG with ink is stored on the row and noted in the signed event; the payload still carries no image', async () => {
    const dataUrl = await png();
    const res = await sign({ ...typed, signatureImage: dataUrl });
    expect(res.status).toBe(200);
    const update = mockState.updates.find((u) => u.table === 'customer_contracts');
    expect(update.payload).toMatchObject({ status: 'signed', signature_image: dataUrl });
    const signedEvent = mockState.events.find((e) => e.table === 'customer_contract_events');
    expect(JSON.parse(signedEvent.payload.metadata)).toMatchObject({ drawnSignature: true });
    expect(JSON.stringify(res.body)).not.toContain('base64');
    expect(res.body.contract).not.toHaveProperty('hasDrawnSignature');
  });

  test('an empty signatureImage is the same as none', async () => {
    const res = await sign({ ...typed, signatureImage: '   ' });
    expect(res.status).toBe(200);
    expect(mockState.updates.find((u) => u.table === 'customer_contracts').payload).not.toHaveProperty('signature_image');
  });

  test.each([
    ['a blank pad', () => png({ ink: false }), { status: 400, body: { code: 'signature_blank' } }],
    ['a non-image', async () => 'data:text/plain;base64,aGk=', { status: 400, body: { error: 'signature must be a PNG or JPEG data URL' } }],
    ['bytes that are not a PNG', async () => `data:image/png;base64,${Buffer.from('plain text').toString('base64')}`, { status: 400, body: { error: 'signature image is not a valid PNG or JPEG' } }],
    ['an oversized image (noise: ~700KB, under the 1MB body limit, over the 512KB cap)', () => noisePng(), { status: 413, body: { error: 'Signature image too large (max 512KB)' } }],
  ])('%s is refused before any lock or write', async (_label, make, expected) => {
    const res = await sign({ ...typed, signatureImage: await make() });
    expect(res).toMatchObject(expected);
    expect(mockState.locks).toBe(0);
    expect(mockState.updates).toEqual([]);
    expect(mockState.events).toEqual([]);
    expect(mockState.row.status).toBe('viewed');
  });

  test('an unknown link with a drawn signature is the plain 404, before any image work, lock or write', async () => {
    const res = await sign({ ...typed, signatureImage: await png({ ink: false }) }, 'c'.repeat(48));
    // A blank pad would be a 400 if it were decoded: the 404 shows the image was never looked at.
    expect(res).toMatchObject({ status: 404, body: { error: 'Contract not found' } });
    expect(mockState.locks).toBe(0);
    expect(mockState.updates).toEqual([]);
    expect(mockState.events).toEqual([]);
  });

  // A blank pad answers 400 signature_blank when it IS decoded, so a different answer proves the decode never ran.
  test.each([
    ['an expired link', () => { mockState.row.share_token_expires_at = new Date(Date.now() - 60000); }, typed, { status: 410, body: { error: 'Contract link expired' } }],
    ['a signed link', () => { mockState.row.status = 'signed'; }, typed, { status: 410, body: { alreadySigned: true } }],
    ['a cancelled link', () => { mockState.row.status = 'cancelled'; }, typed, { status: 410, body: { error: 'Contract is no longer available' } }],
    ['a request without the document consent', () => {}, { ...typed, agreeDocumentTerms: false }, { status: 400, body: { error: 'Document agreement is required.' } }],
  ])('%s with a drawing gets the locked path\'s own refusal, and the drawing is never decoded', async (_label, arrange, body, expected) => {
    arrange();
    const res = await sign({ ...body, signatureImage: await png({ ink: false }) });
    expect(res).toMatchObject(expected);
    expect(mockState.updates).toEqual([]);
  });

  test('a link that was not signable when the request arrived but is signable under lock is refused, never signed without the drawing', async () => {
    mockState.peekRow = { ...mockState.row, share_token_expires_at: new Date(Date.now() - 60000) };
    const res = await sign({ ...typed, signatureImage: await png() });
    expect(res).toMatchObject({ status: 409, body: { error: 'This contract was just updated — please reload the page and sign again.' } });
    expect(mockState.updates).toEqual([]);
    expect(mockState.row.status).toBe('viewed');
  });

  test('the drawing pixel bounds are the signing pad\'s, tighter than the WDO pad\'s', async () => {
    const res = await sign({ ...typed, signatureImage: await png({ width: 2400, height: 300 }) });
    expect(res).toMatchObject({ status: 413, body: { error: 'Signature image is too large. Please clear the pad and sign again.' } });
    expect(mockState.updates).toEqual([]);
  });

  test('each signing link has its own drawing budget, counted only for a drawing on a well-formed link', () => {
    const budget = mockLimiterOptions.find((o) => typeof o.keyGenerator === 'function' && o.max === 10);
    expect(budget).toMatchObject({ windowMs: 15 * 60 * 1000, max: 10 });
    const drawn = { params: { token: TOKEN }, body: { signatureImage: 'data:image/png;base64,AAAA' } };
    expect(budget.keyGenerator(drawn)).toBe(`contract-sign-drawn:${hashContractToken(TOKEN)}`);
    expect(budget.keyGenerator({ ...drawn, params: { token: 'c'.repeat(48) } })).not.toBe(budget.keyGenerator(drawn));
    expect(budget.skip(drawn)).toBe(false);
    expect(budget.skip({ params: { token: TOKEN }, body: { signedName: 'Pat Owner' } })).toBe(true);
    expect(budget.skip({ params: { token: TOKEN }, body: { signatureImage: '  ' } })).toBe(true);
    expect(budget.skip({ params: { token: 'short' }, body: drawn.body })).toBe(true);
  });

  test('the typed signature stays required even with a drawn one', async () => {
    const res = await sign({ ...typed, signedName: '', signatureImage: await png() });
    expect(res).toMatchObject({ status: 400, body: { error: 'Typed signature is required.' } });
    expect(mockState.updates).toEqual([]);
  });
});
