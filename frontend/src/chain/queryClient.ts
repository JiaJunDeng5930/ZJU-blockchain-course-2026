import { QueryClient } from "@tanstack/react-query";

export function createChainQueryClient(): QueryClient {
  // Local RPC can remain available without Internet access. The actual wallet
  // and RPC results decide availability; browser hints must not queue writes.
  return new QueryClient({
    defaultOptions: {
      queries: {
        networkMode: "always",
        retry: false,
        staleTime: 2000,
        refetchOnWindowFocus: false,
      },
      mutations: { networkMode: "always", retry: false },
    },
  });
}
