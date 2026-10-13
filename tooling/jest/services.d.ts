export type TestService = 'postgres' | 'redis';

export declare const IMAGES: Readonly<Record<TestService, string>>;
export declare const ENV: Readonly<Record<TestService, string>>;

/**
 * Connection URL of a service started for this run. For Postgres it is the server's default
 * database: give each test file its own with createTestDatabase() from `@tripwire/db/testing`.
 */
export declare function serviceUrl(name: TestService): string;
