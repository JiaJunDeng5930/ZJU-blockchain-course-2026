import { formatUnits, parseUnits } from "ethers";
import type { Pool } from "./types";
export const sameAddress = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();
export const poolKey = (pool: Pool) => `${pool.exchange.address}:${pool.id}`;
export const shorten = (value: string) =>
  `${value.slice(0, 6)}…${value.slice(-4)}`;
export const formatAmount = (value: bigint, digits = 5) =>
  Number(formatUnits(value, 18)).toLocaleString("en-US", {
    maximumFractionDigits: digits,
  });
export const reservePrice = (pool: Pool) =>
  pool.reserve0 === 0n
    ? undefined
    : Number(pool.reserve1) / Number(pool.reserve0);
export function positiveAmount(value: string): bigint {
  if (!/^(?:\d+)(?:\.\d{0,18})?$/.test(value.trim()))
    throw new Error("Enter a positive amount with at most 18 decimal places.");
  const amount = parseUnits(value.trim(), 18);
  if (amount <= 0n) throw new Error("Amount must be greater than zero.");
  return amount;
}
export function slippageBps(value: string): bigint {
  if (!/^\d+(?:\.\d{0,2})?$/.test(value) || Number(value) > 50)
    throw new Error(
      "Slippage must be between 0% and 50%, with at most two decimal places.",
    );
  return BigInt(Math.round(Number(value) * 100));
}
export const minimumReceived = (amount: bigint, slippage: bigint) =>
  (amount * (10000n - slippage)) / 10000n;
export function depositAmounts(pool: Pool, amount0: bigint, amount1: bigint) {
  if (pool.totalShares === 0n) return [amount0, amount1] as const;
  const required1 = (amount0 * pool.reserve1) / pool.reserve0;
  return required1 <= amount1
    ? ([amount0, required1] as const)
    : ([(amount1 * pool.reserve0) / pool.reserve1, amount1] as const);
}
export function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    if (
      "code" in error &&
      (error.code === 4001 || error.code === "ACTION_REJECTED")
    )
      return "Wallet request rejected. No transaction was submitted for this step.";
    if ("reason" in error && typeof error.reason === "string")
      return error.reason;
    if ("shortMessage" in error && typeof error.shortMessage === "string")
      return error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}
