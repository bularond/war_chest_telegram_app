/**
 * Refuses to let a build start while the lab is playing.
 *
 * `tsc -b` rewrites `dist`, the lab spawns a worker per experiment, and a worker
 * started mid-write loads half a file. CLAUDE.md has warned about this since
 * August; I walked into it three times in one night, because `npm run typecheck`
 * is the natural thing to type and it emits like any other build. A note in a
 * document does not stop that. This does.
 *
 * **It must never be the reason a build fails.** The first version asked
 * `pgrep -fl "lab-cli.js|game-worker.js"`, which is a pattern in a dialect that
 * differs between `procps` and `busybox` — inside the Docker image it matched
 * the build's own `/bin/sh` and stopped the deployment. So the matching is done
 * here, on plain text, with no pattern at all: `ps` lists the processes and this
 * looks for the two file names in the output. Anything unexpected — no `ps`, an
 * unfamiliar format, an error — means no lab, because a workbench convenience
 * has no business having an opinion about a production build.
 *
 * Set `ALLOW_BUILD_DURING_LAB=1` when the risk is understood and taken.
 */
import { execSync } from 'node:child_process';

if (process.env.ALLOW_BUILD_DURING_LAB === '1') process.exit(0);

/** The two processes that read `dist` while a match is running. */
const NEEDLES = ['lab-cli.js', 'game-worker.js'];

let lines = [];
try {
  lines = execSync('ps -Ao pid=,args= 2>/dev/null || true')
    .toString()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => NEEDLES.some((needle) => line.includes(needle)));
} catch {
  process.exit(0);
}
if (lines.length === 0) process.exit(0);

console.error('\n  A build would rewrite dist while the lab is using it:\n');
for (const line of lines.slice(0, 3)) console.error(`    ${line.slice(0, 110)}`);
console.error(
  '\n  A worker started mid-write loads a half-file and the experiment dies. Wait for\n' +
    '  the queue to drain, or run the checks that do not emit:\n\n' +
    '    npx vitest run packages/shared packages/bots packages/tooling\n\n' +
    '  ALLOW_BUILD_DURING_LAB=1 overrides this.\n',
);
process.exit(1);
