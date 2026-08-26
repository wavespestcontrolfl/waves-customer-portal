/**
 * Careers funnel invariants:
 *   - validation fails closed (400) on missing name/phone/role.
 *   - unknown answer keys are dropped, not stored; answers are length-capped.
 *   - the insert touches ONLY job_applications — never customers or leads
 *     (call-pipeline job_applicant rule).
 *   - the AI screen maps only well-formed results (score range +
 *     recommendation enum) — a malformed screen stores nothing rather than
 *     a garbage ranking.
 *   - the new_job_application bell masks the applicant phone.
 */

const {
  normalizeAnswers,
  normalizeSource,
  createJobApplication,
  ANSWER_KEYS,
} = require('../services/job-applications');
const { __private: screenPrivate } = require('../services/job-application-screen');
const { TRIGGER_REGISTRY, __private: triggerPrivate } = require('../services/notification-triggers');

function mockDb() {
  const inserts = [];
  const database = (table) => {
    if (table !== 'job_applications') throw new Error(`unexpected table ${table}`);
    return {
      insert: (row) => ({
        returning: async () => {
          inserts.push(row);
          return [{ id: 'app-1', role: row.role, status: row.status, language: row.language, created_at: new Date() }];
        },
      }),
    };
  };
  database.inserts = inserts;
  return database;
}

const VALID_BODY = {
  name: 'jane doe',
  phone: '941-555-0142',
  email: 'jane@example.com',
  city: 'Venice',
  role: 'technician',
  language: 'en',
  answers: { experience: '2 years lawn crew', judgment_gate_code: 'Call the office, then the customer.' },
};

describe('normalizeAnswers', () => {
  test('keeps only known keys and caps length', () => {
    const long = 'x'.repeat(5000);
    const out = normalizeAnswers({
      experience: ' kept ',
      evil_key: 'dropped',
      availability: long,
      pay_expectation: 42,
      why_waves: '',
    });
    expect(out).toEqual({
      experience: 'kept',
      availability: 'x'.repeat(2000),
    });
    expect(Object.keys(out).every((k) => ANSWER_KEYS.includes(k))).toBe(true);
  });

  test('non-object input yields empty answers', () => {
    expect(normalizeAnswers(null)).toEqual({});
    expect(normalizeAnswers(['a'])).toEqual({});
    expect(normalizeAnswers('str')).toEqual({});
  });
});

describe('normalizeSource', () => {
  test('allowlists keys, caps length, null when empty', () => {
    expect(normalizeSource({ page_url: '/careers/apply', hack: 'x' }))
      .toEqual({ page_url: '/careers/apply' });
    expect(normalizeSource({ hack: 'x' })).toBeNull();
    expect(normalizeSource(undefined)).toBeNull();
  });
});

describe('createJobApplication', () => {
  test('valid application inserts one normalized job_applications row', async () => {
    const database = mockDb();
    const row = await createJobApplication({ body: VALID_BODY, database });
    expect(row.id).toBe('app-1');
    expect(database.inserts).toHaveLength(1);
    const inserted = database.inserts[0];
    expect(inserted.status).toBe('new');
    const contact = JSON.parse(inserted.contact_snapshot);
    expect(contact).toEqual({
      name: 'Jane Doe',
      phone: '+19415550142',
      email: 'jane@example.com',
      city: 'Venice',
    });
    expect(JSON.parse(inserted.answers)).toEqual(VALID_BODY.answers);
  });

  test('rejects missing name, bad phone, unknown role with 400', async () => {
    for (const bad of [
      { ...VALID_BODY, name: '' },
      { ...VALID_BODY, phone: '123' },
      { ...VALID_BODY, role: 'ceo' },
      { ...VALID_BODY, role: undefined },
    ]) {
      const database = mockDb();
      await expect(createJobApplication({ body: bad, database }))
        .rejects.toMatchObject({ status: 400 });
      expect(database.inserts).toHaveLength(0);
    }
  });

  test('unknown language falls back to en; es is kept', async () => {
    const database = mockDb();
    await createJobApplication({ body: { ...VALID_BODY, language: 'fr' }, database });
    expect(database.inserts[0].language).toBe('en');
    await createJobApplication({ body: { ...VALID_BODY, language: 'es' }, database });
    expect(database.inserts[1].language).toBe('es');
  });
});

describe('AI screen mapping', () => {
  const { mapScreen } = screenPrivate;

  test('well-formed screen maps with capped arrays', () => {
    const mapped = mapScreen({
      score: 82,
      recommendation: 'strong',
      strengths: ['a', 'b', 'c', 'd'],
      flags: [],
      summary: 'Solid outdoor-work history.',
    });
    expect(mapped).toMatchObject({ score: 82, recommendation: 'strong' });
    expect(mapped.strengths).toHaveLength(3);
  });

  test('malformed screens are rejected (never a garbage ranking)', () => {
    expect(mapScreen({ score: 182, recommendation: 'strong' })).toBeNull();
    expect(mapScreen({ score: 50, recommendation: 'hire_now' })).toBeNull();
    expect(mapScreen({ recommendation: 'weak' })).toBeNull();
  });
});

describe('new_job_application bell', () => {
  test('carries ZERO applicant PII — staff-wide fan-out vs requireAdmin queue', () => {
    const trigger = TRIGGER_REGISTRY.new_job_application;
    expect(trigger).toBeDefined();
    // Even a payload that (wrongly) includes PII must not surface it.
    const built = trigger.build({
      applicationId: 'app-1',
      role: 'technician',
      name: 'Jane Doe',
      phone: '941-555-0142',
      city: 'Venice',
    });
    expect(built.link).toBe('/admin/recruiting?application=app-1');
    const surface = `${built.title} ${built.body}`;
    expect(surface).not.toContain('Jane');
    expect(surface).not.toContain('0142');
    expect(surface).not.toContain('Venice');
  });

  test('push tag is per-application so pushes never collapse', () => {
    const tagA = triggerPrivate.pushTagFor('new_job_application', { applicationId: 'app-1' });
    const tagB = triggerPrivate.pushTagFor('new_job_application', { applicationId: 'app-2' });
    expect(tagA).not.toBe(tagB);
    expect(tagA).toContain('app-1');
  });
});
