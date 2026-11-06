import { expect, test } from "@playwright/test";
import {
  openWallet,
  closeWallet,
  selectLocalAccount,
  goToWorkspace,
  expectStatus,
} from "./navigation";
import { readFileSync } from "node:fs";
import { Contract, JsonRpcProvider, parseEther } from "ethers";

const deployment = JSON.parse(
  readFileSync("../shared/deployment.json", "utf8"),
);
const provider = new JsonRpcProvider(deployment.rpcUrl, deployment.chainId, {
  staticNetwork: true,
  cacheTimeout: -1,
});
test("complete browser workflow uses real local blockchain transactions", async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await page.goto("/");
  const selectedAccount = await selectLocalAccount(page, 1);
  await openWallet(page);
  await page
    .getByRole("button", { name: "Claim 10,000", exact: false })
    .first()
    .click();
  await expectStatus(page, "confirmed in block");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await closeWallet(page);
  await page.getByLabel("Swap amount").fill("12");
  await page
    .getByRole("form", { name: "Swap tokens", exact: true })
    .getByRole("button", { name: "Swap", exact: true })
    .click();
  await expectStatus(page, "Swap tokens confirmed");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("01-swap.png"),
    fullPage: true,
  });

  await goToWorkspace(page, "Liquidity");
  const liquidityMarket = new Contract(
    deployment.exchanges[0].address,
    deployment.abis.MiniDEX,
    provider,
  );
  const positionId: bigint = await liquidityMarket.nextPositionId();
  await page.getByRole("button", { name: "New position", exact: true }).click();
  const deposit = page.getByRole("dialog", {
    name: "New liquidity position",
    exact: true,
  });
  await deposit.getByLabel("Liquidity token 0").fill("100");
  await deposit.getByLabel("Liquidity token 1").fill("100");
  await deposit
    .getByRole("button", { name: "Review position", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Review new position", exact: true })
    .getByRole("button", { name: "Approve & mint position NFT", exact: true })
    .click();
  await expectStatus(page, "Add liquidity confirmed");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page
    .getByRole("button", { name: /^Manage NFT #/ })
    .last()
    .click();
  await expect(
    page.getByRole("button", {
      name: `Burn NFT #${positionId} & redeem`,
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("02-liquidity.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", {
      name: `Burn NFT #${positionId} & redeem`,
      exact: true,
    })
    .click();
  await page
    .getByRole("dialog", { name: "Review position redemption" })
    .getByRole("button", { name: "Confirm redemption", exact: true })
    .click();
  await expectStatus(page, "Redeem position confirmed");
  await expect(page.getByRole("alert")).toHaveCount(0);

  await goToWorkspace(page, "Pools & tokens");
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Browser Test Token");
  await page.getByRole("textbox", { name: "Symbol", exact: true }).fill("BTT");
  await page.getByRole("button", { name: "Deploy ERC20", exact: true }).click();
  await expectStatus(page, "Deploy ERC20 confirmed");
  await openWallet(page);
  await page.getByRole("button", { name: "Claim 10,000 BTT" }).click();
  await expectStatus(page, "Claim BTT confirmed");
  await closeWallet(page);
  const newToken = await page
    .getByLabel("Second token")
    .locator("option")
    .filter({ hasText: "BTT" })
    .getAttribute("value");
  await page.getByLabel("Second token").selectOption(newToken!);
  await page.getByRole("button", { name: "Create pool", exact: true }).click();
  await expectStatus(page, "Create pool confirmed");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Wrap ETH", exact: true }).click();
  await expectStatus(page, "Wrap ETH confirmed");
  await page.getByRole("button", { name: "Unwrap WETH", exact: true }).click();
  await expectStatus(page, "Unwrap WETH confirmed");
  await page.screenshot({
    path: testInfo.outputPath("03-pools.png"),
    fullPage: true,
  });

  // Generate a real market imbalance, then find and execute the route entirely in the UI.
  const signer = await provider.getSigner(0);
  const market = new Contract(
    deployment.exchanges[0].address,
    deployment.abis.MiniDEX,
    signer,
  );
  const p = await market.pools(1);
  const input = new Contract(p.token0, deployment.abis.TestToken, signer);
  await (await input.faucet()).wait();
  await (await input.approve(market.target, parseEther("2000"))).wait();
  await (
    await market.swap(
      1,
      p.token0,
      parseEther("2000"),
      0,
      await signer.getAddress(),
      Math.floor(Date.now() / 1000) + 1200,
    )
  ).wait();
  await openWallet(page);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await closeWallet(page);
  await goToWorkspace(page, "Arbitrage");
  await page.getByRole("button", { name: "Find profitable route" }).click();
  await expectStatus(page, "Profitable route found", 60_000);
  await page
    .getByRole("button", { name: "Approve & execute atomic arbitrage" })
    .click();
  await expect(page.getByTestId("arbitrage-result")).toContainText(
    "Realized token profit",
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("04-arbitrage.png"),
    fullPage: true,
  });
  await goToWorkspace(page, "Transactions");
  await expect(
    page.getByRole("cell", { name: "Atomic arbitrage", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("05-transactions.png"),
    fullPage: true,
  });
  expect(consoleErrors).toEqual([]);
});
