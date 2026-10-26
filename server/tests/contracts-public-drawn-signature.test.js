/**
 * The optional drawn signature on POST /api/contracts/:token/sign and the shared validator behind it
 * (services/signature-image.js, also the WDO licensee pad's). Invariants: a typed signature alone still signs
 * exactly as before (no image stored, no new key in the public payload); a drawn PNG with ink is stored on the row
 * and noted in the signed event; a blank, oversized, mistyped or non-image body is refused BEFORE any lock or write
 * with the WDO route's wording; the public payload never carries the image. Synthetic data only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const state = { row: null, updates: [], events: [], locks: 0 };
jest.mock('../models/db', () => {
  const make = (table) => {
    const q = {};
    const chain = {
      leftJoin: () => chain, select: () => chain, whereIn: () => chain, whereNull: () => chain, orWhere: () => chain,
      where(obj, ...rest) { if (typeof obj === 'object') Object.assign(q, obj); else if (typeof obj === 'function') obj(chain); else q[obj] = rest[rest.length - 1]; return chain; },
      forUpdate: () => { state.locks += 1; return chain; },
      async first() {
        if (table === 'customers') return { id: 'cust-1', active: true, deleted_at: null };
        if (String(table).startsWith('customer_contracts')) return state.row;
        return null;
      },
      async update(payload) { state.updates.push({ table, payload }); Object.assign(state.row, payload); return 1; },
      async insert(payload) { state.events.push({ table, payload }); return [1]; },
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

const express = require('express');
const sharp = require('sharp');
const { hashContractToken } = require('../services/contracts');
const { parseSignatureImage, signatureImageBuffer } = require('../services/signature-image');
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

async function sign(body) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/contracts', contractsPublic);
  // Surface the route's own error (never HTML) so a failing case names it.
  app.use((err, _req, res, _next) => { res.status(err.status || err.statusCode || 500).json({ error: err.message, where: String(err.stack || '').split('\n').slice(1, 3).join(' ') }); });
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/contracts/${TOKEN}/sign`, {
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
  state.row = freshRow();
  state.updates.length = 0;
  state.events.length = 0;
  state.locks = 0;
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
    const update = state.updates.find((u) => u.table === 'customer_contracts');
    expect(update.payload).toMatchObject({ status: 'signed', signed_name: 'Pat Owner', recipient_initials: 'PO' });
    expect(update.payload).not.toHaveProperty('signature_image');
    const signedEvent = state.events.find((e) => e.table === 'customer_contract_events');
    expect(JSON.parse(signedEvent.payload.metadata)).toMatchObject({ drawnSignature: false });
    expect(JSON.stringify(res.body)).not.toMatch(/signature_image|signatureImage|hasDrawnSignature/);
  });

  test('a drawn PNG with ink is stored on the row and noted in the signed event; the payload still carries no image', async () => {
    const dataUrl = await png();
    const res = await sign({ ...typed, signatureImage: dataUrl });
    expect(res.status).toBe(200);
    const update = state.updates.find((u) => u.table === 'customer_contracts');
    expect(update.payload).toMatchObject({ status: 'signed', signature_image: dataUrl });
    const signedEvent = state.events.find((e) => e.table === 'customer_contract_events');
    expect(JSON.parse(signedEvent.payload.metadata)).toMatchObject({ drawnSignature: true });
    expect(JSON.stringify(res.body)).not.toContain('base64');
    expect(res.body.contract).not.toHaveProperty('hasDrawnSignature');
  });

  test('an empty signatureImage is the same as none', async () => {
    const res = await sign({ ...typed, signatureImage: '   ' });
    expect(res.status).toBe(200);
    expect(state.updates.find((u) => u.table === 'customer_contracts').payload).not.toHaveProperty('signature_image');
  });

  test.each([
    ['a blank pad', () => png({ ink: false }), { status: 400, body: { code: 'signature_blank' } }],
    ['a non-image', async () => 'data:text/plain;base64,aGk=', { status: 400, body: { error: 'signature must be a PNG or JPEG data URL' } }],
    ['bytes that are not a PNG', async () => `data:image/png;base64,${Buffer.from('plain text').toString('base64')}`, { status: 400, body: { error: 'signature image is not a valid PNG or JPEG' } }],
    ['an oversized image (noise: ~700KB, under the 1MB body limit, over the 512KB cap)', () => noisePng(), { status: 413, body: { error: 'Signature image too large (max 512KB)' } }],
  ])('%s is refused before any lock or write', async (_label, make, expected) => {
    const res = await sign({ ...typed, signatureImage: await make() });
    expect(res).toMatchObject(expected);
    expect(state.locks).toBe(0);
    expect(state.updates).toEqual([]);
    expect(state.events).toEqual([]);
    expect(state.row.status).toBe('viewed');
  });

  test('the typed signature stays required even with a drawn one', async () => {
    const res = await sign({ ...typed, signedName: '', signatureImage: await png() });
    expect(res).toMatchObject({ status: 400, body: { error: 'Typed signature is required.' } });
    expect(state.updates).toEqual([]);
  });
});
