'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { etDateString } = require('../../../server/utils/datetime-et');
const { insertVisit } = require('../fixtures');

// The office completes a visit with the completion text on. One text goes to the customer: it names the service, links the
// report of this visit (and the invoice the visit billed), and neither a replay nor a second request texts again.
module.exports = {
  name: 'completion-text-names-service-and-report-once',
  async run(ctx) {
    const { page, db, fixture, baseUrl, json } = ctx;
    const captured = () => fs.readFileSync(ctx.captureFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const before = captured().length;
    const texts = () => captured().slice(before).filter((entry) => entry.kind === 'sms');
    const id = fixture.completionTextAppointmentId;
    const endpoint = `${baseUrl}/api/admin/dispatch/${id}/complete`;
    const key = `${fixture.runId}-completion-text`;
    const request = (idempotencyKey) => ({ headers: { Authorization: `Bearer ${ctx.adminToken}`, 'Idempotency-Key': idempotencyKey },
      data: { technicianNotes: 'QA-PRIVATE-TECH-NOTE-DO-NOT-PUBLISH', customerRecap: 'Service completed.', products: [],
        sendCompletionSms: true, requestReview: false, offerInspectionCredit: false, timeOnSite: 30, areasServiced: ['Exterior'], protocolActionsCompleted: [] } });

    // A due-today visit for the fixture customer.
    await insertVisit(db, fixture, { id, scheduledDate: etDateString(new Date()), windowStart: '09:00:00' });
    const visit = await db('scheduled_services').where({ id }).first('service_type');

    // 1. Completing it texts the customer once.
    const completed = await json(await page.request.post(endpoint, request(key)));
    assert.ok(!completed.replayed);
    const record = await db('service_records').where({ scheduled_service_id: id }).first();
    assert.ok(record?.report_view_token, 'The completed visit has a report link token');
    const invoices = await db('invoices').where({ scheduled_service_id: id });
    assert.equal(invoices.length, 1, 'The visit billed one invoice');
    // The send stamps its outcome after the provider returns; wait for that committed stamp before counting.
    let notes = {};
    for (let attempt = 0; attempt < 100; attempt++) {
      const row = await db('service_records').where({ id: record.id }).first('structured_notes');
      notes = typeof row.structured_notes === 'string' ? JSON.parse(row.structured_notes || '{}') : row.structured_notes || {};
      if (notes.completionSmsStatus && notes.completionSmsStatus !== 'sending') break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(notes.completionSmsStatus, 'sent');
    assert.equal(texts().length, 1, `Exactly one text goes out: ${JSON.stringify(texts().map((entry) => entry.body))}`);
    const [text] = texts();
    assert.equal(text.to, fixture.phone);
    // The fake transport only sees the phone, which the sibling fixture shares; the app's own log names the customer.
    const logged = await db('sms_log').where({ twilio_sid: text.sid, direction: 'outbound' });
    assert.equal(logged.length, 1, 'The completion text is logged once');
    assert.equal(logged[0].customer_id, fixture.customerId, 'The app records the text against this customer');
    // The text names the service without the catalog's trailing word "Service".
    assert.ok(text.body.includes(`your Waves ${visit.service_type.replace(/ Service$/, '')} is done`), `The text names the service: ${JSON.stringify(text.body)}`);
    assert.ok(!text.body.includes('QA-PRIVATE-'), 'The text carries no private note');
    // The report link may be wrapped as a short link; resolve it to the report page of THIS visit.
    const links = text.body.match(/(?:https?:\/\/)?[\w.-]+\/(?:report|l)\/[\w-]+/g) || [];
    const targets = [];
    for (const link of links) {
      const [, kind, code] = /\/(report|l)\/([\w-]+)$/.exec(link);
      if (kind === 'report') targets.push(`/report/${code}`);
      else {
        const short = await db('short_codes').where({ code }).first('target_url');
        if (short) targets.push(new URL(short.target_url, 'http://qa.invalid').pathname);
      }
    }
    assert.ok(targets.includes(`/report/${record.report_view_token}`), `The text links this visit's report: ${JSON.stringify({ links, targets })}`);
    assert.ok(targets.includes(`/pay/${invoices[0].token}`), 'The text links the invoice this visit billed');

    // 2. The report the text links opens, and it is this visit's.
    const reportResponse = await page.request.get(`${baseUrl}/api/reports/${record.report_view_token}/data`);
    assert.equal(reportResponse.status(), 200, 'The linked report opens');
    const report = JSON.stringify(await reportResponse.json());
    assert.ok(report.includes(record.id) || report.includes(visit.service_type), 'The linked report is this visit\'s');
    assert.ok(!report.includes('QA-PRIVATE-'), 'The report carries no private note');

    // 3. A replay of the same request, and a new request for the same completed visit, send nothing and change nothing.
    const replay = await json(await page.request.post(endpoint, request(key)));
    assert.equal(replay.replayed, true);
    const refused = await page.request.post(endpoint, request(`${key}-new`));
    assert.equal(refused.status(), 409);
    assert.equal((await refused.json()).code, 'service_already_completed');
    await new Promise((resolve) => setTimeout(resolve, 4000));
    assert.equal(texts().length, 1, 'Still one text after the replay and the refused request');
    assert.equal((await db('service_records').where({ scheduled_service_id: id })).length, 1);
    assert.equal((await db('invoices').where({ scheduled_service_id: id })).length, 1);
    return { serviceRecordId: record.id, body: text.body, links, targets, texts: texts().length };
  },
};
