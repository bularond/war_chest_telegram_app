/**
 * A path typed at the repository root has to mean the repository root.
 *
 * The root `package.json` forwards every tool to the workspace, and the script
 * then runs with its working directory set to `packages/tooling`. So every
 * `weights/…` in `CLAUDE.md` — typed at the root, sitting at the root — was
 * being opened one directory too deep. `npm run ladder` had never worked.
 */

import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { fromInvocation } from './paths.js';

/** Runs `body` with `INIT_CWD` set to what npm would have recorded. */
function invokedFrom<T>(dir: string | undefined, body: () => T): T {
  const before = process.env.INIT_CWD;
  if (dir === undefined) delete process.env.INIT_CWD;
  else process.env.INIT_CWD = dir;
  try {
    return body();
  } finally {
    if (before === undefined) delete process.env.INIT_CWD;
    else process.env.INIT_CWD = before;
  }
}

describe('a path on the command line', () => {
  it('is measured from where the command was typed, not from where it runs', () => {
    expect(invokedFrom('/repo', () => fromInvocation('weights/base.json'))).toBe(
      '/repo/weights/base.json',
    );
  });

  it('leaves an absolute path alone', () => {
    expect(invokedFrom('/repo', () => fromInvocation('/elsewhere/base.json'))).toBe(
      '/elsewhere/base.json',
    );
  });

  it('falls back to the working directory when nothing recorded an invocation', () => {
    // Running a CLI with plain `node` is a normal thing to do, and there the
    // working directory *is* what was meant. Every match this project has
    // recorded was started that way, which is why the bug went unseen.
    expect(invokedFrom(undefined, () => fromInvocation('weights/base.json'))).toBe(
      resolve('weights/base.json'),
    );
  });
});
