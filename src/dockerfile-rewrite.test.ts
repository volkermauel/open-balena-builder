/* eslint-disable indent */
import { strict as assert } from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it } from 'node:test';
import {
  parseRewriteMap,
  rewriteFromLine,
  rewriteDockerfile,
  rewriteDockerfilesIn,
} from './dockerfile-rewrite';

const options = {
  host: 'harbor.lan',
  map: parseRewriteMap(
    'docker.io=dockerhub,ghcr.io=ghcr,registry.internal:5000=local,localhost=localmirror'
  ),
};

const makeTempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'rw-'));

describe('parseRewriteMap', () => {
  it('parses comma separated registry=project pairs', () => {
    const map = parseRewriteMap('docker.io=dockerhub,ghcr.io=ghcr');
    assert.equal(map.size, 2);
    assert.equal(map.get('docker.io'), 'dockerhub');
    assert.equal(map.get('ghcr.io'), 'ghcr');
  });

  it('trims whitespace around registries and projects', () => {
    const map = parseRewriteMap(' docker.io = dockerhub , quay.io=quay ');
    assert.equal(map.size, 2);
    assert.equal(map.get('docker.io'), 'dockerhub');
    assert.equal(map.get('quay.io'), 'quay');
  });

  it('drops empty and malformed entries', () => {
    const map = parseRewriteMap('a.io=p1,,=p2,x=, ,b.io=p3');
    assert.equal(map.size, 2);
    assert.ok(map.has('a.io') && map.has('b.io'));
  });

  it('returns an empty map for an empty string', () => {
    assert.equal(parseRewriteMap('').size, 0);
  });

  it('lets later entries win for duplicate registries', () => {
    const map = parseRewriteMap('docker.io=first,docker.io=second');
    assert.equal(map.size, 1);
    assert.equal(map.get('docker.io'), 'second');
  });
});

describe('rewriteFromLine: rewrites', () => {
  const rewrites: [string, string, string][] = [
    [
      'implicit docker.io reference with namespace',
      'FROM balenalib/raspberrypi4-64-node:24-bookworm',
      'FROM harbor.lan/dockerhub/balenalib/raspberrypi4-64-node:24-bookworm',
    ],
    [
      'official image is prefixed with library/',
      'FROM nginx',
      'FROM harbor.lan/dockerhub/library/nginx',
    ],
    [
      'official image with tag keeps tag',
      'FROM nginx:1.27',
      'FROM harbor.lan/dockerhub/library/nginx:1.27',
    ],
    [
      'official image with digest keeps digest',
      'FROM ubuntu@sha256:deadbeef',
      'FROM harbor.lan/dockerhub/library/ubuntu@sha256:deadbeef',
    ],
    [
      'bare repository with tag is docker.io, not a registry',
      'FROM node:22',
      'FROM harbor.lan/dockerhub/library/node:22',
    ],
    [
      'AS stage name is preserved',
      'FROM balenalib/x AS base',
      'FROM harbor.lan/dockerhub/balenalib/x AS base',
    ],
    [
      '--platform flag is preserved',
      'FROM --platform=linux/arm64 balenalib/y AS build',
      'FROM --platform=linux/arm64 harbor.lan/dockerhub/balenalib/y AS build',
    ],
    [
      'multiple flags are preserved',
      'FROM --platform=$BUILDPLATFORM --foo=bar balenalib/z',
      'FROM --platform=$BUILDPLATFORM --foo=bar harbor.lan/dockerhub/balenalib/z',
    ],
    [
      'mapped registry ghcr.io',
      'FROM ghcr.io/volkermauel/app@sha256:abc123',
      'FROM harbor.lan/ghcr/volkermauel/app@sha256:abc123',
    ],
    [
      'registry with port',
      'FROM registry.internal:5000/team/img:v1',
      'FROM harbor.lan/local/team/img:v1',
    ],
    [
      'bare localhost is treated as a registry',
      'FROM localhost/myimg',
      'FROM harbor.lan/localmirror/myimg',
    ],
    [
      'lowercase from instruction',
      'from alpine',
      'from harbor.lan/dockerhub/library/alpine',
    ],
    [
      'mixed case From instruction',
      'From alpine',
      'From harbor.lan/dockerhub/library/alpine',
    ],
    [
      'indented from instruction',
      '  FROM node:22',
      '  FROM harbor.lan/dockerhub/library/node:22',
    ],
  ];

  rewrites.forEach(([name, input, expected]) => {
    it(name, () => {
      const result = rewriteFromLine(input, options);
      assert.ok(result.changed, `expected change for: ${input}`);
      assert.equal(result.line, expected);
    });
  });
});

