import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, realpathSync, symlinkSync, unlinkSync, copyFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const base = join(root, ".local/toolchain");
const jobs = process.env.DEX_BUILD_JOBS ?? "4";
const reuse = process.argv.includes("--reuse");
const previous = reuse && existsSync(join(base, "manifest.json")) ? JSON.parse(readFileSync(join(base, "manifest.json"), "utf8")) : {};
if (process.argv.some((arg, index) => index > 1 && arg !== "--reuse"))
  throw new Error("Usage: node scripts/bootstrap-formal.mjs [--reuse]");
mkdirSync(join(base, "src"), { recursive: true });
const log = join(base, "bootstrap.log");
writeFileSync(log, "");
const env = { ...process.env };
// Fix the upstream build-date component; native binary bytes also depend on the host toolchain.
env.SOURCE_DATE_EPOCH = "1793059200";
const pins = {
  coq: ["https://github.com/rocq-prover/rocq.git", "fd609f07dab2d2720695882a711cd0a022068ea8"],
  solidity: ["https://github.com/formal-land/rocq-of-solidity.git", "a53c579ab822838dd938ff5eb8fbcb09b918ec03"],
  coqhammer: ["https://github.com/lukaszcz/coqhammer.git", "af9fab74391a48a7f8fddb28ef280d5110bbb2fb"],
  coqutil: ["https://github.com/mit-plv/coqutil.git", "b8bb9bcc6ff19b6bad060323d822bc8e2058bee0"],
};
const packages = ["ocamlfind.1.9.8", "dune.3.23.1", "zarith.1.14", "num.1.6", "yojson.3.0.0", "js_of_ocaml.6.4.1", "zarith_stubs_js.v0.16.1"];
function run(command, args = [], cwd = root) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  writeFileSync(log, `$ ${command} ${args.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}\n`, { flag: "a" });
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed: ${result.error?.message ?? `exit ${result.status}`}. Full log: ${log}`);
  return result.stdout.trim();
}
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
function link(target, path) {
  if (existsSync(path) && realpathSync(path) === realpathSync(target)) return;
  const existing = lstatSync(path, { throwIfNoEntry: false });
  // DEFENSE: an existing installation is user data; only replace managed symbolic links.
  if (existing && !existing.isSymbolicLink()) throw new Error(`Refusing to replace directory ${path}`);
  if (existing) unlinkSync(path);
  symlinkSync(resolve(target), path, "dir");
}
function source(name, variable) {
  const [url, commit] = pins[name];
  const path = resolve(process.env[variable] ?? previous.sources?.[name] ?? join(base, "src", name));
  if (!existsSync(join(path, ".git"))) {
    if (reuse) throw new Error(`--reuse requires ${variable} pointing to the existing ${name} checkout`);
    run("git", ["clone", "--no-checkout", url, path]);
    run("git", ["checkout", "--detach", commit], path);
  }
  if (run("git", ["rev-parse", "HEAD"], path) !== commit) throw new Error(`${name} checkout is not pinned to ${commit}`);
  if (name !== "solidity" && run("git", ["diff", "HEAD", "--name-only"], path) !== "")
    throw new Error(`Modified tracked ${name} sources are not accepted`);
  return path;
}
function vfiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? vfiles(path) : entry.name.endsWith(".v") ? [path] : [];
  }).sort();
}

let switchPrefix;
if (reuse) {
  env.OPAMROOT = previous.opamRoot ?? env.OPAMROOT ?? run("opam", ["var", "root"]);
  switchPrefix = previous.opamSwitch ?? run("opam", ["switch", "show"]);
  Object.assign(env, JSON.parse(run("opam", ["exec", "--switch", switchPrefix, "--", process.execPath, "-e", "process.stdout.write(JSON.stringify(process.env))"])));
} else {
  env.OPAMROOT = join(base, "opam-root");
  delete env.OPAMSWITCH;
  delete env.OPAM_SWITCH_PREFIX;
  if (!existsSync(join(env.OPAMROOT, "config")))
    run("opam", ["init", "--bare", "--no-setup", "--yes"]);
  switchPrefix = join(base, "ocaml");
  if (!existsSync(join(switchPrefix, "_opam")))
    run("opam", ["switch", "create", "--no-switch", switchPrefix, "ocaml-base-compiler.4.14.2", "--yes"]);
  Object.assign(env, JSON.parse(run("opam", ["exec", "--switch", switchPrefix, "--", process.execPath, "-e", "process.stdout.write(JSON.stringify(process.env))"])));
  run("opam", ["install", "--switch", switchPrefix, "--yes", ...packages]);
}
if (run("ocamlc", ["-version"]) !== "4.14.2") throw new Error("Expected OCaml 4.14.2");
const installed = run("opam", ["list", "--installed", "--columns=name,version", "--short"]).split("\n");
for (const pin of packages) {
  const dot = pin.indexOf(".");
  const name = pin.slice(0, dot), version = pin.slice(dot + 1);
  if (!installed.some((line) => line.trim().split(/\s+/).join(".") === `${name}.${version}`))
    throw new Error(`Missing pinned package ${pin}; see formal/TOOLCHAIN.md`);
}

const coqSource = source("coq", "DEX_BOOTSTRAP_COQ_SOURCE");
const solidity = source("solidity", "DEX_BOOTSTRAP_SOLIDITY_SOURCE");
const hammer = source("coqhammer", "DEX_BOOTSTRAP_HAMMER_SOURCE");
const coqutil = source("coqutil", "DEX_BOOTSTRAP_COQUTIL_SOURCE");
const coq = join(coqSource, "_build/install/default");
if (!reuse) {
  run("./configure", ["-prefix", join(base, "coq-install"), "-native-compiler", "no"], coqSource);
  run("make", ["dunestrap"], coqSource);
  run("dune", ["build", "-p", "coq-core,coq-stdlib", "-j", jobs], coqSource);
}
const coqc = join(coq, "bin/coqc");
const coqVersion = run(coqc, ["--version"]);
if (!coqVersion.includes("version 8.20.1")) throw new Error("Expected Coq 8.20.1");
env.PATH = `${join(coq, "bin")}:${env.PATH}`;
env.OCAMLPATH = `${join(coq, "lib")}:${env.OCAMLPATH ?? ""}`;
link(coq, join(base, "coq"));
if (!reuse) {
  run("make", ["tactics", `-j${jobs}`], hammer);
  run("make", ["notest", `-j${jobs}`], coqutil);
}
link(hammer, join(base, "coqhammer"));
link(coqutil, join(base, "coqutil"));

const patch = join(root, "contracts/scripts/verify-swap.compiler.patch");
const expectedPatch = readFileSync(patch, "utf8").trim();
let difference = run("git", ["diff", "HEAD", "--", "libsolidity/codegen/ir/Common.h"], solidity).trim();
if (difference === "" && !reuse) {
  run("git", ["apply", patch], solidity);
  difference = run("git", ["diff", "HEAD", "--", "libsolidity/codegen/ir/Common.h"], solidity).trim();
}
if (difference !== expectedPatch) throw new Error("Compiler source does not contain exactly the documented C++ ordering patch");
const modified = run("git", ["diff", "HEAD", "--name-only"], solidity).split("\n").filter(Boolean);
if (modified.some((path) => path !== "libsolidity/codegen/ir/Common.h")) throw new Error("Unexpected compiler source modifications");
const nativeBuild = join(base, "solidity-build");
const binary = resolve(process.env.DEX_BOOTSTRAP_SOLC_BINARY ?? previous.sources?.binary ?? join(nativeBuild, "solc/solc"));
if (!reuse) {
  run("git", ["submodule", "update", "--init", "--recursive"], solidity);
  run("cmake", ["-S", solidity, "-B", nativeBuild, "-DCMAKE_BUILD_TYPE=Release", "-DTESTS=OFF", "-DSTRICT_Z3_VERSION=OFF", "-DPEDANTIC=OFF", "-DCMAKE_CXX_FLAGS=-DMETA_NO_STD_FORWARD_DECLARATIONS=1 -include filesystem"], root);
  run("cmake", ["--build", nativeBuild, "--target", "solc", "--parallel", jobs]);
}
const solcVersion = run(binary, ["--version"]);
if (!solcVersion.includes("commit.a53c579a.mod")) throw new Error("Unexpected rocq-of-solidity compiler");
const targetBinary = join(base, "solc");
if (!existsSync(targetBinary) || hash(targetBinary) !== hash(binary)) copyFileSync(binary, targetBinary);
chmodSync(targetBinary, 0o755);

const upstreamSemantics = join(solidity, "rocq/RocqOfSolidity");
const semantics = resolve(process.env.DEX_BOOTSTRAP_SEMANTICS_SOURCE ?? previous.sources?.semantics ?? upstreamSemantics);
for (const path of vfiles(semantics)) {
  const relative = path.slice(semantics.length + 1);
  if (hash(path) !== hash(join(upstreamSemantics, relative))) throw new Error(`Modified official semantics: ${relative}`);
}
const flags = ["-R", semantics, "RocqOfSolidity", "-R", join(hammer, "theories/Tactics"), "Hammer.Tactics", "-R", join(hammer, "src/lib"), "Hammer.Tactics", "-R", join(hammer, "src/tactics"), "Hammer.Tactics", "-I", join(hammer, "src/lib"), "-I", join(hammer, "src/tactics"), "-Q", join(coqutil, "src/coqutil"), "coqutil"];
if (!reuse) {
  const sources = [join(semantics, "RecordUpdate.v"), ...vfiles(join(semantics, "RocqEvm")).filter((p) => !p.endsWith("/SInt.v")), join(semantics, "RocqOfSolidity.v"), join(semantics, "simulations/RocqOfSolidity.v")];
  const ordered = run(join(coq, "bin/coqdep"), ["-sort", ...flags, ...sources]).split(/\s+/);
  for (const path of ordered) run(coqc, ["-q", "-impredicative-set", ...flags, path]);
}
link(semantics, join(base, "rocq-of-solidity"));
const probe = join(base, "ToolchainProbe.v");
writeFileSync(probe, "Require Import RocqOfSolidity.RocqOfSolidity.\nRequire Import RocqOfSolidity.simulations.RocqOfSolidity.\nGoal True. Proof. exact I. Qed.\n");
run(coqc, ["-q", "-impredicative-set", ...flags, probe]);
run("ocamlfind", ["query", "zarith", "zarith_stubs_js", "yojson", "js_of_ocaml"]);
run("js_of_ocaml", ["--version"]);
const smtInput = { language: "Solidity", sources: { "Probe.sol": { content: "pragma solidity ^0.8.20; contract Probe { function check(uint x) external pure { require(x < 100); assert(x + 1 <= 100); } }" } }, settings: { modelChecker: { engine: "bmc", targets: ["assert", "overflow"], showProvedSafe: true }, outputSelection: { "*": { "*": ["abi"] } } } };
const smt = spawnSync(binary, ["--standard-json"], { input: JSON.stringify(smtInput), env, encoding: "utf8" });
const diagnostics = JSON.parse(smt.stdout).errors ?? [];
writeFileSync(join(base, "solver-probe.json"), JSON.stringify(diagnostics, null, 2));
if (smt.status !== 0 || !diagnostics.some((d) => /safe/.test(d.message)) || diagnostics.some((d) => /might happen|not available|could not|unsupported/i.test(d.message)))
  throw new Error("Native SMT solver probe failed; see .local/toolchain/solver-probe.json");

writeFileSync(join(base, "env.sh"), `# Generated by bootstrap-formal.mjs\nexport OPAMROOT=${quote(env.OPAMROOT)}\neval "$(opam env --switch=${quote(switchPrefix)} --set-switch)"\nexport DEX_COQ_ROOT=${quote(join(base, "coq"))}\nexport DEX_SOLC=${quote(targetBinary)}\nexport SOLC_BINARY=${quote(targetBinary)}\nexport DEX_SOLIDITY_ROCQ_LIB=${quote(join(base, "rocq-of-solidity"))}\nexport DEX_HAMMER_ROOT=${quote(join(base, "coqhammer"))}\nexport DEX_COQUTIL_ROOT=${quote(join(base, "coqutil"))}\nexport OCAMLPATH=${quote(join(base, "coq/lib"))}:"\${OCAMLPATH:-}"\nexport PATH=${quote(join(base, "coq/bin"))}:"$PATH"\n`);
writeFileSync(join(base, "environment.json"), JSON.stringify({ PATH: env.PATH, OCAMLPATH: env.OCAMLPATH, DEX_COQ_ROOT: join(base, "coq"), DEX_SOLC: targetBinary, SOLC_BINARY: targetBinary, DEX_SOLIDITY_ROCQ_LIB: join(base, "rocq-of-solidity"), DEX_HAMMER_ROOT: join(base, "coqhammer"), DEX_COQUTIL_ROOT: join(base, "coqutil"), OPAMROOT: env.OPAMROOT, OPAMSWITCH: env.OPAMSWITCH ?? switchPrefix, OPAM_SWITCH_PREFIX: env.OPAM_SWITCH_PREFIX ?? run("opam", ["var", "prefix"]) }, null, 2));
writeFileSync(join(base, "manifest.json"), JSON.stringify({ mode: reuse ? "checked-existing-builds" : "built-from-pinned-sources", sources: { coq: coqSource, solidity, coqhammer: hammer, coqutil, semantics, binary }, opamRoot: env.OPAMROOT, opamSwitch: switchPrefix, pins, packages, resolvedPackages: installed, sourceDateEpoch: env.SOURCE_DATE_EPOCH, coqVersion, solcVersion, solcSha256: hash(binary), compilerPatchSha256: hash(patch), semantics: Object.fromEntries(vfiles(semantics).map((path) => [path.slice(semantics.length + 1), hash(path)])), checked: ["versions", "source-pins", "compiler-patch", "unchanged-semantics", "compiled-semantics-import", "OCaml-packages", "native-BMC-solver"] }, null, 2));
console.log(`Toolchain checked. Load ${join(base, "env.sh")} before building. Full log: ${log}`);
