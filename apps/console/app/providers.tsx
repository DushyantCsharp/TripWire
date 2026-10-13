'use client';

import { cacheExchange, createClient, fetchExchange, ssrExchange, UrqlProvider } from '@urql/next';
import { useMemo, type ReactNode } from 'react';

/** `url` comes from the server's environment (layout.tsx), read per request, not built in. */
export function Providers({ url, children }: { url: string; children: ReactNode }) {
  const [client, ssr] = useMemo(() => {
    const ssr = ssrExchange({ isClient: typeof window !== 'undefined' });
    const client = createClient({
      url,
      exchanges: [cacheExchange, ssr, fetchExchange],
      suspense: true,
    });
    return [client, ssr] as const;
  }, [url]);

  return (
    <UrqlProvider client={client} ssr={ssr}>
      {children}
    </UrqlProvider>
  );
}
