const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_REPLY_FIXTURE_OUTPUT = path.join(
  os.tmpdir(),
  'waves-reply-training-fixtures',
  'customer_reply_sms.captured.json'
);

function isPathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveReplyFixtureOutput(output) {
  return path.resolve(output || DEFAULT_REPLY_FIXTURE_OUTPUT);
}

function assertSafeReplyFixtureOutput(output, { allowPii = false, repoRoot = REPO_ROOT } = {}) {
  const resolved = resolveReplyFixtureOutput(output);
  if (isPathInside(repoRoot, resolved) && !allowPii) {
    throw new Error(
      'Refusing to write raw reply training fixtures inside the repository without --allow-pii; use the default temp output or pass --allow-pii intentionally.'
    );
  }
  return resolved;
}

module.exports = {
  DEFAULT_REPLY_FIXTURE_OUTPUT,
  REPO_ROOT,
  assertSafeReplyFixtureOutput,
  isPathInside,
  resolveReplyFixtureOutput,
};
