# 011: Preserve generated decoder and callback boundaries

Status: accepted.

The simulation controller must continue observing a task for as long as it
runs. A real-service acceptance run exposed a valid `poll` event being rejected
after repeated observations. Replaying the real, immutable completed-job HTTP
response through the public controller reproduced the failure at iteration 256
on Node 26.5.0 (V8 14.6.202.34-node.24).

The same generated artifact and 600 observations passed on Node 24.19.0, and on
Node 26.5.0 with Maglev disabled for diagnosis. A private build from the same
OCaml bytecode, compiler and runtime stubs, using js_of_ocaml's official
`--disable inline` option, passed all 600 observations on unmodified Node
26.5.0. These observations identify an execution-path interaction; they do not
establish a general defect classification or repair of V8.

Disable inlining in the normal JavaScript generation command. Record the actual
compiler version and arguments in the existing build manifest. Keep the Rocq
state machine, JSON interface, callback exports and production JavaScript engine
settings unchanged. A global compilation option avoids adding artificial
controller limits, retries, replacement controllers or a special-purpose codec
wrapper to domain code. The existing compiler and runtime remain trusted.

The public simulation acceptance includes more than 256 consecutive real HTTP
observations. The other public workflow runners exercise the newly generated
artifact because this option changes the whole bundle's code shape. The
reported results cover those executions; they do not prove browser or compiler
correctness. Revisit the option only with evidence from the same public
long-running observation contract, rather than a presumed compiler upgrade.

Reference: [js_of_ocaml compiler options](https://ocsigen.org/js_of_ocaml/latest/manual/options).
