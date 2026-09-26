const fs = require('node:fs');

const { runVisitCompletionPacketMemberEffects, _test: { packetSnapshot } } = require('../services/visit-completion-packets');
const {
  treeShrubPhotosHash,
  treeShrubReviewSignature,
} = require('../services/tree-shrub-assessment');

const SERVICE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SERVICE_ID = '22222222-2222-4222-8222-222222222222';

function signedReview({
  serviceId = SERVICE_ID,
  photoData = ['data:image/jpeg;base64,YQ==', 'data:image/jpeg;base64,Yg=='],
  decisions = [
    { key: 'pest_activity', action: 'hidden' },
    { key: 'foliage_fullness', action: 'confirmed' },
  ],
} = {}) {
  const scores = {
    foliageFullness: 82,
    leafColorVigor: 74,
    pestActivity: 48,
    diseaseLeafSpot: 91,
    waterHeatStress: 78,
    overallScore: 75,
  };
  const photosHash = treeShrubPhotosHash(photoData);
  const observations = 'Reviewed photo signals at closeout.';
  return {
    scores,
    scoredCount: photoData.length,
    photoCount: photoData.length,
    photosHash,
    signature: treeShrubReviewSignature(
      scores,
      photoData.length,
      serviceId,
      photosHash,
      observations,
    ),
    observations,
    decisions,
    confirmed: true,
  };
}

function packetRequest({
  serviceId = SERVICE_ID,
  photoData = ['data:image/jpeg;base64,YQ==', 'data:image/jpeg;base64,Yg=='],
  review = signedReview({ serviceId, photoData }),
  verifiedTreeShrubPhotosHash = 'f'.repeat(64),
} = {}) {
  return {
    items: [{
      serviceId,
      verifiedTreeShrubPhotosHash,
      body: {
        completionPhotos: photoData.map((data, index) => ({
          data,
          caption: `Tree and shrub photo ${index + 1}`,
          zone: index ? 'Back' : 'Front',
          sortOrder: index,
        })),
        gaugePhoto: { data: 'data:image/jpeg;base64,Z2F1Z2U=', caption: 'Gauge' },
        treeShrubReview: review,
      },
    }],
  };
}

