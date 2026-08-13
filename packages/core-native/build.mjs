/**
 * Builds the addon and drops it next to this file.
 *
 * `cargo` produces a platform-shaped shared library; Node wants a `.node`, and
 * wants it somewhere `require` can see. That is the whole of this script.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

execFileSync('cargo', ['build', '--release', '-p', 'wc-napi'], {
  cwd: root,
  stdio: 'inherit',
});

const built = {
  darwin: 'libwc_napi.dylib',
  linux: 'libwc_napi.so',
  win32: 'wc_napi.dll',
}[process.platform];
if (!built) throw new Error(`no addon name known for ${process.platform}`);

const from = path.join(root, 'target/release', built);
if (!existsSync(from)) throw new Error(`cargo did not produce ${from}`);
copyFileSync(from, path.join(here, 'wc-core.node'));
console.log('@wc/core-native: wc-core.node');
