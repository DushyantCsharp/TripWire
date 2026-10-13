'use client';

import { PingDocument } from '@tripwire/contracts/graphql';
import { useQuery } from '@urql/next';

export function ApiStatus() {
  const [{ data, error }] = useQuery({ query: PingDocument });
  if (error) return <p>API unreachable: {error.message}</p>;
  return <p>API says: {data?.ping}</p>;
}
