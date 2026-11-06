import { expect, test, type Page } from "@playwright/test";
import {
  openWallet,
  closeWallet,
  selectLocalAccount,
  goToWorkspace,
  expectStatus,
} from "./navigation";
import { readFileSync } from "node:fs";
import { Contract, JsonRpcProvider, Wallet } from "ethers";

const deployment = JSON.parse(
  readFileSync("../shared/deployment.json", "utf8"),
);
const rpc = new JsonRpcProvider(deployment.rpcUrl, deployment.chainId, {
  cacheTimeout: -1,
});

type SetupWallet = {
  requests: { method: string; params: unknown[] }[];
  rejectNetworkChange: boolean;
  rejectConnection: boolean;
};
declare global {
  interface Window {
    setupWallet: SetupWallet;
  }
}

// This EIP-1193 adapter sends transactions to the actual local chain. It verifies
// the dapp's onboarding sequence, not a third-party extension's confirmation UI.
async function installNewWallet(page: Page, address: string) {
  await page.addInitScript(
    ({ address, rpcUrl }) => {
      const listeners = new Map<string, Set<(value: unknown) => void>>();
      let chain = "0x1";
      const networks = new Set([chain]);
      let requestId = 0;
      const state: SetupWallet = {
        requests: [],
        rejectNetworkChange: true,
        rejectConnection: false,
      };
      window.setupWallet = state;
      const emit = (event: string, value: unknown) => {
        for (const listener of listeners.get(event) ?? []) listener(value);
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
          state.requests.push({ method, params });
          if (method === "eth_requestAccounts") {
            if (state.rejectConnection) {
              state.rejectConnection = false;
              throw Object.assign(new Error("User rejected connection"), {
                code: 4001,
              });
            }
            return [address];
          }
          if (method === "eth_accounts") return [address];
          if (method === "eth_chainId") return chain;
          if (method === "net_version") return String(Number(chain));
          if (method === "wallet_switchEthereumChain") {
            if (state.rejectNetworkChange) {
              state.rejectNetworkChange = false;
              throw Object.assign(new Error("User rejected network change"), {
                code: 4001,
              });
            }
            const target = (params[0] as { chainId: string }).chainId;
            if (!networks.has(target))
              throw Object.assign(new Error("Unknown chain"), { code: 4902 });
            chain = target;
            emit("chainChanged", chain);
            return null;
          }
          if (method === "wallet_addEthereumChain") {
            networks.add((params[0] as { chainId: string }).chainId);
            return null;
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
          return result.result;
        },
      };
      Object.defineProperty(window, "ethereum", {
        value: wallet,
        configurable: true,
      });
    },
    { address, rpcUrl: deployment.rpcUrl },
  );
}

test("a new zero-asset wallet can add the local network, recover from rejection and fund its first trade", async ({
  page,
}, testInfo) => {
  const address = Wallet.createRandom().address;
  await rpc.send("hardhat_impersonateAccount", [address]);
  try {
    await installNewWallet(page, address);
    await page.goto("/");
    await openWallet(page);
    await expect(page.getByLabel("Test account")).toBeVisible();
    await expect(page.getByLabel("Connected account").first()).toHaveAttribute(
      "title",
      new RegExp(`^${(await rpc.send("eth_accounts", []))[0]}$`, "i"),
    );
    await page
      .getByRole("button", { name: "Connect browser wallet", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText("Wrong wallet network");
    await page
      .getByRole("button", { name: "Add / switch local network" })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      "Network change rejected",
    );
    await page
      .getByRole("button", { name: "Add / switch local network" })
      .click();
    await expect(page.getByLabel("Connected account").first()).toHaveAttribute(
      "title",
      address,
    );
    await openWallet(page);
    await expect(
      page.getByRole("button", { name: "Prepare test assets", exact: true }),
    ).toBeVisible();
    expect(await rpc.getBalance(address)).toBe(0n);
    await page
      .getByRole("button", { name: "Prepare test assets", exact: true })
      .click();
    await expectStatus(page, "confirmed");
    expect(await rpc.getBalance(address)).toBeGreaterThan(0n);
    for (const token of deployment.tokens.filter(
      (token: { kind: string }) => token.kind === "faucet",
    )) {
      const asset = new Contract(
        token.address,
        ["function balanceOf(address) view returns (uint256)"],
        rpc,
      );
      await expect
        .poll(async () => await asset.balanceOf(address))
        .toBeGreaterThan(0n);
    }
    const requests = await page.evaluate(() => window.setupWallet.requests);
    const add = requests.find(
      (request) => request.method === "wallet_addEthereumChain",
    );
    expect(add?.params[0]).toMatchObject({
      chainId: `0x${deployment.chainId.toString(16)}`,
      rpcUrls: [deployment.rpcUrl],
      nativeCurrency: { symbol: "ETH", decimals: 18 },
    });
    await closeWallet(page);
    await page.getByLabel("Swap amount").fill("10");
    await expect(
      page
        .getByRole("form", { name: "Swap tokens", exact: true })
        .getByRole("button", { name: "Review swap", exact: true }),
    ).toBeEnabled();
    await page
      .getByRole("form", { name: "Swap tokens", exact: true })
      .getByRole("button", { name: "Review swap", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Review swap", exact: true })
      .getByRole("button", { name: "Confirm swap", exact: true })
      .click();
    await expectStatus(page, "Swap tokens confirmed");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await openWallet(page);
    await expect(
      page.getByRole("dialog", { name: "Wallet and test assets" }),
    ).toContainText("9,990");
    await page.screenshot({
      path: testInfo.outputPath("06-first-wallet.png"),
      fullPage: true,
    });
  } finally {
    await rpc.send("hardhat_stopImpersonatingAccount", [address]);
  }
});

test("a declined browser connection can be retried or replaced with a local demo account", async ({
  page,
}) => {
  const address = (await rpc.send("eth_accounts", []))[3] as string;
  await installNewWallet(page, address);
  await page.goto("/");
  await openWallet(page);
  await expect(page.getByLabel("Test account")).toBeVisible();
  await page.evaluate(() => {
    window.setupWallet.rejectConnection = true;
  });
  await page
    .getByRole("button", { name: "Connect browser wallet", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("rejected");
  await selectLocalAccount(page, 1);
  await openWallet(page);
  await expect(page.getByLabel("Test account")).toBeVisible();
  await expect(page.getByLabel("Connected account").first()).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Connect browser wallet", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Wrong wallet network");
});
