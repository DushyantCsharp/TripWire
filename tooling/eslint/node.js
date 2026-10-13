import { defineConfig } from 'eslint/config';
import { typescriptConfig } from './base.js';

export { forbid } from './base.js';

/**
 * @param {string} tsconfigRootDir pass `import.meta.dirname`
 * @param {Parameters<typeof typescriptConfig>[1]} [options]
 */
export function nodeConfig(tsconfigRootDir, options) {
  return defineConfig(typescriptConfig(tsconfigRootDir, options));
}
