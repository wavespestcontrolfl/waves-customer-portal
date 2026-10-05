#!/usr/bin/env node
'use strict';

/**
 * Replay harness for the lawn "From your technician" paragraph
 * (server/services/service-report/lawn-tech-paragraph.js). NO MODEL CALL, ever:
 * it prints the exact prompt for a visit's inputs, and validates a pasted answer
 * with the same code the completion step runs. Candidate answers are written by
 * a person or a subagent and pasted in.
 *
 *   node server/scripts/lawn-tech-paragraph-replay.js <inputs.json>
 *       prints the system prompt, the user message and the output schema
 *   node server/scripts/lawn-tech-paragraph-replay.js <inputs.json> --answer <answer.json | ->
 *       validates the answer ({ "paragraph": "...", "sources": [{ "sentence": "...", "from": ["note"] }] })
 *       and prints ACCEPTED (with the stored text) or REJECTED (with every reason);
 *       exit 0 accepted, 1 rejected, 2 bad usage
 *
 * The inputs file is the normalized inputs shape (see server/scripts/fixtures/
 * lawn-tech-paragraph/chinch-bug-arena.json). Keys starting with "_" are ignored.
 */

const fs = require('fs');
const tech = require('../services/service-report/lawn-tech-paragraph');

function readJson(file, label) {
  try {
    return JSON.parse(file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`Cannot read ${label} (${file}): ${err.message}`);
    process.exit(2);
  }
}

function main(argv) {
  const args = argv.slice(2);
  const inputsFile = args.find((a) => !a.startsWith('--'));
  const answerAt = args.indexOf('--answer');
  const answerFile = answerAt >= 0 ? args[answerAt + 1] : null;
  if (!inputsFile || (answerAt >= 0 && !answerFile)) {
    console.error('usage: lawn-tech-paragraph-replay.js <inputs.json> [--answer <answer.json | ->]');
    process.exit(2);
  }
  const inputs = tech.normalizeInputs(readJson(inputsFile, 'inputs'));
  if (!answerFile) {
    const prompt = tech.buildPrompt(inputs);
    console.log(`PROMPT VERSION: ${prompt.promptVersion}\n`);
    console.log('=== SYSTEM ===');
    console.log(prompt.system);
    console.log('\n=== USER ===');
    console.log(prompt.text);
    console.log('\n=== OUTPUT SCHEMA ===');
    console.log(JSON.stringify(prompt.jsonSchema, null, 2));
    return 0;
  }
  const verdict = tech.validateParagraph(readJson(answerFile, 'answer'), inputs);
  if (verdict.ok) {
    console.log('ACCEPTED');
    console.log(verdict.paragraph);
    return 0;
  }
  console.log('REJECTED');
  verdict.problems.forEach((p) => console.log(`- ${p}`));
  return 1;
}

process.exitCode = main(process.argv);
