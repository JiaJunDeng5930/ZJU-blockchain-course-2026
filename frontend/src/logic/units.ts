import "../generated/dex_logic.js";

type UnitsRuntime = {
  compactUnits(value: string, decimals: string, digits: string): string | null;
  approvalNeeded(allowance: string, amount: string): boolean;
  parseUnits(text: string, decimals: string): string | null;
  positiveUnits(text: string, decimals: string): string | null;
  formatUnits(value: string, decimals: string): string | null;
  priceText(
    numerator: string,
    np: string,
    denominator: string,
    dp: string
  ): string | null;
  positiveUnits18(text: string): string | null;
  parseSlippageBps(text: string): string | null;
  formatUnits18(value: string): string;
  minimumReceived(quoted: string, slippage: string): string;
  amountError(
    text: string,
    decimals: string,
    balance: string | null
  ): string | null;
  slippageError(text: string): string | null;
};

declare global {
  var DEXUnits: UnitsRuntime;
}

export const approvalNeeded = (allowance: bigint, amount: bigint): boolean =>
  globalThis.DEXUnits.approvalNeeded(allowance.toString(), amount.toString());

export function positiveAmount(text: string, decimals: number): bigint {
  const value = globalThis.DEXUnits.positiveUnits(text, decimals.toString());
  if (value === null)
    throw new Error(
      globalThis.DEXUnits.amountError(text, decimals.toString(), null)!
    );
  return BigInt(value);
}

export function slippageBps(text: string): bigint {
  const value = globalThis.DEXUnits.parseSlippageBps(text);
  if (value === null) throw new Error(globalThis.DEXUnits.slippageError(text)!);
  return BigInt(value);
}

export function minimumReceived(quoted: bigint, slippage: bigint): bigint {
  return BigInt(
    globalThis.DEXUnits.minimumReceived(quoted.toString(), slippage.toString())
  );
}

export const formatUnits18 = (value: bigint) =>
  globalThis.DEXUnits.formatUnits18(value.toString());
export const amountError = (text: string, decimals: number, balance?: bigint) =>
  globalThis.DEXUnits.amountError(
    text,
    decimals.toString(),
    balance?.toString() ?? null
  ) ?? undefined;
export const toleranceError = (text: string) =>
  globalThis.DEXUnits.slippageError(text) ?? undefined;

export function formatUnits(value: bigint, decimals: number): string {
  const result = globalThis.DEXUnits.formatUnits(
    value.toString(),
    decimals.toString()
  );
  if (result === null) throw new Error("Token precision must be a uint8.");
  return result;
}
export const formatPrice = (
  numerator: bigint,
  np: number,
  denominator: bigint,
  dp: number
) =>
  globalThis.DEXUnits.priceText(
    numerator.toString(),
    np.toString(),
    denominator.toString(),
    dp.toString()
  ) ?? undefined;

export const compactUnits = (
  value: bigint,
  decimals: number,
  digits: number
): string => {
  const text = globalThis.DEXUnits.compactUnits(
    value.toString(),
    decimals.toString(),
    digits.toString()
  );
  if (text === null) throw new Error("Display precision must be a uint8.");
  return text;
};
