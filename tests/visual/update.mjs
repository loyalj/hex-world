// Re-bake the visual goldens. A script rather than an env prefix in
// package.json so it works from cmd, PowerShell, and a POSIX shell alike.
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vitest', 'run', '--config', 'vitest.visual.config.ts'],
  { stdio: 'inherit', shell: true, env: { ...process.env, UPDATE_SNAPSHOTS: '1' } },
);
process.exit(result.status ?? 1);
