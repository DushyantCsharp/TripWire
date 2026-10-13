// Node only: the SDL for building the executable schema, plus schema and resolver types.
import { readFileSync } from 'node:fs';

export * from './generated/graphql-schema.js';

export const typeDefs = readFileSync(new URL('../schema/schema.graphql', import.meta.url), 'utf8');
