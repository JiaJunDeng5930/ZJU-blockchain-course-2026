# 012: Observe local chain availability through RPC

Status: accepted.

The demo uses a local RPC node and HTTP services. Losing Internet access does
not imply losing access to localhost. TanStack Query's default `online` network
mode can pause both initial queries and mutations when the browser reports
offline. A user could therefore see an indefinite loading state or enqueue a
manual operation without that operation reaching the existing wallet model.
The browser's connectivity hint is not evidence that the configured RPC is
unavailable.

Create the application's QueryClient through `createChainQueryClient` and use
TanStack Query's `always` network mode for queries and mutations. Keep the
existing `retry: false`, polling intervals, query keys, cache and Rocq wallet
identity guards. Availability is established by the real HTTP/RPC response and
the existing wallet checks. Failed operations still surface their actual error;
this decision does not add an offline write queue or a retry mechanism.

Render the existing query's source block, balance owner, background fetch and
placeholder status. A failed refresh explicitly identifies retained data;
an initial failure is not described as ongoing loading. Manual refresh uses
the same query's `refetch`, and an in-flight read disables that button. These
are projections of TanStack Query's existing state, not a second query state
machine. The existing Rocq `retainsSnapshot` decision remains responsible for
whether data from an earlier query identity may be shown.

Independent acceptance exercises the production query-client factory with
public observers and real isolated RPC operations, including a failed request
and recovery. It checks the external connection policy, not browser rendering
or an alternative implementation of TanStack Query.

References:

- [TanStack Query network modes](https://tanstack.com/query/latest/docs/framework/react/guides/network-mode)
- [TanStack Query background fetching indicators](https://tanstack.com/query/latest/docs/framework/react/guides/background-fetching-indicators)
- [MDN: Navigator.onLine](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine)
