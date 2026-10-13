import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer } from 'testcontainers';
import { ENV, IMAGES } from './services.js';

/** @typedef {{ url: string, stop: () => Promise<unknown> }} RunningService */

/**
 * Containers this run started, for the teardown. Jest runs a global setup module once per run
 * however many projects name it (with the first project's config), so this starts every service
 * any integration project uses, rather than reading what one project wants.
 * @type {RunningService[]}
 */
export const running = [];

/**
 * Starts Postgres (with pgvector) and Redis and publishes their URLs for the test workers. When
 * both URLs are already set, as CI's service containers do, it starts nothing and uses those.
 */
export default async function globalSetup() {
  if (process.env[ENV.postgres] && process.env[ENV.redis]) return;
  const [postgres, redis] = await Promise.all([
    new PostgreSqlContainer(IMAGES.postgres).start(),
    new GenericContainer(IMAGES.redis).withExposedPorts(6379).start(),
  ]);
  running.push(
    { url: postgres.getConnectionUri(), stop: () => postgres.stop() },
    {
      url: `redis://${redis.getHost()}:${String(redis.getMappedPort(6379))}`,
      stop: () => redis.stop(),
    },
  );
  // Jest's workers start after this and inherit the environment.
  process.env[ENV.postgres] = running[0].url;
  process.env[ENV.redis] = running[1].url;
}
