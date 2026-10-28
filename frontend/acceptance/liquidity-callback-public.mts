import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { parseEther, parseEventLogs, zeroAddress, type Abi, type Address, type Hex, type TransactionReceipt } from "viem";
import { isolatedChain, root, until } from "./support/chain.mts";
const fixturePath = "frontend/acceptance/support/LiquidityCallbackFixtures.sol";
const json = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type CompilationInput = {
  solcVersion: string;
  solcLongVersion: string;
  input: { sources: Record<string, { content: string }> };
};
type ImportNode = { nodeType: string; absolutePath?: string };

// Inspect public compiler import metadata, not production function bodies.
async function productionBinding(contractName: string) {
  const artifact = JSON.parse(await readFile(resolve(root, `contracts/artifacts/contracts/${contractName}.sol/${contractName}.json`), "utf8")) as {
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
  const target = output.contracts[artifact.inputSourceName][contractName];
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
  for (const path of [`contracts/artifacts/contracts/${contractName}.sol/${contractName}.json`, inputPath, outputPath]) {
    artifacts[path] = digest(await readFile(resolve(root, path)));
  }
  return { artifact, sources, artifacts, compiler: input.solcLongVersion };
}

async function main() {
  const bindings = await Promise.all([productionBinding("MiniDEX"), productionBinding("TestToken")]);
  const sources = Object.assign({}, ...bindings.map(b => b.sources)) as Record<string, string>;
  const artifacts = Object.assign({}, ...bindings.map(b => b.artifacts)) as Record<string, string>;
  const environment = await isolatedChain("liquidity-callback-public");
  const { directory, read, admin, accounts, rpc, deploy, fixtures } = environment;
  const scenarios: string[] = [];
  const evidence: unknown[] = [];
  let status = "failed";
  let failure: string | undefined;
  try {
    const dexABI = bindings[0].artifact.abi;
    const tokenABI = bindings[1].artifact.abi;
    const dex = await deploy(bindings[0].artifact, ["Callback acceptance"]);
    const tokenA = await deploy(bindings[1].artifact, ["Callback A", "CBA"]);
    const tokenB = await deploy(bindings[1].artifact, ["Callback B", "CBB"]);
    for (const [address, binding] of [[dex, bindings[0]], [tokenA, bindings[1]], [tokenB, bindings[1]]] as const) {
      assert.equal(await read.getCode({ address }), binding.artifact.deployedBytecode);
    }
    const compiled = (await fixtures(fixturePath)).LiquidityCallbackActor;
    const actorArtifact = { abi: compiled.abi, bytecode: `0x${compiled.evm.bytecode.object}` as Hex };
    const payer = accounts[0] as Address;
    const passive = accounts[1] as Address;
    const sender = accounts[2] as Address;
    const beneficiary = accounts[3] as Address;
    const operator = accounts[4] as Address;
    const query = <T = bigint,>(address: Address, abi: Abi, functionName: string,
      args: readonly unknown[] = [], blockNumber?: bigint) => read.readContract({ address, abi,
        functionName, args, blockNumber }) as Promise<T>;
    const transact = async (address: Address, abi: Abi, functionName: string,
      args: readonly unknown[] = [], account = payer) => {
      // DEFENSE: Hardhat automining throws on reverted sends before returning their hash.
      await rpc("evm_setAutomine", [false]);
      try {
        const hash = await admin.writeContract({ address, abi, functionName, args, account, gas: 2_500_000n });
        await rpc("evm_mine");
        return await read.waitForTransactionReceipt({ hash });
      } finally { await rpc("evm_setAutomine", [true]); }
    };
    const success = async (...args: Parameters<typeof transact>) => {
      const receipt = await transact(...args); assert.equal(receipt.status, "success"); return receipt;
    };
    const deadline = async () => (await read.getBlock()).timestamp + 1200n;
    const event = (receipt: TransactionReceipt, eventName: "LiquidityAdded" | "LiquidityRemoved") => {
      const found = parseEventLogs({ abi: dexABI, logs: receipt.logs, eventName })
        .filter(log => log.address.toLowerCase() === dex.toLowerCase());
      assert.equal(found.length, 1);
      return found[0].args as Record<string, bigint | Address>;
    };
    await success(dex, dexABI, "createPool", [tokenA, tokenB]);
    const poolId = await query(dex, dexABI, "getPool", [tokenA, tokenB]);
    type Pool = readonly [Address, Address, bigint, bigint, bigint, bigint];
    type Position = readonly [bigint, bigint, bigint, bigint, bigint];
    const initialPool = await query<Pool>(dex, dexABI, "pools", [poolId]);
    const tokens = [initialPool[0], initialPool[1]] as const;
    for (const token of tokens) for (const account of [payer, passive, sender]) {
      await success(token, tokenABI, "faucet", [], account);
      await success(token, tokenABI, "approve", [dex, parseEther("1000")], account);
    }
    const passiveReceipt = await success(dex, dexABI, "addLiquidity",
      [poolId, parseEther("100"), parseEther("100"), 0n, 0n, await deadline()], passive);
    const passiveId = event(passiveReceipt, "LiquidityAdded").positionId as bigint;
    const passiveState = async () => ({
      owner: await query<Address>(dex, dexABI, "ownerOf", [passiveId]),
      position: await query<Position>(dex, dexABI, "positions", [passiveId]),
      count: await query(dex, dexABI, "balanceOf", [passive]),
    });
    const passiveOriginal = await passiveState();
    const fundActor = async () => {
      const actor = await deploy(actorArtifact, [dex, ...tokens]);
      for (const token of tokens) await success(token, tokenABI, "transfer", [actor, parseEther("100")]);
      await success(actor, compiled.abi, "approveTokens", [parseEther("20")]);
      return actor;
    };
    const configure = (actor: Address, mode: number, forward: Address = zeroAddress, victim = 0n, owner: Address = zeroAddress) =>
      success(actor, compiled.abi, "configure", [mode, forward, victim, owner]);
    const snapshot = async (actor: Address, target?: bigint) => {
      const blockNumber = BigInt(await rpc("eth_blockNumber") as string);
      const balance = (token: Address, account: Address) => query(token, tokenABI, "balanceOf", [account], blockNumber);
      const principal = {
        pool: await query<Pool>(dex, dexABI, "pools", [poolId], blockNumber),
        nextPositionId: await query(dex, dexABI, "nextPositionId", [], blockNumber),
        actorBalances: await Promise.all(tokens.map(t => balance(t, actor))),
        dexBalances: await Promise.all(tokens.map(t => balance(t, dex))),
        payerTokens: await Promise.all(tokens.map(t => balance(t, payer))),
        passiveTokens: await Promise.all(tokens.map(t => balance(t, passive))),
        allowances: await Promise.all(tokens.map(t => query(t, tokenABI, "allowance", [actor, dex], blockNumber))),
        actorNFTs: await query(dex, dexABI, "balanceOf", [actor], blockNumber),
        callbacks: await query(actor, compiled.abi, "callbacks", [], blockNumber),
        passive: await passiveState(),
        target: target === undefined ? null : {
          owner: await query<Address>(dex, dexABI, "ownerOf", [target], blockNumber),
          position: await query<Position>(dex, dexABI, "positions", [target], blockNumber),
          approval: await query<Address>(dex, dexABI, "getApproved", [target], blockNumber),
        },
      };
      return { blockNumber, payerNative: await read.getBalance({ address: payer, blockNumber }), principal };
    };
    const feeOnly = (before: Awaited<ReturnType<typeof snapshot>>, after: Awaited<ReturnType<typeof snapshot>>, receipt: TransactionReceipt) =>
      assert.equal(before.payerNative - after.payerNative, receipt.gasUsed * receipt.effectiveGasPrice);
    const verifyRedemption = async (id: bigint, owner: Address, execute: () => Promise<TransactionReceipt>) => {
      const before = await Promise.all(tokens.map(t => query(t, tokenABI, "balanceOf", [owner])));
      const poolBefore = await query<Pool>(dex, dexABI, "pools", [poolId]);
      const receipt = await execute(); const removed = event(receipt, "LiquidityRemoved");
      const after = await Promise.all(tokens.map(t => query(t, tokenABI, "balanceOf", [owner])));
      assert.equal(after[0] - before[0], removed.amount0); assert.equal(after[1] - before[1], removed.amount1);
      assert((removed.amount0 as bigint) > 0n && (removed.amount1 as bigint) > 0n);
      const poolAfter = await query<Pool>(dex, dexABI, "pools", [poolId]);
      assert.equal(poolBefore[2] - poolAfter[2], removed.amount0); assert.equal(poolBefore[3] - poolAfter[3], removed.amount1);
      assert.equal(poolBefore[4] - poolAfter[4], removed.shares);
      assert.equal((removed.owner as Address).toLowerCase(), owner.toLowerCase());
      assert.equal(removed.positionId, id);
      await assert.rejects(query(dex, dexABI, "ownerOf", [id]));
      assert.deepEqual(await passiveState(), passiveOriginal);
      return { receipt, owner, before, after, poolBefore, poolAfter };
    };

    const forwarded = await fundActor();
    await configure(forwarded, 3, beneficiary);
    const forwardBefore = await snapshot(forwarded);
    const forwardingAttempt = await transact(forwarded, compiled.abi, "provide", [poolId, parseEther("10"), parseEther("10")]);
    let forwardedMint = forwardingAttempt;
    if (forwardingAttempt.status === "reverted") {
      assert.deepEqual((await snapshot(forwarded)).principal, forwardBefore.principal);
      await configure(forwarded, 0);
      forwardedMint = await success(forwarded, compiled.abi, "provide", [poolId, parseEther("10"), parseEther("10")]);
      await success(forwarded, compiled.abi, "forward", [event(forwardedMint, "LiquidityAdded").positionId, beneficiary]);
    }
    const forwardedId = event(forwardedMint, "LiquidityAdded").positionId as bigint;
    assert.equal((await query<Address>(dex, dexABI, "ownerOf", [forwardedId])).toLowerCase(), beneficiary.toLowerCase());
    assert.equal(await query(dex, dexABI, "balanceOf", [forwarded]), 0n);
    assert.equal(await query(forwarded, compiled.abi, "callbacks"), 1n);
    const deadlineValue = await deadline();
    const forwardedRedemption = await verifyRedemption(forwardedId, beneficiary, () => success(dex, dexABI,
      "removeLiquidity", [forwardedId, 0n, 0n, deadlineValue], beneficiary));
    scenarios.push("A contract can receive a liquidity NFT and transfer its redemption rights to the final owner");
    evidence.push({ scenario: scenarios.at(-1), actor: forwarded, forwardingAttempt, mint: forwardedMint, id: forwardedId, redemption: forwardedRedemption });

    const refusingMint = await fundActor();
    const approvals = await success(refusingMint, compiled.abi, "approveTokens", [parseEther("20")]);
    await configure(refusingMint, 1);
    const rejectedBefore = await snapshot(refusingMint);
    assert.deepEqual(rejectedBefore.principal.allowances, [parseEther("20"), parseEther("20")]);
    const rejectedMint = await transact(refusingMint, compiled.abi, "provide", [poolId, parseEther("10"), parseEther("10")]);
    assert.equal(rejectedMint.status, "reverted");
    const rejectedAfter = await snapshot(refusingMint);
    assert.deepEqual(rejectedAfter.principal, rejectedBefore.principal); feeOnly(rejectedBefore, rejectedAfter, rejectedMint);
    assert.equal((await read.getTransactionReceipt({ hash: approvals.transactionHash })).status, "success");
    await configure(refusingMint, 0);
    const retriedMint = await success(refusingMint, compiled.abi, "provide", [poolId, parseEther("10"), parseEther("10")]);
    const retriedId = event(retriedMint, "LiquidityAdded").positionId as bigint;
    assert.equal((await query<Address>(dex, dexABI, "ownerOf", [retriedId])).toLowerCase(), refusingMint.toLowerCase());
    assert.deepEqual((await snapshot(refusingMint)).principal.allowances, [parseEther("10"), parseEther("10")]);
    scenarios.push("Rejected safe mint rolls back principal, reserves, NFT state and finite allowance consumption, then permits retry");
    evidence.push({ scenario: scenarios.at(-1), actor: refusingMint, approvals, before: rejectedBefore, after: rejectedAfter,
      rejectedMint, retriedMint, retriedId });

    const receiver = await fundActor();
    const senderMint = await success(dex, dexABI, "addLiquidity",
      [poolId, parseEther("10"), parseEther("10"), 0n, 0n, await deadline()], sender);
    const senderId = event(senderMint, "LiquidityAdded").positionId as bigint;
    await success(dex, dexABI, "approve", [operator, senderId], sender);
    await configure(receiver, 2);
    const transferBefore = await snapshot(receiver, senderId);
    const refusedTransfer = await transact(dex, dexABI, "safeTransferFrom", [sender, receiver, senderId], operator);
    assert.equal(refusedTransfer.status, "reverted");
    const transferAfter = await snapshot(receiver, senderId);
    assert.deepEqual(transferAfter.principal, transferBefore.principal);
    await configure(receiver, 0);
    const acceptedTransfer = await success(dex, dexABI, "safeTransferFrom", [sender, receiver, senderId], operator);
    assert.equal((await query<Address>(dex, dexABI, "ownerOf", [senderId])).toLowerCase(), receiver.toLowerCase());
    assert.equal(await query<Address>(dex, dexABI, "getApproved", [senderId]), zeroAddress);
    assert.deepEqual(await query<Position>(dex, dexABI, "positions", [senderId]), transferBefore.principal.target!.position);
    assert.deepEqual(await query<Pool>(dex, dexABI, "pools", [poolId]), transferBefore.principal.pool);
    const currentBefore = await snapshot(receiver, senderId);
    const oldOwnerRedeem = await transact(dex, dexABI, "removeLiquidity", [senderId, 0n, 0n, await deadline()], sender);
    assert.equal(oldOwnerRedeem.status, "reverted");
    const currentAfter = await snapshot(receiver, senderId);
    assert.deepEqual(currentAfter.principal, currentBefore.principal);
    const receivedRedemption = await verifyRedemption(senderId, receiver,
      () => success(receiver, compiled.abi, "redeem", [senderId]));
    scenarios.push("Rejected NFT transfer restores its approval and ownership; retry moves redemption rights to the contract holder");
    evidence.push({ scenario: scenarios.at(-1), actor: receiver, senderMint, senderId, before: transferBefore,
      after: transferAfter, refusedTransfer, acceptedTransfer, oldOwnerRedeem, redemption: receivedRedemption });

    const probing = await fundActor();
    await configure(probing, 4, zeroAddress, passiveId, passive);
    const probeBefore = await snapshot(probing);
    const probeMint = await transact(probing, compiled.abi, "provide", [poolId, parseEther("10"), parseEther("10")]);
    const probeAfter = await snapshot(probing);
    assert.deepEqual(await passiveState(), passiveOriginal);
    if (probeMint.status === "success") {
      assert.equal(await query(probing, compiled.abi, "attempts"), 2n);
      assert.equal(await query<boolean>(probing, compiled.abi, "victimRemoved"), false);
      assert.equal(await query<boolean>(probing, compiled.abi, "victimMoved"), false);
      const added = event(probeMint, "LiquidityAdded");
      const ownId = added.positionId as bigint;
      const ownPosition = await query<Position>(dex, dexABI, "positions", [ownId]);
      assert.equal(ownPosition[0], poolId); assert.equal(ownPosition[1], added.shares);
      assert.equal(probeAfter.principal.pool[4] - probeBefore.principal.pool[4], added.shares);
      assert.equal(probeAfter.principal.pool[2] - probeBefore.principal.pool[2], added.amount0);
      assert.equal(probeAfter.principal.pool[3] - probeBefore.principal.pool[3], added.amount1);
      assert.equal((await query<Address>(dex, dexABI, "ownerOf", [ownId])).toLowerCase(), probing.toLowerCase());
      assert.equal(probeBefore.principal.actorBalances[0] - probeAfter.principal.actorBalances[0], parseEther("10"));
      assert.equal(probeBefore.principal.actorBalances[1] - probeAfter.principal.actorBalances[1], parseEther("10"));
      assert.equal(probeAfter.principal.dexBalances[0] - probeBefore.principal.dexBalances[0], parseEther("10"));
      assert.equal(probeAfter.principal.dexBalances[1] - probeBefore.principal.dexBalances[1], parseEther("10"));
      await verifyRedemption(ownId, probing, () => success(probing, compiled.abi, "redeem", [ownId]));
    } else {
      assert.deepEqual(probeAfter.principal, probeBefore.principal);
      await configure(probing, 0);
      const retry = await success(probing, compiled.abi, "provide", [poolId, parseEther("10"), parseEther("10")]);
      const ownId = event(retry, "LiquidityAdded").positionId as bigint;
      await verifyRedemption(ownId, probing, () => success(probing, compiled.abi, "redeem", [ownId]));
    }
    feeOnly(probeBefore, probeAfter, probeMint);
    scenarios.push("An NFT mint callback cannot redeem or transfer a passive holder's position despite funded pool reserves");
    evidence.push({ scenario: scenarios.at(-1), actor: probing, before: probeBefore, after: probeAfter, receipt: probeMint });
    for (const [path, expected] of Object.entries({ ...sources, ...artifacts })) {
      assert.equal(digest(await readFile(resolve(root, path))), expected, path);
    }
    status = "passed";
  } catch (error) {
    failure = error instanceof Error ? error.stack : String(error); throw error;
  } finally {
    await environment.close();
    const launch = JSON.parse(await readFile(resolve(directory, "launch.json"), "utf8")) as { pid: number; rpcUrl: string };
    const processAbsent = await until(() => {
      try { process.kill(launch.pid, 0); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
    }, value => value, "isolated liquidity callback node termination");
    const portClosed = await until(() => new Promise<boolean>((done) => {
      const socket = createConnection({ host: "127.0.0.1", port: Number(new URL(launch.rpcUrl).port) });
      socket.once("connect", () => { socket.destroy(); done(false); });
      socket.once("error", error => { socket.destroy(); done((error as NodeJS.ErrnoException).code === "ECONNREFUSED"); });
    }), value => value, "isolated liquidity callback RPC shutdown");
    await writeFile(resolve(directory, "result.json"), json({ status, scenarios, evidence,
      compiler: bindings.map((b, i) => ({ contract: i === 0 ? "MiniDEX" : "TestToken", version: b.compiler })),
      sourceFingerprints: sources, artifactFingerprints: artifacts,
      runnerSha256: digest(await readFile(new URL(import.meta.url))), fixtureSha256: digest(await readFile(resolve(root, fixturePath))),
      cleanup: { ...launch, processAbsent, portClosed }, error: failure }));
    console.log(json({ status, directory, scenarios: scenarios.length, checkedProductionSources: Object.keys(sources).length,
      checkedArtifacts: Object.keys(artifacts).length, cleanup: { processAbsent, portClosed } }));
  }
}
await main();
