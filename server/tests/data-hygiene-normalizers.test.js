const {
  normalizeUsState,
  normalizationCandidatesForCustomer,
  _private,
} = require('../services/data-hygiene/normalizers');
const {
  buildIdempotencyKey,
  isSensitiveProposal,
  stalePendingNormalizationForResource,
  stableJson,
  upsertProposal,
} = require('../services/data-hygiene/proposal-store');
const {
  buildScanOutcome,
} = require('../services/data-hygiene');
const {
  buildAccessCodeProposals,
  buildMessageExtractionProposals,
  buildNoteProposals,
  normalizeAccessCode,
  normalizeNoteFragment,
  redactExcerpt,
} = require('../services/data-hygiene/message-extractor');

describe('data hygiene deterministic normalizers', () => {
  const id = '00000000-0000-0000-0000-000000000001';

  test('emits conservative proposals for customer contact drift', () => {
    const proposals = normalizationCandidatesForCustomer({
      id,
      first_name: ' JOHN ',
      last_name: 'SMITH',
      email: 'TEST@Example.COM ',
      phone: '3174180397',
      state: 'ma',
      zip: '2123',
    });

    expect(proposals.map((p) => [p.rule_id, p.field, p.proposed_value, p.tier])).toEqual([
      ['name.whitespace_trim', 'first_name', 'JOHN', 'high'],
      ['name.proper_case_last', 'last_name', 'Smith', 'medium'],
      ['email.lowercase_trim', 'email', 'test@example.com', 'high'],
      ['phone.e164', 'phone', '+13174180397', 'high'],
      ['state.normalize_to_us_2letter', 'state', 'MA', 'high'],
      ['zip.zero_pad_5', 'zip', '02123', 'high'],
    ]);
    expect(new Set(proposals.map((p) => p.scope_id))).toEqual(new Set([id]));
  });

  test('proper-case name proposals skip known unsafe casing changes', () => {
    const base = {
      id,
      first_name: 'John',
      last_name: 'Smith',
      email: 'john@example.com',
      phone: '+13174180397',
      state: 'FL',
      zip: '34202',
    };
    const unsafeCases = [
      ['first_name', 'AS', 'name.proper_case_first'],
      ['first_name', 'CJ', 'name.proper_case_first'],
      ['first_name', 'Mackenzie', 'name.proper_case_first'],
      ['first_name', 'MACKENZIE', 'name.proper_case_first'],
      ['last_name', 'Smith-Mackenzie', 'name.proper_case_last'],
      ['last_name', 'LaSalle', 'name.proper_case_last'],
      ['last_name', 'DeSanto', 'name.proper_case_last'],
      ['last_name', 'DeFusco', 'name.proper_case_last'],
      ['last_name', 'DeJoseph', 'name.proper_case_last'],
      ['last_name', 'VanMeter', 'name.proper_case_last'],
      ['last_name', 'LaCourte', 'name.proper_case_last'],
      ['last_name', 'DiStefano', 'name.proper_case_last'],
      ['last_name', 'LaRue', 'name.proper_case_last'],
    ];

    for (const [field, value, ruleId] of unsafeCases) {
      const proposals = normalizationCandidatesForCustomer({
        ...base,
        [field]: value,
      });

      expect(proposals.some((p) => p.field === field && p.rule_id === ruleId)).toBe(false);
    }
  });

  test('proper-case name proposals keep safe all-caps cleanup and Mc fixes', () => {
    const base = {
      id,
      first_name: 'John',
      last_name: 'Smith',
      email: 'john@example.com',
      phone: '+13174180397',
      state: 'FL',
      zip: '34202',
    };
    const safeCases = [
      ['first_name', 'BILLY', 'name.proper_case_first', 'Billy'],
      ['last_name', 'MOSER', 'name.proper_case_last', 'Moser'],
      ['last_name', 'Mcconaghy', 'name.proper_case_last', 'McConaghy'],
      ['last_name', 'Mccash', 'name.proper_case_last', 'McCash'],
      ['last_name', 'MACDONALD', 'name.proper_case_last', 'MacDonald'],
      ['last_name', 'SMITH-MACDONALD', 'name.proper_case_last', 'Smith-MacDonald'],
    ];

    for (const [field, value, ruleId, proposedValue] of safeCases) {
      const proposals = normalizationCandidatesForCustomer({
        ...base,
        [field]: value,
      });

      expect(proposals.find((p) => p.field === field && p.rule_id === ruleId)).toMatchObject({
        current_value: value,
        proposed_value: proposedValue,
      });
    }
  });

  test('does not rewrite foreign, vanity, or extension phone numbers', () => {
    expect(_private.nanpPhoneGuard('+44 20 7946 0958').ok).toBe(false);
    expect(_private.nanpPhoneGuard('1-800-FLOWERS').ok).toBe(false);
    expect(_private.nanpPhoneGuard('317-418-0397 x2').ok).toBe(false);

    const base = {
      id,
      first_name: 'John',
      last_name: 'Smith',
      email: 'john@example.com',
      state: 'FL',
      zip: '34202',
    };
    expect(normalizationCandidatesForCustomer({ ...base, phone: '+44 20 7946 0958' })
      .some((p) => p.rule_id === 'phone.e164')).toBe(false);
    expect(normalizationCandidatesForCustomer({ ...base, phone: '1-800-FLOWERS' })
      .some((p) => p.rule_id === 'phone.e164')).toBe(false);
    expect(normalizationCandidatesForCustomer({ ...base, phone: '317-418-0397 x2' })
      .some((p) => p.rule_id === 'phone.e164')).toBe(false);
  });

  test('normalizes state names and abbreviations without touching invalid states', () => {
    expect(normalizeUsState('fl')).toBe('FL');
    expect(normalizeUsState('Florida')).toBe('FL');
    expect(normalizeUsState('new york')).toBe('NY');
    expect(normalizeUsState('not-a-state')).toBeNull();
  });

  test('does not zero-pad ZIP+4, foreign-looking, or wrong-state postal codes', () => {
    const base = {
      id,
      first_name: 'John',
      last_name: 'Smith',
      email: 'john@example.com',
      phone: '+13174180397',
      state: 'FL',
    };
    expect(normalizationCandidatesForCustomer({ ...base, zip: '34470-1234' })
      .some((p) => p.rule_id === 'zip.zero_pad_5')).toBe(false);
    expect(normalizationCandidatesForCustomer({ ...base, zip: 'A1A 1A1' })
      .some((p) => p.rule_id === 'zip.zero_pad_5')).toBe(false);
    expect(normalizationCandidatesForCustomer({ ...base, zip: '3454' })
      .some((p) => p.rule_id === 'zip.zero_pad_5')).toBe(false);
  });

  test('only zero-pads when the proposed ZIP prefix matches the state', () => {
    const proposals = normalizationCandidatesForCustomer({
      id,
      first_name: 'John',
      last_name: 'Smith',
      email: 'john@example.com',
      phone: '+13174180397',
      state: 'MA',
      zip: '2123',
    });
    expect(proposals.find((p) => p.rule_id === 'zip.zero_pad_5')).toMatchObject({
      proposed_value: '02123',
      evidence: { normalized_state: 'MA', zip3: '021' },
    });
  });

  test('email lowercase proposals record auto-apply exclusions', () => {
    const [proposal] = normalizationCandidatesForCustomer({
      id,
      first_name: 'John',
      last_name: 'Smith',
      email: '"John"@Example.COM',
      phone: '+13174180397',
      state: 'FL',
      zip: '34202',
    }).filter((p) => p.rule_id === 'email.lowercase_trim');

    expect(proposal.proposed_value).toBe('"john"@example.com');
    expect(proposal.evidence.auto_apply_eligible).toBe(false);
    expect(proposal.evidence.auto_apply_exclusions).toContain('quoted_local_part');
  });
});

