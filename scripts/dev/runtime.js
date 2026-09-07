'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function checkRuntime(root, revision) {
  const selected = (revision
    ? execFileSync('git', ['show', `${revision}:.nvmrc`], { cwd: root, encoding: 'utf8' })
    : fs.readFileSync(path.join(root, '.nvmrc'), 'utf8')).trim();
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== Number(selected) || (major === 20 && minor < 9)) {
    if (revision) throw new Error(`Node ${process.versions.node} does not match ${revision}'s Node ${selected} development runtime (minimum 20.9). Run nvm install ${selected} && nvm use ${selected}, then retry from a checkout with the matching .nvmrc.`);
    throw new Error(`Node ${process.versions.node} does not match this checkout's Node ${selected} development runtime (minimum 20.9). In ${root}, run nvm install && nvm use, then npm ci; or select .nvmrc with your version manager.`);
  }
  return process.versions.node;
}

module.exports = { checkRuntime };
