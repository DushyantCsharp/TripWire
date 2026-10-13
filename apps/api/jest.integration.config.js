import { integration } from '@tripwire/jest-config';

// Each test isolates itself with its own queue prefix in the shared Redis.
export default integration(import.meta.dirname);
