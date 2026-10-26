import { expect } from "chai";
import hre from "hardhat";
import type { Contract, Signer } from "ethers";

const { ethers, networkHelpers } = await hre.network.create();
const units = ethers.parseEther;
const asUser = (contract: Contract, user: Signer): Contract => contract.connect(user) as Contract;

async function deadline() {
  const block = await ethers.provider.getBlock("latest");
  return block!.timestamp + 3600;
}

async function deployFixture() {
  const users = await ethers.getSigners();
  const tokenA = await ethers.deployContract("TestToken", ["Token A", "TKA"]) as unknown as Contract;
  const tokenB = await ethers.deployContract("TestToken", ["Token B", "TKB"]) as unknown as Contract;
  const wrapped = await ethers.deployContract("WrappedEther") as unknown as Contract;
  const dex1 = await ethers.deployContract("MiniDEX", ["Exchange One"]) as unknown as Contract;
  const dex2 = await ethers.deployContract("MiniDEX", ["Exchange Two"]) as unknown as Contract;
  const arbitrage = await ethers.deployContract("AtomicArbitrage") as unknown as Contract;
  await Promise.all([tokenA, tokenB, wrapped, dex1, dex2, arbitrage].map(c => c.waitForDeployment()));
  const [token0, token1] = BigInt(await tokenA.getAddress()) < BigInt(await tokenB.getAddress())
    ? [tokenA, tokenB] : [tokenB, tokenA];
  for (const token of [token0, token1]) {
    await (await token.faucet()).wait();
    for (const dex of [dex1, dex2]) await (await token.approve(dex, ethers.MaxUint256)).wait();
  }
  return { users, tokenA, tokenB, token0, token1, wrapped, dex1, dex2, arbitrage };
}

async function seed(dex: Contract, token0: Contract, token1: Contract, amount0 = "1000", amount1 = "1000") {
  await (await dex.createPool(token0, token1)).wait();
  const poolId = await dex.getPool(token0, token1);
  const positionId = await dex.nextPositionId();
  await (await dex.addLiquidity(poolId, units(amount0), units(amount1), 0, 0, await deadline())).wait();
  return { poolId, positionId };
}

async function accountState(dex1: Contract, dex2: Contract, token0: Contract, token1: Contract, arbitrage: Contract, user: Signer) {
  const address = await user.getAddress();
  return {
    pools: [Array.from(await dex1.pools(1)).map(String), Array.from(await dex2.pools(1)).map(String)],
    balances: await Promise.all([token0, token1].flatMap(token =>
      [address, arbitrage.target, dex1.target, dex2.target].map(account => token.balanceOf(account).then(String)))),
    allowances: await Promise.all([token0.allowance(address, arbitrage).then(String),
      ...[token0, token1].flatMap(token => [dex1, dex2].map(dex => token.allowance(arbitrage, dex).then(String)))])
  };
}

