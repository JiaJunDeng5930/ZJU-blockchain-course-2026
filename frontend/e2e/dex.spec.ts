import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { Contract, JsonRpcProvider, parseEther } from "ethers";

const deployment = JSON.parse(
  readFileSync("../shared/deployment.json", "utf8"),
);
const provider = new JsonRpcProvider(deployment.rpcUrl, deployment.chainId, {
  staticNetwork: true,
  cacheTimeout: -1,
});
const shots = "../docs/screenshots";

async function expectStatus(page: Page, text: string, timeout = 5000) {
  await expect(page.getByRole("status").filter({ hasText: text })).toBeVisible({
    timeout,
  });
}

test("complete browser workflow uses real local blockchain transactions", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await page.goto("/");
  await expect(page.getByLabel("Test account")).toBeVisible();
  await expectStatus(page, "Connected to chain 31337");
  const selectedAccount = await page
    .getByLabel("Test account")
    .locator("option")
    .nth(2)
    .getAttribute("value");
  await page.getByLabel("Test account").selectOption(selectedAccount!);
  await expect(page.getByLabel("Connected account")).toHaveAttribute(
    "title",
    new RegExp(`^${selectedAccount}$`, "i"),
  );
  await page
    .getByRole("button", { name: "Claim 10,000", exact: false })
    .first()
    .click();
  await expectStatus(page, "confirmed in block");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByLabel("Swap amount").fill("12");
  await page
    .getByRole("button", { name: "Approve & swap", exact: true })
    .click();
  await expectStatus(page, "Swap tokens confirmed");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.screenshot({ path: `${shots}/01-swap.png`, fullPage: true });

  await page.getByRole("button", { name: "Liquidity", exact: true }).click();
  await page
    .getByRole("button", { name: "Approve & mint position NFT" })
    .click();
  await expectStatus(page, "Add liquidity confirmed");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Burn NFT #/ }).last(),
  ).toBeVisible();
  await page.screenshot({ path: `${shots}/02-liquidity.png`, fullPage: true });
  await page
    .getByRole("button", { name: /Burn NFT #/ })
    .last()
    .click();
  await page
    .getByRole("dialog", { name: "Review position redemption" })
    .getByRole("button", { name: "Confirm redemption", exact: true })
    .click();
  await expectStatus(page, "Redeem position confirmed");
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page
    .getByRole("button", { name: "Pools & tokens", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Browser Test Token");
  await page.getByRole("textbox", { name: "Symbol", exact: true }).fill("BTT");
  await page.getByRole("button", { name: "Deploy ERC20", exact: true }).click();
  await expectStatus(page, "Deploy ERC20 confirmed");
  await page.getByRole("button", { name: "Claim 10,000 BTT" }).click();
  await expectStatus(page, "Claim BTT confirmed");
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
  await page.screenshot({ path: `${shots}/03-pools.png`, fullPage: true });

  // Generate a real market imbalance, then find and execute the route entirely in the UI.
  const signer = await provider.getSigner(0);
  const market = new Contract(
    deployment.exchanges[0].address,
    deployment.abis.MiniDEX,
    signer,
  );
  const p = await market.pools(1);
  const input = new Contract(p.token0, deployment.abis.TestToken, signer);
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
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("button", { name: "Arbitrage", exact: true }).click();
  await page.getByRole("button", { name: "Find profitable route" }).click();
  await expectStatus(page, "Profitable route found", 60_000);
  await page
    .getByRole("button", { name: "Approve & execute atomic arbitrage" })
    .click();
  await expect(page.getByTestId("arbitrage-result")).toContainText(
    "Realized token profit",
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.screenshot({ path: `${shots}/04-arbitrage.png`, fullPage: true });
  await page.getByRole("button", { name: /Transactions/ }).click();
  await expect(
    page.getByRole("cell", { name: "Atomic arbitrage", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `${shots}/05-transactions.png`,
    fullPage: true,
  });
  expect(consoleErrors).toEqual([]);
});
