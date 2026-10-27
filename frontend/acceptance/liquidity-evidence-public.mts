import "../src/generated/dex_logic.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import {
  getAddress,
  maxUint256,
  parseEventLogs,
  zeroAddress,
  type Abi,
  type TransactionReceipt,
} from "viem";
import { ExchangeClient } from "../src/chain/client";
import type {
  Deployment,
  LiquidityConfirmation,
  Pool,
  Token,
} from "../src/chain/types";
import { positionView } from "../src/logic/liquidity";
import { WalletController } from "../src/wallet/session";
import { isolatedChain, root, until } from "./support/chain.mts";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const serialize = (value: unknown) =>
  JSON.stringify(
    value,
    (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry),
    2,
  );
type AmountEvent = {
  poolId: bigint;
  positionId: bigint;
  provider?: string;
  owner?: string;
  amount0: bigint;
  amount1: bigint;
  shares: bigint;
};
type NFTEvent = { from: string; to: string; tokenId: bigint };
type RPCRequest = {
  id: number;
  method: string;
  params?: { from?: string; to?: string; data?: string }[];
};

async function main() {
  const environment = await isolatedChain("liquidity-evidence-public");
  const { directory, accounts, read, admin, deploy, artifact, rpc } =
    environment;
  const hash = async (path: string) =>
    createHash("sha256")
      .update(await readFile(resolve(root, path)))
      .digest("hex");
  const fingerprints = async () =>
    Object.fromEntries(
      await Promise.all(
        [
          "frontend/src/generated/dex_logic.js",
          "frontend/src/chain/client.ts",
          "frontend/src/chain/liquidity.ts",
          "frontend/src/chain/types.ts",
          "frontend/src/logic/liquidity.ts",
          "frontend/src/wallet/session.ts",
          "frontend/src/wallet/kernel.ts",
        ].map(async (path) => [path, await hash(path)]),
      ),
    );
  const sourceFingerprints = await fingerprints();
  const scenarios: { scenario: string; outcome: string }[] = [];
  const evidence: Record<string, unknown> = {
    status: "running",
    kernelSha256: sourceFingerprints["frontend/src/generated/dex_logic.js"],
    sourceFingerprints,
    scenarios,
  };
  let wallet: WalletController | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let releaseApproval: (() => void) | undefined;
  let approvalHeld = false;
  let holdApproval = false;
  const writes: { from: string; to: string; data: string; hash?: string }[] =
    [];
  const scenario = async (name: string, action: () => Promise<void>) => {
    evidence.currentScenario = name;
    await action();
    assert.deepEqual(await fingerprints(), sourceFingerprints);
    scenarios.push({ scenario: name, outcome: "passed" });
    delete evidence.currentScenario;
  };

  try {
    const base = await artifact("TestToken");
    const dex = await artifact("MiniDEX");
    const firstToken = await deploy(base, ["Liquidity base", "LPB"]);
    const otherBase = await deploy(base, ["Liquidity reserve", "LPR"]);
    const wrapped = await deploy(await artifact("WrappedEther"));
    const firstDEX = await deploy(dex, ["First liquidity DEX"]);
    const secondDEX = await deploy(dex, ["Second liquidity DEX"]);
    const arbitrage = await deploy(await artifact("AtomicArbitrage"));
    const fixture = (
      await environment.fixtures("contracts/test/fixtures/PrecisionToken.sol")
    ).PrecisionToken;
    const sixAddress = await deploy(
      { abi: fixture.abi, bytecode: `0x${fixture.evm.bytecode.object}` },
      ["Liquidity six", "LP6", 6],
    );
    const actor = accounts[1];
    const recipient = accounts[2];
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const incoming = JSON.parse(Buffer.concat(chunks).toString()) as
        RPCRequest | RPCRequest[];
      const batch = Array.isArray(incoming) ? incoming : [incoming];
      const transactions = batch.filter(
        (item) => item.method === "eth_sendTransaction",
      );
      const observed = transactions.map((item) => {
        const tx = item.params![0];
        const value: (typeof writes)[number] = {
          from: tx.from!,
          to: tx.to!,
          data: tx.data!,
        };
        writes.push(value);
        return { request: item, write: value };
      });
      try {
        const forwarded = await fetch(environment.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(incoming),
        }).then((reply) => reply.json());
        const results = Array.isArray(forwarded) ? forwarded : [forwarded];
        for (const item of observed) {
          const result = results.find((entry) => entry.id === item.request.id);
          item.write.hash = result?.result;
          if (
            holdApproval &&
            same(item.write.from, actor) &&
            item.write.data.startsWith("0x095ea7b3")
          ) {
            holdApproval = false;
            approvalHeld = true;
            await new Promise<void>((done) => (releaseApproval = done));
          }
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(forwarded));
      } catch (error) {
        // DEFENSE: a real fixture transport failure must terminate the waiting request.
        response.writeHead(502);
        response.end(String(error));
      }
    });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    const port = (server.address() as { port: number }).port;
    const deployment: Deployment = {
      schemaVersion: 1,
      chainId: 31337,
      rpcUrl: `http://127.0.0.1:${port}`,
      tokens: [
        {
          address: firstToken,
          name: "Liquidity base",
          symbol: "LPB",
          kind: "faucet",
          decimals: 18,
        },
        {
          address: otherBase,
          name: "Liquidity reserve",
          symbol: "LPR",
          kind: "faucet",
          decimals: 18,
        },
        {
          address: wrapped,
          name: "Wrapped Ether",
          symbol: "WETH",
          kind: "wrapped",
          decimals: 18,
        },
      ],
      exchanges: [
        { address: firstDEX, name: "First liquidity DEX" },
        { address: secondDEX, name: "Second liquidity DEX" },
      ],
      arbitrage,
      bytecodes: { TestToken: base.bytecode },
    };
    const client = new ExchangeClient(deployment);
    await client.verifyDeployment();
    const six = await client.importToken(sixAddress);
    assert.equal(six.decimals, 6);
    const tokens: Token[] = [...deployment.tokens, six];
    const assetABI = (address: string): Abi =>
      same(address, sixAddress) ? fixture.abi : base.abi;
    const rawBalance = async (token: string, owner: string) =>
      (await read.readContract({
        address: getAddress(token),
        abi: assetABI(token),
        functionName: "balanceOf",
        args: [owner],
      })) as bigint;
    const balances = async (pool: Pool, owner: string) =>
      Promise.all([
        rawBalance(pool.token0, owner),
        rawBalance(pool.token1, owner),
      ]);
    const sendAdmin = async (
      address: string,
      abi: Abi,
      name: string,
      args: readonly unknown[] = [],
    ) => {
      const hash = await admin.writeContract({
        address: getAddress(address),
        abi,
        functionName: name,
        args,
      });
      const receipt = await read.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      return receipt;
    };
    const ownerOf = async (pool: Pool, id: bigint) =>
      (await read.readContract({
        address: getAddress(pool.exchange.address),
        abi: dex.abi,
        functionName: "ownerOf",
        args: [id],
      })) as string;
    const findPool = async (exchange: string): Promise<Pool> => {
      const found = (await client.snapshot(actor, tokens)).pools.find((pool) =>
        same(pool.exchange.address, exchange),
      );
      assert(found);
      return found;
    };
    const event = <T,>(
      receipt: TransactionReceipt,
      address: string,
      name: string,
    ): T => {
      const events = parseEventLogs({
        abi: dex.abi,
        logs: receipt.logs.filter((log) => same(log.address, address)),
        eventName: name,
      });
      assert.equal(
        events.length,
        1,
        `${name} must belong to the final target receipt`,
      );
      return events[0].args as T;
    };
    const checkIdentity = (result: LiquidityConfirmation, pool: Pool) => {
      assert(same(result.pool.exchange.address, pool.exchange.address));
      assert.equal(result.pool.id, pool.id);
      assert(same(result.pool.token0, pool.token0));
      assert(same(result.pool.token1, pool.token1));
      assert.equal(result.receipt.status, "success");
      assert(same(result.receipt.to!, pool.exchange.address));
    };
    const checkAmounts = (
      result: LiquidityConfirmation,
      pool: Pool,
      name: string,
    ) => {
      assert(result.kind !== "transfer");
      checkIdentity(result, pool);
      const observed = event<AmountEvent>(
        result.receipt,
        pool.exchange.address,
        name,
      );
      assert.equal(result.positionId, observed.positionId);
      assert.equal(result.pool.id, observed.poolId);
      assert.equal(result.amount0, observed.amount0);
      assert.equal(result.amount1, observed.amount1);
      assert.equal(result.shares, observed.shares);
      assert(
        same(
          result.owner,
          (name === "LiquidityAdded" ? observed.provider : observed.owner)!,
        ),
      );
      return observed;
    };

    wallet = new WalletController(client, { storage: null });
    await wallet.start();
    const select = async (owner: string) => {
      wallet!.dispatch({ kind: "select-local", address: owner });
      await until(
        () => wallet!.session(),
        (session) => !!session && same(session.address, owner),
        "liquidity wallet selection",
      );
    };
    const perform = async (
      label: string,
      action: Parameters<WalletController["perform"]>[0]["perform"],
    ) => {
      const session = wallet!.session();
      assert(session);
      await wallet!.perform({ label, session, perform: action });
    };
    await select(actor);
    await perform("Prepare LP capital", (writer) =>
      writer.faucet(deployment.tokens[0]),
    );
    await sendAdmin(firstToken, base.abi, "faucet");
    for (const owner of [accounts[0], actor])
      await sendAdmin(sixAddress, fixture.abi, "mint", [
        owner,
        10_000n * 10n ** 6n,
      ]);
    const unit = (address: string) =>
      same(address, sixAddress) ? 10n ** 6n : 10n ** 18n;
    for (const exchange of [firstDEX, secondDEX]) {
      await sendAdmin(exchange, dex.abi, "createPool", [
        firstToken,
        sixAddress,
      ]);
      for (const token of [firstToken, sixAddress])
        await sendAdmin(token, assetABI(token), "approve", [
          exchange,
          maxUint256,
        ]);
      const pool = await findPool(exchange);
      await sendAdmin(exchange, dex.abi, "addLiquidity", [
        pool.id,
        1000n * unit(pool.token0),
        1000n * unit(pool.token1),
        0n,
        0n,
        (await read.getBlock()).timestamp + 1200n,
      ]);
    }

    let firstDeposit: LiquidityConfirmation | undefined;
    let secondDeposit: LiquidityConfirmation | undefined;
    await scenario(
      "Deposit evidence follows actual use after a real market change during approval",
      async () => {
        const pool = await findPool(firstDEX);
        const desired = [
          10n * unit(pool.token0),
          10n * unit(pool.token1),
        ] as const;
        const before = await balances(pool, actor);
        const writeStart = writes.length;
        holdApproval = true;
        const operation = perform(
          "Deposit with approval-time price change",
          async (writer) => {
            firstDeposit = await writer.addLiquidity(
              pool,
              desired[0],
              desired[1],
              50n,
            );
          },
        );
        await until(() => approvalHeld, Boolean, "real approval response held");
        const observedDeposit = (): LiquidityConfirmation | undefined =>
          firstDeposit;
        assert.equal(
          observedDeposit(),
          undefined,
          "An approval is not a minted position",
        );
        await sendAdmin(firstDEX, dex.abi, "swap", [
          pool.id,
          pool.token0,
          unit(pool.token0) / 2n,
          0n,
          accounts[0],
          (await read.getBlock()).timestamp + 1200n,
        ]);
        releaseApproval!();
        await operation;
        assert(firstDeposit && firstDeposit.kind === "deposit");
        const observed = checkAmounts(firstDeposit, pool, "LiquidityAdded");
        assert(same(firstDeposit.owner, actor));
        const after = await balances(pool, actor);
        assert.equal(before[0] - after[0], firstDeposit.amount0);
        assert.equal(before[1] - after[1], firstDeposit.amount1);
        assert(
          firstDeposit.amount0 !== desired[0] ||
            firstDeposit.amount1 !== desired[1],
        );
        const mint = event<NFTEvent>(
          firstDeposit.receipt,
          firstDEX,
          "Transfer",
        );
        assert(same(mint.from, zeroAddress));
        assert(same(mint.to, actor));
        assert.equal(mint.tokenId, firstDeposit.positionId);
        assert(same(await ownerOf(pool, mint.tokenId), actor));
        const stored = (await read.readContract({
          address: getAddress(firstDEX),
          abi: dex.abi,
          functionName: "positions",
          args: [mint.tokenId],
        })) as readonly bigint[];
        assert.equal(stored[1], firstDeposit.shares);
        const sent = writes.slice(writeStart);
        assert.equal(
          sent.filter((tx) => tx.data.startsWith("0x095ea7b3")).length,
          2,
        );
        assert.equal(sent.at(-1)!.hash, firstDeposit.receipt.transactionHash);
        evidence.changedDeposit = {
          desired,
          before,
          after,
          event: observed,
          result: firstDeposit,
          writes: sent,
        };
      },
    );

    await scenario(
      "Equal NFT numbers in two DEX contracts retain separate identities",
      async () => {
        const pool = await findPool(secondDEX);
        const before = await balances(pool, actor);
        await perform("Deposit into second DEX", async (writer) => {
          secondDeposit = await writer.addLiquidity(
            pool,
            10n * unit(pool.token0),
            10n * unit(pool.token1),
            50n,
          );
        });
        assert(
          firstDeposit && secondDeposit && secondDeposit.kind === "deposit",
        );
        checkAmounts(secondDeposit, pool, "LiquidityAdded");
        assert(same(secondDeposit.owner, actor));
        assert.equal(firstDeposit.positionId, secondDeposit.positionId);
        assert(
          !same(
            firstDeposit.pool.exchange.address,
            secondDeposit.pool.exchange.address,
          ),
        );
        const after = await balances(pool, actor);
        assert.equal(before[0] - after[0], secondDeposit.amount0);
        assert.equal(before[1] - after[1], secondDeposit.amount1);
        assert(same(await ownerOf(pool, secondDeposit.positionId), actor));
        evidence.secondDeposit = { result: secondDeposit, before, after };
      },
    );

    await scenario(
      "Transfer evidence follows the NFT and the former owner cannot redeem it",
      async () => {
        assert(firstDeposit);
        const pool = await findPool(firstDEX);
        const position = (await client.snapshot(actor, tokens)).positions.find(
          (p) =>
            p.id === firstDeposit!.positionId &&
            same(p.exchange.address, firstDEX),
        );
        assert(position);
        const oldRequest = positionView(pool, position).amounts;
        let transferred: LiquidityConfirmation | undefined;
        const balancesBefore = await balances(pool, actor);
        await perform("Transfer LP NFT", async (writer) => {
          transferred = await writer.transferPosition(
            pool,
            firstDeposit!.positionId,
            recipient,
          );
        });
        assert(transferred && transferred.kind === "transfer");
        checkIdentity(transferred, pool);
        const observed = event<NFTEvent>(
          transferred.receipt,
          firstDEX,
          "Transfer",
        );
        assert.equal(transferred.positionId, observed.tokenId);
        assert(
          same(transferred.from, observed.from) && same(observed.from, actor),
        );
        assert(
          same(transferred.to, observed.to) && same(observed.to, recipient),
        );
        assert(same(await ownerOf(pool, observed.tokenId), recipient));
        assert.deepEqual(await balances(pool, actor), balancesBefore);
        const nonce = await rpc("eth_getTransactionCount", [actor, "latest"]);
        let rejectedResult: LiquidityConfirmation | undefined;
        await assert.rejects(() =>
          perform("Former owner cannot redeem", async (writer) => {
            rejectedResult = await writer.removeLiquidity(
              pool,
              observed.tokenId,
              oldRequest,
              50n,
            );
          }),
        );
        assert.equal(rejectedResult, undefined);
        assert.equal(
          await rpc("eth_getTransactionCount", [actor, "latest"]),
          nonce,
        );
        assert.deepEqual(await balances(pool, actor), balancesBefore);
        assert.equal(wallet!.kernel.getSnapshot().pending, false);
        assert(wallet!.kernel.getSnapshot().error);
        assert(
          same(
            await ownerOf(secondDeposit!.pool, secondDeposit!.positionId),
            actor,
          ),
        );
        evidence.transfer = {
          result: transferred,
          event: observed,
          formerOwnerNonce: nonce,
          formerOwnerError: wallet!.kernel.getSnapshot().error,
        };
      },
    );

    await scenario(
      "The new owner burns only its transferred NFT and receives actual reserve assets",
      async () => {
        assert(firstDeposit && secondDeposit);
        await select(recipient);
        const pool = await findPool(firstDEX);
        const position = (
          await client.snapshot(recipient, tokens)
        ).positions.find(
          (p) =>
            p.id === firstDeposit!.positionId &&
            same(p.exchange.address, firstDEX),
        );
        assert(position && same(position.owner, recipient));
        const request = positionView(pool, position).amounts;
        const before = await balances(pool, recipient);
        let redeemed: LiquidityConfirmation | undefined;
        await perform(
          "New owner redeems transferred position",
          async (writer) => {
            redeemed = await writer.removeLiquidity(
              pool,
              position.id,
              request,
              50n,
            );
          },
        );
        assert(redeemed && redeemed.kind === "redeem");
        checkAmounts(redeemed, pool, "LiquidityRemoved");
        const after = await balances(pool, recipient);
        assert.equal(after[0] - before[0], redeemed.amount0);
        assert.equal(after[1] - before[1], redeemed.amount1);
        assert(same(redeemed.owner, recipient));
        assert(same(redeemed.receipt.from, recipient));
        const burn = event<NFTEvent>(redeemed.receipt, firstDEX, "Transfer");
        assert(same(burn.to, zeroAddress));
        assert(same(burn.from, recipient));
        assert.equal(burn.tokenId, position.id);
        await assert.rejects(() => ownerOf(pool, position.id));
        assert(
          same(
            await ownerOf(secondDeposit.pool, secondDeposit.positionId),
            actor,
          ),
        );
        evidence.redemption = { result: redeemed, before, after, burn };
      },
    );

    assert.deepEqual(await fingerprints(), sourceFingerprints);
    evidence.status = "passed";
  } catch (error) {
    evidence.status = "failed";
    evidence.error = error instanceof Error ? error.stack : String(error);
    throw error;
  } finally {
    releaseApproval?.();
    wallet?.stop();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((done, reject) =>
        server!.close((error) => (error ? reject(error) : done())),
      );
    }
    await writeFile(resolve(directory, "result.json"), serialize(evidence));
    await environment.close();
    console.log(
      serialize({
        status: evidence.status,
        scenarios,
        result: resolve(directory, "result.json"),
        kernelSha256: evidence.kernelSha256,
      }),
    );
  }
}

await main();
