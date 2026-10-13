// Regenerates src/generated/ from schema/: GraphQL types, typed documents and resolver types;
// OpenAPI types for openapi-fetch; zod validators for the API.
// `--check` generates into a temp dir instead and exits 1 if src/generated/ differs from it.
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generate as generateGraphql } from '@graphql-codegen/cli';
import { createClient as generateZod } from '@hey-api/openapi-ts';
import openapiTS, { astToString } from 'openapi-typescript';
import * as prettier from 'prettier';
import codegenConfig from './codegen.ts';

const root = import.meta.dirname;
const target = join(root, 'src/generated');
const openapiPath = join(root, 'schema/openapi.yaml');
const banner = '// Generated from packages/contracts/schema by `pnpm generate`. Do not edit.\n\n';

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** What graphql-codegen's `generate(config, false)` returns; its own typing is `any`. */
interface GeneratedFile {
  filename: string;
  content: string;
}

async function generateInto(out: string): Promise<void> {
  const graphqlFiles = (await generateGraphql(
    { ...codegenConfig, cwd: root, silent: true },
    false,
  )) as GeneratedFile[];
  for (const file of graphqlFiles) {
    write(join(out, relative(target, join(root, file.filename))), banner + file.content);
  }

  const openapiAst = await openapiTS(pathToFileURL(openapiPath));
  write(join(out, 'openapi.ts'), banner + astToString(openapiAst));

  await generateZod({
    input: openapiPath,
    output: join(out, 'zod'),
    logs: { level: 'silent' },
    plugins: [
      {
        name: 'zod',
        // RFC 3339 date-times may carry an offset (Alertmanager can send +02:00); zod rejects them by default.
        dates: { offset: true },
        '~resolvers': {
          // `additionalProperties: false` must reject unknown fields; plain z.object() strips them.
          object(ctx) {
            const extra = ctx.schema.additionalProperties;
            if (extra !== false && extra?.type !== 'never') return undefined;
            return ctx.$(ctx.plugin.imports.z).attr('strictObject').call(ctx.nodes.shape(ctx));
          },
          // Query and header values arrive as strings, so numeric parameters coerce. Bodies don't.
          number(ctx) {
            if (!isParameter(ctx.path['~ref'])) return undefined;
            let chain = ctx.$(ctx.plugin.imports.z).attr('coerce').attr('number').call();
            if (ctx.schema.type === 'integer') chain = chain.attr('int').call();
            ctx.chain.current = chain;
            ctx.chain.current = ctx.nodes.min(ctx) ?? ctx.chain.current;
            ctx.chain.current = ctx.nodes.max(ctx) ?? ctx.chain.current;
            return ctx.chain.current;
          },
        },
      },
    ],
  });
}

/** Formats the output with the repo's prettier config, so generated diffs read like hand-written ones. */
async function formatInto(out: string): Promise<void> {
  for (const file of listFiles(out)) {
    const path = join(out, file);
    const options = await prettier.resolveConfig(join(target, file));
    writeFileSync(
      path,
      await prettier.format(readFileSync(path, 'utf8'), { ...options, filepath: path }),
    );
  }
}

/** Schema paths look like components/parameters/<name> or paths/<route>/<method>/query/... */
function isParameter(ref: readonly (string | number)[]): boolean {
  if (ref[0] === 'components') return ref[1] === 'parameters';
  return ref[0] === 'paths' && ['query', 'headers', 'path'].includes(String(ref[3]));
}

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path, base) : [relative(base, path)];
  });
}

/** Files that differ between the fresh output and src/generated/, as "<status> <path>" lines. */
function diff(fresh: string, current: string): string[] {
  const freshFiles = new Set(listFiles(fresh));
  const currentFiles = new Set(listFiles(current));
  const stale: string[] = [];
  for (const file of freshFiles) {
    if (!currentFiles.has(file)) stale.push(`missing  ${file}`);
    else if (!readFileSync(join(fresh, file)).equals(readFileSync(join(current, file)))) {
      stale.push(`stale    ${file}`);
    }
  }
  for (const file of currentFiles) if (!freshFiles.has(file)) stale.push(`orphaned ${file}`);
  return stale;
}

const check = process.argv.includes('--check');
const out = mkdtempSync(join(tmpdir(), 'tripwire-contracts-'));
try {
  await generateInto(out);
  await formatInto(out);
  if (check) {
    mkdirSync(target, { recursive: true });
    const stale = diff(out, target);
    if (stale.length > 0) {
      console.error(
        `packages/contracts/src/generated is out of date with schema/:\n${stale.map((line) => `  ${line}`).join('\n')}\n` +
          'Run `pnpm generate` and commit the result.',
      );
      process.exitCode = 1;
    } else {
      console.log('packages/contracts/src/generated is up to date.');
    }
  } else {
    rmSync(target, { recursive: true, force: true });
    cpSync(out, target, { recursive: true });
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
