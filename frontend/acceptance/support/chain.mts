import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  type Abi,
  type Hex,
} from "viem";

export const root = fileURLToPath(new URL("../../../", import.meta.url));
export const delay = (milliseconds: number) =>
  new Promise<void>((done) => setTimeout(done, milliseconds));
export async function until<T>(
  read: () => T | Promise<T>,
  accepts: (value: T) => boolean,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (accepts(value)) return value;
    await delay(30);
  }
  throw new Error(`Timed out: ${label}`);
}

export async function isolatedChain(prefix: string) {
  const directory = await mkdtemp(resolve(root, `.local/${prefix}-`));
  const socket = createServer();
  await new Promise<void>((done) => socket.listen(0, "127.0.0.1", done));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((done, reject) =>
    socket.close((error) => (error ? reject(error) : done())),
  );
  const rpcUrl = `http://127.0.0.1:${port}`;
  const log = await open(resolve(directory, "chain.log"), "w");
  const node = spawn(
    process.execPath,
    [
      resolve(root, "contracts/node_modules/hardhat/dist/src/cli.js"),
      "node",
      "--network",
      "hardhat",
      "--port",
      String(port),
    ],
    {
      cwd: resolve(root, "contracts"),
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    },
  );
  await writeFile(
    resolve(directory, "launch.json"),
    JSON.stringify({ pid: node.pid, rpcUrl }),
  );
  const rpc = async (method: string, params: unknown[] = []) => {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await response.json()) as {
      result: unknown;
      error?: { message: string };
    };
    if (body.error) throw new Error(body.error.message);
    return body.result;
  };
  const close = async () => {
    // DEFENSE: startup can fail before the child binds RPC; always stop the process we spawned.
    if (node.pid && node.exitCode === null) process.kill(-node.pid, "SIGTERM");
    await log.close();
  };
  try {
    await until(
      async () => {
        // DEFENSE: RPC is unavailable while the newly spawned node is starting.
        try {
          return await rpc("eth_chainId");
        } catch (error) {
          if (error instanceof TypeError) return null;
          throw error;
        }
      },
      (value) => value === "0x7a69",
      "isolated node startup",
    );
    const accounts = ((await rpc("eth_accounts")) as string[]).map((address) =>
      getAddress(address),
    );
    const chain = defineChain({
      id: 31337,
      name: "Precision acceptance",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const read = createPublicClient({ chain, transport: http(rpcUrl) });
    const admin = createWalletClient({
      account: accounts[0],
      chain,
      transport: http(rpcUrl),
    });
    const artifact = async (name: string) =>
      JSON.parse(
        await readFile(
          resolve(
            root,
            `contracts/artifacts/contracts/${name}.sol/${name}.json`,
          ),
          "utf8",
        ),
      ) as { abi: Abi; bytecode: Hex };
    const deploy = async (
      compiled: { abi: Abi; bytecode: Hex },
      args: readonly unknown[] = [],
    ) => {
      const hash = await admin.deployContract({
        abi: compiled.abi,
        bytecode: compiled.bytecode,
        args,
      });
      const receipt = await read.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      assert(receipt.contractAddress);
      return getAddress(receipt.contractAddress);
    };
    const fixtures = async (path: string) => {
      const result = spawnSync(
        resolve(root, ".local/toolchain/solc"),
        [
          "--base-path",
          root,
          "--include-path",
          resolve(root, "contracts/node_modules"),
          "--standard-json",
        ],
        {
          encoding: "utf8",
          input: JSON.stringify({
            language: "Solidity",
            sources: {
              [path]: { content: await readFile(resolve(root, path), "utf8") },
            },
            settings: {
              evmVersion: "paris",
              outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
            },
          }),
        },
      );
      assert.equal(result.status, 0, result.stderr);
      await writeFile(
        resolve(directory, "fixture-compiler.json"),
        result.stdout,
      );
      const output = JSON.parse(result.stdout);
      assert(
        !output.errors?.some(
          (entry: { severity: string }) => entry.severity === "error",
        ),
        result.stdout,
      );
      return output.contracts[path] as Record<
        string,
        { abi: Abi; evm: { bytecode: { object: string } } }
      >;
    };
    return {
      directory,
      rpcUrl,
      accounts,
      chain,
      read,
      admin,
      rpc,
      artifact,
      deploy,
      fixtures,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
