import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { Contract, JsonRpcProvider, parseEther } from "ethers";
import { expectStatus } from "./navigation";

const deployment = JSON.parse(
  readFileSync("../shared/deployment.json", "utf8"),
);
const rpc = new JsonRpcProvider(deployment.rpcUrl, deployment.chainId, {
  staticNetwork: true,
  cacheTimeout: -1,
});

test("the compact swap stays usable on narrow screens and executes the selected direction", async ({
  page,
}) => {
  await page.setViewportSize({ width: 581, height: 588 });
  await page.goto("/");
  const form = page.getByRole("form", { name: "Swap tokens", exact: true });
  const amount = form.getByLabel("Swap amount", { exact: true });
  await expect(amount).toBeEnabled();
  await expect(amount).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Claim 10,000", exact: false }),
  ).toHaveCount(0);
  const initialAction = form.getByRole("button", {
    name: "Enter amount",
    exact: true,
  });
  const actionBox = await initialAction.boundingBox();
  expect(actionBox).not.toBeNull();
  expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(588);
  const amountBox = await amount.boundingBox();
  expect(amountBox!.y).toBeLessThan(350);

  const pay = form.getByLabel("Pay token", { exact: true });
  const receive = form.getByLabel("Receive token", { exact: true });
  const initialPay = await pay.inputValue();
  const initialReceive = await receive.inputValue();
  await form.getByRole("button", { name: "Reverse swap direction" }).click();
  await expect(pay).toHaveValue(initialReceive);
  await expect(receive).toHaveValue(initialPay);

  await form.getByRole("button", { name: "Settings", exact: true }).click();
  await form.getByLabel("Slippage", { exact: true }).fill("0.75");
  await expect(form.getByLabel("Slippage", { exact: true })).toHaveValue(
    "0.75",
  );
  await form.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(form.getByLabel("Slippage", { exact: true })).toBeHidden();

  await amount.fill("10");
  const market = form.getByLabel("Active pool", { exact: true });
  const otherMarket = await market
    .locator("option")
    .filter({ hasText: deployment.exchanges[1].name })
    .first()
    .getAttribute("value");
  expect(otherMarket).toBeTruthy();
  await market.selectOption(otherMarket!);
  await expect(amount).toHaveValue("10");
  await expect(pay).toHaveValue(initialReceive);

  await page.setViewportSize({ width: 390, height: 844 });
  const readyAction = form.getByRole("button", { name: "Swap", exact: true });
  await expect(readyAction).toBeEnabled();
  const narrowAction = await readyAction.boundingBox();
  expect(narrowAction!.y + narrowAction!.height).toBeLessThanOrEqual(844);
  const account = await page
    .getByLabel("Connected account", { exact: true })
    .first()
    .getAttribute("title");
  expect(account).toBeTruthy();
  const tokenIn = new Contract(initialReceive, deployment.abis.TestToken, rpc);
  const tokenOut = new Contract(initialPay, deployment.abis.TestToken, rpc);
  const beforeIn: bigint = await tokenIn.balanceOf(account);
  const beforeOut: bigint = await tokenOut.balanceOf(account);
  await form.getByRole("button", { name: "Max", exact: true }).click();
  expect(parseEther(await amount.inputValue())).toEqual(beforeIn);
  await amount.fill("10");
  await expect(
    form.getByRole("button", { name: "Swap", exact: true }),
  ).toBeEnabled();
  await page.screenshot({ path: "/tmp/dex-trade-mobile.png", fullPage: true });
  await form.getByRole("button", { name: "Swap", exact: true }).click();
  await expectStatus(page, "Swap tokens confirmed", 30_000);
  expect(await tokenIn.balanceOf(account)).toEqual(beforeIn - parseEther("10"));
  expect(await tokenOut.balanceOf(account)).toBeGreaterThan(beforeOut);
});
