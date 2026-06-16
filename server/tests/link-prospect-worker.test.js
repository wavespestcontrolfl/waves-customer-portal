const { mapReportToPatch, businessProfile } = require('../services/seo/link-prospect-worker');

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

  test('placed persists a valid cost and nulls an invalid one', () => {
    expect(mapReportToPatch('placed', { live_url: 'https://x', cost: 49.99 }).cost).toBe(49.99);
    expect(mapReportToPatch('placed', { live_url: 'https://x', cost: '25' }).cost).toBe(25);
    expect(mapReportToPatch('placed', { live_url: 'https://x' }).cost).toBeNull();
    expect(mapReportToPatch('placed', { live_url: 'https://x', cost: -5 }).cost).toBeNull();
    expect(mapReportToPatch('placed', { live_url: 'https://x', cost: 'free' }).cost).toBeNull();
    // Blank/whitespace/non-numeric-type inputs must NOT coerce to 0.
    expect(mapReportToPatch('placed', { live_url: 'https://x', cost: '' }).cost).toBeNull();
    expect(mapReportToPatch('placed', { live_url: 'https://x', cost: '   ' }).cost).toBeNull();
    expect(mapReportToPatch('placed', { live_url: 'https://x', cost: false }).cost).toBeNull();
    expect(mapReportToPatch('placed', { live_url: 'https://x', cost: [] }).cost).toBeNull();
    // An explicit numeric zero (genuinely free) is kept.
    expect(mapReportToPatch('placed', { live_url: 'https://x', cost: 0 }).cost).toBe(0);
  });

  test('placed without live_url maps to live_url=null (why report() rejects it)', () => {
    // The pure mapper has no I/O context to reject; report() guards this so a
    // placed row never lands with live_url=null (verifier-invisible, unclaimable).
    const p = mapReportToPatch('placed', {});
    expect(p.status).toBe('placed');
    expect(p.live_url).toBeNull();
  });

  test('placed + pending marks quality_signals.pending and tolerates a null live_url', () => {
    const p = mapReportToPatch('placed', { pending: true, notes: '8-10wk queue' });
    expect(p.status).toBe('placed');
    expect(p.live_url).toBeNull();
    const q = JSON.parse(p.quality_signals);
    expect(q.pending).toBe(true);
    expect(q.submitted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('pending merges into existing quality_signals (object or json) without clobbering', () => {
    const fromObj = mapReportToPatch('placed', { pending: true }, { target_indexed: true });
    expect(JSON.parse(fromObj.quality_signals).target_indexed).toBe(true);
    const fromJson = mapReportToPatch('placed', { pending: true }, '{"omega_submitted":"2026-06-01T00:00:00Z"}');
    const merged = JSON.parse(fromJson.quality_signals);
    expect(merged.omega_submitted).toBe('2026-06-01T00:00:00Z');
    expect(merged.pending).toBe(true);
  });

  test('placed WITHOUT pending leaves quality_signals untouched', () => {
    const p = mapReportToPatch('placed', { live_url: 'https://x' });
    expect(p.quality_signals).toBeUndefined();
  });

  test('drafted parks the outreach draft, leaves status unchanged, releases lease', () => {
    const p = mapReportToPatch('drafted', {
      outreach_to_email: ' editor@site.com ',
      outreach_subject: 'Pitch',
      outreach_body: 'Hello',
      notes: 'found editor contact',
    });
    expect(p.status).toBeUndefined(); // NOT contacted — nothing sends until human approval
    expect(p.outreach_status).toBe('drafted');
    expect(p.outreach_to_email).toBe('editor@site.com'); // trimmed
    expect(p.outreach_subject).toBe('Pitch');
    expect(p.outreach_body).toBe('Hello');
    expect(p.claimed_at).toBeNull();
    expect(p.claimed_by).toBeNull();
  });
});

describe('link prospect worker — business profile (canonical NAP)', () => {
  test('serves complete NAP for every GBP-backed office', () => {
    const bp = businessProfile();
    expect(bp.brand).toBe('Waves Pest Control');
    expect(bp.website).toBe('https://wavespestcontrol.com');
    expect(bp.contact_email).toMatch(/@wavespestcontrol\.com$/);
    expect(bp.locations.length).toBeGreaterThanOrEqual(4);
    for (const loc of bp.locations) {
      expect(loc.id).toBeTruthy();
      expect(loc.address).toMatch(/, FL \d{5}$/);
      expect(loc.phone).toMatch(/^\(941\) \d{3}-\d{4}$/);
      expect(loc.google_place_id).toBeTruthy();
    }
  });

  test('default_location_id resolves to a served location', () => {
    const bp = businessProfile();
    expect(bp.locations.some((l) => l.id === bp.default_location_id)).toBe(true);
  });

  test('exposes only public NAP — no GBP account internals', () => {
    const json = JSON.stringify(businessProfile());
    expect(json).not.toMatch(/RefreshToken/i);
    expect(json).not.toMatch(/googleAccountId|googleLocationId|accounts\//);
    expect(json).not.toMatch(/latitude|longitude/);
  });
});
