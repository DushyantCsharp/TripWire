import { parseEnv } from '@tripwire/config';
import type { Metadata } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { z } from 'zod';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Tripwire',
  description: 'Incident triage console',
};

const consoleEnv = z.object({
  /** The API's GraphQL endpoint, as both the browser and this server reach it. */
  GRAPHQL_URL: z.url().default('http://localhost:4000/graphql'),
});

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Rendered per request, never at build time (/_not-found included), so the URL comes from the
  // environment the console runs in and one image serves any deployment.
  await connection();
  const env = parseEnv(consoleEnv);
  if (!env.ok) throw new Error(`invalid console environment: ${env.error.issues.join('; ')}`);
  return (
    <html lang="en">
      <body>
        <Providers url={env.value.GRAPHQL_URL}>{children}</Providers>
      </body>
    </html>
  );
}
