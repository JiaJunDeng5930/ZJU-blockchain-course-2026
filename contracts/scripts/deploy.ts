import hre from "hardhat";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

async function main() {
  const { ethers, networkConfig } = await hre.network.create();
  // DEFENSE: a transient Hardhat network disappears after this script exits, so its
  // addresses cannot be exported as a usable browser/simulator deployment.
  if (networkConfig.type !== "http") {
    throw new Error(
      "Deployment requires a persistent HTTP node; use npm run deploy or npm run deploy:ganache"
    );
  }
  const rpcUrl = await networkConfig.url.getUrl();
  const signers = await ethers.getSigners();
  if (signers.length < 20)
    throw new Error(
      "Deployment requires at least 20 unlocked teaching accounts"
    );
  const [deployer] = signers;
  const tokenA = await ethers.deployContract("TestToken", ["Token A", "TKA"]);
  await tokenA.waitForDeployment();
  const tokenB = await ethers.deployContract("TestToken", ["Token B", "TKB"]);
  await tokenB.waitForDeployment();
  const weth = await ethers.deployContract("WrappedEther");
  await weth.waitForDeployment();
  const exchangeA = await ethers.deployContract("MiniDEX", ["Harbor DEX"]);
  await exchangeA.waitForDeployment();
  const exchangeB = await ethers.deployContract("MiniDEX", ["Summit DEX"]);
  await exchangeB.waitForDeployment();
  const arbitrage = await ethers.deployContract("AtomicArbitrage");
  await arbitrage.waitForDeployment();

  // Each independent account claims tokens through the same public faucet used in the UI.
  await Promise.all(
    signers.slice(0, 20).map(async (signer) => {
      await (await tokenA.connect(signer).getFunction("faucet")()).wait();
      await (await tokenB.connect(signer).getFunction("faucet")()).wait();
    })
  );
  for (let claim = 0; claim < 2; claim++) {
    await (await tokenA.connect(deployer).getFunction("faucet")()).wait();
    await (await tokenB.connect(deployer).getFunction("faucet")()).wait();
  }

  const tokenAAddress = await tokenA.getAddress();
  const tokenBAddress = await tokenB.getAddress();
  const seed = ethers.parseEther("10000");
  const deadline = BigInt(
    (await ethers.provider.getBlock("latest"))!.timestamp + 3600
  );
  for (const exchange of [exchangeA, exchangeB]) {
    await (await exchange.createPool(tokenAAddress, tokenBAddress)).wait();
    await (await tokenA.approve(await exchange.getAddress(), seed)).wait();
    await (await tokenB.approve(await exchange.getAddress(), seed)).wait();
    await (
      await exchange.addLiquidity(1, seed, seed, seed, seed, deadline)
    ).wait();
  }
  const contractNames = [
    "TestToken",
    "WrappedEther",
    "MiniDEX",
    "AtomicArbitrage",
  ] as const;
  const artifacts = await Promise.all(
    contractNames.map((name) => hre.artifacts.readArtifact(name))
  );
  const deployment = {
    schemaVersion: 1,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    rpcUrl,
    tokens: [
      {
        address: tokenAAddress,
        name: "Token A",
        symbol: "TKA",
        kind: "faucet",
        decimals: 18,
      },
      {
        address: tokenBAddress,
        name: "Token B",
        symbol: "TKB",
        kind: "faucet",
        decimals: 18,
      },
      {
        address: await weth.getAddress(),
        name: "Wrapped Ether",
        symbol: "WETH",
        kind: "wrapped",
        decimals: 18,
      },
    ],
    exchanges: [
      { address: await exchangeA.getAddress(), name: "Harbor DEX" },
      { address: await exchangeB.getAddress(), name: "Summit DEX" },
    ],
    arbitrage: await arbitrage.getAddress(),
    abis: Object.fromEntries(
      contractNames.map((name, index) => [name, artifacts[index].abi])
    ),
    bytecodes: { TestToken: artifacts[0].bytecode },
  };
  const outputDirectory = fileURLToPath(
    new URL("../../shared/", import.meta.url)
  );
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    `${outputDirectory}deployment.json`,
    `${JSON.stringify(deployment, null, 2)}\n`
  );
  console.log(
    JSON.stringify(
      {
        message:
          "Deployment complete: 20 funded accounts, two seeded AMM exchanges",
        chainId: deployment.chainId,
        tokens: deployment.tokens,
        exchanges: deployment.exchanges,
        arbitrage: deployment.arbitrage,
        output: `${outputDirectory}deployment.json`,
      },
      null,
      2
    )
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
