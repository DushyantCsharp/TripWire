// Integration hooks create databases, run migrations and seed thousands of rows. In a multi-project
// run Jest takes testTimeout only from the root config, so each integration test file sets its own.
import { jest } from '@jest/globals';

jest.setTimeout(60_000);
