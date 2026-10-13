import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import { typescriptConfig } from './base.js';

/**
 * Composed from the plugins directly: eslint-config-next pulls in react, import and jsx-a11y
 * plugins that don't support ESLint 10 yet.
 * @param {string} tsconfigRootDir pass `import.meta.dirname`
 */
export function nextConfig(tsconfigRootDir) {
  return defineConfig([
    ...typescriptConfig(tsconfigRootDir),
    nextPlugin.configs['core-web-vitals'],
    reactHooks.configs.flat['recommended-latest'],
  ]);
}
