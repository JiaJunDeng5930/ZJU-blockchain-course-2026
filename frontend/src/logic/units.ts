import "../generated/dex_logic.js";

type UnitsRuntime = {
  approvalNeeded(allowance: string, amount: string): boolean;
  parseUnits18(text: string): string | null;
  positiveUnits18(text: string): string | null;
  parseSlippageBps(text: string): string | null;
  formatUnits18(value: string): string;
  minimumReceived(quoted: string, slippage: string): string;
  amountError(text: string, balance: string | null): string | null;
  slippageError(text: string): string | null;
};

declare global {
  var DEXUnits: UnitsRuntime;
}

export const approvalNeeded = (allowance: bigint, amount: bigint): boolean =>
  globalThis.DEXUnits.approvalNeeded(allowance.toString(), amount.toString());

export function positiveAmount(text: string): bigint {
  const value = globalThis.DEXUnits.positiveUnits18(text);
  if (value === null)
    throw new Error(globalThis.DEXUnits.amountError(text, null)!);
  return BigInt(value);
}

export function slippageBps(text: string): bigint {
  const value = globalThis.DEXUnits.parseSlippageBps(text);
  if (value === null) throw new Error(globalThis.DEXUnits.slippageError(text)!);
  return BigInt(value);
}

export function minimumReceived(quoted: bigint, slippage: bigint): bigint {
  return BigInt(
    globalThis.DEXUnits.minimumReceived(quoted.toString(), slippage.toString()),
  );
}

export const formatUnits18 = (value: bigint) =>
  globalThis.DEXUnits.formatUnits18(value.toString());
export const amountError = (text: string, balance?: bigint) =>
  globalThis.DEXUnits.amountError(text, balance?.toString() ?? null) ??
  undefined;
export const toleranceError = (text: string) =>
  globalThis.DEXUnits.slippageError(text) ?? undefined;
