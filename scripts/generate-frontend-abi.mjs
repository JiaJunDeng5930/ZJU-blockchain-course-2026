import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const contracts = [
  ["MiniDEX", "miniDexAbi"],
  ["TestToken", "testTokenAbi"],
  ["WrappedEther", "wrappedEtherAbi"],
  ["AtomicArbitrage", "arbitrageAbi"],
];
let source = "// Generated from solc artifacts. Do not edit.\n";
for (const [name, exportName] of contracts) {
  const artifact = JSON.parse(
    await readFile(
      join(
        root,
        "contracts/artifacts/contracts",
        `${name}.sol`,
        `${name}.json`,
      ),
      "utf8",
    ),
  );
  source += `export const ${exportName} = ${JSON.stringify(artifact.abi)} as const;\n`;
  source += `export const ${exportName.replace(/Abi$/, "RuntimeBytecode")} = ${JSON.stringify(artifact.deployedBytecode)} as const;\n`;
  if (name === "TestToken") {
    source += `export const testTokenBytecode = ${JSON.stringify(artifact.bytecode)} as const;\n`;
  }
}
const output = join(root, "frontend/src/generated/abis.ts");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, source);
