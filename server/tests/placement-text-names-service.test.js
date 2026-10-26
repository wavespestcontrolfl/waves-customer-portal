// Owner 2026-10-26: the recurring placement text names the service, so a
// customer with a pest series and a mosquito series can tell the two apart.
const migration = require('../models/migrations/20261026160000_placement_text_names_service');
const tighten = require('../models/migrations/20261006220000_sms_template_tighten');
const { placementServiceName, isCleanServiceName } = require('../services/placement-service-name');
const { normalizeGsmPunctuation } = require('../services/messaging/gsm-normalize');
const { stripSmsUrlScheme } = require('../services/messaging/sms-link-policy');
const { countSegments } = require('../services/messaging/segment-counter');

jest.mock('../services/appointment-reminders', () => ({ buildServiceLabel: jest.fn() }));
const reminders = require('../services/appointment-reminders');

const KEY = 'appointment_recurring_placement_confirmed';
const [, TIGHTEN_BEFORE, TIGHTEN_AFTER] = tighten._SWAPS.find(([key]) => key === KEY);
const OLD_VARIABLES = ['first_name', 'start_date', 'window_text'];

// Same substitution getTemplate does for plain vars.
const render = (body, vars) => body.replace(/\{(\w+)\}/g, (_, key) => vars[key]);

