import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { JsonRpcProvider } from "ethers";
import { openWallet, closeWallet, selectLocalAccount } from "./navigation";

const deployment = JSON.parse(
  readFileSync("../shared/deployment.json", "utf8"),
);
const rpc = new JsonRpcProvider(deployment.rpcUrl, deployment.chainId, {
  staticNetwork: true,
  cacheTimeout: -1,
});

async function installWallet(page: Page, address: string) {
  await page.addInitScript(
    ({ rpcUrl, chainId, address }) => {
      const listeners = new Map<string, Set<(value: unknown) => void>>();
      let id = 0;
      const emit = (event: string, value: unknown) => {
        for (const listener of listeners.get(event) ?? []) listener(value);
      };
      const controls = {
        requests: [] as string[],
        transactions: [] as string[],
        lock() {
          localStorage.setItem("continuity-test-locked", "yes");
          emit("accountsChanged", []);
        },
        wrongNetwork() {
          localStorage.setItem("continuity-test-chain", "0x1");
          emit("chainChanged", "0x1");
        },
        restore() {
          localStorage.removeItem("continuity-test-locked");
          localStorage.removeItem("continuity-test-chain");
          emit("chainChanged", `0x${chainId.toString(16)}`);
          emit("accountsChanged", [address]);
        },
      };
      Object.defineProperty(window, "ethereum", {
        configurable: true,
        value: {
          on(event: string, listener: (value: unknown) => void) {
            const group = listeners.get(event) ?? new Set();
            group.add(listener);
            listeners.set(event, group);
          },
          removeListener(event: string, listener: (value: unknown) => void) {
            listeners.get(event)?.delete(listener);
          },
          async request({
            method,
            params = [],
          }: {
            method: string;
            params?: unknown[];
          }) {
            controls.requests.push(method);
            if (method === "eth_accounts")
              return localStorage.getItem("continuity-test-locked")
                ? []
                : [address];
            if (method === "eth_requestAccounts") {
              localStorage.removeItem("continuity-test-locked");
              return [address];
            }
            if (method === "eth_chainId")
              return (
                localStorage.getItem("continuity-test-chain") ??
                `0x${chainId.toString(16)}`
              );
            const response = await fetch(rpcUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: ++id,
                method,
                params,
              }),
            });
            const body = await response.json();
            if (body.error)
              throw Object.assign(new Error(body.error.message), body.error);
            if (method === "eth_sendTransaction")
              controls.transactions.push(body.result);
            return body.result;
          },
        },
      });
      Object.defineProperty(window, "continuityWallet", { value: controls });
    },
    { rpcUrl: deployment.rpcUrl, chainId: deployment.chainId, address },
  );
}
async function browserAccount(page: Page, address: string) {
  await installWallet(page, address);
  await page.goto("/");
  const wallet = await openWallet(page);
  await wallet
    .getByRole("button", { name: "Connect browser wallet", exact: true })
    .click();
  await expect(page.getByLabel("Connected account").first()).toHaveAttribute(
    "title",
    address,
  );
  await closeWallet(page);
}
async function requests(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      (window as unknown as { continuityWallet: { requests: string[] } })
        .continuityWallet.requests,
  );
}

test("refresh preserves a browser wallet without another authorization request", async ({
  page,
}) => {
  const address = await (await rpc.getSigner(14)).getAddress();
  await browserAccount(page, address);
  await page.reload();
  await expect(page.getByLabel("Connected account").first()).toHaveAttribute(
    "title",
    address,
  );
  await expect.poll(() => requests(page)).toContain("eth_accounts");
  expect(await requests(page)).not.toContain("eth_requestAccounts");
  const wallet = await openWallet(page);
  await wallet
    .getByRole("button", { name: "Claim 10,000 TKA", exact: true })
    .click();
  const transactions = () =>
    page.evaluate(
      () =>
        (window as unknown as { continuityWallet: { transactions: string[] } })
          .continuityWallet.transactions,
    );
  await expect.poll(transactions).toHaveLength(1);
  const receipt = await rpc.waitForTransaction((await transactions())[0]);
  expect(receipt?.from.toLowerCase()).toBe(address.toLowerCase());
});

test("refresh preserves the selected demo identity", async ({ page }) => {
  await page.goto("/");
  const address = await selectLocalAccount(page, 12);
  await page.reload();
  await expect(page.getByLabel("Connected account").first()).toHaveAttribute(
    "title",
    new RegExp(`^${address}$`, "i"),
  );
});

test("locked or wrong-network browser wallets stay in browser mode across refresh", async ({
  page,
}) => {
  const address = await (await rpc.getSigner(15)).getAddress();
  await browserAccount(page, address);
  await page.evaluate(() =>
    (
      window as unknown as { continuityWallet: { lock(): void } }
    ).continuityWallet.lock(),
  );
  await page.reload();
  const locked = await openWallet(page);
  await expect(locked.getByRole("alert")).toContainText(
    /disconnect|connect|unlock/i,
  );
  await expect(locked.getByLabel("Test account")).toHaveCount(0);
  expect(await requests(page)).not.toContain("eth_requestAccounts");
  await page.evaluate(() =>
    (
      window as unknown as { continuityWallet: { restore(): void } }
    ).continuityWallet.restore(),
  );
  await expect(page.getByLabel("Connected account").first()).toHaveAttribute(
    "title",
    address,
  );
  await page.evaluate(() =>
    (
      window as unknown as { continuityWallet: { wrongNetwork(): void } }
    ).continuityWallet.wrongNetwork(),
  );
  await page.reload();
  const wrong = await openWallet(page);
  await expect(wrong.getByRole("alert")).toContainText(/network/i);
  await expect(wrong.getByLabel("Test account")).toHaveCount(0);
  expect(await requests(page)).not.toContain("eth_requestAccounts");
  await page.evaluate(() =>
    (
      window as unknown as { continuityWallet: { restore(): void } }
    ).continuityWallet.restore(),
  );
  await expect(page.getByLabel("Connected account").first()).toHaveAttribute(
    "title",
    address,
  );
  await closeWallet(page);
  const demo = await selectLocalAccount(page, 10);
  await page.reload();
  await expect(page.getByLabel("Connected account").first()).toHaveAttribute(
    "title",
    new RegExp(`^${demo}$`, "i"),
  );
  expect(await requests(page)).not.toContain("eth_requestAccounts");
});
