#!/usr/bin/env node
'use strict';

/**
 * Prints the exact prompt the service report's "Ask Waves" AI answer would
 * send to the model (GATE_REPORT_ASK_AI), as JSON { system, user, topic,
 * requiredLines, ruleAnswer }: the prompt, the rule router's topic, the
 * recorded instructions the AI answer must repeat word for word, and the
 * fixed-rule answer the customer gets when the gate is off or the AI misses.
 * No server, no database, no model call: it reads a saved report payload and
 * a question.
 *
 *   node scripts/dev/report-ask-prompt.js <report-data.json> "<question>"
 *
 * <report-data.json> is the body of GET /api/reports/:token/data (what
 * buildServiceReportV1ResponseData returns), or { "data": {...},
 * "nextAppointment": {...} }. A report payload's own camelCase
 * `nextAppointment` is mapped the same way POST /:token/ask maps it.
 *
 * From Node:
 *   const { buildReportAskPrompt } = require('./server/services/service-report/report-ask-ai');
 *   buildReportAskPrompt({ question, data, nextAppointment, requiredLines }) // -> { system, user }
 */

const fs = require('node:fs');
const path = require('node:path');

function nextAppointmentFor(data = {}) {
  const next = data.nextAppointment;
  return next
    ? { service_type: next.serviceType, scheduled_date: next.scheduledDate, window_start: next.windowStart }
    : null;
}

function main(argv) {
  const [file, ...rest] = argv;
  const question = rest.join(' ').trim();
  if (!file || !question) {
    process.stderr.write('Usage: node scripts/dev/report-ask-prompt.js <report-data.json> "<question>"\n');
    return 2;
  }
  const parsed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const wrapped = parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object'
    && !parsed.reportVersion;
  const data = wrapped ? parsed.data : parsed;
  const nextAppointment = (wrapped && parsed.nextAppointment) || nextAppointmentFor(data);
  // Keep stdout pure JSON: the portal logger prints module-load warnings there.
  process.env.LOG_LEVEL = 'error';
  const { buildReportAskPrompt } = require('../../server/services/service-report/report-ask-ai');
  const { routeServiceReportQuestion } = require('../../server/services/service-report/report-assistant');
  const routed = routeServiceReportQuestion({ question, data, nextAppointment });
  const prompt = buildReportAskPrompt({
    question, data, nextAppointment, requiredLines: routed.requiredLines,
  });
  process.stdout.write(`${JSON.stringify({
    ...prompt,
    topic: routed.topic,
    requiredLines: routed.requiredLines,
    ruleAnswer: routed.answer,
  }, null, 2)}\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