describe('copy', () => {
  test('starts from exactly the body the 10-06 tighten pass left', () => {
    expect(migration._BEFORE).toBe(TIGHTEN_AFTER);
    expect(TIGHTEN_BEFORE).not.toBe(migration._BEFORE);
  });

  test('uses the owner-approved wording and adds only {service_name}', () => {
    expect(migration._AFTER).toBe(
      "Hi {first_name}, your next Waves {service_name} is {start_date}{window_text}.\n\nYou'll get a reminder before each visit.",
    );
    const names = (body) => [...body.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    expect(names(migration._AFTER).sort()).toEqual([...names(migration._BEFORE), 'service_name'].sort());
    expect(migration._AFTER).toMatch(/^[\n\x20-\x7E]+$/);
  });

  test('a mosquito anchor reads with its service name; no clean name reads as before', () => {
    const base = { first_name: 'Jordan', start_date: 'Friday, Oct 30', window_text: ', 12:00 PM - 2:00 PM' };
    expect(render(migration._AFTER, { ...base, service_name: 'Monthly Mosquito Control Service' })).toBe(
      "Hi Jordan, your next Waves Monthly Mosquito Control Service is Friday, Oct 30, 12:00 PM - 2:00 PM.\n\nYou'll get a reminder before each visit.",
    );
    expect(render(migration._AFTER, { ...base, service_name: 'visit' })).toBe(
      render(migration._BEFORE, base),
    );
  });

  test('stays in the segment count the old text had at typical and long lengths', () => {
    const flat = (text) => countSegments(normalizeGsmPunctuation(stripSmsUrlScheme(text)));
    const typical = { first_name: 'Jordan', start_date: 'Friday, Oct 30', window_text: ', 12:00 PM - 2:00 PM' };
    expect(flat(render(migration._AFTER, { ...typical, service_name: 'Quarterly Pest Control Service' })).segmentCount)
      .toBeLessThanOrEqual(flat(render(migration._BEFORE, typical)).segmentCount);
    const long = { first_name: 'Longtestname', start_date: 'Wednesday, Sep 30', window_text: ', 12:00 PM - 2:00 PM' };
    const rendered = flat(render(migration._AFTER, { ...long, service_name: 'Monthly Mosquito Control Service' }));
    expect(rendered.encoding).toBe('GSM_7');
    expect(rendered.segmentCount).toBe(1);
  });
});

describe('service name lookup', () => {
  beforeEach(() => reminders.buildServiceLabel.mockReset());

  test('uses the reminders label for a clean service type', async () => {
    reminders.buildServiceLabel.mockResolvedValue('Monthly Mosquito Control Service');
    await expect(placementServiceName('visit-1', 'Monthly Mosquito Control Service'))
      .resolves.toBe('Monthly Mosquito Control Service');
    expect(reminders.buildServiceLabel).toHaveBeenCalledWith('visit-1', 'Monthly Mosquito Control Service');
  });

  test.each([
    'I6TSOQXQWTGW6UMLL2XATXDU', '- 1 hour - $117', '$89.00', '', null, undefined, 'service', 'QWERTYUIOPASDF',
  ])('falls back to "visit" for the junk value %j', async (raw) => {
    reminders.buildServiceLabel.mockResolvedValue(raw);
    await expect(placementServiceName('visit-1', raw)).resolves.toBe('visit');
  });

  test('falls back to "visit" when the label is junk or the lookup fails', async () => {
    reminders.buildServiceLabel.mockResolvedValue('service');
    await expect(placementServiceName('visit-1', 'Quarterly Pest Control')).resolves.toBe('visit');
    reminders.buildServiceLabel.mockRejectedValue(new Error('db down'));
    await expect(placementServiceName('visit-1', 'Quarterly Pest Control')).resolves.toBe('visit');
  });

  test('real names stay clean', () => {
    for (const name of ['Quarterly Pest Control Service', 'Tree & Shrub Care', 'WDO Inspection', 'Mosquito', 'Rodent Trapping, Exclusion & Sanitation Service']) {
      expect(isCleanServiceName(name)).toBe(true);
    }
  });
});

describe('migration guard', () => {
  // In-memory sms_templates + sms_template_variants; audit_log absent.
  function makeKnex(tables) {
    const knex = (table) => {
      let filter = () => true;
      const query = {
        where(cond) { const prev = filter; filter = (r) => prev(r) && Object.entries(cond).every(([k, v]) => r[k] === v); return query; },
        select() { return Promise.resolve(tables[table].filter(filter).map((r) => ({ ...r }))); },
        update(patch) {
          const hit = tables[table].filter(filter);
          hit.forEach((r) => Object.assign(r, patch));
          return Promise.resolve(hit.length);
        },
      };
      return query;
    };
    knex.fn = { now: () => 'now()' };
    knex.schema = { hasTable: async (name) => name in tables };
    return knex;
  }
  const row = (body, variables = OLD_VARIABLES) => ({ id: 1, template_key: KEY, body, variables: JSON.stringify(variables) });

  test('up swaps the exact old body and adds service_name to the variable list', async () => {
    const tables = { sms_templates: [row(migration._BEFORE)], sms_template_variants: [{ id: 9, template_key: KEY, body: migration._BEFORE }] };
    await migration.up(makeKnex(tables));
    expect(tables.sms_templates[0].body).toBe(migration._AFTER);
    expect(JSON.parse(tables.sms_templates[0].variables)).toEqual([...OLD_VARIABLES, 'service_name']);
    expect(tables.sms_template_variants[0].body).toBe(migration._AFTER);
  });

  test('up leaves a staff-edited body and its variables alone', async () => {
    const tables = { sms_templates: [row('Hi {first_name}, staff wording {start_date}{window_text}.')] };
    await migration.up(makeKnex(tables));
    expect(tables.sms_templates[0].body).toBe('Hi {first_name}, staff wording {start_date}{window_text}.');
    expect(JSON.parse(tables.sms_templates[0].variables)).toEqual(OLD_VARIABLES);
  });

  test('up twice is a no-op the second time', async () => {
    const tables = { sms_templates: [row(migration._BEFORE)] };
    await migration.up(makeKnex(tables));
    await migration.up(makeKnex(tables));
    expect(tables.sms_templates[0].body).toBe(migration._AFTER);
    expect(JSON.parse(tables.sms_templates[0].variables)).toEqual([...OLD_VARIABLES, 'service_name']);
  });

  test('down restores the old body only from the new body', async () => {
    const tables = { sms_templates: [row(migration._AFTER, [...OLD_VARIABLES, 'service_name'])] };
    await migration.down(makeKnex(tables));
    expect(tables.sms_templates[0].body).toBe(migration._BEFORE);
    expect(JSON.parse(tables.sms_templates[0].variables)).toEqual(OLD_VARIABLES);

    const edited = { sms_templates: [row('Staff edit {service_name}', [...OLD_VARIABLES, 'service_name'])] };
    await migration.down(makeKnex(edited));
    expect(edited.sms_templates[0].body).toBe('Staff edit {service_name}');
  });

  test('no sms_templates table is a no-op', async () => {
    await expect(migration.up(makeKnex({}))).resolves.toBeUndefined();
  });
});
