import { expect, test, type Page } from "@playwright/test";
import {
  openWallet,
  closeWallet,
  goToWorkspace,
  expectStatus,
} from "./navigation";
import { readFileSync } from "node:fs";
import { Contract, JsonRpcProvider, id, parseEther } from "ethers";

const deployment = JSON.parse(
  readFileSync("../shared/deployment.json", "utf8"),
);
const rpc = new JsonRpcProvider(deployment.rpcUrl, deployment.chainId, {
  staticNetwork: true,
  cacheTimeout: -1,
});
const swapSelector = id(
  "swap(uint256,address,uint256,uint256,address,uint256)",
).slice(0, 10);
const approveSelector = id("approve(address,uint256)").slice(0, 10);

type SentTransaction = {
  from: string;
  data: string;
  hash?: string;
  rejected?: boolean;
};
type TestWallet = {
  transactions: SentTransaction[];
  changeAccount(address: string): void;
  changeChain(chainId: string): void;
  rejectSelector: string | null;
  switchAfter: { selector: string; address: string } | null;
};
declare global {
  interface Window {
    testWallet: TestWallet;
  }
}

// This adapter tests EIP-1193 integration against the real local chain. It is not
// a browser-extension wallet or an assertion about any extension's confirmation UI.
async function installWallet(page: Page, address: string) {
  await page.addInitScript(
    ({ rpcUrl, address, chainId }) => {
      const listeners = new Map<string, Set<(value: unknown) => void>>();
      let currentAddress = address;
      let currentChain = `0x${chainId.toString(16)}`;
      let requestId = 0;
      const emit = (event: string, value: unknown) => {
        for (const listener of listeners.get(event) ?? []) listener(value);
      };
      const controls: TestWallet = {
        transactions: [],
        rejectSelector: null,
        switchAfter: null,
        changeAccount(nextAddress) {
          currentAddress = nextAddress;
          emit("accountsChanged", [nextAddress]);
        },
        changeChain(nextChain) {
          currentChain = nextChain;
          emit("chainChanged", nextChain);
        },
      };
      const wallet = {
        on(event: string, listener: (value: unknown) => void) {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)!.add(listener);
          return wallet;
        },
        removeListener(event: string, listener: (value: unknown) => void) {
          listeners.get(event)?.delete(listener);
          return wallet;
        },
        async request({
          method,
          params = [],
        }: {
          method: string;
          params?: unknown[];
        }) {
          if (method === "eth_requestAccounts" || method === "eth_accounts")
            return [currentAddress];
          if (method === "eth_chainId") return currentChain;
          if (method === "net_version") return String(Number(currentChain));
          if (method === "wallet_switchEthereumChain") {
            controls.changeChain((params[0] as { chainId: string }).chainId);
            return null;
          }
          let transaction: SentTransaction | undefined;
          if (method === "eth_sendTransaction") {
            const input = params[0] as { from: string; data?: string };
            transaction = { from: input.from, data: input.data ?? "0x" };
            controls.transactions.push(transaction);
            if (
              controls.rejectSelector &&
              transaction.data.startsWith(controls.rejectSelector)
            ) {
              controls.rejectSelector = null;
              transaction.rejected = true;
              throw Object.assign(new Error("User rejected the request."), {
                code: 4001,
              });
            }
          }
          const response = await fetch(rpcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: ++requestId,
              method,
              params,
            }),
          });
          const result = await response.json();
          if (result.error)
            throw Object.assign(new Error(result.error.message), result.error);
          if (transaction) {
            transaction.hash = result.result;
            if (
              controls.switchAfter &&
              transaction.data.startsWith(controls.switchAfter.selector)
            ) {
              const next = controls.switchAfter.address;
              controls.switchAfter = null;
              controls.changeAccount(next);
            }
          }
          return result.result;
        },
      };
      Object.defineProperty(window, "ethereum", {
        value: wallet,
        configurable: true,
      });
      window.testWallet = controls;
    },
    { rpcUrl: deployment.rpcUrl, address, chainId: deployment.chainId },
  );
}