// These scenarios interact only through deployed contracts, receipts and public balances.
// They intentionally do not import contract implementation helpers or duplicate its data structures.
describe("Coursework public transaction flows", function () {
  this.timeout(120_000);

  it("lets users claim ERC20s, wrap ETH and create a unique canonical token pool", async function () {
    const { users, tokenA, tokenB, wrapped, dex1 } = await networkHelpers.loadFixture(deployFixture);
    const user = users[1];
    await (await asUser(tokenA, user).faucet()).wait();
    await (await asUser(tokenB, user).faucet()).wait();
    expect(await tokenA.balanceOf(user)).to.equal(units("10000"));
    expect(await tokenB.balanceOf(user)).to.equal(units("10000"));
    await (await asUser(wrapped, user).deposit({ value: units("2") })).wait();
    expect(await wrapped.balanceOf(user)).to.equal(units("2"));
    expect(await ethers.provider.getBalance(wrapped)).to.equal(units("2"));
    await (await asUser(wrapped, user).withdraw(units("1"))).wait();
    expect(await wrapped.balanceOf(user)).to.equal(units("1"));
    expect(await ethers.provider.getBalance(wrapped)).to.equal(units("1"));
    await (await asUser(dex1, user).createPool(tokenB, tokenA)).wait();
    expect(await dex1.getPool(tokenA, tokenB)).to.equal(1n);
    expect(await dex1.getPool(tokenB, tokenA)).to.equal(1n);
    const pool = await dex1.pools(1);
    expect(BigInt(pool.token0)).to.be.lessThan(BigInt(pool.token1));
    expect(pool.reserve0).to.equal(0n);
    expect(pool.reserve1).to.equal(0n);
    await expect(dex1.createPool(tokenA, tokenB)).to.revert(ethers);
    await expect(dex1.createPool(tokenA, tokenA)).to.revert(ethers);
    await (await asUser(dex1, user).createPool(tokenA, wrapped)).wait();
    expect(await dex1.poolCount()).to.equal(2n);
  });

  it("mints proportional NFT liquidity, preserves deposit metadata and redeems to its new owner", async function () {
    const { users, token0, token1, dex1 } = await networkHelpers.loadFixture(deployFixture);
    const { poolId } = await seed(dex1, token0, token1);
    const provider = users[1], recipient = users[2];
    for (const token of [token0, token1]) {
      await (await asUser(token, provider).faucet()).wait();
      await (await asUser(token, provider).approve(dex1, ethers.MaxUint256)).wait();
    }
    const before0 = await token0.balanceOf(provider), before1 = await token1.balanceOf(provider);
    const positionId = await dex1.nextPositionId();
    await (await asUser(dex1, provider).addLiquidity(poolId, units("100"), units("200"), units("100"), units("100"), await deadline())).wait();
    expect(before0 - await token0.balanceOf(provider)).to.equal(units("100"));
    expect(before1 - await token1.balanceOf(provider)).to.equal(units("100"));
    expect(await dex1.ownerOf(positionId)).to.equal(provider.address);
    const position = await dex1.positions(positionId);
    expect(position.poolId).to.equal(poolId);
    expect(position.shares).to.be.greaterThan(0n);
    expect(position.amount0).to.equal(units("100"));
    expect(position.amount1).to.equal(units("100"));
    expect(position.createdAt).to.be.greaterThan(0n);
    const uri = await dex1.tokenURI(positionId);
    expect(uri).to.match(/^data:application\/json/);
    const [header, payload] = uri.split(",", 2);
    const metadata = JSON.parse(header.includes("base64") ? Buffer.from(payload, "base64").toString() : decodeURIComponent(payload));
    expect(metadata.name).to.be.a("string").and.not.empty;
    expect(metadata.attributes).to.be.an("array").and.not.empty;
    const traits = new Map(metadata.attributes.map((attribute: { trait_type: string; value: string | number }) => [attribute.trait_type, String(attribute.value)]));
    expect(traits.get("Pool")).to.equal(String(poolId));
    expect(traits.get("Shares (raw)")).to.equal(String(position.shares));
    expect(traits.get("Initial token0 (raw)")).to.equal(String(position.amount0));
    expect(traits.get("Initial token1 (raw)")).to.equal(String(position.amount1));
    expect(traits.get("Created timestamp")).to.equal(String(position.createdAt));
    await (await asUser(dex1, provider).transferFrom(provider, recipient, positionId)).wait();
    await expect(asUser(dex1, provider).removeLiquidity(positionId, 0, 0, await deadline())).to.revert(ethers);
    await expect(asUser(dex1, recipient).removeLiquidity(positionId, units("101"), 0, await deadline())).to.revert(ethers);
    const balancesBefore = [await token0.balanceOf(recipient), await token1.balanceOf(recipient)];
    await (await asUser(dex1, recipient).removeLiquidity(positionId, units("100"), units("100"), await deadline())).wait();
    expect(await token0.balanceOf(recipient) - balancesBefore[0]).to.equal(units("100"));
    expect(await token1.balanceOf(recipient) - balancesBefore[1]).to.equal(units("100"));
    await expect(dex1.ownerOf(positionId)).to.revert(ethers);
    await expect(asUser(dex1, recipient).removeLiquidity(positionId, 0, 0, await deadline())).to.revert(ethers);
  });

  it("applies the 0.3% trade fee, enforces execution limits and pays accrued fees on NFT burn", async function () {
    const { users, token0, token1, dex1 } = await networkHelpers.loadFixture(deployFixture);
    const { poolId, positionId } = await seed(dex1, token0, token1);
    const trader = users[1];
    for (const token of [token0, token1]) {
      await (await asUser(token, trader).faucet()).wait();
      await (await asUser(token, trader).approve(dex1, ethers.MaxUint256)).wait();
    }
    // Independent protocol formula from the coursework's constant-product/30 bps contract.
    const input = units("100");
    const quote = await dex1.quote(poolId, token0, input);
    expect(quote).to.equal(input * 997n * units("1000") / (units("1000") * 1000n + input * 997n));
    const poolBefore = Array.from(await dex1.pools(poolId));
    const balanceBefore = await token0.balanceOf(trader);
    await expect(asUser(dex1, trader).swap(poolId, token0, input, quote + 1n, trader, await deadline(), { gasLimit: 1_000_000 })).to.revert(ethers);
    await expect(asUser(dex1, trader).swap(poolId, token0, input, 0, trader, 0, { gasLimit: 1_000_000 })).to.revert(ethers);
    expect(Array.from(await dex1.pools(poolId))).to.deep.equal(poolBefore);
    expect(await token0.balanceOf(trader)).to.equal(balanceBefore);
    const receivedBefore = await token1.balanceOf(trader);
    await (await asUser(dex1, trader).swap(poolId, token0, input, quote, trader, await deadline())).wait();
    expect(await token1.balanceOf(trader) - receivedBefore).to.equal(quote);
    const afterSwap = await dex1.pools(poolId);
    expect(afterSwap.reserve0 * afterSwap.reserve1).to.be.greaterThan(units("1000") ** 2n);
    const returnQuote = await dex1.quote(poolId, token1, quote);
    await (await asUser(dex1, trader).swap(poolId, token1, quote, returnQuote, trader, await deadline())).wait();
    const owner = users[0];
    const ownerBefore = await token0.balanceOf(owner);
    await (await dex1.removeLiquidity(positionId, 0, 0, await deadline())).wait();
    expect(await token0.balanceOf(owner) - ownerBefore).to.be.greaterThan(units("1000"));
    const remainder = await dex1.pools(poolId);
    expect(remainder.totalShares).to.be.greaterThan(0n);
  });

  it("runs twenty distinct addresses through token claims, liquidity, swaps and redemption", async function () {
    const { users, token0, token1, dex1, dex2 } = await networkHelpers.loadFixture(deployFixture);
    expect(users.length).to.be.at.least(20);
    await seed(dex1, token0, token1);
    await seed(dex2, token0, token1);
    const seen = new Set<string>();
    for (const [index, user] of users.slice(0, 20).entries()) {
      seen.add(user.address);
      const dex = index % 2 === 0 ? dex1 : dex2;
      for (const token of [token0, token1]) {
        await (await asUser(token, user).faucet()).wait();
        await (await asUser(token, user).approve(dex, ethers.MaxUint256)).wait();
      }
      const id = await dex.nextPositionId();
      await (await asUser(dex, user).addLiquidity(1, units("10"), units("10"), 0, 0, await deadline())).wait();
      expect(await dex.ownerOf(id)).to.equal(user.address);
      const tokenIn = index % 3 === 0 ? token0 : token1;
      const amountIn = units(String(index + 1));
      const amountOut = await dex.quote(1, tokenIn, amountIn);
      const tokenOut = tokenIn === token0 ? token1 : token0;
      const before = await tokenOut.balanceOf(user);
      const receipt = await (await asUser(dex, user).swap(1, tokenIn, amountIn, amountOut, user, await deadline())).wait();
      expect(receipt.status).to.equal(1);
      expect(await tokenOut.balanceOf(user) - before).to.equal(amountOut);
      await (await asUser(dex, user).removeLiquidity(id, 0, 0, await deadline())).wait();
      await expect(dex.ownerOf(id)).to.revert(ethers);
    }
    expect(seen.size).to.equal(20);
    for (const dex of [dex1, dex2]) {
      const pool = await dex.pools(1);
      expect(await token0.balanceOf(dex)).to.equal(pool.reserve0);
      expect(await token1.balanceOf(dex)).to.equal(pool.reserve1);
    }
  });

  it("settles profitable two-exchange arbitrage atomically and rolls back every observable token effect on failure", async function () {
    const { users, token0, token1, dex1, dex2, arbitrage } = await networkHelpers.loadFixture(deployFixture);
    await seed(dex1, token0, token1, "1000", "2000");
    await seed(dex2, token0, token1, "1000", "1000");
    const trader = users[1];
    await (await asUser(token0, trader).faucet()).wait();
    await (await asUser(token0, trader).approve(arbitrage, units("1000"))).wait();
    const amountIn = units("10");
    const intermediate = await dex1.quote(1, token0, amountIn);
    const expectedReturn = await dex2.quote(1, token1, intermediate);
    const expectedProfit = expectedReturn - amountIn;
    expect(expectedProfit).to.be.greaterThan(0n);
    const before = await accountState(dex1, dex2, token0, token1, arbitrage, trader);
    await expect(asUser(arbitrage, trader).execute(dex1, 1, dex2, 1, token0, amountIn, units("10000"), await deadline(), { gasLimit: 2_000_000 })).to.revert(ethers);
    expect(await accountState(dex1, dex2, token0, token1, arbitrage, trader)).to.deep.equal(before);
    const traderBefore = await token0.balanceOf(trader);
    const receipt = await (await asUser(arbitrage, trader).execute(dex1, 1, dex2, 1, token0, amountIn, expectedProfit, await deadline())).wait();
    expect(receipt.status).to.equal(1);
    expect(await token0.balanceOf(trader) - traderBefore).to.equal(expectedProfit);
    expect(await token0.balanceOf(arbitrage)).to.equal(0n);
    expect(await token1.balanceOf(arbitrage)).to.equal(0n);
    const buyAfter = await dex1.pools(1), sellAfter = await dex2.pools(1);
    expect(buyAfter.reserve0).to.equal(units("1000") + amountIn);
    expect(buyAfter.reserve1).to.equal(units("2000") - intermediate);
    expect(sellAfter.reserve0).to.equal(units("1000") - expectedReturn);
    expect(sellAfter.reserve1).to.equal(units("1000") + intermediate);
    // The inverse route loses money at these prices and must revert even with a zero requested profit.
    const afterSuccess = await accountState(dex1, dex2, token0, token1, arbitrage, trader);
    await expect(asUser(arbitrage, trader).execute(dex2, 1, dex1, 1, token0, amountIn, 0, await deadline(), { gasLimit: 2_000_000 })).to.revert(ethers);
    expect(await accountState(dex1, dex2, token0, token1, arbitrage, trader)).to.deep.equal(afterSuccess);
  });
});
