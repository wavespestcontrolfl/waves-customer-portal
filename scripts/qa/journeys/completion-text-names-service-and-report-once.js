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
    // A recap unique to this visit, so the linked report can be told apart from other visits of the same service.
    const recap = `Service completed. QA recap ${fixture.runId}.`;
    const request = (idempotencyKey) => ({ headers: { Authorization: `Bearer ${ctx.adminToken}`, 'Idempotency-Key': idempotencyKey },
      data: { technicianNotes: 'QA-PRIVATE-TECH-NOTE-DO-NOT-PUBLISH', customerRecap: recap, products: [],
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
    // Messages never print the text body or its links: report.json and the CI log are uploaded.
    assert.equal(texts().length, 1, 'Exactly one text goes out');
    const [text] = texts();
    assert.equal(text.to, fixture.phone);
    // The fake transport only sees the phone, which the sibling fixture shares; the app's own log names the customer.
    const logged = await db('sms_log').where({ twilio_sid: text.sid, direction: 'outbound' });
    assert.equal(logged.length, 1, 'The completion text is logged once');
    assert.equal(logged[0].customer_id, fixture.customerId, 'The app records the text against this customer');
    // The text names the service without the catalog's trailing word "Service".
    assert.ok(text.body.includes(`your Waves ${visit.service_type.replace(/ Service$/, '')} is done`), 'The text names the service');
    assert.ok(!text.body.includes('QA-PRIVATE-'), 'The text carries no private note');
    // Each link the customer receives is a direct /report/ or /pay/ path, or a short /l/ link; a short link is followed
    // through the QA server (as the customer's phone would) and must redirect, not answer 404 or 410.
    const links = text.body.match(/(?:https?:\/\/)?[\w-]+(?:\.[\w-]+)+\/(?:report|pay|l)\/[\w-]+/g) || [];
    assert.ok(links.length >= 2, `The text carries the report and invoice links (${links.length} found)`);
    const targets = [];
    for (const link of links) {
      const path = new URL(/^https?:/.test(link) ? link : `https://${link}`).pathname;
      const short = /^\/l\/([\w-]+)$/.exec(path);
      if (!short) { targets.push(path); continue; }
      const hop = await page.request.get(`${baseUrl}/l/${short[1]}`, { maxRedirects: 0 });
      assert.ok([301, 302, 303, 307, 308].includes(hop.status()), `A short link redirects (status ${hop.status()})`);
      targets.push(new URL(hop.headers().location, baseUrl).pathname);
    }
    assert.ok(targets.includes(`/report/${record.report_view_token}`), 'The text links this visit\'s report');
    assert.ok(targets.includes(`/pay/${invoices[0].token}`), 'The text links the invoice this visit billed');

    // 2. The report the text links opens, and it is this visit's.
    const reportResponse = await page.request.get(`${baseUrl}/api/reports/${record.report_view_token}/data`);
    assert.equal(reportResponse.status(), 200, 'The linked report opens');
    const report = JSON.stringify(await reportResponse.json());
    assert.ok(report.includes(recap), 'The linked report is this visit\'s (it shows this visit\'s recap)');
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
    return { serviceRecordId: record.id, links: links.length, texts: texts().length };
  },
};
