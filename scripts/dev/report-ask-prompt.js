#!/usr/bin/env node
'use strict';

/**
 * Prints the exact prompt the service report's "Ask Waves" AI answer would
 * send to the model (GATE_REPORT_ASK_AI), as JSON { system, user }. No server,
 * no database, no model call: it reads a saved report payload and a question.
 *
 *   node scripts/dev/report-ask-prompt.js <report-data.json> "<question>"
 *
 * <report-data.json> is the body of GET /api/reports/:token/data (what
 * buildServiceReportV1ResponseData returns), or { "data": {...} }. The
 * prompt carries no appointment: next-visit and schedule questions keep the
 * fixed-rule answer.
 *
 * From Node:
 *   const { buildReportAskPrompt } = require('./server/services/service-report/report-ask-ai');
 *   buildReportAskPrompt({ question, data }) // -> { system, user }
 */

const fs = require('node:fs');
const path = require('node:path');

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
  // Keep stdout pure JSON: the portal logger prints module-load warnings there.
  process.env.LOG_LEVEL = 'error';
  const { buildReportAskPrompt } = require('../../server/services/service-report/report-ask-ai');
  process.stdout.write(`${JSON.stringify(buildReportAskPrompt({ question, data }), null, 2)}\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
