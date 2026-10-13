import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { attempt } from '@tripwire/result';

/**
 * The commit a report measured, as `git describe --always --dirty` gives it (`a2f0cfb`, or
 * `a2f0cfb-dirty` with uncommitted changes), so every published number names the code behind it.
 * Null outside a git checkout.
 */
export async function currentCommit(cwd: string = process.cwd()): Promise<string | null> {
  const described = await attempt(
    () => promisify(execFile)('git', ['describe', '--always', '--dirty', '--abbrev=7'], { cwd }),
    () => null,
  );
  return described.ok ? described.value.stdout.trim() || null : null;
}
