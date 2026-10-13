// The services the integration global setup starts, and how tests find them. Plain JS: the global
// setup runs in Jest's own process, outside its transform.

/** The same images as infra/docker-compose.yml. */
export const IMAGES = {
  postgres: 'pgvector/pgvector:0.8.7-pg16',
  redis: 'redis:7.4.11-alpine',
};

/**
 * The global setup publishes each URL here, or finds both already set and starts nothing (CI's
 * service containers). Jest's workers inherit the environment.
 */
export const ENV = {
  postgres: 'TRIPWIRE_TEST_POSTGRES_URL',
  redis: 'TRIPWIRE_TEST_REDIS_URL',
};

/**
 * Connection URL of a service started for this run. For Postgres it is the server's default
 * database: give each test file its own with createTestDatabase() from `@tripwire/db/testing`.
 * @param {keyof typeof ENV} name
 * @returns {string}
 */
export function serviceUrl(name) {
  const url = process.env[ENV[name]];
  if (!url) {
    throw new Error(`${name} runs only for integration tests: name the file *.integration.test.ts`);
  }
  return url;
}
