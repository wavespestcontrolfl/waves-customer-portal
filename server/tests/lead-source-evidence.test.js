const {
  sourceEvidenceFromAttribution,
  sourceEvidenceForLead,
  sourceEvidenceLabelSql,
  attributionWithSourceEvidence,
  classifyAttributionSignals,
} = require('../services/lead-source-evidence');
// Vendored snapshot of astro/src/lib/paid-source-fixtures.json; root integration
// byte-compares the two repos, while portal CI remains standalone.
const sharedPaidSourceFixtures = require('./fixtures/paid-source-fixtures.json');

describe('shared browser/server attribution matrix', () => {
  test.each(sharedPaidSourceFixtures)('$name', ({ attribution, expected_backend_kind: expected }) => {
    const classified = classifyAttributionSignals(attribution);
    const expectedBucket = {
      google_ads: 'google_ads', google_business: 'google_business', meta_ads: 'meta_ads',
      organic_social: 'organic_social', organic_search: 'organic_search',
      chatgpt: 'ai', copilot: 'ai', other_ai: 'ai', referral: 'referral',
      website: 'website', direct: 'direct',
    }[expected] || 'unknown';
    expect(classified.bucket).toBe(expectedBucket);
    expect(sourceEvidenceFromAttribution(attribution)?.kind || null).toBe(expected);
  });
});

describe('sourceEvidenceFromAttribution', () => {
  test('a term-only tag and an unfamiliar social source do not identify a discovery channel', () => {
    for (const utm of [{ term: 'ants' }, { source: 'constructor', medium: 'social' }]) {
      const recorded = sourceEvidenceFromAttribution({ observed: true, utm, landing_url: 'https://www.wavespestcontrol.com/' });
      expect(recorded).toMatchObject({ kind: 'website' });
    }
  });
  test('facebook + organic is organic social, not a paid Meta lead', () => {
    expect(sourceEvidenceFromAttribution({
      observed: true,
      utm: { source: 'facebook', medium: 'organic' },
      landing_url: 'https://wavespestcontrol.com/quote',
    })).toEqual({
      kind: 'organic_social',
      label: 'Organic social',
      detail: 'Facebook',
      basis: 'Observed an unpaid Facebook referral or campaign tag.',
    });
  });

  test('google + ppc is paid without a click id', () => {
    expect(sourceEvidenceFromAttribution({
      observed: true,
      utm: { source: ' Google ', medium: ' PPC ' },
    })).toMatchObject({ kind: 'google_ads', label: 'Google Ads' });
  });

  test('explicit GBP tags beat stale Google and Meta click ids', () => {
    expect(sourceEvidenceFromAttribution({
      observed: true,
      utm: { source: 'gbp' },
      gclid: 'stale-google',
      fbclid: 'stale-meta',
    }).kind).toBe('google_business');
  });

  test('Google click evidence wins a conflicting Meta click', () => {
    expect(sourceEvidenceFromAttribution({ gclid: 'google', fbclid: 'meta' }).kind).toBe('google_ads');
  });

  test.each([
    ['https://chatgpt.com/c/private-thread?secret=1', 'chatgpt', 'ChatGPT'],
    ['https://copilot.microsoft.com/chats/private?secret=1', 'copilot', 'Microsoft Copilot'],
    ['https://claude.ai/chat/private?secret=1', 'other_ai', 'Claude'],
  ])('known AI host %s is provider-specific and emits no raw URL', (referrer, kind, label) => {
    const out = sourceEvidenceFromAttribution({ observed: true, referrer });
    expect(out).toMatchObject({ kind, label });
    expect(JSON.stringify(out)).not.toContain('private');
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(JSON.stringify(out)).not.toContain('https://');
  });

  test('an observed empty referrer is direct', () => {
    expect(sourceEvidenceFromAttribution({
      observed: true,
      referrer: '',
      landing_url: 'https://wavespestcontrol.com/quote',
    })).toMatchObject({ kind: 'direct', label: 'Direct' });
  });

  test('a legacy object without observed is not reinterpreted as direct', () => {
    expect(sourceEvidenceFromAttribution({
      referrer: '',
      landing_url: 'https://wavespestcontrol.com/quote',
    })).toMatchObject({ kind: 'website', label: 'Website' });
    expect(sourceEvidenceFromAttribution({})).toBeNull();
  });

  test('external referral detail is host-only', () => {
    const out = sourceEvidenceFromAttribution({
      observed: true,
      referrer: 'https://example.org/person/private?email=person@example.org',
    });
    expect(out).toMatchObject({ kind: 'referral', detail: 'example.org' });
    expect(JSON.stringify(out)).not.toContain('person');
  });

  test('canonical Google Maps referral is local discovery before organic search', () => {
    expect(sourceEvidenceFromAttribution({
      observed: true,
      referrer: 'https://www.google.com/maps',
    })).toEqual({
      kind: 'google_business',
      label: 'Google Maps',
      detail: 'Maps listing visit',
      basis: 'Observed a Google Maps referral.',
    });
  });

  test.each([
    ['https://docs.google.com/document/d/id', 'docs.google.com'],
    ['https://mail.google.com/mail/u/0/', 'mail.google.com'],
  ])('%s is a referral, not Google Search', (referrer, host) => {
    expect(sourceEvidenceFromAttribution({ observed: true, referrer })).toMatchObject({
      kind: 'referral', detail: host,
    });
  });

  test.each([
    [{ utm: { source: 'bing', medium: 'cpc' } }, null],
    [{ utm: { source: 'google', medium: 'email' } }, null],
    [{ utm: { source: 'facebook', medium: 'email' } }, null],
  ])('explicit nonorganic unsupported tags are not described as organic: %j', (attribution, expected) => {
    expect(sourceEvidenceFromAttribution(attribution)).toBe(expected);
  });

  test('known GBP content keeps the recognized sanitized location', () => {
    expect(sourceEvidenceFromAttribution({
      observed: true,
      utm: { source: 'gbp', medium: 'organic', content: 'parrish-profile' },
    })).toEqual({
      kind: 'google_business',
      label: 'Google Business Profile',
      detail: 'GBP — Parrish',
      basis: 'Observed Google Business Profile campaign tags for Parrish.',
    });
  });

  test('lookalike AI and ad hosts do not match known providers', () => {
    expect(sourceEvidenceFromAttribution({ observed: true, referrer: 'https://notchatgpt.com/' })).toMatchObject({
      kind: 'referral', detail: 'notchatgpt.com',
    });
    expect(sourceEvidenceFromAttribution({ observed: true, referrer: 'https://evilgoogle.com/' })).toMatchObject({
      kind: 'referral', detail: 'evilgoogle.com',
    });
  });

  test('own fleet subdomains stay website, never external referral', () => {
    expect(sourceEvidenceFromAttribution({
      observed: true, referrer: 'https://offers.parrishpestcontrol.com/',
    })).toMatchObject({ kind: 'website', label: 'Website' });
  });
});

