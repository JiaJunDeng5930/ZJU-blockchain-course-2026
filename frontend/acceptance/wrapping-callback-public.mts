import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { parseEther, type Abi, type Address, type Hex, type TransactionReceipt } from "viem";
import { isolatedChain, root, until } from "./support/chain.mts";

const fixturePath = "frontend/acceptance/support/WrappingCallbackFixtures.sol";
const artifactPath = "contracts/artifacts/contracts/WrappedEther.sol/WrappedEther.json";
const json = (value: unknown) => JSON.stringify(value,
  (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

type CompilationInput = {
  solcVersion: string;
  solcLongVersion: string;
  input: { sources: Record<string, { content: string }> };
};
type ImportNode = { nodeType: string; absolutePath?: string };

// Inspect public compiler import metadata, not production function bodies.
async function productionBinding() {
  const artifact = JSON.parse(await readFile(resolve(root, artifactPath), "utf8")) as {
    inputSourceName: string; buildInfoId: string; abi: Abi;
    bytecode: Hex; deployedBytecode: Hex;
  };
  const inputPath = `contracts/artifacts/build-info/${artifact.buildInfoId}.json`;
  const outputPath = `contracts/artifacts/build-info/${artifact.buildInfoId}.output.json`;
  const input = JSON.parse(await readFile(resolve(root, inputPath), "utf8")) as CompilationInput;
  const { output } = JSON.parse(await readFile(resolve(root, outputPath), "utf8")) as {
    output: {
      sources: Record<string, { ast: { nodes: ImportNode[] } }>;
      contracts: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>>;
    };
  };
  const target = output.contracts[artifact.inputSourceName].WrappedEther;
  assert.deepEqual(artifact.abi, target.abi);
  assert.equal(artifact.bytecode, `0x${target.evm.bytecode.object}`);
  const pending = [artifact.inputSourceName];
  const visited = new Set<string>();
  const sources: Record<string, string> = {};
  while (pending.length) {
    const name = pending.pop()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const dependency = name.match(/^npm\/(@[^/]+\/[^@/]+)@[^/]+\/(.+)$/);
    const path = dependency
      ? `contracts/node_modules/${dependency[1]}/${dependency[2]}`
      : `contracts/${name.replace(/^project\//, "")}`;
    const actual = await readFile(resolve(root, path), "utf8");
    assert.equal(digest(actual), digest(input.input.sources[name].content),
      `${name} must match the source used by the deployed artifact`);
    sources[path] = digest(actual);
    for (const node of output.sources[name].ast.nodes) {
      if (node.nodeType === "ImportDirective") pending.push(node.absolutePath!);
    }
  }
  const artifacts: Record<string, string> = {};
  for (const path of [artifactPath, inputPath, outputPath]) {
    artifacts[path] = digest(await readFile(resolve(root, path)));
  }
  return { artifact, sources, artifacts, compiler: input.solcLongVersion };
}

async function main() {
  const binding = await productionBinding();
  const environment = await isolatedChain("wrapping-callback-public");
  const { directory, accounts, admin, read, rpc, deploy, fixtures } = environment;
  const scenarios: string[] = [];
  const evidence: unknown[] = [];
  let status = "failed";
  let failure: string | undefined;
  try {
    const wrapped = await deploy(binding.artifact);
    assert.equal(await read.getCode({ address: wrapped }), binding.artifact.deployedBytecode);
    const compiled = (await fixtures(fixturePath)).WrappingCallbackActor;
    const actorArtifact = { abi: compiled.abi, bytecode: `0x${compiled.evm.bytecode.object}` as Hex };
    const passive = accounts[1] as Address;
    const payer = accounts[0] as Address;
    const transact = async (address: Address, abi: Abi, functionName: string,
      args: readonly unknown[] = [], value = 0n, account = payer) => {
      // Hardhat's automining RPC rejects reverted sends even when they are mined.
      // Manual mining exposes the actual hash/receipt for both success and revert.
      await rpc("evm_setAutomine", [false]);
      try {
        const hash = await admin.writeContract({ address, abi, functionName, args,
          value, account, gas: 800_000n });
        await rpc("evm_mine");
        return await read.waitForTransactionReceipt({ hash });
      } finally {
        await rpc("evm_setAutomine", [true]);
      }
    };
    const success = async (address: Address, abi: Abi, functionName: string,
      args: readonly unknown[] = [], value = 0n, account = payer) => {
      const receipt = await transact(address, abi, functionName, args, value, account);
      assert.equal(receipt.status, "success");
      return receipt;
    };
    const tokenRead = (functionName: string, args: readonly unknown[], blockNumber: bigint) =>
      read.readContract({ address: wrapped, abi: binding.artifact.abi,
        functionName, args, blockNumber }) as Promise<bigint>;
    const actorRead = (address: Address, functionName: string, blockNumber: bigint) =>
      read.readContract({ address, abi: compiled.abi, functionName, blockNumber }) as Promise<bigint | boolean>;
    const snapshot = async (actor: Address) => {
      const blockNumber = BigInt(await rpc("eth_blockNumber") as string);
      const [native, actorNative, actorTokens, supply, passiveTokens, payerNative,
        callbacks, received, nestedAttempts, nestedSucceeded] = await Promise.all([
        read.getBalance({ address: wrapped, blockNumber }),
        read.getBalance({ address: actor, blockNumber }),
        tokenRead("balanceOf", [actor], blockNumber), tokenRead("totalSupply", [], blockNumber),
        tokenRead("balanceOf", [passive], blockNumber),
        read.getBalance({ address: payer, blockNumber }),
        actorRead(actor, "callbacks", blockNumber), actorRead(actor, "received", blockNumber),
        actorRead(actor, "nestedAttempts", blockNumber), actorRead(actor, "nestedSucceeded", blockNumber),
      ]);
      return { blockNumber, native, actorNative, actorTokens, supply, passiveTokens,
        payerNative, callbacks, received, nestedAttempts, nestedSucceeded };
    };
    type Snapshot = Awaited<ReturnType<typeof snapshot>>;
    const feeOnly = (before: Snapshot, after: Snapshot, receipt: TransactionReceipt) => {
      assert.equal(before.payerNative - after.payerNative,
        receipt.gasUsed * receipt.effectiveGasPrice,
        "The EOA pays gas; withdrawal principal is sent to the contract holder");
    };
    const principalState = ({ blockNumber: _block, payerNative: _payer, ...state }: Snapshot) => state;
    const actor = async (amount: bigint) => {
      const address = await deploy(actorArtifact, [wrapped]);
      await success(address, compiled.abi, "fund", [], amount);
      return address;
    };
    await success(wrapped, binding.artifact.abi, "deposit", [], parseEther("3"), passive);

    const accepted = await actor(parseEther("2"));
    const acceptedBefore = await snapshot(accepted);
    const acceptedReceipt = await success(accepted, compiled.abi, "redeem", [parseEther("0.75")]);
    const acceptedAfter = await snapshot(accepted);
    assert.equal(acceptedAfter.actorNative - acceptedBefore.actorNative, parseEther("0.75"));
    assert.equal(acceptedBefore.actorTokens - acceptedAfter.actorTokens, parseEther("0.75"));
    assert.equal(acceptedBefore.supply - acceptedAfter.supply, parseEther("0.75"));
    assert.equal(acceptedBefore.native - acceptedAfter.native, parseEther("0.75"));
    assert.equal(acceptedAfter.passiveTokens, acceptedBefore.passiveTokens);
    feeOnly(acceptedBefore, acceptedAfter, acceptedReceipt);
    scenarios.push("A contract holder receives a partial withdrawal while the EOA pays only gas");
    evidence.push({ scenario: scenarios.at(-1), actor: accepted, before: acceptedBefore,
      after: acceptedAfter, receipt: acceptedReceipt });

    const rejecting = await actor(parseEther("1.25"));
    await success(rejecting, compiled.abi, "configure", [1, 0n]);
    const rejectingBefore = await snapshot(rejecting);
    const rejectingReceipt = await transact(rejecting, compiled.abi, "redeem", [parseEther("0.5")]);
    assert.equal(rejectingReceipt.status, "reverted");
    assert(rejectingReceipt.gasUsed < 800_000n, "The rejection is mined without exhausting the transaction gas limit");
    const rejectingAfter = await snapshot(rejecting);
    assert.deepEqual(principalState(rejectingAfter), principalState(rejectingBefore));
    feeOnly(rejectingBefore, rejectingAfter, rejectingReceipt);
    await success(rejecting, compiled.abi, "configure", [0, 0n]);
    const retryBefore = await snapshot(rejecting);
    const retryReceipt = await success(rejecting, compiled.abi, "redeem", [parseEther("0.5")]);
    const retryAfter = await snapshot(rejecting);
    assert.equal(retryAfter.actorNative - retryBefore.actorNative, parseEther("0.5"));
    assert.equal(retryBefore.actorTokens - retryAfter.actorTokens, parseEther("0.5"));
    assert.equal(retryBefore.supply - retryAfter.supply, parseEther("0.5"));
    assert.equal(retryBefore.native - retryAfter.native, parseEther("0.5"));
    assert.equal(retryAfter.passiveTokens, retryBefore.passiveTokens);
    feeOnly(retryBefore, retryAfter, retryReceipt);
    scenarios.push("A rejecting recipient rolls back all asset/callback changes and can retry after accepting ETH");
    evidence.push({ scenario: scenarios.at(-1), actor: rejecting, before: rejectingBefore,
      after: rejectingAfter, receipt: rejectingReceipt, retryBefore, retryAfter, retryReceipt });

    const nested = await actor(parseEther("1"));
    await success(nested, compiled.abi, "configure", [2, parseEther("1")]);
    const nestedBefore = await snapshot(nested);
    assert(nestedBefore.passiveTokens >= parseEther("1"));
    assert(nestedBefore.native - nestedBefore.actorTokens >= parseEther("1"),
      "Independent reserves can fund the attempted second payment");
    const nestedReceipt = await transact(nested, compiled.abi, "redeem", [parseEther("1")]);
    const nestedAfter = await snapshot(nested);
    if (nestedReceipt.status === "success") {
      const paid = nestedAfter.actorNative - nestedBefore.actorNative;
      const burned = nestedBefore.actorTokens - nestedAfter.actorTokens;
      assert(paid > 0n && paid <= nestedBefore.actorTokens);
      assert.equal(paid, burned);
      assert.equal(nestedBefore.supply - nestedAfter.supply, burned);
      assert.equal(nestedBefore.native - nestedAfter.native, paid);
      assert.equal(nestedAfter.passiveTokens, nestedBefore.passiveTokens);
      assert.equal(nestedAfter.nestedAttempts, 1n);
    } else {
      assert.deepEqual(principalState(nestedAfter), principalState(nestedBefore));
    }
    feeOnly(nestedBefore, nestedAfter, nestedReceipt);
    scenarios.push("A callback cannot spend the same WETH twice despite sufficient third-party reserves");
    evidence.push({ scenario: scenarios.at(-1), actor: nested, before: nestedBefore,
      after: nestedAfter, receipt: nestedReceipt });

    for (const [path, expected] of Object.entries({ ...binding.sources, ...binding.artifacts })) {
      assert.equal(digest(await readFile(resolve(root, path))), expected, path);
    }
    status = "passed";
  } catch (error) {
    failure = error instanceof Error ? error.stack : String(error);
    throw error;
  } finally {
    await environment.close();
    const launch = JSON.parse(await readFile(resolve(directory, "launch.json"), "utf8")) as {
      pid: number; rpcUrl: string;
    };
    const processAbsent = await until(() => {
      try { process.kill(launch.pid, 0); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
    }, value => value, "isolated callback node termination");
    const portClosed = await until(() => new Promise<boolean>((done) => {
      const socket = createConnection({ host: "127.0.0.1", port: Number(new URL(launch.rpcUrl).port) });
      socket.once("connect", () => { socket.destroy(); done(false); });
      socket.once("error", error => { socket.destroy(); done((error as NodeJS.ErrnoException).code === "ECONNREFUSED"); });
    }), value => value, "isolated callback RPC shutdown");
    await writeFile(resolve(directory, "result.json"), json({ status, scenarios, evidence,
      compiler: binding.compiler, sourceFingerprints: binding.sources,
      artifactFingerprints: binding.artifacts, runnerSha256: digest(await readFile(new URL(import.meta.url))),
      fixtureSha256: digest(await readFile(resolve(root, fixturePath))),
      cleanup: { ...launch, processAbsent, portClosed }, error: failure }));
    console.log(json({ status, directory, scenarios: scenarios.length,
      checkedProductionSources: Object.keys(binding.sources).length,
      cleanup: { processAbsent, portClosed } }));
  }
}

await main();
