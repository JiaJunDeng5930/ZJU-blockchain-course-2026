import "../generated/dex_logic.js";

declare global {
  var DEXWrappingSettlement: { summarize: (input: string) => string };
}

export function wrappingSettlement(amount: bigint, withdraw: boolean, gasCostWei: bigint) {
  const value = JSON.parse(globalThis.DEXWrappingSettlement.summarize(JSON.stringify({
    amount: amount.toString(),
    withdraw,
    gasCostWei: gasCostWei.toString(),
  }))) as { nativeChangeWei: string; wrappedChange: string };
  return {
    nativeChangeWei: BigInt(value.nativeChangeWei),
    wrappedChange: BigInt(value.wrappedChange),
  };
}
