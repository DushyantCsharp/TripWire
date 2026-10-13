import { Suspense } from 'react';
import { ApiStatus } from './api-status';

// A live console renders against the running API on every request, never at build time.
export const dynamic = 'force-dynamic';

export default function HomePage() {
  return (
    <main>
      <h1>Tripwire</h1>
      <Suspense fallback={<p>Connecting to API…</p>}>
        <ApiStatus />
      </Suspense>
    </main>
  );
}
