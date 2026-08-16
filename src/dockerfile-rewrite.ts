/* eslint-disable indent */
import * as fs from 'fs';

// See docs/cache-registry-harbor.md for the full design.
// Rewrites `FROM <ref>` instructions in uploaded Dockerfiles so base-image
// pulls are served by a local cache registry (e.g. a Harbor proxy-cache
// project) instead of the upstream registry. Pure module with no side
// effects on import, so it can be unit-tested directly.

export interface RewriteOptions {
  // Cache registry host without scheme, e.g. 'harbor.lan' or 'harbor.lan:443'
  host: string;
  // Upstream registry -> proxy-cache project, e.g. 'docker.io' -> 'dockerhub'
  map: Map<string, string>;
}

// Parses `registry=project` pairs, comma separated:
// 'docker.io=dockerhub,ghcr.io=ghcr' -> { 'docker.io': 'dockerhub', ... }
export const parseRewriteMap = (raw: string): Map<string, string> => {
  const map = new Map<string, string>();
  raw
    .split(',')
    .map((entry) => entry.split('=').map((part) => part.trim()))
    .filter(([registry, project]) => registry !== '' && project !== '')
    .forEach(([registry, project]) => map.set(registry, project));
  return map;
};

// Detects the registry of an image reference. References without a registry
// segment in the first path component ('balenalib/foo', 'nginx') are
// implicitly docker.io; anything host-like ('ghcr.io', 'registry:5000',
// 'localhost') is treated as an explicit registry.
const splitRef = (ref: string): { registry: string; remainder: string } => {
  // A first path component is only a registry when a repository path
  // follows it: 'ghcr.io/org/app', 'registry:5000/img', 'localhost/x'.
  // Without a slash ('node:22', 'nginx') the whole reference is a
  // docker.io repository (the ':' is just the tag separator).
  const firstSegment = ref.split('/')[0];
  const hasRepositoryPath = ref.includes('/');
  if (
    hasRepositoryPath &&
    (firstSegment.includes('.') ||
      firstSegment.includes(':') ||
      firstSegment === 'localhost')
  ) {
    return {
      registry: firstSegment,
      remainder: ref.slice(firstSegment.length + 1),
    };
  }
  return { registry: 'docker.io', remainder: ref };
};

// Rewrites a single image reference, or returns null when it must be left
// alone: dynamic references, scratch, references to registries without a
// configured mapping, and references already served by the cache registry.
export const rewriteRef = (
  ref: string,
  options: RewriteOptions
): string | null => {
  if (ref === '' || ref.toLowerCase() === 'scratch') return null;
  if (ref.startsWith('$')) return null; // e.g. FROM ${BASE_IMAGE}
  if (ref.toLowerCase().startsWith(`${options.host.toLowerCase()}/`))
    return null;
  const { registry, remainder } = splitRef(ref);
  const project = options.map.get(registry);
  if (!project) return null;
  if (remainder === '') return null; // bare registry reference
  let rest = remainder;
  // Official docker.io images live in the library/ namespace
  if (registry === 'docker.io' && !rest.includes('/')) {
    rest = `library/${rest}`;
  }
  return `${options.host}/${project}/${rest}`;
};

// Matches: FROM [--flag=value ...] <image ref> [AS stage-name] (instruction is
// case-insensitive); prefix/flags/tail are preserved verbatim.
const FROM_LINE = /^(\s*FROM\s+)((?:--\S+\s+)*)(\S+)(.*)$/i;

export const rewriteFromLine = (
  line: string,
  options: RewriteOptions
): { line: string; changed: boolean } => {
  const match = FROM_LINE.exec(line);
  if (!match) return { line, changed: false };
  const [, prefix, flags, ref, tail] = match;
  const rewritten = rewriteRef(ref, options);
  if (rewritten === null) return { line, changed: false };
  return { line: `${prefix}${flags}${rewritten}${tail}`, changed: true };
};

const isDockerfile = (name: string): boolean =>
  /^dockerfile(\..+)?$/i.test(name);

// Rewrites one Dockerfile in place; returns true when anything changed.
export const rewriteDockerfile = (
  path: string,
  options: RewriteOptions,
  log: (msg: string) => void
): boolean => {
  const source = fs.readFileSync(path, 'utf8');
  let changed = false;
  const rewritten = source
    .split('\n')
    .map((line) => {
      const result = rewriteFromLine(line, options);
      if (result.changed) {
        changed = true;
        log(`FROM rewrite in ${path}: ${line.trim()} -> ${result.line.trim()}`);
      }
      return result.line;
    })
    .join('\n');
  if (changed) fs.writeFileSync(path, rewritten);
  return changed;
};

// Recursively rewrites every Dockerfile under dir; returns files changed.
export const rewriteDockerfilesIn = (
  dir: string,
  options: RewriteOptions,
  log: (msg: string) => void
): number => {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      count += rewriteDockerfilesIn(path, options, log);
    } else if (
      isDockerfile(entry.name) &&
      rewriteDockerfile(path, options, log)
    ) {
      count += 1;
    }
  }
  return count;
};
