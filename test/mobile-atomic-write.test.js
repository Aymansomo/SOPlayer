'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeFileAtomic } = require('../src/server/mobile/atomic-write');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'riff-atomic-'));
}

test('writeFileAtomic writes a new file and replaces an existing one', () => {
  const dir = tempDir();
  const file = path.join(dir, 'mobile-online.json');

  assert.equal(writeFileAtomic(file, '{"tracks":[1]}', 'utf8'), null);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"tracks":[1]}');

  assert.equal(writeFileAtomic(file, '{"tracks":[1,2]}', 'utf8'), null);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"tracks":[1,2]}');

  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('writeFileAtomic writes buffers without an encoding', () => {
  const dir = tempDir();
  const file = path.join(dir, 'cover.jpg');
  const buffer = Buffer.from([0xff, 0xd8, 0xff]);

  assert.equal(writeFileAtomic(file, buffer), null);
  assert.deepEqual(fs.readFileSync(file), buffer);
});

test('writeFileAtomic falls back to in-place write when rename keeps failing', () => {
  const dir = tempDir();
  const file = path.join(dir, 'mobile-collection.json');
  fs.writeFileSync(file, '{"old":true}', 'utf8');

  const realRename = fs.renameSync;
  fs.renameSync = () => {
    const err = new Error('EBUSY: resource busy or locked');
    err.code = 'EBUSY';
    throw err;
  };
  try {
    assert.equal(writeFileAtomic(file, '{"old":false}', 'utf8'), null);
  } finally {
    fs.renameSync = realRename;
  }

  assert.equal(fs.readFileSync(file, 'utf8'), '{"old":false}');
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});
