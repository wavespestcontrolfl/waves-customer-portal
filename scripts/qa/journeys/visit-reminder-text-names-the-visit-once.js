'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { etDateString, addETDays, parseETDateTime, formatETDay, formatETDate } = require('../../../server/utils/datetime-et');
const { spokenArrivalWindow } = require('../../../server/utils/sms-time-format');
const { insertVisit } = require('../fixtures');

// A visit two days out, booked a week ago, is inside the three-day reminder band. The scheduler's reminder job texts the
// customer the day and arrival window of the visit row, once, and a second pass sends nothing.
module.exports = {
  name: 'visit-reminder-text-names-the-visit-once',
  async run(ctx) {
    const { db, fixture, runJob } = ctx;
    const captured = () => fs.readFileSync(ctx.captureFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const before = captured().length;
    const texts = () => captured().slice(before).filter((entry) => entry.kind === 'sms');
    const id = fixture.reminderAppointmentId;
    const reminderRow = async () => db('appointment_reminders').where({ scheduled_service_id: id }).first();

    // Noon ET two days from today is 36 to 60 hours away at any hour of the day, whatever the run time or daylight saving.
    const date = etDateString(addETDays(new Date(), 2));
    await insertVisit(db, fixture, { id, scheduledDate: date, windowStart: '12:00:00', created_at: addETDays(new Date(), -7) });
    assert.equal(await reminderRow(), undefined, 'The visit starts with no reminder row, as a booking outside the booking paths does');

    // The visit row is the source of the words: read it back, then compute the day, date and window with the ET helpers.
    const visit = await db('scheduled_services').where({ id }).first('scheduled_date', 'window_start', 'service_type', db.raw('scheduled_date::text as date_text'));
    assert.equal(visit.date_text, date);
    const apptTime = parseETDateTime(`${visit.date_text}T${String(visit.window_start).slice(0, 8)}`);
    const hoursAway = (apptTime.getTime() - Date.now()) / 3600000;
    assert.ok(hoursAway > 25 && hoursAway < 72, `The visit sits in the 72-hour reminder band (${hoursAway.toFixed(1)} hours away)`);
    const expectedWhen = `${formatETDay(apptTime)}, ${formatETDate(apptTime)}, ${spokenArrivalWindow(String(visit.window_start).slice(0, 5))}`;

    // The sweep runs over the whole (private, per-run) QA database. Any reminder it sends for another visit fails the
    // exact counts below, so a stray visit can only fail this journey, never let it pass.
    // 1. The first pass registers the visit's reminder and texts it.
    const first = await runJob('appointment-reminders');
    assert.equal(first.errors, 0);
    assert.equal(first.sent72h, 1, 'The job reports one 72-hour reminder sent');
    assert.equal(texts().length, 1, 'Exactly one text goes out');
    const [text] = texts();
    assert.equal(text.to, fixture.phone);
    // The fake transport only sees the phone, which the sibling fixture shares; the app's own log names the customer.
    const logged = await db('sms_log').where({ twilio_sid: text.sid, direction: 'outbound' });
    assert.equal(logged.length, 1, 'The reminder is logged once');
    assert.equal(logged[0].customer_id, fixture.customerId, 'The app records the reminder against this customer');
    assert.ok(text.body.includes(expectedWhen), `The text names the visit's day, date and arrival window: ${expectedWhen} in ${JSON.stringify(text.body)}`);
    // The reminder drops a trailing cadence label such as "(Quarterly)" from the catalog name; the rest must appear.
    const serviceLabel = String(visit.service_type).replace(/\s*\([^)]*\)\s*$/, '');
    assert.ok(serviceLabel.length > 0 && text.body.includes(serviceLabel), `The text names the service: ${serviceLabel}`);
    const sent = await reminderRow();
    assert.equal(sent.reminder_72h_sent, true);
    assert.ok(sent.reminder_72h_sent_at, 'The sent stamp is committed');
    assert.equal(sent.reminder_24h_sent, false, 'The day-before reminder is still to come');
    assert.equal(sent.cancelled, false);
    assert.equal(new Date(sent.appointment_time).getTime(), apptTime.getTime(), 'The reminder row holds the visit row\'s time');

    // 2. A second pass over the same data sends nothing and rewrites no stamp.
    const second = await runJob('appointment-reminders');
    assert.equal(second.errors, 0);
    assert.equal(second.sent72h, 0);
    assert.equal(second.sent24h, 0);
    const after = await reminderRow();
    const ms = (value) => (value == null ? null : new Date(value).getTime());
    assert.deepEqual({ id: after.id, sent: after.reminder_72h_sent, at: ms(after.reminder_72h_sent_at), updated: ms(after.updated_at) },
      { id: sent.id, sent: true, at: ms(sent.reminder_72h_sent_at), updated: ms(sent.updated_at) }, 'The second pass rewrites no stamp');
    assert.equal(texts().length, 1, 'Still one text after the second pass');
    return { date, expectedWhen, body: text.body, firstPass: first, secondPass: second };
  },
};
