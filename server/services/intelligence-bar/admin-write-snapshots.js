/**
 * Intelligence Bar general admin edit: the record snapshot behind each card.
 *
 * For every catalog edit this file holds ONE small read-only query set that
 * answers, for the record the path names:
 *   - a human label (who or what the card is about: never just a UUID);
 *   - the current value of every field an edit may carry (the card's "before",
 *     and the value the Confirm re-reads and compares);
 *   - the row's version (updated_at where the table has one);
 *   - the state the row is in (so a row may require, say, a draft).
 * admin-write-tools.js pins the label, the current values and the version in the
 * card, re-reads them at Confirm (refusing on any difference), and reads them
 * once more after the save to check the new value is really there.
 *
 * Read only: nothing here writes. A catalog row without a snapshot here cannot
 * be edited (admin-write-tools.js refuses it, and the catalog test fails).
 */
const db = (...args) => require('../../models/db')(...args);

const ET = 'America/New_York';
const text = value => (value === null || value === undefined ? '' : String(value));
// Only a column that holds JSON is decoded; text stays verbatim (a note that reads `"quoted"` or `123` is text).
const json = value => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
};
// A database value as plain JSON: a timestamp becomes its ISO string, so the card, the scrubber, the pin and the read-back all see one form.
const plain = value => (value instanceof Date ? value.toISOString() : value);
const dateOnly = value => (value instanceof Date ? value.toISOString().slice(0, 10) : text(value).slice(0, 10));
const etTime = value => (value ? new Date(value).toLocaleString('en-US', { timeZone: ET, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'no end time');
const fullName = c => [c?.first_name, c?.last_name].filter(Boolean).join(' ') || c?.company_name || 'a customer';

async function customerOf(id) {
  return id ? db('customers').where({ id }).first('first_name', 'last_name', 'company_name', 'deleted_at') : null;
}

// What confirming a timesheet edit also does (time-tracking.js adminEditEntry + recomputeEntryMutationSummaries):
// ANY edit, a notes-only one included, marks the entry edited and pending approval, and clears the
// technician's signature on every affected week that is not approved. The card says so, with the state
// it is in now; the lines are pinned, so a week signed or approved after the card was shown is a new card.
async function timesheetEffects(row, techName, body) {
  const { staffWorkDate, staffWeekStartForWorkDate } = require('../../utils/staff-time-work-date');
  const dates = [staffWorkDate(row.clock_in)];
  if (body.clock_in) dates.push(staffWorkDate(new Date(body.clock_in)));
  const lines = [`This marks the entry as edited and resets it to pending approval (it is now ${text(row.status)}, approval ${text(row.approval_status)}).`];
  for (const weekStart of [...new Set(dates.map(staffWeekStartForWorkDate))].sort()) {
    const weekly = await db('time_weekly_summary').where({ technician_id: row.technician_id, week_start: weekStart }).first('status', 'tech_signed_at');
    const signed = weekly?.tech_signed_at ? new Date(weekly.tech_signed_at).toLocaleDateString('en-US', { timeZone: ET, month: 'short', day: 'numeric', year: 'numeric' }) : null;
    if (weekly?.status === 'approved') {
      lines.push(`The week of ${weekStart} is approved (${signed ? `signed ${signed}` : 'not signed'}): the timesheet screen refuses this edit until the week is unlocked.`);
    } else if (signed) {
      lines.push(`This clears ${techName}'s signed week of ${weekStart} (signed ${signed}): they must sign again.`);
    } else {
      lines.push(`${techName} has not signed the week of ${weekStart}, so no signature is cleared (week status ${text(weekly?.status) || 'not summarized yet'}).`);
    }
    const dayDates = dates.filter(d => staffWeekStartForWorkDate(d) === weekStart);
    for (const workDate of [...new Set(dayDates)].sort()) {
      const daily = await db('time_entry_daily_summary').where({ technician_id: row.technician_id, work_date: workDate }).first('status');
      if (daily?.status === 'approved') lines.push(`The day ${workDate} is approved: the timesheet screen refuses this edit until the day is reopened.`);
    }
  }
  return lines;
}

// A field map: body key -> column. A snapshot's `current` holds each mapped
// column's value for the body keys the edit carries.
const SNAPSHOTS = {
  'PUT /admin/sms-templates/:id': {
    fields: { body: 'body', name: 'name' },
    async load(p) {
      const row = await db('sms_templates').where({ id: p.id }).first();
      return row && { row, label: `Text message template "${text(row.name)}" (${text(row.template_key)})` };
    },
  },
  'PUT /admin/email-templates/:key': {
    fields: { name: 'name', description: 'description' },
    async load(p) {
      const row = await db('email_templates').where({ template_key: p.key }).first();
      return row && { row, label: `Email template "${text(row.name)}" (${text(row.template_key)})` };
    },
  },
  'PUT /admin/email-templates/versions/:id': {
    fields: { subject: 'subject', previewText: 'preview_text', textBody: 'text_body', blocks: 'blocks' },
    jsonFields: ['blocks'],
    async load(p) {
      const row = await db('email_template_versions').where({ id: p.id }).first();
      if (!row) return null;
      const template = await db('email_templates').where({ id: row.template_id }).first('name', 'template_key');
      return {
        row,
        label: `Email template "${text(template?.name)}" (${text(template?.template_key)}), version ${text(row.version_number)} (${text(row.status)}), subject "${text(row.subject)}"`,
        state: { status: row.status },
      };
    },
    // The same canonical blocks the screen saves (EmailTemplates.normalizeBlocks): the card shows and pins THIS value.
    normalize(body) {
      if (body.blocks === undefined) return body;
      const { normalizeBlocks } = require('../email-template-library');
      return { ...body, blocks: normalizeBlocks(body.blocks) };
    },
  },
  'PUT /admin/email-templates/fixtures/:id': {
    fields: { name: 'name', payload: 'payload' },
    jsonFields: ['payload'],
    async load(p) {
      const row = await db('email_template_fixtures').where({ id: p.id }).first();
      if (!row) return null;
      const template = await db('email_templates').where({ id: row.template_id }).first('name', 'template_key');
      return { row, label: `Preview data "${text(row.name)}" for email template "${text(template?.name)}" (${text(template?.template_key)})` };
    },
  },
  'PUT /admin/automations/steps/:id': {
    fields: { subject: 'subject', previewText: 'preview_text', htmlBody: 'html_body', textBody: 'text_body' },
    async load(p) {
      const row = await db('automation_steps').where({ id: p.id }).first();
      return row && { row, label: `Email automation "${text(row.template_key)}", step ${text(row.step_order)}, subject "${text(row.subject)}"` };
    },
  },
  'PUT /admin/timetracking/entries/:id': {
    fields: { clock_in: 'clock_in', clock_out: 'clock_out', entry_type: 'entry_type', notes: 'notes', edit_reason: 'edit_reason' },
    async load(p, body = {}) {
      const row = await db('time_entries').where({ id: p.id }).first();
      if (!row) return null;
      const tech = await db('technicians').where({ id: row.technician_id }).first('name');
      const techName = text(tech?.name) || 'The technician';
      const day = new Date(row.clock_in).toLocaleDateString('en-US', { timeZone: ET, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      return {
        row,
        label: `${techName}: ${text(row.entry_type)} entry on ${day}, ${etTime(row.clock_in)} to ${etTime(row.clock_out)} ET (${text(row.status)}, ${text(row.approval_status)})`,
        effects: await timesheetEffects(row, techName, body),
      };
    },
  },
  'PUT /admin/customers/:id/notification-prefs': {
    fields: {
      autoFlipEnRoute: 'auto_flip_en_route', paymentConfirmationSms: 'payment_confirmation_sms', appointmentNotifyPrimary: 'appointment_notify_primary',
      serviceReportNotifyPrimary: 'service_report_notify_primary', serviceReportNotifyBilling: 'service_report_notify_billing',
    },
    async load(p) {
      const customer = await customerOf(p.id);
      if (!customer || customer.deleted_at) return null;
      const row = await db('notification_prefs').where({ customer_id: p.id }).first();
      // With no saved row the screen's save first seeds the defaults (confirmations, reminders, en-route and
      // completed texts, SMS and email, payment confirmations) and then applies the patch: a much bigger change
      // than the card could show. Refused; the preferences are set on the customer page first.
      if (!row) {
        return { blocked: {
          error: `${fullName(customer)} has no text preferences saved yet. Setting the first one would also switch on the default texts and emails, which this card cannot show. Set their preferences on the customer page first. Nothing was proposed.`,
          code: 'capability_unimplemented',
        } };
      }
      return { row, label: `${fullName(customer)}: text and report preferences` };
    },
  },
  'PATCH /admin/dispatch/:serviceId/note': {
    fields: { notes: 'notes' },
    async load(p) {
      const row = await db('scheduled_services').where({ id: p.serviceId }).first();
      if (!row) return null;
      const customer = await customerOf(row.customer_id);
      return { row, label: `${fullName(customer)}: ${text(row.service_type) || 'visit'} on ${dateOnly(row.scheduled_date)}` };
    },
  },
  'PUT /admin/inventory/service-usage/:id': {
    fields: { notes: 'notes' },
    async load(p) {
      const row = await db('service_product_usage').where({ id: p.id }).first();
      if (!row) return null;
      const product = await db('products_catalog').where({ id: row.product_id }).first('name');
      return { row, label: `Product use: ${text(product?.name) || 'a product'} for ${text(row.service_type)}` };
    },
  },
};

// { label, current: { bodyKey: value }, version, state } for the record, or null
// when it does not exist. Throws when the database cannot be read.
async function loadSnapshot(key, pathParams, bodyKeys, body = {}) {
  const spec = SNAPSHOTS[key];
  if (!spec) return { unsupported: true };
  const found = await spec.load(pathParams, body);
  if (!found) return null;
  if (found.blocked) return { blocked: found.blocked };
  const current = {};
  for (const bodyKey of bodyKeys) {
    const value = plain(found.row[spec.fields[bodyKey]]);
    current[bodyKey] = (spec.jsonFields || []).includes(bodyKey) ? json(value) : value;
    if (current[bodyKey] === undefined) current[bodyKey] = null;
  }
  const stamp = found.row.updated_at;
  return {
    label: found.label, current, state: found.state || {}, effects: found.effects || [],
    version: stamp ? new Date(stamp).toISOString() : null,
  };
}

// The body in the form the request carries and the database keeps: through JSON, so a field the
// screen's normalizer leaves undefined is gone from the card, the pin, the request and the read-back alike.
function normalizeBody(key, body) {
  const spec = SNAPSHOTS[key];
  return spec?.normalize ? JSON.parse(JSON.stringify(spec.normalize(body))) : body;
}

function hasSnapshot(key) {
  return Object.hasOwn(SNAPSHOTS, key);
}

// Does the stored value equal what the edit set? Compared the way the stored
// value is read back: text by trimmed content (an empty value equals none), a
// date-time by instant, a list or object by its canonical JSON.
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}

function sameValue(expected, actual, spec = {}) {
  // The catalog field type decides: only a datetime field is compared as an instant; text is always text.
  if (spec.type === 'datetime' && (actual instanceof Date || typeof actual === 'string')) {
    return new Date(expected).getTime() === new Date(actual).getTime();
  }
  if (typeof expected === 'string' || expected === null) return text(expected).trim() === text(actual).trim();
  if (typeof expected === 'object') return stable(JSON.parse(JSON.stringify(expected))) === stable(JSON.parse(JSON.stringify(typeof actual === 'string' ? json(actual) : actual)));
  return expected === actual;
}

module.exports = { loadSnapshot, normalizeBody, hasSnapshot, sameValue, SNAPSHOT_KEYS: Object.keys(SNAPSHOTS) };
