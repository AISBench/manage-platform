import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureTokenEncryptionKey } from '../server/config.js';

function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'triage-key-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('token encryption key is generated once next to the database and reused', t => {
  const dir = tempDir(t);
  const dbPath = path.join(dir, 'platform.sqlite');
  const first = { demo: false, dbPath, tokenEncryptionKey: '' };
  const key = ensureTokenEncryptionKey(first);
  assert.equal(Buffer.from(key, 'base64').length, 32);
  assert.equal(first.tokenEncryptionKeyGenerated, true);
  const file = path.join(dir, 'token-encryption.key');
  assert.equal(existsSync(file), true);
  assert.equal(readFileSync(file, 'utf8').trim(), key);

  const second = { demo: false, dbPath, tokenEncryptionKey: '' };
  assert.equal(ensureTokenEncryptionKey(second), key);
  assert.equal(second.tokenEncryptionKeyGenerated, undefined);
});

test('explicit key wins and demo mode never creates a key file', t => {
  const dir = tempDir(t);
  const explicit = Buffer.alloc(32, 9).toString('base64');
  const withKey = { demo: false, dbPath: path.join(dir, 'platform.sqlite'), tokenEncryptionKey: explicit };
  assert.equal(ensureTokenEncryptionKey(withKey), explicit);
  assert.equal(existsSync(path.join(dir, 'token-encryption.key')), false);

  const demo = { demo: true, dbPath: path.join(dir, 'demo.sqlite'), tokenEncryptionKey: '' };
  assert.equal(ensureTokenEncryptionKey(demo), '');
  assert.equal(existsSync(path.join(dir, 'token-encryption.key')), false);
});

test('invalid explicit key or key file fails fast', t => {
  const dir = tempDir(t);
  assert.throws(
    () => ensureTokenEncryptionKey({ demo: false, dbPath: path.join(dir, 'platform.sqlite'), tokenEncryptionKey: 'short' }),
    /32-byte/,
  );
  writeFileSync(path.join(dir, 'token-encryption.key'), 'not-a-valid-key');
  assert.throws(
    () => ensureTokenEncryptionKey({ demo: false, dbPath: path.join(dir, 'platform.sqlite'), tokenEncryptionKey: '' }),
    /Invalid token encryption key file/,
  );
});