describe('data hygiene proposal idempotency', () => {
  test('stableJson orders object keys deterministically', () => {
    expect(stableJson({ b: 2, a: 1 })).toBe(stableJson({ a: 1, b: 2 }));
  });

  test('idempotency includes scope and proposed value', () => {
    const base = {
      resource_type: 'customer',
      resource_id: '00000000-0000-0000-0000-000000000001',
      scope_type: 'customer',
      scope_id: '00000000-0000-0000-0000-000000000001',
      field: 'email',
      proposed_value: 'test@example.com',
      source: 'normalization',
      rule_id: 'email.lowercase_trim',
      rule_version: '1',
      current_value: 'TEST@EXAMPLE.COM',
      evidence: {},
    };

    expect(buildIdempotencyKey(base)).toBe(buildIdempotencyKey({ ...base }));
    expect(buildIdempotencyKey(base)).not.toBe(buildIdempotencyKey({
      ...base,
      proposed_value: 'other@example.com',
    }));
    expect(buildIdempotencyKey(base)).not.toBe(buildIdempotencyKey({
      ...base,
      current_value: ' Test@Example.COM ',
    }));
  });

  test('store refuses sensitive proposals until vault redaction is wired', async () => {
    const proposal = {
      resource_type: 'property_preferences',
      resource_id: null,
      scope_type: 'customer',
      scope_id: '00000000-0000-0000-0000-000000000001',
      field: 'lockbox_code',
      current_value: null,
      proposed_value: '1234',
      source: 'message-extraction',
      rule_id: 'extract.lockbox_code',
      rule_version: '1',
      confidence: 0.8,
      tier: 'medium',
      evidence: {},
    };

    expect(isSensitiveProposal(proposal)).toBe(true);
    await expect(upsertProposal(proposal)).rejects.toThrow(/vault-backed redaction/);
  });

  test('caller cannot override inferred sensitive detection', async () => {
    const proposal = {
      resource_type: 'property_preferences',
      resource_id: null,
      scope_type: 'customer',
      scope_id: '00000000-0000-0000-0000-000000000001',
      field: 'gate_code',
      current_value: null,
      proposed_value: '4321',
      source: 'message-extraction',
      rule_id: 'extract.gate_code',
      rule_version: '1',
      confidence: 0.8,
      tier: 'medium',
      evidence: {},
      is_sensitive: false,
    };

    await expect(upsertProposal(proposal)).rejects.toThrow(/vault-backed redaction/);
  });

  test('parking_notes is sensitive even outside extract rule ids', () => {
    expect(isSensitiveProposal({
      resource_type: 'property_preferences',
      resource_id: null,
      scope_type: 'customer',
      scope_id: '00000000-0000-0000-0000-000000000001',
      field: 'parking_notes',
      current_value: null,
      proposed_value: 'park behind the gate',
      source: 'cross-record-backfill',
      rule_id: 'backfill.parking_notes_from_message',
      rule_version: '1',
      confidence: 0.8,
      tier: 'medium',
      evidence: {},
    })).toBe(true);
  });

  test('pet_details is sensitive for extracted property preference proposals', () => {
    expect(isSensitiveProposal({
      resource_type: 'property_preferences',
      resource_id: null,
      scope_type: 'customer',
      scope_id: '00000000-0000-0000-0000-000000000001',
      field: 'pet_details',
      current_value: null,
      proposed_value: 'Dog is friendly but stays in the yard',
      source: 'message-extraction',
      rule_id: 'extract.pet_details',
      rule_version: '1',
      confidence: 0.8,
      tier: 'medium',
      evidence: {},
    })).toBe(true);
  });

  test('stale updates only mutate rows still pending', async () => {
    const rows = [{
      id: 'proposal-1',
      field: 'first_name',
      current_value: 'JOHN',
      proposed_value: 'John',
    }];
    const selectBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    };
    const updateBuilder = {
      whereIn: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      update: jest.fn().mockResolvedValue(1),
    };
    const trx = jest.fn()
      .mockReturnValueOnce(selectBuilder)
      .mockReturnValueOnce(updateBuilder);

    const count = await stalePendingNormalizationForResource({
      resource_type: 'customer',
      resource_id: '00000000-0000-0000-0000-000000000001',
      currentValues: { first_name: 'JANE' },
      trx,
    });

    expect(count).toBe(1);
    expect(updateBuilder.whereIn).toHaveBeenCalledWith('id', ['proposal-1']);
    expect(updateBuilder.where).toHaveBeenCalledWith({ status: 'pending' });
  });
});

