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
