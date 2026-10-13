import { defineConfig } from 'drizzle-kit';

// drizzle-kit only generates SQL here; src/migrator.ts applies it (see MIGRATIONS.md).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  casing: 'snake_case',
  strict: true,
  verbose: true,
});