describe('data hygiene run status', () => {
  test('row-level errors fail the run outcome', () => {
    expect(buildScanOutcome({ errors: 1 })).toEqual({
      status: 'failed',
      verb: 'failed with row-level errors',
      errorMessage: '1 row-level data hygiene scan error encountered',
    });
    expect(buildScanOutcome({ errors: 0 })).toEqual({
      status: 'ok',
      verb: 'completed',
      errorMessage: null,
    });
  });
});

describe('data hygiene message access extraction', () => {
  const baseMessage = {
    id: '00000000-0000-0000-0000-000000000101',
    channel: 'sms',
    customer_id: '00000000-0000-0000-0000-000000000001',
    property_preferences_id: '00000000-0000-0000-0000-000000000201',
    neighborhood_gate_code: null,
    property_gate_code: null,
    lockbox_code: null,
    garage_code: null,
    pet_details: null,
    parking_notes: null,
    access_notes: null,
  };

  test('extracts obvious gate codes into property preference proposals', () => {
    const proposals = buildAccessCodeProposals({
      ...baseMessage,
      body: 'Gate: #4821 then press 5\nYard: Side gate combo: 1234',
    });

    expect(proposals).toEqual([
      expect.objectContaining({
        field: 'property_gate_code',
        proposed_value: '1234',
        rule_id: 'extract.gate_code',
        resource_type: 'property_preferences',
        scope_id: baseMessage.customer_id,
      }),
      expect.objectContaining({
        field: 'neighborhood_gate_code',
        proposed_value: '#4821 then press 5',
        rule_id: 'extract.gate_code',
      }),
    ]);
    expect(proposals[0].evidence.source_excerpt).toContain('[redacted access code]');
    expect(proposals[0].evidence.source_excerpt).not.toContain('1234');
  });

  test('skips already-matching stored codes and non-code access text', () => {
    expect(buildAccessCodeProposals({
      ...baseMessage,
      neighborhood_gate_code: '7492',
      body: 'Gate code is 7492',
    })).toEqual([]);

    expect(buildAccessCodeProposals({
      ...baseMessage,
      body: 'Side gate - lift latch, no code needed',
    })).toEqual([]);
  });

  test('normalizes access codes conservatively', () => {
    expect(normalizeAccessCode('#4821 then press 5')).toBe('#4821 then press 5');
    expect(normalizeAccessCode('lift latch')).toBeNull();
    expect(redactExcerpt('Gate code is 7492 for Dustin', '7492')).not.toContain('7492');
  });

  test('extracts pet, parking, and access notes as review proposals', () => {
    const proposals = buildNoteProposals({
      ...baseMessage,
      body: 'Dog is friendly but stays in the yard. Please park on street only. Use left side gate for entry.',
    });

    expect(proposals).toEqual([
      expect.objectContaining({
        field: 'pet_details',
        proposed_value: 'Dog is friendly but stays in the yard',
        rule_id: 'extract.pet_details',
      }),
      expect.objectContaining({
        field: 'parking_notes',
        proposed_value: 'park on street only',
        rule_id: 'extract.parking_notes',
      }),
      expect.objectContaining({
        field: 'access_notes',
        proposed_value: 'Use left side gate for entry',
        rule_id: 'extract.access_notes',
      }),
    ]);
  });

  test('appends note proposals to existing property preference text', () => {
    const [proposal] = buildNoteProposals({
      ...baseMessage,
      parking_notes: 'Use driveway if open',
      body: 'Parking: park on street only today.',
    });

    expect(proposal).toMatchObject({
      field: 'parking_notes',
      current_value: 'Use driveway if open',
      proposed_value: 'Use driveway if open; Parking: park on street only today',
    });
  });

  test('skips note fragments that appear to contain access codes', () => {
    expect(buildNoteProposals({
      ...baseMessage,
      body: 'Use side gate code 1234 to enter.',
    })).toEqual([]);
    expect(normalizeNoteFragment('side gate code 1234')).toBeNull();
  });

  test('skips rejected pet false positives from treatment, negation, and transcript spelling', () => {
    const bodies = [
      'Again no where our curious dog can get to.',
      'Applying topical to the cats per vet instructions. Still see an occasional flea at random.',
      'Caller: Email is last name Sperry. S P E R R Y D A S for Dog Apple Sam @gmail.com.',
      "St. Pete. We don't have pets or anything like that.",
    ];

    for (const body of bodies) {
      expect(buildNoteProposals({ ...baseMessage, body })
        .some((proposal) => proposal.field === 'pet_details')).toBe(false);
    }
  });

  test('skips rejected access false positives from outbound-style template text', () => {
    const bodies = [
      'Your tech will text when en route. Portal: wavespestcontrol.com/portal Questions?',
      'Your technician will arrive within a two-hour window and text when 30 minutes out.',
    ];

    for (const body of bodies) {
      expect(buildNoteProposals({ ...baseMessage, body })
        .some((proposal) => proposal.field === 'access_notes')).toBe(false);
    }
  });

  test('keeps durable pet and access operational notes', () => {
    expect(buildNoteProposals({
      ...baseMessage,
      body: 'We have a friendly dog in the backyard, please keep gate closed.',
    })).toEqual([
      expect.objectContaining({
        field: 'pet_details',
        proposed_value: 'dog in the backyard, please keep gate closed',
      }),
    ]);

    expect(buildNoteProposals({
      ...baseMessage,
      body: 'Please call before entering the gate, dog may be outside.',
    }).map((proposal) => proposal.field)).toEqual(['pet_details', 'access_notes']);
  });

  test('combines access code and note extraction without duplicate fields', () => {
    const proposals = buildMessageExtractionProposals({
      ...baseMessage,
      body: 'Gate code is 7492. Dog is friendly. Park on street.',
    });

    expect(proposals.map((p) => p.field)).toEqual([
      'neighborhood_gate_code',
      'pet_details',
      'parking_notes',
    ]);
  });
});
