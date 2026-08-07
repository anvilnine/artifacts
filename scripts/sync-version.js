#!/usr/bin/env node
// Runs from the `version` npm lifecycle script, after npm has written the new version
// into package.json and package-lock.json but before it makes the version commit.
// Copies that version into the other files that carry one and stages them, so
// `npm version patch` produces one commit with every version moved together.
//
// server.js does not need an edit: it reads the version out of package.json at boot.
// The identity checks at the end of .github/workflows/smoke.sh assert these agree.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (name) => JSON.parse(readFileSync(path.join(root, name), 'utf8'));

const version = readJson('package.json').version;
if (!version) throw new Error('package.json has no version field');

// Every file besides package.json / package-lock.json that carries the version.
const targets = ['server.json'];
const staged = [];

for (const name of targets) {
  const data = readJson(name);
  if (!('version' in data)) throw new Error(`${name} has no version field to sync`);
  if (data.version === version) continue;
  data.version = version;
  writeFileSync(path.join(root, name), `${JSON.stringify(data, null, 2)}\n`);
  staged.push(name);
  console.log(`synced ${name} to ${version}`);
}

// npm sets this to an empty string when `--no-git-tag-version` is passed and leaves it
// unset otherwise. No commit is coming in that case, so leave the index alone.
const willCommit = process.env.npm_config_git_tag_version !== '';
if (staged.length && willCommit) execFileSync('git', ['add', ...staged], { cwd: root });
