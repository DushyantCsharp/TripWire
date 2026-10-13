import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { currentCommit } from './commit.js';

describe('currentCommit', () => {
  it('names the checkout’s commit, marked when the tree has changes', async () => {
    expect(await currentCommit()).toMatch(/^[0-9a-f]{7,}(-dirty)?$/);
  });

  it('is null outside a git checkout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'no-git-'));
    try {
      expect(await currentCommit(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
