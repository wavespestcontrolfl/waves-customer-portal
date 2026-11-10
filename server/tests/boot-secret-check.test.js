/**
 * Boot-time secret strength check (audit run 3, hardening G).
 * Production refuses to start on a placeholder or short JWT_SECRET; a
 * placeholder TERMINAL_HANDOFF_SECRET / BOUNCIE_WEBHOOK_SECRET only warns.
 * No message may ever carry a secret value.
 */
const fs = require('fs');
const path = require('path');
const { checkBootSecrets, isPlaceholder } = require('../utils/boot-secret-check');

const ROOT = path.resolve(__dirname, '..', '..');

function exampleValue(name) {
  const text = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const match = text.match(new RegExp(`^${name}=(.*)$`, 'm'));
  return match ? match[1].trim() : null;
}

const GOOD_JWT = 'a1b2c3d4'.repeat(8); // 64 chars

describe('checkBootSecrets', () => {
  test('the .env.example JWT_SECRET placeholder is fatal', () => {
    const placeholder = exampleValue('JWT_SECRET');
    expect(placeholder).toMatch(/^replace_with/);
    const { fatal } = checkBootSecrets({ jwtSecret: placeholder, env: {} });
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toMatch(/JWT_SECRET/);
    expect(JSON.stringify(fatal)).not.toContain(placeholder);
  });

  test('a JWT_SECRET shorter than 32 characters is fatal, 32 is accepted', () => {
    expect(checkBootSecrets({ jwtSecret: 'x'.repeat(31), env: {} }).fatal).toHaveLength(1);
    expect(checkBootSecrets({ jwtSecret: 'x'.repeat(32), env: {} }).fatal).toEqual([]);
  });

  test('a 64-hex JWT_SECRET passes with no warnings', () => {
    expect(checkBootSecrets({ jwtSecret: GOOD_JWT, env: {} })).toEqual({ fatal: [], warnings: [] });
  });

  test('a missing JWT_SECRET is left to the required-variable check', () => {
    expect(checkBootSecrets({ jwtSecret: undefined, env: {} }).fatal).toEqual([]);
    expect(checkBootSecrets({ jwtSecret: '   ', env: {} }).fatal).toEqual([]);
  });

  test('placeholder handoff and Bouncie secrets warn but are never fatal', () => {
    const env = {
      TERMINAL_HANDOFF_SECRET: exampleValue('TERMINAL_HANDOFF_SECRET'),
      BOUNCIE_WEBHOOK_SECRET: exampleValue('BOUNCIE_WEBHOOK_SECRET'),
    };
    expect(isPlaceholder(env.TERMINAL_HANDOFF_SECRET)).toBe(true);
    expect(isPlaceholder(env.BOUNCIE_WEBHOOK_SECRET)).toBe(true);
    const { fatal, warnings } = checkBootSecrets({ jwtSecret: GOOD_JWT, env });
    expect(fatal).toEqual([]);
    expect(warnings).toHaveLength(2);
    expect(warnings.join('\n')).toMatch(/TERMINAL_HANDOFF_SECRET/);
    expect(warnings.join('\n')).toMatch(/BOUNCIE_WEBHOOK_SECRET/);
    for (const value of Object.values(env)) expect(warnings.join('\n')).not.toContain(value);
  });

  test('real or unset handoff and Bouncie secrets stay silent', () => {
    expect(checkBootSecrets({ jwtSecret: GOOD_JWT, env: {} }).warnings).toEqual([]);
    const env = { TERMINAL_HANDOFF_SECRET: 'f'.repeat(64), BOUNCIE_WEBHOOK_SECRET: 'e'.repeat(40) };
    expect(checkBootSecrets({ jwtSecret: GOOD_JWT, env }).warnings).toEqual([]);
  });
});

describe('server/index.js wiring', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');

  test('assertRequiredSecrets runs the strength check, exits in production on a fatal result', () => {
    expect(source).toMatch(/require\('\.\/utils\/boot-secret-check'\)/);
    const fn = source.slice(source.indexOf('function assertSecretStrength()'), source.indexOf('assertRequiredSecrets();'));
    expect(fn).toMatch(/checkBootSecrets\(/);
    expect(fn).toMatch(/process\.exit\(1\)/);
    expect(fn).toMatch(/logger\.error\(`\[startup\] \$\{warning\}/);
    expect(source).toMatch(/assertSecretStrength\(\);/);
  });
});
