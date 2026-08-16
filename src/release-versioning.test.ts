import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readProjectVersion,
  nextVersion,
  ensureProjectVersion,
} from './release-versioning';

const makeTempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'rv-'));

const writeFile = (workdir: string, name: string, content: string): string => {
  const filePath = path.join(workdir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
};

describe('readProjectVersion', () => {
  it('returns null when balena.yml is missing', () => {
    assert.equal(readProjectVersion(makeTempDir()), null);
  });

  it('returns null for an empty file', () => {
    const workdir = makeTempDir();
    writeFile(workdir, 'balena.yml', '');
    assert.equal(readProjectVersion(workdir), null);
  });

  it('reads a plain version', () => {
    const workdir = makeTempDir();
    writeFile(workdir, 'balena.yml', 'version: 1.2.3\n');
    assert.equal(readProjectVersion(workdir), '1.2.3');
  });

  it('reads single- and double-quoted versions', () => {
    const single = makeTempDir();
    writeFile(single, 'balena.yml', "version: '2.0.0'\n");
    assert.equal(readProjectVersion(single), '2.0.0');

    const double = makeTempDir();
    writeFile(double, 'balena.yml', 'version: "3.1.4"\n');
    assert.equal(readProjectVersion(double), '3.1.4');
  });

  it('strips a trailing comment', () => {
    const workdir = makeTempDir();
    writeFile(workdir, 'balena.yml', 'version: 1.2.3 # pinned for fleet X\n');
    assert.equal(readProjectVersion(workdir), '1.2.3');
  });

  it('returns null for an empty or comment-only value', () => {
    const empty = makeTempDir();
    writeFile(empty, 'balena.yml', 'version:\n');
    assert.equal(readProjectVersion(empty), null);

    const comment = makeTempDir();
    writeFile(comment, 'balena.yml', 'version: # TODO decide\n');
    assert.equal(readProjectVersion(comment), null);
  });

  it('ignores commented-out and indented version keys', () => {
    const workdir = makeTempDir();
    writeFile(
      workdir,
      'balena.yml',
      [
        '# version: 9.9.9',
        'services:',
        '  main:',
        '    version: 8.8.8',
        'build-args:',
        '  FOO: bar',
      ].join('\n')
    );
    assert.equal(readProjectVersion(workdir), null);
  });

  it('returns the first top-level version key', () => {
    const workdir = makeTempDir();
    writeFile(workdir, 'balena.yml', 'version: 1.0.0\nversion: 2.0.0\n');
    assert.equal(readProjectVersion(workdir), '1.0.0');
  });
});

describe('nextVersion', () => {
  it('starts at 0.0.1 with no prior release', () => {
    assert.equal(nextVersion(null), '0.0.1');
    assert.equal(nextVersion(undefined), '0.0.1');
    assert.equal(nextVersion(''), '0.0.1');
  });

  it('bumps the patch segment', () => {
    assert.equal(nextVersion('1.2.3'), '1.2.4');
    assert.equal(nextVersion('0.0.0'), '0.0.1');
    assert.equal(nextVersion('10.20.30'), '10.20.31');
  });

  it('strips a leading v and ignores prerelease/build metadata', () => {
    assert.equal(nextVersion('v1.2.3'), '1.2.4');
    assert.equal(nextVersion('1.2.3-beta.1'), '1.2.4');
    assert.equal(nextVersion('1.2.3+rev7'), '1.2.4');
  });

  it('falls back to 0.0.1 for malformed input', () => {
    assert.equal(nextVersion('not-a-version'), '0.0.1');
    assert.equal(nextVersion('latest'), '0.0.1');
  });
});

describe('ensureProjectVersion', () => {
  it('creates balena.yml when missing', () => {
    const workdir = makeTempDir();
    assert.equal(ensureProjectVersion(workdir, '0.0.1'), true);
    assert.equal(readProjectVersion(workdir), '0.0.1');
  });

  it('appends a version while preserving existing content', () => {
    const workdir = makeTempDir();
    const original = 'services:\n  main:\n    build: .\n';
    writeFile(workdir, 'balena.yml', original);
    assert.equal(ensureProjectVersion(workdir, '1.2.4'), true);
    const content = fs.readFileSync(path.join(workdir, 'balena.yml'), 'utf8');
    assert.ok(content.startsWith(original));
    assert.ok(content.includes('version: 1.2.4'));
    assert.equal(readProjectVersion(workdir), '1.2.4');
  });

  it('separates the appended key when the file lacks a trailing newline', () => {
    const workdir = makeTempDir();
    writeFile(workdir, 'balena.yml', 'name: my-fleet');
    ensureProjectVersion(workdir, '2.0.0');
    const content = fs.readFileSync(path.join(workdir, 'balena.yml'), 'utf8');
    assert.ok(content.includes('name: my-fleet\nversion: 2.0.0\n'));
  });

  it('fills an empty version key in place', () => {
    const workdir = makeTempDir();
    writeFile(workdir, 'balena.yml', 'version:\nservices: {}\n');
    assert.equal(ensureProjectVersion(workdir, '1.0.1'), true);
    const content = fs.readFileSync(path.join(workdir, 'balena.yml'), 'utf8');
    assert.ok(content.includes('version: 1.0.1'));
    assert.ok(content.includes('services: {}'));
    assert.equal(content.indexOf('1.0.1') < content.indexOf('services'), true);
  });

  it('preserves CRLF line endings when filling the key', () => {
    const workdir = makeTempDir();
    writeFile(workdir, 'balena.yml', 'version:\r\nname: fleet\r\n');
    ensureProjectVersion(workdir, '0.0.5');
    const content = fs.readFileSync(path.join(workdir, 'balena.yml'), 'utf8');
    assert.ok(content.includes('version: 0.0.5\r\nname: fleet\r\n'));
  });

  it('leaves a file with an existing version byte-identical', () => {
    const workdir = makeTempDir();
    const original = 'version: 4.5.6\nservices: {}\n';
    writeFile(workdir, 'balena.yml', original);
    assert.equal(ensureProjectVersion(workdir, '9.9.9'), false);
    assert.equal(
      fs.readFileSync(path.join(workdir, 'balena.yml'), 'utf8'),
      original
    );
  });
});
