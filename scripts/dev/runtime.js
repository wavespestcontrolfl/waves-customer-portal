'use strict';

const fs = require('node:fs');
const path = require('node:path');

function checkRuntime(root) {
  const selected = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim();
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== Number(selected) || (major === 20 && minor < 9)) {
    throw new Error(`Node ${process.versions.node} does not match this checkout's Node ${selected} development runtime (minimum 20.9). In ${root}, run nvm install && nvm use, then npm ci; or select .nvmrc with your version manager.`);
  }
  return process.versions.node;
}

module.exports = { checkRuntime };
