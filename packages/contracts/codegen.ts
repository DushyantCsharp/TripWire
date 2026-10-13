import type { CodegenConfig } from '@graphql-codegen/cli';

const shared = {
  useTypeImports: true,
  enumsAsTypes: true,
  strictScalars: true,
  scalars: {
    // Our IDs are prefixed strings (inc_…). GraphQL would also accept an Int for an ID input.
    ID: 'string',
    // RFC 3339 strings on the wire; clients parse them when they need a Date.
    DateTime: 'string',
    JSON: 'unknown',
  },
};

const config: CodegenConfig = {
  schema: 'schema/schema.graphql',
  documents: 'schema/operations/**/*.graphql',
  generates: {
    // For the console: operation result/variable types and typed documents for urql.
    'src/generated/graphql-operations.ts': {
      plugins: ['typescript-operations', 'typed-document-node'],
      config: shared,
    },
    // For the API: schema types and resolver signatures.
    'src/generated/graphql-schema.ts': {
      plugins: ['typescript', 'typescript-resolvers'],
      config: {
        ...shared,
        // The API supplies its own context type: Resolvers<ApiContext>.
        contextType: 'unknown',
      },
    },
  },
};

export default config;
