import { compactUnits } from "../logic/units";
export { positiveAmount, slippageBps, minimumReceived } from "../logic/units";
export { depositAmounts } from "../logic/liquidity";
import type { Pool, Token } from "./types";
export const sameAddress = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();
export const poolKey = (pool: Pool) => `${pool.exchange.address}:${pool.id}`;
export const shorten = (value: string) =>
  `${value.slice(0, 6)}…${value.slice(-4)}`;
export const tokenDecimals = (
  tokens: readonly Token[],
  address: string
): number => {
  const token = tokens.find((item) => sameAddress(item.address, address));
  if (!token) throw new Error("Token metadata has not been verified.");
  return token.decimals;
};
export { formatPrice } from "../logic/units";
export const formatAmount = (value: bigint, decimals: number, digits = 5) => {
  const text = compactUnits(value, decimals, digits);
  const [whole, fraction] = text.split(".");
  return (
    whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
    (fraction ? `.${fraction}` : "")
  );
};
export const reservePrice = (pool: Pool, tokens: readonly Token[]) => {
  const first = tokens.find((token) => sameAddress(token.address, pool.token0));
  const second = tokens.find((token) =>
    sameAddress(token.address, pool.token1)
  );
  if (!first || !second || pool.reserve0 === 0n) return undefined;
  return (
    (Number(pool.reserve1) / Number(pool.reserve0)) *
    10 ** (first.decimals - second.decimals)
  );
};
export function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    if ("reason" in error && typeof error.reason === "string")
      return error.reason;
    if ("shortMessage" in error && typeof error.shortMessage === "string")
      return error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}
