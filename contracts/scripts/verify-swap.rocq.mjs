import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const compiler = process.env.DEX_SOLC;
if (!compiler)
  throw new Error("Set DEX_SOLC to the pinned rocq-of-solidity compiler.");
const directory = await mkdtemp(join(tmpdir(), "dex-swap-translation-"));
const args = [
  "--ir-rocq",
  "--optimize",
  "--base-path",
  "contracts",
  "--include-path",
  "contracts/node_modules",
  "--output-dir",
  directory,
  "--overwrite",
  "contracts/formal/SwapProperties.sol",
];
const result = spawnSync(compiler, args, {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 8 * 1024 * 1024,
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr || result.stdout);
const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
if (version.error || version.status !== 0)
  throw new Error("Cannot identify the translation compiler.");
if (!version.stdout.includes("a53c579a"))
  throw new Error("The translation compiler is not the pinned fork revision.");
const generated = await readFile(join(directory, "SwapProperties.v"));
const target = join(root, "formal/theories/Contracts/SwapGenerated.v");
const update = process.argv.includes("--update");
if (update) await writeFile(target, generated);
const expected = await readFile(target);
const matches = generated.equals(expected);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sources = [
  "contracts/contracts/AMMMath.sol",
  "contracts/formal/SwapProperties.sol",
];
const sourceHashes = Object.fromEntries(
  await Promise.all(
    sources.map(async (path) => [path, hash(await readFile(join(root, path)))]),
  ),
);
const report = {
  status: matches ? (update ? "updated" : "matching") : "mismatch",
  scope:
    "Actual AMMMath.calculateAmountOut inherited by the existing SMT harness; translation correspondence only.",
  compiler: version.stdout.trim(),
  compilerHash: hash(await readFile(compiler)),
  compilerPatchHash: hash(
    await readFile(join(root, "contracts/scripts/verify-swap.compiler.patch")),
  ),
  arguments: args,
  sourceHashes,
  generatedHash: hash(generated),
  expectedHash: hash(expected),
  candidate: join(directory, "SwapProperties.v"),
};
const reportPath = join(root, "formal/build/swap-translation.json");
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify({
    status: report.status,
    report: "formal/build/swap-translation.json",
  }),
);
if (!matches)
  throw new Error(
    `The checked Rocq artifact differs from the current compiler output: ${report.candidate}`,
  );
