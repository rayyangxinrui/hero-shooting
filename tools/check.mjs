#!/usr/bin/env node
/**
 * Fast syntax gate.
 *
 * Runs `node --check` over every source file and reports the first parse error
 * per file. This exists because a single stray character in one agent's file
 * takes the whole build down for every other agent, and the browser reports it
 * as an opaque "Unexpected identifier" with no stack and no filename.
 *
 * The specific trap it catches: a backtick inside a GLSL template literal.
 * Writing `pow(x, k)` in a shader comment terminates the JS template string,
 * and the shader source breaks mid-file. Use 'single quotes' in GLSL comments.
 *
 * Usage: node tools/check.mjs
 * Exit code is non-zero if anything fails to parse.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path, out);
    else if (extname(entry.name) === '.js' || extname(entry.name) === '.mjs') out.push(path);
  }
  return out;
}

const files = [...(await walk('src')), ...(await walk('tools'))];
let failed = 0;

/**
 * Point at the *cause* rather than at the symptom.
 *
 * `node --check` reports a stray backtick in a GLSL comment as an unexpected
 * identifier on whatever word happens to follow it, several lines from the
 * comment that actually broke. Since that trap is the documented reason this
 * gate exists, find it explicitly: scan the failing file for a backtick that
 * sits inside a template literal opened by a `/* glsl *\/` marker, and name the
 * line. Costs nothing — it only runs after a file has already failed.
 */
async function explainBackticks(file) {
  const source = await readFile(file, 'utf8');
  const lines = source.split('\n');
  const hits = [];
  let inTemplate = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inTemplate) {
      if (/\/\*\s*glsl\s*\*\/\s*`/.test(line)) inTemplate = true;
      continue;
    }
    // A lone backtick on a line by itself (possibly with a semicolon) closes it.
    if (/^\s*`\s*[;,)]?\s*$/.test(line)) {
      inTemplate = false;
      continue;
    }
    if (line.includes('`')) hits.push([i + 1, line.trim()]);
  }
  return hits;
}

for (const file of files) {
  try {
    await run(process.execPath, ['--check', file]);
  } catch (error) {
    failed++;
    const message = String(error.stderr ?? error.message)
      .split('\n')
      .filter((line) => line.trim())
      .slice(0, 4)
      .join('\n    ');
    console.error(`FAIL ${file}\n    ${message}\n`);

    const hits = await explainBackticks(file);
    if (hits.length) {
      console.error('    ^ backtick(s) inside a GLSL template literal:');
      for (const [line, text] of hits.slice(0, 6)) {
        console.error(`        ${file}:${line}  ${text.slice(0, 90)}`);
      }
      console.error("      Use 'single quotes' in shader comments.\n");
    }
  }
}

console.log(`${files.length - failed}/${files.length} files parse cleanly`);
if (failed) {
  console.error('\nCommon cause: a backtick inside a GLSL template literal.');
  console.error("Use 'single quotes' in shader comments, never backticks.");
  process.exit(1);
}
