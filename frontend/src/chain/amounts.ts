import { formatUnits18 } from "../logic/units";
export { positiveAmount, slippageBps, minimumReceived } from "../logic/units";
export { depositAmounts } from "../logic/liquidity";
import type { Pool } from "./types";
export const sameAddress = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();
export const poolKey = (pool: Pool) => `${pool.exchange.address}:${pool.id}`;
export const shorten = (value: string) =>
  `${value.slice(0, 6)}…${value.slice(-4)}`;
export const formatAmount = (value: bigint, digits = 5) => {
  const [whole, fraction = ""] = formatUnits18(value).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const visible = fraction.slice(0, digits).replace(/0+$/, "");
  return visible ? `${grouped}.${visible}` : grouped;
};
export const reservePrice = (pool: Pool) =>
  pool.reserve0 === 0n
    ? undefined
    : Number(pool.reserve1) / Number(pool.reserve0);
export function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    if ("reason" in error && typeof error.reason === "string")
      return error.reason;
    if ("shortMessage" in error && typeof error.shortMessage === "string")
      return error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}
