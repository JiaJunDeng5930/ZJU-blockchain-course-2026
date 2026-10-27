import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  WalletKernel, accepted, type KernelReply, type JournalView,
} from "../src/wallet/kernel";
import { activityStep, activityView, initialActivityQuery } from "../src/logic/activity";

const root = fileURLToPath(new URL("../../", import.meta.url));
const bundle = resolve(root, "frontend/src/generated/dex_logic.js");
const fingerprint = async () => createHash("sha256").update(await readFile(bundle)).digest("hex");
const sha256 = await fingerprint();
await mkdir(resolve(root, ".local"), { recursive: true });
const directory = await mkdtemp(resolve(root, ".local/activity-public-"));
const evidence: { scenario: string; outcome: string }[] = [];
const alice = "0x52908400098527886E0F7030069857D2E4169EE7";
const bob = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const faucet = "0xde709f2102306220921060314715629080e2fb77";
const nobody = "0x0000000000000000000000000000000000000001";
let hashCounter = 0;
let pageCounter = 0;
const transactions = new Map<string, string>();
function instance() { return `6a0936a7-b56e-4412-a5bd-${String(++pageCounter).padStart(12, "0")}`; }
function observe(kernel: WalletKernel, reply: KernelReply, account: string) {
  const effect = reply.effects.find((entry) => entry.kind === "observe");
  assert.ok(effect && effect.kind === "observe");
  kernel.dispatch({ kind: "observed", request: effect.request, accounts: [account], chain: "31337" });
}
function createKernel(account = alice) {
  const owner = instance();
  const kernel = new WalletKernel({ chain: "31337", source: "local", address: account, instance: owner });
  observe(kernel, kernel.start(), account);
  kernel.dispatch({ kind: "history-load-failed", key: "public-activity-acceptance", message: "No persistent storage in this public API fixture" });
  return kernel;
}
function selectAccount(kernel: WalletKernel, account: string) {
  observe(kernel, kernel.dispatch({ kind: "select-local", address: account }), account);
}
function record(
  kernel: WalletKernel, label: string, account: string,
  state: JournalView["state"], beneficiary = account,
  authority: JournalView["authority"] = "wallet",
) {
  selectAccount(kernel, beneficiary);
  const wallet = kernel.getSnapshot().wallet;
  assert.equal(wallet.kind, "ready");
  if (wallet.kind !== "ready") throw new Error("Fixture wallet must be ready");
  const operation = accepted(kernel.dispatch<string>({ kind: "begin-operation", identity: wallet.identity, label }));
  const transaction = accepted(kernel.dispatch<string>({
    kind: "request-write", operation, label,
    authority: authority === "dev-faucet" ? { kind: "dev-faucet", sender: account } : null,
  }));
  const hash = `0x${(++hashCounter).toString(16).padStart(64, "0")}`;
  if (state === "failed" && label === "A28") {
    kernel.dispatch({ kind: "preflight-failed", transaction, message: "Insufficient balance" });
  } else if (state !== "awaiting-wallet") {
    accepted(kernel.dispatch({ kind: "authorize", operation, transaction, accounts: [beneficiary], chain: "31337" }));
    if (state === "submission-unknown") {
      kernel.dispatch({ kind: "signature-failed", transaction, code: null, message: "Transport closed without a transaction hash" });
    } else {
      kernel.dispatch({ kind: "broadcast", transaction, hash });
      if (state === "confirmed" || state === "failed") {
        kernel.dispatch({ kind: "receipt", transaction, hash, sender: account,
          status: state === "confirmed" ? "success" : "reverted", block: "17", gasUsed: "21000", gasPrice: "2000000000" });
      }
    }
  }
  if (state === "submitted") {
    kernel.dispatch({ kind: "receipt-unavailable", transaction, message: "Receipt observation reached its time limit" });
  }
  if (state !== "awaiting-wallet") {
    kernel.dispatch({ kind: "finish-operation", operation,
      error: state === "confirmed" ? null : "Operation did not produce a successful receipt" });
  }
  const entry = kernel.getSnapshot().journal.find((entry) => entry.label === label);
  assert.ok(entry, `Public wallet must expose ${label}`);
  assert.equal(entry.state, state, `Fixture ${label} must reach its requested external state`);
  transactions.set(entry.id, transaction);
  return entry;
}
const names = (prefix: string, start: number, end: number) =>
  Array.from({ length: end - start + 1 }, (_, i) => `${prefix}${String(start + i).padStart(2, "0")}`);
