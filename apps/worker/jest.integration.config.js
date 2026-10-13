import { integration } from '@tripwire/jest-config';

// Each file gets its own database, and each test its own queue prefix.
export default integration(import.meta.dirname);
