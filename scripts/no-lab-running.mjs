/**
 * Refuses to let a build start while the lab is playing.
 *
 * `tsc -b` rewrites `dist`, the lab spawns a worker per experiment, and a worker
 * started mid-write loads half a file. CLAUDE.md has warned about this since
 * August; I walked into it three times in one night, because `npm run typecheck`
 * is the natural thing to type and it emits like any other build. A note in a
 * document does not stop that. This does.
 *
 * Set `ALLOW_BUILD_DURING_LAB=1` when the risk is understood and taken.
 */
import { execSync } from 'node:child_process';

if (process.env.ALLOW_BUILD_DURING_LAB === '1') process.exit(0);

let running = '';
try {
  running = execSync('pgrep -fl "lab-cli.js|game-worker.js" 2>/dev/null || true').toString().trim();
} catch {
  process.exit(0);
}
if (running === '') process.exit(0);

console.error('\n  A build would rewrite dist while the lab is using it:\n');
for (const line of running.split('\n').slice(0, 3)) console.error(`    ${line.slice(0, 110)}`);
console.error(
  '\n  A worker started mid-write loads a half-file and the experiment dies. Wait for\n' +
    '  the queue to drain, or run the checks that do not emit:\n\n' +
    '    npx vitest run packages/shared packages/bots packages/tooling\n\n' +
    '  ALLOW_BUILD_DURING_LAB=1 overrides this.\n',
);
process.exit(1);
