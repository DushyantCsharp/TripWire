import { forbid, nodeConfig } from '@tripwire/eslint-config/node';

export default nodeConfig(import.meta.dirname, { forbidden: [forbid.apps, forbid.database] });