describe('sourceEvidenceForLead', () => {
  const CALL_SID = 'CA0123456789abcdef0123456789abcdef';

  test('returns persisted server evidence on list/detail rows', () => {
    const persisted = {
      kind: 'organic_search', label: 'Organic search', detail: 'Google',
      basis: 'Observed an unpaid Google search referral.',
    };
    expect(sourceEvidenceForLead({ extracted_data: { source_evidence: persisted } })).toEqual(persisted);
  });

  test('an incomplete evidence object and blank click IDs do not identify a provider', () => {
    const lead = {
      extracted_data: { source_evidence: { kind: 'chatgpt', label: 'ChatGPT', basis: '  ' } },
      gclid: ' ', fbc: '',
    };
    expect(sourceEvidenceForLead(lead)).toMatchObject({ kind: 'unknown' });
  });

  test('historical shared Facebook is unknown; a proved paid call placement is Meta', () => {
    expect(sourceEvidenceForLead({ source_type: 'facebook', source_name: 'Facebook Ads' })).toMatchObject({
      kind: 'unknown', label: 'Source unknown',
    });
    expect(sourceEvidenceForLead({
      lead_type: 'inbound_call', first_contact_channel: 'call', twilio_call_sid: CALL_SID,
      source_type: 'facebook', source_channel: 'paid', source_name: 'Facebook Ads — Pest (call-extension)',
    })).toMatchObject({ kind: 'meta_ads', label: 'Meta Ads' });
    // The shared Facebook FK and a call channel are not enough to assert a
    // paid placement when the initiating CallSid is absent.
    expect(sourceEvidenceForLead({
      lead_type: 'inbound_call', first_contact_channel: 'call',
      source_type: 'facebook', source_channel: 'paid', source_name: 'Facebook Ads — Pest (call-extension)',
    })).toMatchObject({ kind: 'unknown', label: 'Source unknown' });
    expect(sourceEvidenceForLead({ source_type: 'ai_assistant', source_name: 'AI Assistant Referrals' })).toMatchObject({
      kind: 'other_ai', label: 'AI assistant referral', detail: 'Provider unverified',
    });
  });

  test.each([
    ['GBP call', {
      lead_type: 'inbound_call', first_contact_channel: 'call',
      source_type: 'gbp', source_name: 'GBP — Sarasota', gclid: 'later-google', fbclid: 'later-meta',
    }, 'google_business'],
    ['shared-line call', {
      lead_type: 'voicemail', first_contact_channel: 'phone',
      source_type: 'main_site', source_name: 'Main Site', gclid: 'later-google',
    }, 'unknown'],
    ['paid Google call', {
      lead_type: 'inbound_call', first_contact_channel: 'inbound_call',
      source_type: 'google_ads', source_name: 'Google Ads — Pest (call-extension)', fbclid: 'later-meta',
    }, 'google_ads'],
    ['older call with blank first-contact channel', {
      lead_type: 'inbound_call', first_contact_channel: '', fbc: 'later-meta',
    }, 'unknown'],
    ['older shared-line call with blank first-contact channel', {
      lead_type: 'voicemail', first_contact_channel: '',
      source_type: 'main_site', source_name: 'Main Site', gclid: 'later-google',
    }, 'unknown'],
  ])('%s ignores click IDs from a later attached browser quote', (_name, lead, expectedKind) => {
    expect(sourceEvidenceForLead(lead).kind).toBe(expectedKind);
  });

  test('a missing CallSid still protects call origin, while a later CallSid alone never changes web-first origin', () => {
    expect(sourceEvidenceForLead({
      lead_type: 'inbound_call', first_contact_channel: 'call', twilio_call_sid: null,
      source_type: 'gbp', source_name: 'GBP — Parrish', gclid: 'later-google',
    })).toMatchObject({ kind: 'google_business', label: 'Google Business Profile' });

    expect(sourceEvidenceForLead({
      // Even a call-shaped type must defer to the explicit original web channel.
      lead_type: 'inbound_call', first_contact_channel: 'form', twilio_call_sid: CALL_SID,
      gclid: 'first-web-google',
    })).toMatchObject({ kind: 'google_ads', label: 'Google Ads' });
    expect(sourceEvidenceForLead({
      lead_type: 'quote_wizard', first_contact_channel: 'website_quote', twilio_call_sid: CALL_SID,
      fbclid: 'first-web-meta',
    })).toMatchObject({ kind: 'meta_ads', label: 'Meta Ads' });
  });

  test('self-reported-only history stays unknown and says why', () => {
    expect(sourceEvidenceForLead({ heard_about: 'google' })).toEqual({
      kind: 'unknown',
      label: 'Source unknown',
      detail: 'Self-reported only',
      basis: 'A self-reported answer exists, but no technical source evidence was captured.',
    });
  });

  test('known website and email placement retain useful historical labels', () => {
    expect(sourceEvidenceForLead({ source_type: 'main_site', source_name: 'Main Site' }).kind).toBe('website');
    expect(sourceEvidenceForLead({ source_type: 'email', source_name: 'Email Inquiry' })).toMatchObject({ kind: 'email', label: 'Email inquiry' });
  });

  test('a shared website phone line and generic phone/manual intake stay unknown', () => {
    expect(sourceEvidenceForLead({
      source_type: 'main_site', source_name: 'Main Site', first_contact_channel: 'call',
    })).toMatchObject({ kind: 'unknown', label: 'Source unknown', detail: 'Shared phone line' });
    expect(sourceEvidenceForLead({ first_contact_channel: 'phone' })).toMatchObject({ kind: 'unknown', label: 'Source unknown' });
    expect(sourceEvidenceForLead({ first_contact_channel: 'manual' })).toMatchObject({ kind: 'unknown', label: 'Source unknown' });
  });
});

describe('persistence and sorting helpers', () => {
  test('client-supplied evidence is replaced by server classification', () => {
    const out = attributionWithSourceEvidence({
      observed: true,
      referrer: '',
      source_evidence: { kind: 'google_ads', label: 'Forged', basis: 'client' },
    });
    expect(out.source_evidence).toMatchObject({ kind: 'direct', label: 'Direct' });
  });

  test('source sort SQL uses the persisted label before historical fallbacks', () => {
    const db = { raw: jest.fn((sql, bindings) => ({ sql, bindings })) };
    const raw = sourceEvidenceLabelSql(db);
    expect(raw.sql).toContain("extracted_data->'source_evidence'->>'label'");
    expect(raw.sql).toContain("extracted_data->'source_evidence'->>'basis'");
    expect(raw.sql).toContain("COALESCE(leads.first_contact_channel, '')");
    expect(raw.sql).toContain("COALESCE(leads.lead_type, '')");
    expect(raw.sql).toContain('NULLIF(BTRIM(leads.twilio_call_sid)');
    expect(raw.sql).toContain('WHEN NOT');
    expect(raw.sql).toContain("THEN 'Source unknown'");
    expect(raw.bindings.length).toBeGreaterThan(5);
  });
});
