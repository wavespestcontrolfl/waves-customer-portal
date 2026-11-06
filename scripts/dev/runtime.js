'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Oldest release allowed on a Node major that .nvmrc can select. Node 24.22.1 is
// the October 21, 2026 security release (CVE-2026-111497, a Brotli decoder
// out-of-bounds write). deploy/portal.Dockerfile runs this same check, so the
// production image cannot build below it.
const MINIMUM_RELEASE = { 24: '24.22.1' };

function minimumFor(selected) {
  return MINIMUM_RELEASE[selected] || `${selected}.0.0`;
}

function atLeast(version, minimum) {
  const have = version.split('.').map((part) => parseInt(part, 10) || 0);
  const need = minimum.split('.').map((part) => parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((have[i] || 0) !== (need[i] || 0)) return (have[i] || 0) > (need[i] || 0);
  }
  return true;
}

function checkRuntime(root, revision) {
  const selected = (revision
    ? execFileSync('git', ['show', `${revision}:.nvmrc`], { cwd: root, encoding: 'utf8' })
    : fs.readFileSync(path.join(root, '.nvmrc'), 'utf8')).trim();
  const minimum = minimumFor(selected);
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== Number(selected) || !atLeast(process.versions.node, minimum)) {
    if (revision) throw new Error(`Node ${process.versions.node} does not match ${revision}'s Node ${selected} development runtime (minimum ${minimum}). Run nvm install ${selected} && nvm use ${selected}, then retry from a checkout with the matching .nvmrc.`);
    throw new Error(`Node ${process.versions.node} does not match this checkout's Node ${selected} development runtime (minimum ${minimum}). In ${root}, run nvm install && nvm use, then npm ci; or select .nvmrc with your version manager.`);
  }
  return process.versions.node;
}

module.exports = { checkRuntime, minimumFor };