const kernel = createKernel();
for (const label of names("A", 1, 25)) record(kernel, label, alice, "confirmed");
record(kernel, "A26", alice, "submitted");
record(kernel, "A27", alice, "submitted");
record(kernel, "A28", alice, "failed");
record(kernel, "A29", alice, "failed");
record(kernel, "A30", alice, "submission-unknown");
record(kernel, "F01", faucet, "confirmed", alice, "dev-faucet");
for (const label of names("B", 1, 12)) record(kernel, label, bob, "confirmed");
record(kernel, "B13", bob, "submitted");
record(kernel, "F02", alice, "confirmed", bob, "dev-faucet");
selectAccount(kernel, alice);
const context = { kernel };
type Page = ReturnType<typeof activityView>;
const labels = (page: Page) => page.entries.map((entry) => entry.label);
async function scenario(name: string, run: () => void | Promise<void>) {
  await run();
  evidence.push({ scenario: name, outcome: "passed" });
}
try {
  await scenario("All activity is reachable in canonical order without overlapping pages", () => {
    const original = JSON.stringify(kernel.getSnapshot());
    let notifications = 0;
    const unsubscribe = kernel.subscribe(() => { notifications++; });
    const first = activityView(context, initialActivityQuery());
    assert.equal(first.total, "45");
    assert.equal(first.filteredTotal, "45");
    assert.equal(first.page, "1");
    assert.equal(first.pages, "3");
    assert.equal(first.canPrevious, false);
    assert.equal(first.canNext, true);
    assert.equal(first.entries.length, 20);
    const second = activityStep(context, first.query, { kind: "next" });
    assert.equal(second.page, "2");
    assert.equal(second.entries.length, 20);
    const third = activityStep(context, second.query, { kind: "next" });
    assert.equal(third.entries.length, 5);
    assert.deepEqual([...labels(first), ...labels(second), ...labels(third)], kernel.getSnapshot().journal.map((entry) => entry.label));
    assert.equal(third.canNext, false);
    assert.equal(third.canPrevious, true);
    assert.deepEqual(activityStep(context, third.query, { kind: "next" }), third);
    assert.deepEqual(activityStep(context, second.query, { kind: "previous" }), first);
    assert.deepEqual(activityStep(context, first.query, { kind: "previous" }), first);
    assert.equal(JSON.stringify(kernel.getSnapshot()), original, "Projection must not change transactions, history, or wallet authority");
    assert.equal(notifications, 0, "Read-only navigation must not emit wallet state changes");
    unsubscribe();
  });
  await scenario("Status groups distinguish confirmation, failed execution, and unknown submission", () => {
    for (const [status, expected] of [
      ["pending", ["A26", "A27", "B13"]], ["failed", ["A28", "A29"]], ["unknown", ["A30"]],
    ] as const) {
      const view = activityStep(context, initialActivityQuery(), { kind: "status", value: status });
      assert.deepEqual(labels(view).sort(), [...expected].sort());
      assert.equal(view.filteredTotal, String(expected.length));
      assert.equal(view.page, "1");
      assert.equal(view.canNext, false);
      assert.equal(view.total, "45");
    }
    const confirmed = activityStep(context, initialActivityQuery(), { kind: "status", value: "confirmed" });
    assert.equal(confirmed.filteredTotal, "39");
    assert.deepEqual([...labels(confirmed), ...labels(activityStep(context, confirmed.query, { kind: "next" }))].sort(),
      [...names("A", 1, 25), "F01", ...names("B", 1, 12), "F02"].sort());
  });
  await scenario("Current-account activity includes both funding sender and recipient", () => {
    const selected = activityStep(context, initialActivityQuery(), { kind: "account", value: "current" });
    const second = activityStep(context, selected.query, { kind: "next" });
    assert.equal(selected.filteredTotal, "32");
    const all = [...labels(selected), ...labels(second)];
    assert.deepEqual([...all].sort(), [...names("A", 1, 30), "F01", "F02"].sort());
    selectAccount(kernel, alice);
    const lower = activityView(context, second.query);
    assert.equal(lower.page, "2", "Reobserving the same canonical account must not count as switching accounts");
    assert.deepEqual(labels(lower), labels(second));
    assert.equal(lower.filteredTotal, selected.filteredTotal);
    const alicePending = activityStep(context, second.query, { kind: "status", value: "pending" });
    assert.equal(alicePending.page, "1");
    assert.deepEqual(labels(alicePending).sort(), ["A26", "A27"]);
  });
  await scenario("An outstanding wallet request belongs to the pending status group", () => {
    const signing = createKernel();
    record(signing, "W01", alice, "awaiting-wallet");
    const pending = activityStep({ kernel: signing }, initialActivityQuery(), { kind: "status", value: "pending" });
    assert.deepEqual(labels(pending), ["W01"]);
    assert.equal(signing.getSnapshot().pending, true);
    assert.equal(pending.filteredTotal, "1");
  });
  await scenario("Wallet changes reset navigation and disconnect never retains a previous account", () => {
    const first = activityStep(context, initialActivityQuery(), { kind: "account", value: "current" });
    const second = activityStep(context, first.query, { kind: "next" });
    assert.equal(second.page, "2");
    selectAccount(kernel, bob);
    const switched = activityView(context, second.query);
    assert.equal(switched.page, "1");
    assert.equal(switched.filteredTotal, "14");
    assert.deepEqual(labels(switched).sort(), [...names("B", 1, 13), "F02"].sort());
    kernel.dispatch({ kind: "disconnect" });
    const disconnected = activityView(context, switched.query);
    assert.equal(disconnected.canCurrentAccount, false);
    assert.equal(disconnected.filteredTotal, "0");
    assert.equal(disconnected.entries.length, 0);
    assert.equal(disconnected.pages, "0");
    assert.ok(disconnected.emptyMessage);
    selectAccount(kernel, alice);
  });
  await scenario("Empty filters can be reset to the complete activity", () => {
    selectAccount(kernel, nobody);
    const selected = activityStep(context, initialActivityQuery(), { kind: "account", value: "current" });
    assert.equal(selected.filteredTotal, "0");
    assert.equal(selected.entries.length, 0);
    assert.equal(selected.pages, "0");
    assert.equal(selected.canNext, false);
    assert.equal(selected.canPrevious, false);
    assert.ok(selected.emptyMessage);
    const reset = activityStep(context, selected.query, { kind: "reset" });
    assert.equal(reset.query.account, "all");
    assert.equal(reset.query.status, "all");
    assert.equal(reset.page, "1");
    assert.equal(reset.filteredTotal, "45");
    assert.equal(reset.entries.length, 20);
    const empty = activityView({ kernel: createKernel() }, initialActivityQuery());
    assert.equal(empty.total, "0");
    assert.equal(empty.pages, "0");
    assert.ok(empty.emptyMessage);
    selectAccount(kernel, alice);
  });
  await scenario("Receipt observations preserve a valid selected page and clamp only when it vanishes", () => {
    const first = activityView(context, initialActivityQuery());
    const second = activityStep(context, first.query, { kind: "next" });
    const submitted = kernel.getSnapshot().journal.find((entry) => entry.label === "A27");
    assert.ok(submitted && submitted.state === "submitted");
    kernel.dispatch({ kind: "receipt", transaction: transactions.get(submitted.id)!, hash: submitted.hash,
      sender: alice, status: "success", block: "18", gasUsed: "21000", gasPrice: "2000000000" });
    const observed = activityView(context, second.query);
    assert.equal(observed.page, "2");
    assert.deepEqual(labels(observed), labels(second));
    const waiting = createKernel();
    const rows = names("P", 1, 41).map((label) => record(waiting, label, alice, "submitted"));
    const pendingContext = { kernel: waiting };
    const pending = activityStep(pendingContext, initialActivityQuery(), { kind: "status", value: "pending" });
    const middle = activityStep(pendingContext, pending.query, { kind: "next" });
    const last = activityStep(pendingContext, middle.query, { kind: "next" });
    assert.equal(last.entries.length, 1);
    const survivor = last.entries[0].label;
    for (const entry of rows) {
      if (entry.label !== survivor) {
        assert.equal(entry.state, "submitted");
        if (entry.state !== "submitted") throw new Error("Fixture must contain submitted transactions");
        waiting.dispatch({ kind: "receipt", transaction: transactions.get(entry.id)!, hash: entry.hash,
          sender: alice, status: "success", block: "19", gasUsed: "21000", gasPrice: "2000000000" });
      }
    }
    const remaining = activityView(pendingContext, last.query);
    assert.equal(remaining.page, "1");
    assert.equal(remaining.pages, "1");
    assert.equal(remaining.filteredTotal, "1");
    assert.deepEqual(labels(remaining), [survivor]);
  });
  await scenario("Stored records from another page remain navigable without restoring authority", () => {
    const saved = kernel.dispatch({ kind: "history-retry-save" });
    const write = saved.effects.find((effect) => effect.kind === "save-history");
    assert.ok(write && write.kind === "save-history");
    kernel.dispatch({ kind: "history-saved" });
    const restored = createKernel(alice);
    restored.dispatch({ kind: "history-retry-load" });
    const owner = kernel.getSnapshot().journal[0].instance;
    restored.dispatch({ kind: "history-loaded", key: "public-activity-acceptance", snapshots: [{ owner, archive: write.archive }] });
    const restoredContext = { kernel: restored };
    const first = activityView(restoredContext, initialActivityQuery());
    const middle = activityStep(restoredContext, first.query, { kind: "next" });
    const last = activityStep(restoredContext, middle.query, { kind: "next" });
    assert.equal(first.total, "45");
    assert.deepEqual([...labels(first), ...labels(middle), ...labels(last)], kernel.getSnapshot().journal.map((entry) => entry.label));
    assert.equal(restored.getSnapshot().pending, false);
    const current = activityStep(restoredContext, first.query, { kind: "account", value: "current" });
    assert.equal(current.filteredTotal, "32");
    selectAccount(restored, bob);
    const switched = activityView(restoredContext, current.query);
    assert.equal(switched.page, "1");
    assert.equal(switched.filteredTotal, "14");
    assert.deepEqual(labels(switched).sort(), [...names("B", 1, 13), "F02"].sort());
  });
  assert.equal(await fingerprint(), sha256, "The extracted program changed during acceptance");
  const result = { status: "passed", bundleSha256: sha256, scenarios: evidence, sourceRecords: 45 };
  const path = resolve(directory, "result.json");
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: "passed", evidence: path, scenarios: evidence.length })}\n`);
} catch (error) {
  await writeFile(resolve(directory, "result.json"), `${JSON.stringify({ status: "failed", bundleSha256: sha256,
    scenarios: evidence, error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) }, null, 2)}\n`);
  throw error;
}
