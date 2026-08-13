/**
 * Where a path on the command line is measured from.
 *
 * Every tool here is started through the root `package.json`, which forwards to
 * the workspace: `npm run ladder -- --weights weights/lab.json` becomes
 * `npm run ladder -w @wc/tooling -- …`, and the script then runs with its
 * working directory set to `packages/tooling`. So `weights/lab.json` — typed at
 * the repository root, sitting at the repository root, and written that way in
 * every line of `CLAUDE.md` — was opened as `packages/tooling/weights/lab.json`
 * and was not there.
 *
 * npm records the directory the command was actually typed in as `INIT_CWD`, and
 * that is the only thing here that knows what the person meant. Absolute paths
 * pass through untouched, and so does everything when the variable is missing —
 * running a CLI with plain `node` is a normal thing to do, and there the working
 * directory *is* what was meant.
 *
 * Found while finishing a branch: `npm run ladder` had been broken this way for
 * as long as it has existed, and the reason nobody noticed is that the matches
 * that mattered were all started as `node packages/tooling/dist/lab-cli.js` from
 * the root, where the bug cannot happen.
 */

import { isAbsolute, resolve } from 'node:path';

export function fromInvocation(path: string): string {
  if (isAbsolute(path)) return path;
  const base = process.env.INIT_CWD;
  return base ? resolve(base, path) : resolve(path);
}