describe('rewriteFromLine: leaves alone', () => {
  const untouched = [
    ['scratch', 'FROM scratch'],
    ['SCRATCH case-insensitive', 'FROM SCRATCH'],
    ['dynamic variable reference', 'FROM ${BASE_IMAGE}'],
    ['dynamic variable without braces', 'FROM $BASE_IMAGE'],
    ['unmapped registry', 'FROM quay.io/org/img'],
    ['already pointing at the cache registry', 'FROM harbor.lan/dockerhub/library/nginx'],
    ['cache registry with different case host', 'FROM HARBOR.LAN/dockerhub/library/nginx'],
    ['non-FROM instruction', 'RUN apt-get update'],
    ['FROM inside a comment', '# FROM nginx'],
    ['empty line', ''],
  ];

  untouched.forEach(([name, line]) => {
    it(name, () => {
      const result = rewriteFromLine(line, options);
      assert.ok(!result.changed);
      assert.equal(result.line, line);
    });
  });
});

describe('rewriteDockerfile', () => {
  it('rewrites all matching lines of a multi-stage Dockerfile in place', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'Dockerfile');
    fs.writeFileSync(
      file,
      [
        '# comment',
        'FROM balenalib/amd64-node:22 AS build',
        'RUN echo hi',
        'FROM scratch',
        'FROM ${FINAL}',
        'FROM ghcr.io/org/tool:2.0 AS tool',
        'COPY . .',
      ].join('\n')
    );
    const logs: string[] = [];
    const changed = rewriteDockerfile(file, options, (m) => logs.push(m));

    assert.equal(changed, true);
    assert.equal(logs.length, 2);
    assert.equal(
      fs.readFileSync(file, 'utf8'),
      [
        '# comment',
        'FROM harbor.lan/dockerhub/balenalib/amd64-node:22 AS build',
        'RUN echo hi',
        'FROM scratch',
        'FROM ${FINAL}',
        'FROM harbor.lan/ghcr/org/tool:2.0 AS tool',
        'COPY . .',
      ].join('\n')
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('leaves files without matches untouched and reports no change', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'Dockerfile');
    fs.writeFileSync(file, 'FROM quay.io/x/y\nRUN echo hi\n');
    const changed = rewriteDockerfile(file, options, () => {
      throw new Error('log callback must not fire');
    });

    assert.equal(changed, false);
    assert.equal(fs.readFileSync(file, 'utf8'), 'FROM quay.io/x/y\nRUN echo hi\n');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('rewriteDockerfilesIn', () => {
  it('rewrites recursively and counts only changed files', () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, 'nested'));
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM nginx\n');
    fs.writeFileSync(path.join(dir, 'Dockerfile.dev'), 'FROM quay.io/a/b\n');
    fs.writeFileSync(path.join(dir, 'dockerfile'), 'FROM node:22\n');
    fs.writeFileSync(path.join(dir, 'nested', 'Dockerfile.custom'), 'FROM ghcr.io/x/y\n');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'FROM nginx\n');
    fs.writeFileSync(path.join(dir, 'index.js'), 'FROM nginx\n');

    const count = rewriteDockerfilesIn(dir, options, () => {});

    assert.equal(count, 3); // Dockerfile, dockerfile, nested/Dockerfile.custom
    assert.equal(
      fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8'),
      'FROM harbor.lan/dockerhub/library/nginx\n'
    );
    assert.equal(
      fs.readFileSync(path.join(dir, 'nested', 'Dockerfile.custom'), 'utf8'),
      'FROM harbor.lan/ghcr/x/y\n'
    );
    // Non-Dockerfile names must not be touched
    assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'FROM nginx\n');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns zero for a tree without Dockerfiles', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'readme.md'), 'hello\n');
    assert.equal(rewriteDockerfilesIn(dir, options, () => {}), 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
