#!/usr/bin/env node
'use strict';

/**
 * Offline-only historical replay for the gratitude SMS policy.
 *
 * Usage:
 *   node server/scripts/replay-sms-gratitude.js --input /private/messages.jsonl --output /private/report.json
 *
 * The input remains local. This script has no database, provider SDK, env, or
 * network dependency and cannot send messages. Names inferred from an earlier
 * outbound "Hello X" are preview labels only and never establish identity.
 */

const fs = require('fs');
const path = require('path');
const {
  CONTEXT_WINDOW_MS,
  QUIET_WINDOW_MS,
  evaluateGratitudeContext,
  gratitudeTimingReason,
} = require('../services/sms-gratitude');

const OUTBOUND_DIRECTIONS = new Set(['outbound-api', 'outbound-reply']);
const PENDING_OUTBOUND_STATUSES = new Set(['accepted', 'queued', 'scheduled', 'sending']);

function usage() {
  return 'Usage: node server/scripts/replay-sms-gratitude.js --input <private.jsonl> --output <private.json>';
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };

    const equals = arg.match(/^--(input|output)=(.+)$/);
    if (equals) {
      args[equals[1]] = equals[2];
      continue;
    }

    if (arg === '--input' || arg === '--output') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a path`);
      args[arg.slice(2)] = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.input || !args.output) throw new Error('Both --input and --output are required');
  if (path.resolve(args.input) === path.resolve(args.output)) {
    throw new Error('--input and --output must be different files');
  }
  return args;
}

function parseJsonLines(contents) {
  const rows = [];
  const lines = contents.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      rows.push({ value: JSON.parse(line), lineNumber: index + 1 });
    } catch {
      throw new Error(`Input line ${index + 1} is not valid JSON`);
    }
  }
  if (rows.length === 0) throw new Error('Input contains no message rows');
  return rows;
}

function requireString(row, field, lineNumber, { allowEmpty = false } = {}) {
  if (typeof row[field] !== 'string' || (!allowEmpty && row[field].trim() === '')) {
    throw new Error(`Input line ${lineNumber} has an invalid ${field}`);
  }
  return row[field];
}

function normalizeRow(row, lineNumber) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`Input line ${lineNumber} must be a JSON object`);
  }

  const id = requireString(row, 'id', lineNumber);
  const at = requireString(row, 'at', lineNumber);
  const timestamp = new Date(at).getTime();
  if (!Number.isFinite(timestamp)) throw new Error(`Input line ${lineNumber} has an invalid at`);

  const originalDirection = requireString(row, 'direction', lineNumber);
  if (originalDirection !== 'inbound' && !OUTBOUND_DIRECTIONS.has(originalDirection)) {
    throw new Error(`Input line ${lineNumber} has an unsupported direction`);
  }

  const from = requireString(row, 'from', lineNumber);
  const to = requireString(row, 'to', lineNumber);
  const mediaCount = typeof row.numMedia === 'string' && /^\d+$/.test(row.numMedia)
    ? Number(row.numMedia)
    : row.numMedia;
  if (!Number.isSafeInteger(mediaCount) || mediaCount < 0) {
    throw new Error(`Input line ${lineNumber} has an invalid numMedia`);
  }

  return {
    id,
    timestamp,
    createdAt: new Date(timestamp).toISOString(),
    direction: originalDirection === 'inbound' ? 'inbound' : 'outbound',
    originalDirection,
    from,
    to,
    body: requireString(row, 'body', lineNumber, { allowEmpty: true }),
    status: typeof row.status === 'string' ? row.status : null,
    mediaCount,
    // Optional export column; the live loader reads the same persisted type.
    messageType: typeof (row.messageType ?? row.message_type) === 'string'
      ? (row.messageType ?? row.message_type) : null,
    // Optional export column; absent means not hand-typed, exactly as live.
    humanAuthored: (row.humanAuthored ?? row.human_authored) === true,
    threadKey: [from, to].sort().join('\u0000'),
  };
}

function normalizeRows(parsedRows) {
  const seenIds = new Set();

  const rows = parsedRows.map(({ value, lineNumber }, sourceIndex) => {
    const row = normalizeRow(value, lineNumber);
    if (seenIds.has(row.id)) throw new Error(`Input line ${lineNumber} repeats a message id`);
    seenIds.add(row.id);
    return { ...row, sourceIndex };
  });

  rows.sort((left, right) => left.timestamp - right.timestamp || left.sourceIndex - right.sourceIndex);
  return rows.map(({ sourceIndex: _, ...row }) => row);
}

function inferPreviewFirstName(history) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message.direction !== 'outbound') continue;
    const match = message.body.match(/^\s*hello[ \t]+([a-z][a-z'’\-]{0,49})(?=[\s,!:.]|$)/i);
    if (match) return match[1];
  }
  return null;
}

function policyHistory(rows, candidate, evaluationTimestamp) {
  return rows
    .filter((row) => row.timestamp <= evaluationTimestamp && row.id !== candidate.id)
    // Match the live loader: failed/undelivered outbounds do not establish
    // what the customer saw. Later queued/in-flight messages still cancel.
    .filter((row) => row.direction === 'inbound'
      || ['sent', 'delivered'].includes(row.status)
      || (row.timestamp >= candidate.timestamp && PENDING_OUTBOUND_STATUSES.has(row.status)))
    .map((row) => ({
      id: row.id,
      body: row.body,
      direction: row.direction,
      createdAt: row.createdAt,
      mediaCount: row.mediaCount,
      messageType: row.messageType,
      humanAuthored: row.humanAuthored,
    }));
}

function incrementReason(counts, reason) {
  counts[reason] = (counts[reason] || 0) + 1;
}

function replayRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Replay requires at least one row');

  const earliestTimestamp = rows[0].timestamp;
  const activatedAt = new Date(earliestTimestamp - 1).toISOString();
  const threads = new Map();
  for (const row of rows) {
    const thread = threads.get(row.threadKey) || [];
    thread.push(row);
    threads.set(row.threadKey, thread);
  }

  const candidates = [];
  const exclusions = [];
  const exclusionCounts = {};
  const evaluatedIds = [];

  for (const inbound of rows) {
    if (inbound.direction !== 'inbound') continue;

    evaluatedIds.push(inbound.id);
    const evaluationTimestamp = inbound.timestamp + QUIET_WINDOW_MS;
    const evaluationAt = new Date(evaluationTimestamp).toISOString();
    const timingReason = gratitudeTimingReason({
      inboundCreatedAt: inbound.createdAt,
      now: evaluationAt,
      activatedAt,
    });
    const thread = threads.get(inbound.threadKey);
    const history = policyHistory(thread, inbound, evaluationTimestamp);
    const firstName = inferPreviewFirstName(history);
    const pendingWork = thread.some((row) => row.direction === 'outbound'
      && row.timestamp < inbound.timestamp
      && row.timestamp <= evaluationTimestamp
      && PENDING_OUTBOUND_STATUSES.has(row.status));
    const context = timingReason
      ? { eligible: false, reason: timingReason, reply: null }
      : evaluateGratitudeContext({
        inbound: {
          id: inbound.id,
          body: inbound.body,
          direction: 'inbound',
          createdAt: inbound.createdAt,
          mediaCount: inbound.mediaCount,
        },
        history,
        firstName,
        contextComplete: inbound.timestamp - earliestTimestamp >= CONTEXT_WINDOW_MS,
        pendingWork,
      });

    if (context.eligible) {
      candidates.push({
        id: inbound.id,
        inboundCreatedAt: inbound.createdAt,
        evaluatedAt: evaluationAt,
        reason: context.reason,
        replyPreview: context.reply,
        identity: {
          firstName,
          source: firstName ? 'outbound_hello_preview_only' : null,
          verified: false,
        },
        liveSendEligible: false,
        liveSendBlockers: ['historical_replay', 'unverified_identity'],
      });
    } else {
      const reason = context.reason || 'policy_ineligible';
      incrementReason(exclusionCounts, reason);
      exclusions.push({
        id: inbound.id,
        inboundCreatedAt: inbound.createdAt,
        evaluatedAt: evaluationAt,
        reason,
      });
    }
  }

  const inboundRows = evaluatedIds.length;
  return {
    mode: 'offline_hypothetical_preview',
    disclaimer: 'Historical policy replay only. No identity is verified and no result is eligible for live sending.',
    safeguards: {
      networkAccess: false,
      providerCalls: false,
      databaseAccess: false,
      customerCommunication: false,
    },
    hypotheticalActivation: {
      activatedAt,
      basis: 'one millisecond before the earliest export timestamp; not a real activation',
    },
    stats: {
      totalRows: rows.length,
      inboundRows,
      outboundRows: rows.length - inboundRows,
      threadCount: threads.size,
      evaluatedInboundRows: evaluatedIds.length,
      candidateCount: candidates.length,
      exclusionCount: exclusions.length,
      exclusionCounts,
      coverage: {
        expectedInboundRows: inboundRows,
        evaluatedInboundRows: evaluatedIds.length,
        complete: evaluatedIds.length === inboundRows,
      },
    },
    candidates,
    exclusions,
    ids: {
      evaluatedInbound: evaluatedIds,
      candidates: candidates.map((candidate) => candidate.id),
      exclusions: exclusions.map((exclusion) => exclusion.id),
    },
  };
}

function readInput(inputPath) {
  try {
    return fs.readFileSync(inputPath, 'utf8');
  } catch {
    throw new Error('Could not read the input file');
  }
}

function assertDistinctFiles(inputPath, outputPath) {
  try {
    const input = fs.statSync(inputPath);
    const output = fs.statSync(outputPath);
    if (input.dev === output.dev && input.ino === output.ino) {
      throw new Error('--input and --output must be different files');
    }
  } catch (error) {
    if (error.message === '--input and --output must be different files') throw error;
    if (error.code !== 'ENOENT') throw new Error('Could not inspect the input and output files');
  }
}

function writePrivateReport(outputPath, report) {
  const resolvedOutput = path.resolve(outputPath);
  const directory = path.dirname(resolvedOutput);
  if (!fs.existsSync(directory)) throw new Error('The output directory does not exist');
  let tempDirectory = null;
  try {
    tempDirectory = fs.mkdtempSync(path.join(directory, '.sms-gratitude-replay-'));
    const tempPath = path.join(tempDirectory, 'report.json');
    fs.writeFileSync(tempPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tempPath, resolvedOutput);
  } catch {
    throw new Error('Could not write the private output file');
  } finally {
    if (tempDirectory) fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }

  const input = readInput(args.input);
  assertDistinctFiles(args.input, args.output);
  const rows = normalizeRows(parseJsonLines(input));
  const report = replayRows(rows);
  writePrivateReport(args.output, report);
  process.stdout.write(
    `Replay complete: ${report.stats.evaluatedInboundRows} inbound messages evaluated across `
      + `${report.stats.threadCount} threads; ${report.stats.candidateCount} candidate previews and `
      + `${report.stats.exclusionCount} exclusions. Private report written.\n`,
  );
  return report;
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`Replay failed: ${error.message}\n${usage()}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  inferPreviewFirstName,
  normalizeRows,
  parseArgs,
  parseJsonLines,
  replayRows,
  run,
  writePrivateReport,
};
