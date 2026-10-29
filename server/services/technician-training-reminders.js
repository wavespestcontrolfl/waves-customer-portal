'use strict';

// Technician ID-card and training reminders (GATE_TECH_TRAINING_DATES, dark). Once a day, in the 6 a.m. ET compliance slot,
// this raises ONE admin bell per technician per deadline and stage, and closes the bell when the matching date is entered.
// Deadlines (services/technician-training-dates.js; F.S. 482.091):
//   ID card application   14 days before, 3 days before, overdue   (30 days after the hire date)
//   Classroom hours       30 days before, 7 days before, overdue   (6 months after the card issue date)
//   Renewal training      30 days before the license expiry
// A deadline holds one stage at a time: the earlier stage's bell closes when the next one rings. The audience is the admin
// bell only. Nothing is sent to a technician or a customer, and nothing here touches who may be assigned field work.
// Gate off = every entry point returns before any query.
const db = require('../models/db');
const logger = require('./logger');
const { techTrainingDatesLive } = require('../config/feature-gates');
const { composeAdminAlert } = require('./admin-alert-compose');
const { closeAdminAlertKeys, openAdminAlertKeys, raiseAdminAlertWithReopen } = require('./admin-alert-episodes');
const { fitAction, shortDateET } = require('./admin-alert-names');
const { etDateString } = require('../utils/datetime-et');
const { daysBetween, idCardDeadline, classroomDeadline, renewalTrainingDeadline } = require('./technician-training-dates');

const LOG = '[technician-training-reminders]';
const AREA = 'System';
const CATEGORY = 'system';
const KEY_PREFIX = 'tech-training:';
const LINK = '/admin/compliance?tab=licenses';

// Stage thresholds in days left (a stage holds while the days left are at or under its number). Highest urgency first.
const DEADLINES = Object.freeze({
  idcard: Object.freeze({
    stages: [['overdue', -1], ['d3', 3], ['d14', 14]],
    doneWhen: 'id_card_applied',
    headline: [(n) => `file the ID card form for ${n}`, (n) => `file ${n}'s ID card form`, (n) => `file an ID card form for ${n}`],
    why: (due, left) => (left < 0 ? `ID card application was due ${due}, 30 days after hire.` : `ID card application is due ${due}, 30 days after hire.`),
  }),
  classroom: Object.freeze({
    stages: [['overdue', -1], ['d7', 7], ['d30', 30]],
    doneWhen: 'classroom_hours_done',
    headline: [(n) => `log the 4 classroom hours for ${n}`, (n) => `log ${n}'s classroom hours`, (n) => `log classroom hours for ${n}`],
    why: (due, left) => (left < 0 ? `The 4 classroom hours were due ${due}, 6 months after the card was issued.` : `The 4 classroom hours are due ${due}, 6 months after the card was issued.`),
  }),
  renewal: Object.freeze({
    stages: [['d30', 30]],
    doneWhen: 'renewal_training_done',
    headline: [(n) => `log the renewal training for ${n}`, (n) => `log ${n}'s renewal training`, (n) => `log renewal training for ${n}`],
    why: (due) => `The card renews ${due}; 2 hours of continuing training come first.`,
  }),
});

const keyFor = (deadline, techId, dueOn, stage) => `${KEY_PREFIX}${deadline}:${techId}:${dueOn}:${stage}`;

// The stage a deadline is in today, or null (done, no date, or still far off). An overdue stage ends on its own when the date is
// entered; a renewal reminder is only useful until the license itself lapses, so it stops at the expiry day.
function stageOf(deadline, dueOn, doneOn, today) {
  if (doneOn || !dueOn) return null;
  const left = daysBetween(today, dueOn);
  if (left === null) return null;
  if (deadline === 'renewal' && left < 0) return null;
  const hit = DEADLINES[deadline].stages.find(([name, atMost]) => (name === 'overdue' ? left < 0 : left >= 0 && left <= atMost));
  return hit ? hit[0] : null;
}

