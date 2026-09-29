#!/usr/bin/env node
// Bump the app version everywhere it is declared. Cargo.lock is intentionally
// left to cargo, which refreshes the `sunburst-disk` entry on the next build.
//
//   npm run version:bump -- 0.3.2
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = process.argv[2]

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: npm run version:bump -- <major.minor.patch>')
  process.exit(1)
}

const edits = [
  {
    file: 'package.json',
    apply: text => text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`),
  },
  {
    file: 'package-lock.json',
    apply: text => text
      .replace(/^(\s*"version"\s*:\s*")[^"]+(")/m, `$1${version}$2`)
      .replace(
        /("packages"\s*:\s*\{\s*""\s*:\s*\{\s*"name"\s*:\s*"sunburst-disk"\s*,\s*"version"\s*:\s*")[^"]+(")/,
        `$1${version}$2`,
      ),
  },
  {
    file: 'src-tauri/Cargo.toml',
    apply: text => text.replace(/(\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m, `$1${version}$2`),
  },
  {
    file: 'src-tauri/tauri.conf.json',
    apply: text => text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`),
  },
]

let changed = 0
for (const { file, apply } of edits) {
  const path = resolve(root, file)
  const before = readFileSync(path, 'utf8')
  const after = apply(before)
  if (after === before) {
    console.error(`! ${file}: no version field matched`)
    process.exitCode = 1
    continue
  }
  writeFileSync(path, after)
  changed += 1
  console.log(`  updated ${file}`)
}

console.log(changed === edits.length
  ? `\nBumped to ${version}. Next: add a RELEASE_HIGHLIGHTS['${version}'] entry in src/App.jsx, then build so Cargo.lock refreshes.`
  : '\nSome files were not updated.')
