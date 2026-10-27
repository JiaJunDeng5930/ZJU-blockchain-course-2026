import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { Contract, JsonRpcProvider } from "ethers";
import {
  closeWallet,
  expectStatus,
  goToWorkspace,
  openWallet,
  selectLocalAccount,
} from "./navigation";

const deployment = JSON.parse(
  readFileSync("../shared/deployment.json", "utf8"),
);
const provider = new JsonRpcProvider(deployment.rpcUrl, deployment.chainId, {
  cacheTimeout: -1,
});

test("another browser can recognize and trade a newly created shared market", async ({
  browser,
}) => {
  const creatorContext = await browser.newContext();
  const traderContext = await browser.newContext();
  const creator = await creatorContext.newPage();
  const trader = await traderContext.newPage();
  const symbol = `SHR${Date.now().toString().slice(-6)}`;
  try {
    await creator.goto("/");
    await trader.goto("/");
    await selectLocalAccount(creator, 8);
    const traderAddress = await selectLocalAccount(trader, 9);
    await trader.getByLabel("Swap amount").fill("10");
    await goToWorkspace(creator, "Pools & tokens");
    await creator
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Shared market token");
    await creator
      .getByRole("textbox", { name: "Symbol", exact: true })
      .fill(symbol);
    await creator
      .getByRole("button", { name: "Deploy ERC20", exact: true })
      .click();
    await expectStatus(creator, "Deploy ERC20 confirmed");
    await openWallet(creator);
    await creator
      .getByRole("button", { name: `Claim 10,000 ${symbol}`, exact: true })
      .click();
    await expectStatus(creator, `Claim ${symbol} confirmed`);
    await closeWallet(creator);
    const token = await creator
      .getByLabel("Second token")
      .locator("option")
      .filter({ hasText: symbol })
      .getAttribute("value");
    expect(token).toBeTruthy();
    await creator.getByLabel("Second token").selectOption(token!);
    await creator
      .getByRole("button", { name: "Create pool", exact: true })
      .click();
    await expectStatus(creator, "Create pool confirmed");
    await goToWorkspace(creator, "Liquidity");
    await creator
      .getByRole("button", { name: "New position", exact: true })
      .click();
    const supply = creator.getByRole("dialog", {
      name: "New liquidity position",
      exact: true,
    });
    const newPool = await supply
      .getByRole("combobox")
      .locator("option")
      .filter({ hasText: symbol })
      .getAttribute("value");
    await supply.getByRole("combobox").selectOption(newPool!);
    await supply.getByLabel("Liquidity token 0").fill("1000");
    await supply.getByLabel("Liquidity token 1").fill("1000");
    await supply
      .getByRole("button", { name: "Review position", exact: true })
      .click();
    await creator
      .getByRole("dialog", { name: "Review new position", exact: true })
      .getByRole("button", { name: "Approve & mint position NFT", exact: true })
      .click();
    await expectStatus(creator, "Add liquidity confirmed");

    await expect(
      trader
        .getByLabel("Active pool")
        .locator("option")
        .filter({ hasText: symbol }),
    ).toHaveCount(1, { timeout: 8000 });
    await expect(trader.getByLabel("Swap amount")).toHaveValue("10");
    await trader.getByLabel("Active pool").selectOption(newPool!);
    await trader
      .getByLabel("Pay token")
      .selectOption(
        deployment.tokens.find(
          (candidate: { symbol: string }) => candidate.symbol === "TKA",
        ).address,
      );
    const contract = new Contract(token!, deployment.abis.TestToken, provider);
    const before = await contract.balanceOf(traderAddress);
    await trader.getByLabel("Swap amount").fill("10");
    await trader
      .getByRole("form", { name: "Swap tokens", exact: true })
      .getByRole("button", { name: "Swap", exact: true })
      .click();
    await expectStatus(trader, "Swap tokens confirmed");
    await expect
      .poll(() => contract.balanceOf(traderAddress))
      .toBeGreaterThan(before);
    await openWallet(trader);
    await expect(
      trader.getByRole("dialog", {
        name: "Wallet and test assets",
        exact: true,
      }),
    ).toContainText(symbol);
    await expect(
      trader.getByRole("button", {
        name: `Claim 10,000 ${symbol}`,
        exact: true,
      }),
    ).toHaveCount(0);
    await creator.reload();
    await openWallet(creator);
    await expect(
      creator.getByRole("button", {
        name: `Claim 10,000 ${symbol}`,
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    await creatorContext.close();
    await traderContext.close();
  }
});
