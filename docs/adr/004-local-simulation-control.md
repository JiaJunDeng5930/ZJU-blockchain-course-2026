# ADR 004: Control the market simulation from the website

Status: accepted

A terminal-only simulator made the course demonstration depend on commands and raw JSON rather than observable market behavior. A browser cannot directly sign for the node's twenty unlocked accounts or own a long-running Node worker, so a loopback-only controller bridges that effect boundary.

The controller forks the existing simulator, accepts only bounded numeric options, and uses typed IPC progress and terminal messages. It does not duplicate swap, liquidity or arbitrage logic. The browser can observe and stop a job without becoming a shell interface. Origin and JSON checks protect mutation endpoints; the service binds only to 127.0.0.1.

Stopping finishes the current confirmed action and redeems positions opened by that run. Stopped and failed jobs remain distinct from completed runs. Receipt evidence and complete downloadable reports preserve the difference between a profitable swap sequence and a deliberately reverted arbitrage. Refresh reconnects to the same server-owned job rather than launching another worker.

The root launcher starts the chain, deployment, controller and frontend as needed. It reuses existing valid local state and owns only the processes it creates. A static production bundle still needs the controller for simulation; this is deliberately a local teaching application, not an unauthenticated hosted transaction service.