async function ready(page: Page, accountIndex = 17) {
  const signer = await rpc.getSigner(accountIndex);
  const address = await signer.getAddress();
  await installWallet(page, address);
  await page.goto("/");
  await openWallet(page);
  await expect(
    page.getByRole("button", { name: "Connect browser wallet" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Connect browser wallet" }).click();
  await expectAccount(page, address);
  await closeWallet(page);
  return { signer, address };
}

async function expectAccount(page: Page, address: string) {
  await expect(page.getByLabel("Connected account").first()).toHaveAttribute(
    "title",
    address,
  );
}

function marketContracts() {
  const market = new Contract(
    deployment.exchanges[0].address,
    deployment.abis.MiniDEX,
    rpc,
  );
  return { market };
}

async function sent(page: Page) {
  return page.evaluate(() => window.testWallet.transactions);
}

async function submitSwap(page: Page, amount: string) {
  await page.getByLabel("Swap amount").fill(amount);
  const button = page
    .getByRole("form", { name: "Swap tokens", exact: true })
    .getByRole("button", { name: "Swap", exact: true });
  await expect(button).toBeEnabled();
  await button.click();
}

test("invalid swap amounts never request a signature or send a transaction", async ({
  page,
}) => {
  const { address } = await ready(page);
  const before = await rpc.getTransactionCount(address, "latest");
  const amount = page.getByLabel("Swap amount");
  const submit = page
    .getByRole("form", { name: "Swap tokens", exact: true })
    .locator('button[type="submit"]');
  await amount.fill("1");
  await expect(submit).toBeEnabled();
  for (const invalid of ["", "0", "-1", "0.0000000000000000001"]) {
    await amount.fill(invalid);
    await expect(submit).toBeDisabled();
  }
  expect(await sent(page)).toEqual([]);
  expect(await rpc.getTransactionCount(address, "latest")).toBe(before);
});

test("account-change events update the visible owner and subsequent real transaction sender", async ({
  page,
}) => {
  await ready(page, 17);
  const next = await rpc.getSigner(18);
  const address = await next.getAddress();
  const token = new Contract(
    deployment.tokens[0].address,
    deployment.abis.TestToken,
    rpc,
  );
  const balanceBefore: bigint = await token.balanceOf(address);
  await page.evaluate(
    (address) => window.testWallet.changeAccount(address),
    address,
  );
  await expectAccount(page, address);
  await openWallet(page);
  await page
    .getByRole("button", {
      name: `Claim 10,000 ${deployment.tokens[0].symbol}`,
      exact: true,
    })
    .click();
  await expect
    .poll(async () => await token.balanceOf(address))
    .toBe(balanceBefore + parseEther("10000"));
  await expect
    .poll(async () => (await sent(page)).filter((tx) => tx.hash).length)
    .toBe(1);
  const [transaction] = await sent(page);
  expect(transaction.from.toLowerCase()).toBe(address.toLowerCase());
  expect(
    (await rpc.getTransaction(transaction.hash!))!.from.toLowerCase(),
  ).toBe(address.toLowerCase());
});

test("an unsupported wallet network blocks signing and switching back restores the session", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { address } = await ready(page, 18);
  await page.getByLabel("Swap amount").fill("1");
  await expect(
    page
      .getByRole("form", { name: "Swap tokens", exact: true })
      .locator('button[type="submit"]'),
  ).toBeEnabled();
  await page.evaluate(() => window.testWallet.changeChain("0x1"));
  const walletButton = page.getByRole("button", {
    name: "Open wallet",
    exact: true,
  });
  await expect(walletButton).toContainText("Wrong network");
  await expect(walletButton).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("form", { name: "Swap tokens", exact: true })
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  await openWallet(page);
  await expect(page.getByRole("alert")).toContainText(/chain|network/i);
  const recovery = page.getByRole("button", {
    name: "Add / switch local network",
    exact: true,
  });
  await recovery.scrollIntoViewIfNeeded();
  await expect(recovery).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(await sent(page)).toEqual([]);
  await recovery.click();
  await expectAccount(page, address);
  await closeWallet(page);
  await page.getByLabel("Swap amount").fill("1");
  await expect(
    page
      .getByRole("form", { name: "Swap tokens", exact: true })
      .locator('button[type="submit"]'),
  ).toBeEnabled();
  const token = new Contract(
    deployment.tokens[0].address,
    deployment.abis.TestToken,
    rpc,
  );
  const before: bigint = await token.balanceOf(address);
  await openWallet(page);
  await page
    .getByRole("button", {
      name: `Claim 10,000 ${deployment.tokens[0].symbol}`,
      exact: true,
    })
    .click();
  await expect
    .poll(async () => await token.balanceOf(address))
    .toBe(before + parseEther("10000"));
});

test("a rejected swap preserves its confirmed approval and can be retried without another approval", async ({
  page,
}) => {
  const { signer, address } = await ready(page, 19);
  const { market } = marketContracts();
  const pool = await market.pools(1);
  const input = new Contract(pool.token0, deployment.abis.TestToken, signer);
  await (await input.approve(market.target, 0)).wait();
  const amount = parseEther("7.125");
  const balanceBefore: bigint = await input.balanceOf(address);
  const reservesBefore = [pool.reserve0, pool.reserve1];
  await page.evaluate((selector) => {
    window.testWallet.rejectSelector = selector;
  }, swapSelector);
  await submitSwap(page, "7.125");
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /Operation stopped:.*reject|cancel/i }),
  ).toBeVisible();
  expect(await input.allowance(address, market.target)).toBeGreaterThanOrEqual(
    amount,
  );
  expect(await input.balanceOf(address)).toBe(balanceBefore);
  const unchanged = await market.pools(1);
  expect([unchanged.reserve0, unchanged.reserve1]).toEqual(reservesBefore);
  const attempts = await sent(page);
  expect(attempts.filter((tx) => tx.hash)).toHaveLength(1);
  expect(attempts.filter((tx) => tx.rejected)).toHaveLength(1);
  await goToWorkspace(page, "Transactions");
  await expect(
    page.getByRole("row").filter({ hasText: "Approve ERC20" }),
  ).toContainText(/confirm/i);
  await goToWorkspace(page, "Swap");
  await submitSwap(page, "7.125");
  await expect
    .poll(async () => await input.balanceOf(address))
    .toBe(balanceBefore - amount);
  const approvals = (await sent(page)).filter((tx) =>
    tx.data.startsWith(approveSelector),
  );
  expect(approvals).toHaveLength(1);
});