describe('tree/shrub review packet snapshot trust boundary', () => {
  test('derives the trusted hash from raw bytes, strips bytes, and preserves reviewed decisions', () => {
    const raw = packetRequest();
    const expectedHash = treeShrubPhotosHash(raw.items[0].body.completionPhotos.map((photo) => photo.data));

    const snapshot = packetSnapshot(raw, { technicianId: 'tech-1' }, [], null);
    const saved = snapshot.items[0];

    expect(snapshot.treeShrubPhotoVerificationVersion).toBe(1);
    expect(saved.verifiedTreeShrubPhotosHash).toBe(expectedHash);
    expect(saved.verifiedTreeShrubPhotosHash).not.toBe('f'.repeat(64));
    expect(saved.body.completionPhotos).toEqual([
      { caption: 'Tree and shrub photo 1', zone: 'Front', sortOrder: 0 },
      { caption: 'Tree and shrub photo 2', zone: 'Back', sortOrder: 1 },
    ]);
    expect(saved.body.gaugePhoto).toEqual({ caption: 'Gauge' });
    expect(saved.body.treeShrubReview).toEqual(raw.items[0].body.treeShrubReview);
    expect(saved.body.treeShrubReview.decisions).toEqual([
      { key: 'pest_activity', action: 'hidden' },
      { key: 'foliage_fullness', action: 'confirmed' },
    ]);

    // Projection is immutable: record-phase callers still retain the bytes they upload.
    expect(raw.items[0].body.completionPhotos.every((photo) => photo.data)).toBe(true);
    expect(raw.items[0].body.gaugePhoto.data).toBeTruthy();
  });

  test.each([
    ['an incoming trusted-hash sibling without a review', () => packetRequest({ review: null })],
    ['photo bytes changed after preview', () => {
      const original = ['data:image/jpeg;base64,YQ==', 'data:image/jpeg;base64,Yg=='];
      return packetRequest({
        photoData: ['data:image/jpeg;base64,YQ==', 'data:image/jpeg;base64,dGFtcGVyZWQ='],
        review: signedReview({ photoData: original }),
      });
    }],
    ['a review signed for another scheduled service', () => packetRequest({
      serviceId: SERVICE_ID,
      review: signedReview({ serviceId: OTHER_SERVICE_ID }),
    })],
  ])('does not trust %s', (_label, buildRequest) => {
    const raw = buildRequest();
    const snapshot = packetSnapshot(raw, { technicianId: 'tech-1' }, [], null);

    expect(raw.items[0].verifiedTreeShrubPhotosHash).toBe('f'.repeat(64));
    expect(snapshot.items[0].verifiedTreeShrubPhotosHash).toBeNull();
    expect(snapshot.items[0].body.completionPhotos.every((photo) => !('data' in photo))).toBe(true);
  });

  test('durable replay wiring uses only the saved server hash and retains review decisions', () => {
    const packetsSource = fs.readFileSync(require.resolve('../services/visit-completion-packets'), 'utf8');
    const completionSource = fs.readFileSync(require.resolve('../services/complete-scheduled-service'), 'utf8');

    expect(packetsSource).toMatch(
      /verifiedTreeShrubPhotosHash:\s*payload\.treeShrubPhotoVerificationVersion === 1\s*\?\s*savedForm\.verifiedTreeShrubPhotosHash\s*\|\|\s*null\s*:\s*null/,
    );
    expect(completionSource).toMatch(
      /const reviewPhotosHash = durableReplay\s*\?\s*packetContext\.verifiedTreeShrubPhotosHash\s*:\s*treeShrubPhotosHash/,
    );
    expect(completionSource).toMatch(
      /storeTreeShrubAssessmentFromReview\(\{[\s\S]{0,500}decisions:\s*Array\.isArray\(review\.decisions\)\s*\?\s*review\.decisions/,
    );
  });
  test.each([false, true])('effects trusts only a versioned server snapshot (versioned=%s)', async (versioned) => {
    const raw = packetRequest();
    const payload = packetSnapshot(raw, { technicianId: 'tech-1' }, [], null);
    const signedHash = raw.items[0].body.treeShrubReview.photosHash;
    if (!versioned) {
      // Old writers persisted arbitrary item siblings; this hash and nested
      // marker could be supplied beside photos B and a valid review for A.
      delete payload.treeShrubPhotoVerificationVersion;
      payload.items[0].treeShrubPhotoVerificationVersion = 1;
      payload.items[0].verifiedTreeShrubPhotosHash = signedHash;
    }
    const reused = packetSnapshot(raw, {}, [], { payload });
    const packet = { id: 'packet-1', visit_id: 'visit-1', status: 'processing', payload: reused };
    const item = { id: 'item-1', scheduled_service_id: SERVICE_ID, service_record_id: 'record-1', derived_idempotency_key: 'key-1' };
    const database = (table) => {
      const chain = {
        where: () => chain,
        first: async () => packet,
        orderBy: async () => [item],
        update: async () => 1,
      };
      if (!['visit_completion_packets', 'visit_completion_packet_items'].includes(table)) throw new Error(`Unexpected table: ${table}`);
      return chain;
    };
    database.fn = { now: () => new Date('2026-09-26T00:00:00Z') };
    const completion = jest.spyOn(require('../services/complete-scheduled-service'), 'completeScheduledService')
      .mockResolvedValue({ status: 200, body: { serviceRecordId: 'record-1' } });
    try {
      await runVisitCompletionPacketMemberEffects(packet.id, database);
      expect(completion).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
        verifiedTreeShrubPhotosHash: versioned ? signedHash : null,
      }));
    } finally { completion.mockRestore(); }
  });

});
