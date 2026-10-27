# Simulation controller verification boundary

`Spec/Simulation.v` defines the four integer inputs and their service ranges.
`Frontend/SimulationModel.v` defines the controller, accepted observations, request
identities, commands, uncertainty, and asset-refresh notifications.
`Frontend/SimulationExtract.v` extracts that controller to OCaml. The JavaScript
export is `globalThis.DEXSimulation`; `logic/simulation.ts` only adapts JSON and
performs HTTP effects. React renders the resulting view and dispatches events.

The model proves that accepted start parameters satisfy every range, invalid
parameters cannot start a run, request identities increase, superseded responses
cannot change the view or trigger an asset refresh, in-flight commands exclude
other commands, stop effects target the observed job identity, polling emits
only reads, and uncertain sends cannot start or stop a job until a successful
read reconciles the service state. Polls may be superseded by commands; their
subsequent responses are ignored. No start or stop operation is automatically
retried. A transport timeout means unknown outcome, not server rejection.

The controller keeps one authoritative state. It treats reports and job progress
as external observations; it does not prove the simulation worker's execution,
reported profits, rollback evidence, or market snapshots. Existing worker policy
and twenty real local-chain participants are unchanged.

## External interface contract

The browser issues same-origin requests through the existing Vite API proxy.
The HTTP service returns a `SimulationJob` JSON object on a successful response;
its state is one of the seven constructors in `simulation-protocol.ts`, and its
job identity refers to the progress/report in that response. JSON decoding,
HTTP delivery, Node execution, worker IPC, React, and browser timers are trusted
interfaces, not consequences of the Rocq proofs. Observations must accurately
represent the service state at the time the service constructs the response.

- `GET /api/simulation` observes state without creating a job.
- `POST /api/simulation/start` accepts the existing numeric options. The service
  independently checks its public input and allows only one worker.
- `POST /api/simulation/stop` requires `{ "jobId": "observed-id" }`. It rejects
  a mismatched job with HTTP 409 before signaling the worker. This protects
  against a stale page stopping another run, including across page instances.
- `GET /api/simulation/report?jobId=observed-id` rejects a changed identity with
  HTTP 409 rather than downloading a different run's report. The query remains
  optional for existing command-line consumers.

Requests have a fifteen-second browser transport deadline. A timeout aborts the
local wait; the service may already have accepted a command. Therefore the
controller enters uncertainty and queries state, without retrying the command.
Local per-controller request identities isolate late responses; server job
identities bind stop/report operations across controllers.

The OCaml bridge only serializes/deserializes domain values. Decimal validation,
integer range checks, command availability, state updates, and response selection
execute the extracted program. Graph coordinates remain approximate display
calculations; token and gas amounts use exact integer formatting.

The worker waits for each Node IPC send callback before proceeding, including
the final report, and disconnects only after that write completes. The service
classifies a missing report on the child's `close` event, after its streams have
closed, rather than on the earlier `exit` event. This ordering repairs an
observed zero-exit report loss; it is an integration obligation of the trusted
Node interface and is not claimed as a Rocq theorem.
