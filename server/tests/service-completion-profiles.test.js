const {
  resolveCompletionProfileForScheduledService,
  serializeProfile,
  resolveCompletionDeliveryPosture,
} = require('../services/service-completion-profiles');

function makeKnex({ service = null, serviceResults = null, profile = null, hasTable = true } = {}) {
  let serviceResultIndex = 0;
  const whereRawCalls = [];
  const knex = jest.fn((table) => {
    const chain = {
      where: jest.fn(() => chain),
      whereRaw: jest.fn((sql, bindings) => {
        whereRawCalls.push({ table, sql, bindings });
        return chain;
      }),
      first: jest.fn(async () => {
        if (table === 'services') {
          if (Array.isArray(serviceResults)) {
            return serviceResults[serviceResultIndex++] || null;
          }
          return service;
        }
        if (table === 'service_completion_profiles') return profile;
        return null;
      }),
      // The short-name fallback now takes TWO rows and resolves only on
      // exactly one, so an ambiguous abbreviation can never be guessed at
      // (a shared "Lawn Care"/"Mosquito" spans one_time AND recurring rows).
      // Consumes the same serviceResults queue as .first(), as an array.
      limit: jest.fn(() => chain),
      select: jest.fn(async () => {
        if (table !== 'services') return [];
        const next = Array.isArray(serviceResults)
          ? serviceResults[serviceResultIndex++]
          : service;
        if (!next) return [];
        return Array.isArray(next) ? next : [next];
      }),
    };
    return chain;
  });
  knex._whereRawCalls = whereRawCalls;
  knex.schema = {
    hasTable: jest.fn(async () => hasTable),
  };
  return knex;
}

