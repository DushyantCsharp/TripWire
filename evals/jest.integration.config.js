import { integration } from '@tripwire/jest-config';

// Each test file creates its own database in the shared Postgres (createTestDatabase).
export default integration(import.meta.dirname);
