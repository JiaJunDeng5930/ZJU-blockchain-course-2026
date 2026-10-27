import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectStatus, goToWorkspace, selectLocalAccount } from "./navigation";
import { readFileSync } from "node:fs";
import {
  Contract,
  JsonRpcProvider,
  formatEther,
  type InterfaceAbi,
} from "ethers";

type Deployment = {
  chainId: number;
  rpcUrl: string;
  exchanges: { address: string; name: string }[];
  abis: Record<string, InterfaceAbi>;
};
const deployment: Deployment = JSON.parse(
  readFileSync("../shared/deployment.json", "utf8"),
);
const provider = new JsonRpcProvider(deployment.rpcUrl, deployment.chainId, {
  staticNetwork: true,
  cacheTimeout: -1,
});

function positionCard(page: Page, id: bigint): Locator {
  return page.locator("article").filter({
    has: page.getByRole("heading", { name: new RegExp(`NFT #${id}$`) }),
  });
}

test("a provider can review, cancel, transfer and redeem an NFT with a retained liquidity history", async ({
  page,
}) => {
  await page.setViewportSize({ width: 581, height: 900 });
  const accounts: string[] = await provider.send("eth_accounts", []);
  const providerAddress = accounts[18];
  const recipientAddress = accounts[19];
  const exchange = new Contract(
    deployment.exchanges[0].address,
    deployment.abis.MiniDEX,
    provider,
  );
  const pool = await exchange.pools(1);
  const token0 = new Contract(pool.token0, deployment.abis.TestToken, provider);
  const token1 = new Contract(pool.token1, deployment.abis.TestToken, provider);
  const positionId: bigint = await exchange.nextPositionId();

  await page.goto("/");
  await selectLocalAccount(page, providerAddress);
  await goToWorkspace(page, "Liquidity");
  const newPosition = page.getByRole("button", {
    name: "New position",
    exact: true,
  });
  await expect(newPosition).toBeVisible();
  const primaryBounds = await newPosition.boundingBox();
  expect(primaryBounds!.y + primaryBounds!.height).toBeLessThan(900);
  await expect(page.getByLabel("Liquidity token 0")).not.toBeVisible();
  await newPosition.click();
  const supply = page.getByRole("dialog", {
    name: "New liquidity position",
    exact: true,
  });
  await expect(supply).toBeVisible();
  await page.getByLabel("Liquidity token 0").fill("50");
  await page.getByLabel("Liquidity token 1").fill("50");
  await supply
    .getByRole("button", { name: "Review position", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Review new position", exact: true }),
  ).toContainText("ERC721 position NFT");
  await page
    .getByRole("button", { name: "Approve & mint position NFT" })
    .click();
  await expectStatus(page, "Add liquidity confirmed");
  await expect
    .poll(() => exchange.ownerOf(positionId))
    .toMatch(new RegExp(`^${providerAddress}$`, "i"));
  // A real trade after the deposit distinguishes mark-to-market changes from a static original deposit.
  await goToWorkspace(page, "Swap");
  await page.getByLabel("Swap amount").fill("500");
  await page
    .getByRole("form", { name: "Swap tokens", exact: true })
    .getByRole("button", { name: "Swap", exact: true })
    .click();
  await expectStatus(page, "Swap tokens confirmed");
  await goToWorkspace(page, "Liquidity");
  const original = positionCard(page, positionId);
  await expect(original).toBeVisible();
  await original
    .getByRole("button", { name: `Manage NFT #${positionId}`, exact: true })
    .click();
  await expect(original).toContainText(
    "Compared with holding the initial deposit",
  );
  await expect(original).toContainText("not a separate fee balance");
  await expect(original).toContainText("Shares / pool ownership");
  await expect(original).toContainText("Redeem quote");
  const shareText = await original
    .locator("dt")
    .filter({ hasText: /^Shares \/ pool ownership$/ })
    .locator("xpath=following-sibling::dd[1]")
    .innerText();
  const ownedPosition = await exchange.positions(positionId);
  const currentPool = await exchange.pools(1);
  const displayedOwnership = Number(shareText.match(/([\d.]+)%/)![1]);
  expect(displayedOwnership).toBeCloseTo(
    (Number(ownedPosition.shares) / Number(currentPool.totalShares)) * 100,
    3,
  );
  async function displayedBenchmark() {
    const text = await original
      .locator("dt")
      .filter({ hasText: /^Compared with holding the initial deposit$/ })
      .locator("xpath=following-sibling::dd[1]")
      .innerText();
    return Number(text.match(/[+-]?[\d,.]+/)![0].replaceAll(",", ""));
  }
  const current0 =
    (currentPool.reserve0 * ownedPosition.shares) / currentPool.totalShares;
  const current1 =
    (currentPool.reserve1 * ownedPosition.shares) / currentPool.totalShares;
  const holdingValue =
    (ownedPosition.amount0 * currentPool.reserve1) / currentPool.reserve0 +
    ownedPosition.amount1;
  const redeemValue =
    (current0 * currentPool.reserve1) / currentPool.reserve0 + current1;
  await expect
    .poll(displayedBenchmark, { timeout: 10_000 })
    .toBeCloseTo(Number(formatEther(redeemValue - holdingValue)), 4);

  await page.locator('summary[aria-label="Pool information"]').click();
  await page.getByRole("button", { name: "Show pool history" }).click();
  const history = page.locator("details").filter({
    has: page.getByRole("heading", {
      name: "Pool activity and fees",
      exact: true,
    }),
  });
  const added = history
    .getByRole("row")
    .filter({
      has: page.getByRole("cell", { name: `#${positionId}`, exact: true }),
    })
    .filter({ hasText: "added" });
  await expect(added).toBeVisible();
  await expect(added).toContainText(new RegExp(providerAddress, "i"));
  const swapsLabel = history
    .locator("dt")
    .filter({ hasText: /^Swaps through block \d+$/ });
  const displayedBlock = Number(
    (await swapsLabel.innerText()).match(/\d+$/)![0],
  );
  const swaps = await exchange.queryFilter(
    exchange.filters.Swap(1),
    0,
    displayedBlock,
  );
  await expect(swapsLabel.locator("xpath=following-sibling::dd[1]")).toHaveText(
    String(swaps.length),
  );
  let volume0 = 0n;
  let volume1 = 0n;
  for (const log of swaps) {
    const swap = exchange.interface.parseLog(log)!;
    const input: bigint = swap.args.amountIn;
    if (
      String(swap.args.tokenIn).toLowerCase() ===
      String(pool.token0).toLowerCase()
    )
      volume0 += input;
    else volume1 += input;
  }
  const feeBps: bigint = await exchange.FEE_BPS();
  expect(feeBps).toBe(30n);
  const displayedVolume = await history
    .locator("dt")
    .filter({ hasText: /^Cumulative input volume$/ })
    .locator("xpath=following-sibling::dd[1]")
    .innerText();
  const displayedFees = await history
    .locator("dt")
    .filter({ hasText: /^Pool trading fees generated$/ })
    .locator("xpath=following-sibling::dd[1]")
    .innerText();
  function amountPair(text: string) {
    return text
      .split("/")
      .map((part) => Number(part.trim().split(/\s+/)[0].replaceAll(",", "")));
  }
  const volumes = amountPair(displayedVolume);
  const fees = amountPair(displayedFees);
  expect(volumes[0]).toBeCloseTo(Number(formatEther(volume0)), 4);
  expect(volumes[1]).toBeCloseTo(Number(formatEther(volume1)), 4);
  expect(fees[0]).toBeCloseTo(
    Number(formatEther((volume0 * feeBps) / 10000n)),
    4,
  );
  expect(fees[1]).toBeCloseTo(
    Number(formatEther((volume1 * feeBps) / 10000n)),
    4,
  );

  const nonceBeforeCancel = await provider.getTransactionCount(
    providerAddress,
    "latest",
  );
  await original.getByRole("button", { name: /Burn NFT #/ }).click();
  const review = page.getByRole("dialog", {
    name: "Review position redemption",
  });
  await expect(review).toContainText("permanently burned");
  await expect(review).toContainText("Expected");
  await expect(review).toContainText("Minimum received");
  await expect(review.getByLabel("Redemption slippage (%)")).toHaveValue("0.5");
  await page.screenshot({
    path: "../docs/screenshots/07-liquidity-review.png",
    fullPage: false,
  });
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(review).not.toBeVisible();
  expect(await provider.getTransactionCount(providerAddress, "latest")).toBe(
    nonceBeforeCancel,
  );
  expect((await exchange.ownerOf(positionId)).toLowerCase()).toBe(
    providerAddress.toLowerCase(),
  );

  await original
    .getByRole("button", { name: "Transfer position", exact: true })
    .click();
  const transfer = page.getByRole("dialog", {
    name: "Transfer liquidity position",
  });
  await transfer.getByLabel("Recipient address").fill(recipientAddress);
  await transfer
    .getByRole("button", { name: "Confirm transfer", exact: true })
    .click();
  await expect
    .poll(async () => (await exchange.ownerOf(positionId)).toLowerCase())
    .toBe(recipientAddress.toLowerCase());
  await expect(original).not.toBeVisible();

  await selectLocalAccount(page, recipientAddress);
  await goToWorkspace(page, "Liquidity");
  const received = positionCard(page, positionId);
  await expect(received).toBeVisible();
  await received
    .getByRole("button", { name: `Manage NFT #${positionId}`, exact: true })
    .click();
  const before0: bigint = await token0.balanceOf(recipientAddress);
  const before1: bigint = await token1.balanceOf(recipientAddress);
  const priorOwner0: bigint = await token0.balanceOf(providerAddress);
  const priorOwner1: bigint = await token1.balanceOf(providerAddress);
  await received.getByRole("button", { name: /Burn NFT #/ }).click();
  const redemption = page.getByRole("dialog", {
    name: "Review position redemption",
  });
  const symbol0: string = await token0.symbol();
  const symbol1: string = await token1.symbol();
  const expected0 = Number(
    (
      await redemption
        .locator("dt")
        .filter({ hasText: `Expected ${symbol0}` })
        .locator("xpath=following-sibling::dd[1]")
        .innerText()
    ).replaceAll(",", ""),
  );
  const expected1 = Number(
    (
      await redemption
        .locator("dt")
        .filter({ hasText: `Expected ${symbol1}` })
        .locator("xpath=following-sibling::dd[1]")
        .innerText()
    ).replaceAll(",", ""),
  );
  await page
    .getByRole("dialog", { name: "Review position redemption" })
    .getByRole("button", { name: "Confirm redemption", exact: true })
    .click();
  await expectStatus(page, "Redeem position confirmed");
  await expect(received).not.toBeVisible();
  const received0: bigint =
    (await token0.balanceOf(recipientAddress)) - before0;
  const received1: bigint =
    (await token1.balanceOf(recipientAddress)) - before1;
  expect(received0).toBeGreaterThan(0n);
  expect(received1).toBeGreaterThan(0n);
  expect(Number(formatEther(received0))).toBeCloseTo(expected0, 4);
  expect(Number(formatEther(received1))).toBeCloseTo(expected1, 4);
  expect(await token0.balanceOf(providerAddress)).toBe(priorOwner0);
  expect(await token1.balanceOf(providerAddress)).toBe(priorOwner1);
  await expect(exchange.ownerOf(positionId)).rejects.toThrow();

  const poolInformation = page
    .locator("details")
    .filter({ has: page.locator('summary[aria-label="Pool information"]') });
  if ((await poolInformation.getAttribute("open")) === null)
    await page.locator('summary[aria-label="Pool information"]').click();
  if (await page.getByRole("button", { name: "Show pool history" }).isVisible())
    await page.getByRole("button", { name: "Show pool history" }).click();
  const removed = history
    .getByRole("row")
    .filter({
      has: page.getByRole("cell", { name: `#${positionId}`, exact: true }),
    })
    .filter({ hasText: "removed" });
  await expect(added).toBeVisible();
  await expect(removed).toBeVisible();
  await expect(removed).toContainText(new RegExp(recipientAddress, "i"));
  await expect(history).toContainText(/fee/i);
  await expect(history).toContainText(/volume/i);
});
