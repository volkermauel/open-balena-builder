import * as fs from 'fs';
import * as path from 'path';

/**
 * Release version auto-assignment.
 *
 * balena-cli takes the release version exclusively from the project's
 * balena.yml (`version:` top-level key) when running `balena deploy`.
 * Without it, the API stores the release as 0.0.0 (balenaCloud behaves
 * identically). These helpers let the builder close that gap: when the
 * uploaded project defines no version, the builder derives the next
 * patch version from the application's latest release and injects it
 * into the project before `balena deploy` runs.
 */

// Matches a top-level (column 0) `version:` key. Indented occurrences
// (nested mappings, e.g. per-service blocks) and comment lines never match.
const VERSION_LINE = /^version:[ \t]*(.*)$/;

// Matches a bare value, optionally quoted, with an optional trailing comment.
const VERSION_VALUE = /^("|')?(.*?)\1?(?:[ \t]+#.*)?$/;

const SEMVER_HEAD = /^v?(\d+)\.(\d+)\.(\d+)/;

const stripQuotesAndComment = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return '';
  const match = VERSION_VALUE.exec(trimmed);
  if (!match) return '';
  return (match[2] ?? '').trim();
};

/**
 * Read the top-level `version:` value from `<workdir>/balena.yml`.
 * Returns null when the file is missing, has no top-level version key,
 * or the key carries no usable value (empty or comment-only).
 */
export const readProjectVersion = (workdir: string): string | null => {
  const balenaYmlPath = path.join(workdir, 'balena.yml');
  if (!fs.existsSync(balenaYmlPath)) return null;

  const lines = fs.readFileSync(balenaYmlPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = VERSION_LINE.exec(line);
    if (match) {
      const value = stripQuotesAndComment(match[1] ?? '');
      return value === '' ? null : value;
    }
  }
  return null;
};

/**
 * Derive the next version from the application's latest release semver.
 * Bumps the patch segment; a null/malformed input starts at 0.0.1
 * (which also lifts an existing 0.0.0 fleet to 0.0.1 on its next build).
 */
export const nextVersion = (latest: string | null | undefined): string => {
  if (!latest) return '0.0.1';
  const match = SEMVER_HEAD.exec(latest.trim());
  if (!match) return '0.0.1';
  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number(patch) + 1}`;
};

/**
 * Ensure `<workdir>/balena.yml` carries the given version. Returns true
 * when the file was created or modified, false when a version was already
 * present (in which case the file is left byte-identical — the CLI will
 * use the project's own version, invalid or not, exactly like balenaCloud).
 */
export const ensureProjectVersion = (
  workdir: string,
  version: string
): boolean => {
  const balenaYmlPath = path.join(workdir, 'balena.yml');
  const line = `version: ${version}`;

  if (!fs.existsSync(balenaYmlPath)) {
    fs.writeFileSync(balenaYmlPath, `${line}\n`);
    return true;
  }

  const content = fs.readFileSync(balenaYmlPath, 'utf8');
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const match = VERSION_LINE.exec(lines[i]);
    if (match) {
      const value = stripQuotesAndComment(match[1] ?? '');
      if (value !== '') return false;
      // Key exists but is empty/comment-only: fill it in place.
      lines[i] = line;
      fs.writeFileSync(balenaYmlPath, lines.join(eol));
      return true;
    }
  }

  // No top-level version key: append one. A column-0 key is valid YAML
  // regardless of where it appears relative to nested blocks.
  const separator = content === '' || content.endsWith('\n') ? '' : eol;
  fs.writeFileSync(balenaYmlPath, `${content}${separator}${line}${eol}`);
  return true;
};
