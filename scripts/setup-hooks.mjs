/**
 * Point git at the committed .githooks/ directory so the CI gates run locally
 * before code leaves the machine. Wired through the npm "prepare" lifecycle, so
 * a plain `npm install` sets it up with no extra step. A relative hooksPath
 * resolves per working tree, so this works in the main checkout and in every
 * git worktree. Safe to no-op when there's no git checkout (tarball installs).
 */
import { execFileSync } from 'node:child_process';

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
  console.log('git hooks configured → .githooks (pre-commit + pre-push run the CI gates)');
} catch {
  // Not a git checkout (or git unavailable) — nothing to wire up.
}
