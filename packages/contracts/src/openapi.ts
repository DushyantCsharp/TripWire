import createClient from 'openapi-fetch';
import type { components, paths } from './generated/openapi.js';

export type { components, paths };

/** Typed client for the REST API; paths include the /v1 prefix. */
export function createRestClient(baseUrl: string) {
  return createClient<paths>({ baseUrl });
}
