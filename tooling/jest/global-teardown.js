import { running } from './global-setup.js';

/** Stops the containers the global setup started. */
export default async function globalTeardown() {
  await Promise.all(running.splice(0).map((service) => service.stop()));
}