// Every live reminder for one technician row: [{ deadline, stage, dueOn, key }].
function dueReminders(tech, today) {
  const out = [];
  const add = (deadline, dueOn, done) => {
    const stage = stageOf(deadline, dueOn, done, today);
    if (stage) out.push({ deadline, stage, dueOn, key: keyFor(deadline, tech.id, dueOn, stage) });
  };
  const card = idCardDeadline({ hireDate: tech.hire_date, appliedOn: tech.id_card_applied_on, issuedOn: tech.id_card_issued_on, today });
  add('idcard', card.applicationDueOn, card.appliedOn || card.issuedOn);
  const classroom = classroomDeadline({ issuedOn: tech.id_card_issued_on, doneOn: tech.classroom_hours_done_on, today });
  add('classroom', classroom.dueOn, classroom.doneOn);
  const renewal = renewalTrainingDeadline({ licenseExpiry: tech.license_expiry, doneOn: tech.renewal_training_done_on, today });
  // The renewal date counts as done only for the current cycle (renewalTrainingDeadline decides that).
  add('renewal', renewal.dueBy, renewal.status === 'done' ? renewal.doneOn : null);
  return out;
}

function alertSpec(tech, reminder, today) {
  const def = DEADLINES[reminder.deadline];
  const left = daysBetween(today, reminder.dueOn);
  const due = shortDateET(new Date(`${reminder.dueOn}T12:00:00Z`));
  return {
    area: AREA,
    action: fitAction(AREA, tech.name, def.headline),
    why: def.why(due, left),
    severity: 'needs-you',
    link: LINK,
    subject: { type: 'check', id: String(tech.id) },
    // Closes itself once the matching date is entered on the Licenses tab.
    doneWhen: def.doneWhen,
    who: 'person',
  };
}

// The date columns a deadline reads, as 'YYYY-MM-DD' text (a pg DATE would arrive as a Date at server-local midnight).
const DATE_COLUMNS = ['hire_date', 'license_expiry', 'id_card_applied_on', 'id_card_issued_on', 'classroom_hours_done_on', 'renewal_training_done_on'];

// Active employees with a hire date. The owner's own row has none and is never listed.
function candidates(conn, technicianId) {
  const query = conn('technicians')
    .whereNotNull('hire_date')
    .where({ active: true, employment_status: 'active' })
    .select('id', 'name', ...DATE_COLUMNS.map((column) => conn.raw(`to_char(${column}, 'YYYY-MM-DD') as ${column}`)));
  return technicianId ? query.where({ id: technicianId }) : query;
}

// Close every open reminder (all technicians, or one) that is no longer in `wanted`.
async function closeStale(conn, wanted, technicianId) {
  const open = await openAdminAlertKeys(conn, KEY_PREFIX);
  const stale = open.filter((key) => !wanted.has(key) && (!technicianId || key.split(':')[2] === String(technicianId)));
  if (!stale.length) return 0;
  return closeAdminAlertKeys(conn, stale, 'training_date_entered', {
    resolution: 'The date was entered, the date moved, or the next reminder took over.',
  });
}

// closeOnly (used right after a save on the Licenses tab): close what the entered dates settled, raise nothing.
async function runTechnicianTrainingReminders({ conn = db, today = etDateString(), technicianId = null, closeOnly = false } = {}) {
  if (!techTrainingDatesLive()) return { skipped: 'gate_off' };
  const techs = await candidates(conn, technicianId);
  const wanted = new Set();
  const reminders = [];
  for (const tech of techs) {
    for (const reminder of dueReminders(tech, today)) {
      wanted.add(reminder.key);
      reminders.push({ tech, reminder });
    }
  }
  const closed = await closeStale(conn, wanted, technicianId);
  let raised = 0;
  if (!closeOnly) {
    for (const { tech, reminder } of reminders) {
      // With reopen: a reminder that closed because a date was entered rings again if that date is
      // later cleared (closeAdminAlertKeys marks the row auto-cleared; a plain notifyAdmin would
      // dedupe onto that closed row forever).
      const composed = composeAdminAlert(alertSpec(tech, reminder, today));
      const posted = await raiseAdminAlertWithReopen(CATEGORY, composed.headline, composed.why, {
        bell: true,
        dedupeKey: reminder.key,
        link: composed.link,
        metadata: { technicianId: tech.id, deadline: reminder.deadline, stage: reminder.stage, dueOn: reminder.dueOn, ...composed.metadata },
      });
      if (posted?.rang) raised += 1;
    }
  }
  if (raised || closed) logger.info(`${LOG} raised=${raised} closed=${closed}`);
  return { scanned: techs.length, raised, closed };
}

module.exports = {
  runTechnicianTrainingReminders,
  _private: { dueReminders, stageOf, keyFor, alertSpec, KEY_PREFIX },
};
