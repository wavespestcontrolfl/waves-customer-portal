const {
  resolveCompletionProfileForScheduledService,
  serializeProfile,
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
});
