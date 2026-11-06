# Formal toolchain

The project uses official Coq 8.20.1 (the pre-rename Rocq release) for both the shared specification and extraction. The pinned Solidity translator's large `Set` inductives require its documented `-impredicative-set` mode. They did not compile with the tested Rocq 9.1.1/9.2 kernels. Frontend proofs use ordinary predicative `Set`; contract refinement commands declare the additional mode explicitly.

## Prepare an isolated installation

Install Node.js, Git, opam, CMake, a C++ compiler, Boost, Z3, GMP and pkg-config using the platform package manager. On macOS, Xcode command-line tools and the following Homebrew packages provide these prerequisites:

```sh
brew install opam cmake boost z3 gmp pkg-config
node scripts/bootstrap-formal.mjs
```

The script creates its opam root, OCaml switch, source checkouts and build products under `.local/toolchain`. It does not select or install packages into the user's global switch. Build output is saved to `.local/toolchain/bootstrap.log`. `DEX_BUILD_JOBS` sets build parallelism (default: 4).

The first installation builds OCaml, Coq and the native Solidity compiler. Subsequent builds reuse these source and build directories. The source paths must not contain whitespace: the Coq dependency tool's sorted filename output is consumed as a whitespace-separated list.

After preparation:

```sh
. .local/toolchain/env.sh
node scripts/build-formal.mjs
```

The generated `.local/toolchain/environment.json` is a plain environment-variable object for the project's Node launchers to load. It includes `PATH`, `OCAMLPATH`, opam selection, `DEX_COQ_ROOT`, `DEX_SOLC`, `SOLC_BINARY`, `DEX_SOLIDITY_ROCQ_LIB`, `DEX_HAMMER_ROOT` and `DEX_COQUTIL_ROOT`. Both Solidity variable names select the same native executable. Shell sourcing changes only the current shell environment.

## Pinned inputs

| Component                                                           | Revision/version                                    |
| ------------------------------------------------------------------- | --------------------------------------------------- |
| [Coq](https://github.com/rocq-prover/rocq)                          | `fd609f07dab2d2720695882a711cd0a022068ea8` (8.20.1) |
| [rocq-of-solidity](https://github.com/formal-land/rocq-of-solidity) | `a53c579ab822838dd938ff5eb8fbcb09b918ec03`          |
| [CoqHammer tactics](https://github.com/lukaszcz/coqhammer)          | `af9fab74391a48a7f8fddb28ef280d5110bbb2fb`          |
| [coqutil](https://github.com/mit-plv/coqutil)                       | `b8bb9bcc6ff19b6bad060323d822bc8e2058bee0`          |
| OCaml / ocamlfind / Dune                                            | 4.14.2 / 1.9.8 / 3.23.1                             |
| Zarith / num / Yojson                                               | 1.14 / 1.6 / 3.0.0                                  |
| js_of_ocaml / zarith_stubs_js                                       | 6.4.1 / v0.16.1                                     |

JavaScript generation disables js_of_ocaml inlining. The build manifest records
the JavaScript compiler version and the actual argument array used for that
artifact. This addresses a reproduced warm-up failure of the default generated
output on Node 26.5's Maglev execution path; it does not change the extracted
models or certify the JavaScript engine. See [ADR 011](../docs/adr/011-preserve-generated-callback-boundaries.md)
for the observed boundary and the reason for using the compiler option.

The source tree needs one documented C++ ordering repair in [`verify-swap.compiler.patch`](../contracts/scripts/verify-swap.compiler.patch), plus the build flags `-DMETA_NO_STD_FORWARD_DECLARATIONS=1 -include filesystem`. These address the host C++/Boost build; no Solidity, Yul or Rocq semantics are patched. The script rejects additional tracked compiler modifications and checks every copied semantics `.v` against the pinned upstream file.

Coq is built with `./configure -native-compiler no`, `make dunestrap`, and `dune build -p coq-core,coq-stdlib`. The native compiler uses Release, `TESTS=OFF`, `STRICT_Z3_VERSION=OFF`, and `PEDANTIC=OFF`. Its build date is fixed through `SOURCE_DATE_EPOCH=1793059200` (2026-10-27 UTC). The tested host used Apple Clang and Boost 1.92.0. Native binary bytes also depend on the host compiler and libraries; the manifest records their resulting compiler identity and SHA-256 rather than promising identical binaries across platforms. Resolved opam package versions are also recorded; transitive dependency resolution is not a complete opam lockfile.

The official semantics are compiled without edits, using the official `Run.t` relation. The project imports the required EVM, base and simulation modules. It does not use the upstream example contract proofs to discharge project obligations.

## Reuse an existing build explicitly

For an already prepared installation, rerun the checks without rebuilding:

```sh
node scripts/bootstrap-formal.mjs --reuse
```

This uses paths recorded in `.local/toolchain/manifest.json`. To register other existing builds on first use, supply:

```sh
DEX_BOOTSTRAP_COQ_SOURCE=/path/to/coq-source \
DEX_BOOTSTRAP_SOLIDITY_SOURCE=/path/to/rocq-of-solidity-source \
DEX_BOOTSTRAP_HAMMER_SOURCE=/path/to/coqhammer-source \
DEX_BOOTSTRAP_COQUTIL_SOURCE=/path/to/coqutil-source \
DEX_BOOTSTRAP_SOLC_BINARY=/path/to/native/solc \
DEX_BOOTSTRAP_SEMANTICS_SOURCE=/path/to/compiled/RocqOfSolidity \
node scripts/bootstrap-formal.mjs --reuse
```

The selected opam switch must provide the pinned OCaml packages. The Coq source must contain its `_build/install/default` prefix; Hammer/coqutil/semantics must already have been compiled with that Coq version. Reuse checks source revisions, the compiler patch, semantics source hashes, package versions, actual Coq imports and a native BMC solver probe. Existing binaries remain trusted build inputs; checking a version string and source checkout does not prove how a binary was produced.

## Interpret bootstrap results

Bootstrap records input provenance and tool/solver probes in `.local/toolchain/manifest.json`, `bootstrap.log` and `solver-probe.json`; it does not establish DEX invariants. The existing-build reuse path has been executed, including reuse from its manifest. The fresh-install recipe has not been repeated from an empty opam root.

Coq, solc, the translator, extraction, OCaml/js_of_ocaml and their host runtimes remain trusted build inputs. Project verification produces separate reports for the properties it checks.
