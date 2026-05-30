const { mapReportToPatch } = require('../services/seo/link-prospect-worker');

describe('link prospect worker — report mapping', () => {
  test('placed records live_url/anchor/evidence, sets status=placed, releases lease', () => {
    const p = mapReportToPatch('placed', {
      live_url: 'https://bradentonherald.com/x',
      claimed_anchor: 'pest control bradenton',
      evidence_url: 'https://shot/1.png',
      notes: 'guest post',
    });
    expect(p.status).toBe('placed'); // NEVER straight to live — verifier promotes
    expect(p.live_url).toBe('https://bradentonherald.com/x');
    expect(p.anchor_text).toBe('pest control bradenton');
    expect(p.evidence_url).toBe('https://shot/1.png');
    expect(p.claimed_at).toBeNull();
    expect(p.claimed_by).toBeNull();
  });

  test('skipped marks rejected and releases lease', () => {
    const p = mapReportToPatch('skipped', { notes: 'ToS prohibits automation' });
    expect(p.status).toBe('rejected');
    expect(p.claimed_at).toBeNull();
  });

  test('failed leaves status unchanged (claimable again) and releases lease', () => {
    const p = mapReportToPatch('failed', { notes: 'form changed' });
    expect(p.status).toBeUndefined(); // status not set -> unchanged in the update
    expect(p.claimed_at).toBeNull();
    expect(p.claimed_by).toBeNull();
    expect(p.notes).toBe('form changed');
  });
});
