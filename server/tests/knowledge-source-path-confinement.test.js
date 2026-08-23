// knowledge_sources.file_path is operator input that the compiler reads from
// disk and ships to the LLM — it must be confined to the wiki/ root.
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/models', () => ({}));
jest.mock('../services/llm/deep', () => ({ createDeepMessage: jest.fn() }));

const compiler = require('../services/knowledge/wiki-compiler');

const WIKI_ROOT = path.resolve(__dirname, '../../wiki');

describe('resolveKnowledgeSourcePath', () => {
  afterEach(() => { delete process.env.KNOWLEDGE_SOURCES_DIR; });

  test('relative paths resolve under the wiki/ root', () => {
    expect(compiler.resolveKnowledgeSourcePath('protocols/x.md')).toBe(path.join(WIKI_ROOT, 'protocols/x.md'));
  });

  test('absolute paths inside wiki/ are accepted', () => {
    const p = path.join(WIKI_ROOT, 'services/y.md');
    expect(compiler.resolveKnowledgeSourcePath(p)).toBe(p);
  });

  test.each([
    '/proc/self/environ',
    '/etc/passwd',
    '../server/knexfile.js',
    'protocols/../../server/knexfile.js',
    path.join(WIKI_ROOT, '..', 'server', 'knexfile.js'),
    '',
    null,
  ])('rejects %s', (input) => {
    expect(() => compiler.resolveKnowledgeSourcePath(input)).toThrow(/wiki\/ folder|required/);
  });

  test('a symlink under wiki/ that escapes the root is rejected on read', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-outside-'));
    const secret = path.join(outside, 'secret.md');
    fs.writeFileSync(secret, 'top secret content here');
    const link = path.join(tmpRoot, 'link.md');
    fs.symlinkSync(secret, link);
    process.env.KNOWLEDGE_SOURCES_DIR = tmpRoot;
    try {
      expect(() => compiler.resolveKnowledgeSourcePath(link)).toThrow(/wiki\/ folder/);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test('KNOWLEDGE_SOURCES_DIR is an additional allowed root', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-root-'));
    process.env.KNOWLEDGE_SOURCES_DIR = tmpRoot;
    try {
      const p = path.join(tmpRoot, 'a.csv');
      fs.writeFileSync(p, 'a,b');
      expect(compiler.resolveKnowledgeSourcePath(p)).toBe(fs.realpathSync(p));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('readSourceFile', () => {
  test('never reads outside the root even for pre-existing rows', async () => {
    await expect(compiler.readSourceFile('/proc/self/environ', 'txt')).rejects.toThrow(/wiki\/ folder/);
    await expect(compiler.readSourceFile('/etc/hosts', 'bin')).rejects.toThrow();
  });

  test('rejects unknown file types (no catch-all read)', () => {
    expect(() => compiler.assertAllowedSourceFileType('pem')).toThrow(/file_type/);
    expect(compiler.assertAllowedSourceFileType('MD')).toBe('md');
  });
});
