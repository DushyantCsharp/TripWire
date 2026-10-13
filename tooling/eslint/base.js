import js from '@eslint/js';
import { globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

/** Import bans that encode the package boundaries in CLAUDE.md. */
export const forbid = {
  apps: {
    group: [
      '@tripwire/api',
      '@tripwire/api/*',
      '@tripwire/worker',
      '@tripwire/worker/*',
      '@tripwire/console',
      '@tripwire/console/*',
      '@tripwire/evals',
      '@tripwire/evals/*',
      '**/apps/**',
      '**/evals/**',
    ],
    message: 'Nothing imports an app or evals. Move shared code into packages/*.',
  },
  database: {
    group: [
      '@tripwire/db',
      '@tripwire/db/*',
      'drizzle-orm',
      'drizzle-orm/*',
      'pg',
      'postgres',
      '**/packages/db/**',
    ],
    message:
      'packages/agent never touches the database: it returns proposals, apps persist and execute them.',
  },
};

/**
 * Type-aware TypeScript rules shared by every workspace.
 * @param {string} tsconfigRootDir directory holding the workspace's tsconfig.json
 * @param {{ forbidden?: Array<{ group: string[], message: string }> }} [options]
 */
export function typescriptConfig(tsconfigRootDir, { forbidden = [forbid.apps] } = {}) {
  return [
    globalIgnores([
      'dist/**',
      '.next/**',
      'coverage/**',
      'src/generated/**',
      '*.config.js',
      'next-env.d.ts',
    ]),
    js.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    {
      languageOptions: {
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      rules: {
        '@typescript-eslint/consistent-type-imports': 'error',
        '@typescript-eslint/switch-exhaustiveness-check': 'error',
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
        '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
        'no-restricted-imports': ['error', { patterns: forbidden }],
      },
    },
  ];
}
