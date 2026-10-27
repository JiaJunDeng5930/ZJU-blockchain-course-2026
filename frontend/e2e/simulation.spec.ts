import { expect, test } from "@playwright/test";
import { goToWorkspace } from "./navigation";
import { readFile } from "node:fs/promises";

const origin = "http://127.0.0.1:3000";
const endpoint = `${origin}/api/simulation`;
test("a presenter can run, inspect, download and safely stop the market simulation from the website", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await goToWorkspace(page, "Simulation");
  await expect(
    page.getByRole("heading", { name: "20-account market simulation" }),
  ).toBeVisible();
  await page.getByLabel("Simulation rounds").fill("20");
  await page.getByLabel("Simulation duration").fill("0");
  await page.getByLabel("Simulation interval").fill("100");
  await page
    .getByRole("button", { name: "Start simulation", exact: true })
    .click();
  await expect(
    page.getByRole("status", { name: "Simulation status" }),
  ).toContainText(/Starting|Running/);
  const duplicate = await request.post(`${endpoint}/start`, {
    headers: { origin },
    data: { rounds: 20, seed: 2026, durationSeconds: 0, intervalMs: 0 },
  });
  expect(duplicate.status()).toBe(409);
  await expect(
    page.getByRole("status", { name: "Simulation status" }),
  ).toContainText("Completed", { timeout: 60_000 });
  await expect(page.getByLabel("Simulation metrics")).toContainText("20 / 20");
  await expect(
    page.getByRole("heading", { name: "Live markets", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Verified: reserves and token balances unchanged", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Price history for the two exchanges" }),
  ).toBeVisible();
  await page.reload();
  await goToWorkspace(page, "Simulation");
  await expect(
    page.getByRole("img", { name: "Price history for the two exchanges" }),
  ).toBeVisible();
  await expect(page.getByLabel("Simulation metrics")).toContainText("20 / 20");
  await page
    .locator(".balances")
    .first()
    .locator("strong")
    .first()
    .filter({ hasText: /\d/ })
    .waitFor();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download complete report" }).click();
  const download = await downloadEvent;
  await download.saveAs("/tmp/dex-web-simulation-report.json");
  const report = JSON.parse(
    await readFile("/tmp/dex-web-simulation-report.json", "utf8"),
  );
  expect(report.status).toBe("completed");
  expect(report.activeAccounts).toBe(20);
  expect(report.counts.swap).toBeGreaterThan(0);
  expect(report.counts.addLiquidity).toBeGreaterThan(0);
  expect(report.counts.addLiquidity).toBe(report.counts.removeLiquidity);
  expect(report.counts.arbitrage).toBeGreaterThan(0);
  expect(report.rollback.status).toBe(0);
  expect(report.rollback.reservesAndTokenBalancesUnchanged).toBe(true);
  await page.screenshot({
    path: "../docs/screenshots/06-simulation.png",
    fullPage: true,
  });

  await page.getByLabel("Simulation rounds").fill("1000");
  await page.getByLabel("Simulation duration").fill("60");
  await page.getByLabel("Simulation interval").fill("500");
  await page
    .getByRole("button", { name: "Start simulation", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await (await request.get(endpoint)).json()).progress?.counts
          .addLiquidity ?? 0,
    )
    .toBeGreaterThan(0);
  await page
    .getByRole("button", { name: "Stop simulation", exact: true })
    .click();
  await expect(
    page.getByRole("status", { name: "Simulation status" }),
  ).toContainText("Stopped by user", { timeout: 30_000 });
  await expect(
    page.getByText(
      "The run was stopped safely. Confirmed transactions remain on chain; this is a partial run.",
    ),
  ).toBeVisible();
  const stopped = await (await request.get(`${endpoint}/report`)).json();
  expect(stopped.status).toBe("stopped");
  expect(stopped.completedRounds).toBeLessThan(1000);
  expect(stopped.counts.addLiquidity).toBe(stopped.counts.removeLiquidity);
  expect(stopped.rollback.reservesAndTokenBalancesUnchanged).toBe(true);

  const crossSite = await request.post(`${endpoint}/start`, {
    headers: { origin: "https://unrelated.example" },
    data: { rounds: 20, seed: 1, durationSeconds: 0, intervalMs: 0 },
  });
  expect(crossSite.status()).toBe(403);
  const invalid = await request.post(`${endpoint}/start`, {
    headers: { origin },
    data: { rounds: 1, seed: 1, durationSeconds: 0, intervalMs: 0 },
  });
  expect(invalid.status()).toBe(400);
  expect((await (await request.get(endpoint)).json()).state).toBe("stopped");
});