test("changing account during approval never executes the swap with the previous signer", async ({
  page,
}) => {
  const { signer, address } = await ready(page, 17);
  const nextAddress = await (await rpc.getSigner(18)).getAddress();
  const { market } = marketContracts();
  const pool = await market.pools(1);
  const input = new Contract(pool.token0, deployment.abis.TestToken, signer);
  await (await input.approve(market.target, 0)).wait();
  const before: bigint = await input.balanceOf(address);
  await page.evaluate(
    ({ selector, address }) => {
      window.testWallet.switchAfter = { selector, address };
    },
    { selector: approveSelector, address: nextAddress },
  );
  await submitSwap(page, "9.25");
  await expectAccount(page, nextAddress);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /Operation stopped:.*account|wallet|session/i }),
  ).toBeVisible();
  const attempts = await sent(page);
  expect(attempts.filter((tx) => tx.data.startsWith(swapSelector))).toEqual([]);
  expect(await input.balanceOf(address)).toBe(before);
  expect(await input.allowance(address, market.target)).toBeGreaterThanOrEqual(
    parseEther("9.25"),
  );
});

test("a confirmed transaction stays confirmed when the following balance refresh fails", async ({
  page,
}) => {
  const { address } = await ready(page, 18);
  const token = new Contract(
    deployment.tokens[0].address,
    deployment.abis.TestToken,
    rpc,
  );
  const before: bigint = await token.balanceOf(address);
  let readOutage = false;
  await page.route(`${new URL(deployment.rpcUrl).origin}/**`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const payload = route.request().postDataJSON() as
      { id: number; method: string } | { id: number; method: string }[];
    const requests = Array.isArray(payload) ? payload : [payload];
    const response = await route.fetch();
    if (requests.some((item) => item.method === "eth_sendTransaction"))
      readOutage = true;
    if (
      !readOutage ||
      !requests.some(
        (item) =>
          item.method === "eth_call" || item.method === "eth_getBalance",
      )
    )
      return route.fulfill({ response });
    const upstream = await response.json();
    const entries = Array.isArray(upstream) ? upstream : [upstream];
    const values = entries.map((entry: { id: number }) => {
      const request = requests.find((item) => item.id === entry.id);
      return request && ["eth_call", "eth_getBalance"].includes(request.method)
        ? {
            jsonrpc: "2.0",
            id: entry.id,
            error: {
              code: -32000,
              message: "Read outage after transaction confirmation",
            },
          }
        : entry;
    });
    await route.fulfill({
      response,
      json: Array.isArray(payload) ? values : values[0],
    });
  });
  await openWallet(page);
  await page
    .getByRole("button", {
      name: `Claim 10,000 ${deployment.tokens[0].symbol}`,
      exact: true,
    })
    .click();
  await expect
    .poll(async () => await token.balanceOf(address))
    .toBe(before + parseEther("10000"));
  await goToWorkspace(page, "Transactions");
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: `Claim ${deployment.tokens[0].symbol}` }),
  ).toContainText(/confirm/i);
  const [transaction] = await sent(page);
  expect((await rpc.getTransactionReceipt(transaction.hash!))?.status).toBe(1);
});
