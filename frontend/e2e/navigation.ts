import { expect, type Page } from "@playwright/test";

export type Workspace =
  | "Swap"
  | "Liquidity"
  | "Pools & tokens"
  | "Arbitrage"
  | "Simulation"
  | "Transactions";

export const walletDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Wallet and test assets", exact: true });

export async function openWallet(page: Page) {
  const dialog = walletDialog(page);
  if (!(await dialog.isVisible()))
    await page
      .getByRole("button", { name: "Open wallet", exact: true })
      .click();
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function closeWallet(page: Page) {
  const dialog = walletDialog(page);
  if (await dialog.isVisible())
    await dialog
      .getByRole("button", { name: "Close wallet", exact: true })
      .click();
  await expect(dialog).toBeHidden();
}

// Numeric selection uses the same zero-based order as eth_accounts.
export async function selectLocalAccount(page: Page, account: number | string) {
  const dialog = await openWallet(page);
  const selector = dialog.getByLabel("Test account");
  if (!(await selector.isVisible())) {
    await dialog
      .getByRole("button", { name: "Demo wallet", exact: true })
      .click();
  }
  await expect(selector).toBeEnabled();
  const address =
    typeof account === "number"
      ? await selector
          .locator("option")
          .nth(account + 1)
          .getAttribute("value")
      : account;
  if (!address)
    throw new Error(
      `Test account ${account} is missing from the local wallet selector`,
    );
  await selector.selectOption(address.toLowerCase());
  await expect(page.getByLabel("Connected account").first()).toHaveAttribute(
    "title",
    new RegExp(`^${address}$`, "i"),
  );
  await closeWallet(page);
  return address;
}

export async function goToWorkspace(page: Page, workspace: Workspace) {
  await closeWallet(page);
  if (workspace === "Swap" || workspace === "Liquidity") {
    await page.getByRole("button", { name: workspace, exact: true }).click();
  } else {
    await page.getByRole("button", { name: "Tools", exact: true }).click();
    await page.getByRole("menuitem", { name: workspace, exact: true }).click();
  }
}

export async function expectStatus(
  page: Page,
  text: string | RegExp,
  timeout = 5000,
) {
  const dialog = walletDialog(page);
  const scope = (await dialog.isVisible()) ? dialog : page;
  await expect(
    scope.getByRole("status").filter({ hasText: text }).first(),
  ).toBeVisible({ timeout });
}
