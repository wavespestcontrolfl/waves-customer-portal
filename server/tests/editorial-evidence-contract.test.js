'use strict';

const { generateKeyPairSync } = require('node:crypto');
const contract = require('../../packages/editorial-evidence/index.cjs');

const reviewedAt = '2026-09-23T12:00:00.000Z';

function manifestInput(privateKey) {
  return {
    document: '# Evidence',
    path: 'src/content/blog/evidence.mdx',
    domain: 'example.test',
    checks: contract.REQUIRED_CHECKS.map((name) => ({ name, status: 'pass', findings: [] })),
    sources: [{
      url: 'https://example.gov/evidence',
      publisher: 'Example Agency',
      retrievedAt: reviewedAt,
      excerpt: 'Authoritative evidence.',
    }],
    reviewedAt,
    model: 'test-model',
    privateKey,
  };
}

function expectVerified(privateKey, publicKey) {
  const input = manifestInput(privateKey);
  const manifest = contract.createManifest(input);
  expect(contract.verifyManifest({
    ...input,
    manifest,
    publicKey,
    now: new Date('2026-09-24T12:00:00.000Z'),
  })).toEqual({ pass: true, findings: [] });
}

describe('editorial evidence signing keys', () => {
  test('accepts Ed25519 KeyObjects', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    expectVerified(privateKey, publicKey);
  });

  test('accepts Ed25519 JWK values', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    expectVerified(
      privateKey.export({ format: 'jwk' }),
      publicKey.export({ format: 'jwk' }),
    );
  });

  test('rejects calendar-invalid timestamps', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    expect(() => contract.createManifest({
      ...manifestInput(privateKey),
      reviewedAt: '2026-02-31T12:00:00.000Z',
    })).toThrow('valid calendar date');
  });

  test('rejects source snapshots captured after the review', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const input = manifestInput(privateKey);
    input.sources[0].retrievedAt = '2026-09-23T13:00:00.000Z';
    const manifest = contract.createManifest(input);
    expect(contract.verifyManifest({ ...input, manifest, publicKey, now: new Date('2026-09-24T12:00:00.000Z') }))
      .toEqual(expect.objectContaining({ pass: false, findings: expect.arrayContaining([expect.objectContaining({ code: 'source_after_review' })]) }));
  });

  test('rejects non-Ed25519 signing keys', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 512 });
    expect(() => contract.createManifest(manifestInput(privateKey))).toThrow('privateKey must be an Ed25519 key');
  });
});
