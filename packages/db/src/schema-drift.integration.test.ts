import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from '@jest/globals';
import { MIGRATIONS_DIR } from './migrator.js';

const packageDir = fileURLToPath(new URL('..', import.meta.url));

// Catches schema.ts edits that were never turned into a migration with `just db-generate`.
it('schema.ts matches the migrations: drizzle-kit has nothing new to generate', async () => {
  const out = mkdtempSync(join(tmpdir(), 'tripwire-drift-'));
  try {
    cpSync(MIGRATIONS_DIR, out, { recursive: true });
    // drizzle-kit mangles absolute --out paths (it prefixes "./"), and exits 0 even when it
    // crashes, so pass a relative path and assert on the output rather than the exit code.
    const { stdout, stderr } = await promisify(execFile)(
      join(packageDir, 'node_modules/.bin/drizzle-kit'),
      [
        'generate',
        '--dialect=postgresql',
        '--schema=./src/schema.ts',
        '--casing=snake_case',
        `--out=${relative(packageDir, out)}`,
      ],
      { cwd: packageDir },
    );
    expect(`${stdout}${stderr}`).toContain('No schema changes');
    expect(readdirSync(out).sort()).toEqual(readdirSync(MIGRATIONS_DIR).sort());
  } finally {
    rmSync(out, { recursive: true });
  }
});