describe('service completion profiles', () => {
  test('serializes project-backed profile flags for one-time service routing', () => {
    const profile = serializeProfile({
      service_key: 'rodent_trapping',
      service_name_snapshot: 'Rodent Trapping Service',
      category: 'rodent',
      billing_type: 'one_time',
      completion_mode: 'project_required',
      project_type: 'rodent_trapping',
      creates_service_record: true,
      portal_visibility: 'token_only',
      portal_attach_policy: 'recurring_customer',
      followup_policy: 'alert',
      default_followup_days: 3,
      active: true,
    });

    expect(profile).toMatchObject({
      serviceKey: 'rodent_trapping',
      completionMode: 'project_required',
      projectType: 'rodent_trapping',
      portalVisibility: 'token_only',
      portalAttachPolicy: 'recurring_customer',
      followupPolicy: 'alert',
      defaultFollowupDays: 3,
      projectBacked: true,
      requiresProject: true,
    });
  });

  test('serializes an internal-only consultation profile with no typed findings', () => {
    const profile = serializeProfile({
      service_key: 'lawn_inspection',
      service_name_snapshot: 'Waves Assessment',
      category: 'inspection',
      billing_type: 'one_time',
      completion_mode: 'internal_only',
      project_type: null,
      creates_service_record: true,
      portal_visibility: 'internal_only',
      portal_attach_policy: 'never',
      followup_policy: 'none',
      active: true,
    });

    expect(profile).toMatchObject({
      serviceKey: 'lawn_inspection',
      serviceName: 'Waves Assessment',
      completionMode: 'internal_only',
      findingsType: null,
      projectType: null,
      projectBacked: false,
      requiresProject: false,
      createsServiceRecord: true,
      portalVisibility: 'internal_only',
      portalAttachPolicy: 'never',
    });
  });

  describe('resolveCompletionDeliveryPosture', () => {
    test('internal-only consultation forces disabled delivery and suppresses comms', () => {
      const posture = resolveCompletionDeliveryPosture({
        typedFindingsType: null,
        completionMode: 'internal_only',
      });
      expect(posture).toEqual({
        typedDeliveryMode: 'disabled',
        suppressCustomerComms: true,
        isInternalOnly: true,
      });
    });

    test('routine non-typed completion auto-sends', () => {
      const posture = resolveCompletionDeliveryPosture({
        typedFindingsType: null,
        completionMode: 'service_report',
      });
      expect(posture).toEqual({
        typedDeliveryMode: 'auto_send',
        suppressCustomerComms: false,
        isInternalOnly: false,
      });
    });

    test('typed completion is unaffected by internal-only branch and honors profile delivery_mode', () => {
      expect(resolveCompletionDeliveryPosture({
        typedFindingsType: 'one_time_lawn_treatment',
        completionMode: 'service_report',
        profileDeliveryMode: 'auto_send',
      })).toEqual({
        typedDeliveryMode: 'auto_send',
        suppressCustomerComms: false,
        isInternalOnly: false,
      });

      expect(resolveCompletionDeliveryPosture({
        typedFindingsType: 'one_time_lawn_treatment',
        completionMode: 'service_report',
        profileDeliveryMode: 'internal_only',
      })).toEqual({
        typedDeliveryMode: 'internal_only',
        suppressCustomerComms: true,
        isInternalOnly: false,
      });
    });

    test('global specialty kill env disables typed delivery', () => {
      const posture = resolveCompletionDeliveryPosture({
        typedFindingsType: 'pest_inspection',
        completionMode: 'service_report',
        profileDeliveryMode: 'auto_send',
        specialtyDeliveryDisabled: true,
      });
      expect(posture).toMatchObject({ typedDeliveryMode: 'disabled', suppressCustomerComms: true });
    });

    test('completion_mode internal_only is ignored when a typed findings type is present', () => {
      // A typed findings type always wins — internal_only only applies to the
      // non-typed routine path, so a (hypothetical) typed + internal_only row
      // must not be treated as a consultation.
      const posture = resolveCompletionDeliveryPosture({
        typedFindingsType: 'pest_inspection',
        completionMode: 'internal_only',
        profileDeliveryMode: 'auto_send',
      });
      expect(posture.isInternalOnly).toBe(false);
      expect(posture.typedDeliveryMode).toBe('auto_send');
    });
  });

  test('resolves a scheduled service through services.service_key to profile table', async () => {
    const knex = makeKnex({
      service: {
        service_key: 'wildlife_trapping',
        name: 'Wildlife Trapping Service',
        category: 'specialty',
        billing_type: 'one_time',
      },
      profile: {
        service_key: 'wildlife_trapping',
        service_name_snapshot: 'Wildlife Trapping Service',
        category: 'specialty',
        billing_type: 'one_time',
        completion_mode: 'project_required',
        project_type: 'wildlife_trapping',
        creates_service_record: true,
        portal_visibility: 'token_only',
        portal_attach_policy: 'recurring_customer',
        followup_policy: 'alert',
        default_followup_days: 1,
        active: true,
      },
    });

    const profile = await resolveCompletionProfileForScheduledService({
      id: 'svc-1',
      service_id: 'catalog-1',
      service_type: 'Wildlife Trapping Service',
    }, knex);

    expect(profile).toMatchObject({
      serviceKey: 'wildlife_trapping',
      projectType: 'wildlife_trapping',
      projectBacked: true,
      defaultFollowupDays: 1,
    });
    expect(knex.schema.hasTable).toHaveBeenCalledWith('service_completion_profiles');
  });

  test('falls back to standard service report when profile table is unavailable', async () => {
    const knex = makeKnex({
      hasTable: false,
      service: {
        service_key: 'pest_general_quarterly',
        name: 'Quarterly Pest Control Service',
        category: 'pest_control',
        billing_type: 'recurring',
      },
    });

    const profile = await resolveCompletionProfileForScheduledService({
      service_id: 'catalog-1',
      service_type: 'Quarterly Pest Control Service',
    }, knex);

    expect(profile).toMatchObject({
      completionMode: 'service_report',
      projectBacked: false,
      requiresProject: false,
      serviceKey: 'pest_general_quarterly',
    });
  });

  test('resolves imported service labels with a trailing Service suffix', async () => {
    const knex = makeKnex({
      serviceResults: [
        null,
        {
          service_key: 'pest_rodent_quarterly',
          name: 'Pest & Rodent Control',
          category: 'pest_control',
          billing_type: 'recurring',
        },
      ],
      profile: {
        service_key: 'pest_rodent_quarterly',
        service_name_snapshot: 'Pest & Rodent Control',
        category: 'pest_control',
        billing_type: 'recurring',
        completion_mode: 'service_report',
        project_type: null,
        creates_service_record: true,
        portal_visibility: 'customer_portal',
        portal_attach_policy: 'active_portal_customer',
        followup_policy: 'none',
        active: true,
        companion_types: [{ type: 'rodent_bait_station', delivery: 'internal_only' }],
      },
    });

    const profile = await resolveCompletionProfileForScheduledService({
      id: 'svc-1',
      service_type: 'Pest & Rodent Control Service',
    }, knex);

    expect(profile).toMatchObject({
      serviceKey: 'pest_rodent_quarterly',
      serviceName: 'Pest & Rodent Control',
      companions: [{ type: 'rodent_bait_station', delivery: 'internal_only' }],
    });
  });

  test('normalizes spelled-out combined service suffix labels', async () => {
    const knex = makeKnex({
      serviceResults: [
        null,
        null,
        {
          service_key: 'pest_rodent_quarterly',
          name: 'Pest & Rodent Control',
          category: 'pest_control',
          billing_type: 'recurring',
        },
      ],
      profile: {
        service_key: 'pest_rodent_quarterly',
        service_name_snapshot: 'Pest & Rodent Control',
        category: 'pest_control',
        billing_type: 'recurring',
        completion_mode: 'service_report',
        project_type: null,
        creates_service_record: true,
        portal_visibility: 'customer_portal',
        portal_attach_policy: 'active_portal_customer',
        followup_policy: 'none',
        active: true,
        companion_types: [{ type: 'rodent_bait_station', delivery: 'internal_only' }],
      },
    });

    const profile = await resolveCompletionProfileForScheduledService({
      id: 'svc-1',
      service_type: 'Pest and Rodent Control Service',
    }, knex);

    expect(profile).toMatchObject({
      serviceKey: 'pest_rodent_quarterly',
      serviceName: 'Pest & Rodent Control',
      companions: [{ type: 'rodent_bait_station', delivery: 'internal_only' }],
    });
  });

  test('does not use suffix-stripped labels for short-name matches', async () => {
    const knex = makeKnex({ serviceResults: [null, null, null] });

    const profile = await resolveCompletionProfileForScheduledService({
      id: 'svc-1',
      service_type: 'Lawn Care Service',
    }, knex);

    expect(profile).toMatchObject({
      serviceKey: null,
      serviceName: 'Lawn Care Service',
      completionMode: 'service_report',
    });
    expect(knex._whereRawCalls).toContainEqual({
      table: 'services',
      sql: 'lower(short_name) = lower(?)',
      bindings: ['Lawn Care Service'],
    });
    expect(knex._whereRawCalls).not.toContainEqual({
      table: 'services',
      sql: 'lower(short_name) = lower(?)',
      bindings: ['Lawn Care'],
    });
  });

  // 2026-08-25 catalog renames: every service name gained a " Service"
  // suffix, while engine lines and older booking labels still carry the
  // bare form. The resolver appends a " Service" candidate (mirror of the
  // long-standing strip) so those labels keep resolving the renamed rows.
  test('a bare label resolves the suffix-renamed catalog row via the appended " Service" candidate', async () => {
    const renamedRow = {
      service_key: 'cockroach_control',
      name: 'Cockroach Treatment Service',
      category: 'pest_control',
      billing_type: 'one_time',
    };
    // exact-name queue: 'Cockroach Treatment' misses, appended candidate hits.
    const knex = makeKnex({ serviceResults: [null, renamedRow] });

    const profile = await resolveCompletionProfileForScheduledService({
      id: 'svc-1',
      service_type: 'Cockroach Treatment',
    }, knex);

    expect(profile).toMatchObject({
      serviceKey: 'cockroach_control',
      serviceName: 'Cockroach Treatment Service',
    });
    expect(knex._whereRawCalls).toContainEqual({
      table: 'services',
      sql: 'lower(name) = lower(?)',
      bindings: ['Cockroach Treatment Service'],
    });
  });

  // Names with a trailing qualifier were renamed with " Service" BEFORE the
  // parenthetical (the 20260507000002 shape) — the bridge must produce that
  // form, not just the plain append (codex pre-push P1, 2026-08-25).
  test('a parenthetical-qualified label resolves the "X Service (Y)" renamed row', async () => {
    const renamedRow = {
      service_key: 'german_roach_initial',
      name: 'German Roach Initial Service (3-Visit)',
      category: 'pest_control',
      billing_type: 'one_time',
    };
    // queue: raw misses, plain append misses, paren-inserted candidate hits.
    const knex = makeKnex({ serviceResults: [null, null, renamedRow] });

    const profile = await resolveCompletionProfileForScheduledService({
      id: 'svc-1',
      service_type: 'German Roach Initial (3-Visit)',
    }, knex);

    expect(profile).toMatchObject({
      serviceKey: 'german_roach_initial',
      serviceName: 'German Roach Initial Service (3-Visit)',
    });
    expect(knex._whereRawCalls).toContainEqual({
      table: 'services',
      sql: 'lower(name) = lower(?)',
      bindings: ['German Roach Initial Service (3-Visit)'],
    });
  });

  // The foam renames are NOT suffix-only, so they get explicit aliases:
  // reserved foam rows carry no service_id by design (20260808070000) and
  // legacy-labeled holds can commit after the rename migration runs.
  test('legacy foam labels resolve the renamed foam rows via explicit aliases', async () => {
    const cases = [
      ['Recurring Foam Treatment', {
        service_key: 'foam_recurring',
        name: 'Recurring Termite Foam Service',
        category: 'termite',
        billing_type: 'recurring',
      }],
      ['Drill-and-Foam Termite', {
        service_key: 'foam_drill',
        name: 'Termite Foam Service',
        category: 'termite',
        billing_type: 'one_time',
      }],
    ];
    for (const [legacyLabel, renamedRow] of cases) {
      // queue: raw misses, appended " Service" candidate misses, alias hits.
      const knex = makeKnex({ serviceResults: [null, null, renamedRow] });
      const profile = await resolveCompletionProfileForScheduledService({
        id: 'svc-1',
        service_type: legacyLabel,
      }, knex);
      expect(profile).toMatchObject({
        serviceKey: renamedRow.service_key,
        serviceName: renamedRow.name,
      });
      expect(knex._whereRawCalls).toContainEqual({
        table: 'services',
        sql: 'lower(name) = lower(?)',
        bindings: [renamedRow.name],
      });
    }
  });

  // Strict resolution (the pre-visit brief hashes the resolved companion
  // list): every swallow point on the resolution path must rethrow under
  // { strict: true } — swallowed-to-default it resolves companions: []
  // and the caller persists an outage-shaped empty over cached guidance.
  // The fail-soft default stays for every other caller.
  describe('strict resolution', () => {
    // Chain where a chosen table's queries reject; everything else
    // resolves empty so the walk reaches the failing leg.
    function failingKnex({ failTable, failOn }) {
      const knex = jest.fn((table) => {
        const chain = {};
        chain.where = jest.fn(() => chain);
        chain.whereRaw = jest.fn(() => chain);
        chain.limit = jest.fn(() => chain);
        chain.first = jest.fn(async () => {
          if (table === failTable && failOn === 'first') throw new Error(`${failTable} down`);
          return null;
        });
        chain.select = jest.fn(async () => {
          if (table === failTable && failOn === 'select') throw new Error(`${failTable} down`);
          return [];
        });
        return chain;
      });
      knex.schema = { hasTable: jest.fn(async () => true) };
      return knex;
    }
    const AMBIGUOUS = { id: 'svc-1', service_type: 'Lawn Care' };

    test('schema-probe failure rethrows under strict, swallows by default', async () => {
      const knex = makeKnex({ service: { service_key: 'lawn_tree_shrub_combo', name: 'Lawn + Tree & Shrub', category: 'lawn', billing_type: 'recurring' } });
      knex.schema.hasTable = jest.fn(async () => { throw new Error('schema probe down'); });
      await expect(
        resolveCompletionProfileForScheduledService({ service_id: 'lib-1' }, knex, { strict: true }),
      ).rejects.toThrow('schema probe down');
      const soft = await resolveCompletionProfileForScheduledService({ service_id: 'lib-1' }, knex);
      expect(soft.companions).toEqual([]);
    });

    test('short-name collision-query outage rethrows under strict, swallows by default', async () => {
      const knex = failingKnex({ failTable: 'services', failOn: 'select' });
      await expect(
        resolveCompletionProfileForScheduledService(AMBIGUOUS, knex, { strict: true }),
      ).rejects.toThrow('services down');
      const soft = await resolveCompletionProfileForScheduledService(AMBIGUOUS, failingKnex({ failTable: 'services', failOn: 'select' }));
      expect(soft.companions).toEqual([]);
    });

    test('identity-evidence reload outage rethrows under strict, swallows by default', async () => {
      const knex = failingKnex({ failTable: 'scheduled_services', failOn: 'first' });
      await expect(
        resolveCompletionProfileForScheduledService(AMBIGUOUS, knex, { strict: true }),
      ).rejects.toThrow('scheduled_services down');
      const soft = await resolveCompletionProfileForScheduledService(AMBIGUOUS, failingKnex({ failTable: 'scheduled_services', failOn: 'first' }));
      expect(soft.companions).toEqual([]);
    });
  });
});
