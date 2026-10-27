import "../generated/dex_logic.js";
import type { Token } from "../chain/types";

export type WrappingEnvironment = {
  connected: boolean;
  pending: boolean;
  token: string | null;
  native: bigint | null;
  wrapped: bigint | null;
};
type EncodedRequest = {
  token: string;
  withdraw: boolean;
  amount: string;
  gas: string;
  feePerGas: string;
};
export type WrappingRequest = Omit<EncodedRequest, "amount" | "gas" | "feePerGas"> & {
  amount: bigint;
  gas: bigint;
  feePerGas: bigint;
};
type Decision =
  | { kind: "rejected"; error: string }
  | { kind: "prepared"; request: EncodedRequest };
export type WrappingView = {
  value: string;
  inputError: string | null;
  wrap: Decision;
  unwrap: Decision;
};
type RawController = {
  view(environment: string): string;
  edit(text: string, environment: string): string;
  submit(withdraw: boolean, environment: string): string;
};
type WrappingRuntime = {
  create(): RawController;
  selectWrapped(tokens: string): string | null;
  requiredWrapped(tokens: string): string;
  plan(environment: string, amount: string, gas: string, fee: string, withdraw: boolean): string;
};
declare global { var DEXWrapping: WrappingRuntime; }

const encodeEnvironment = (environment: WrappingEnvironment) => JSON.stringify({
  ...environment,
  native: environment.native?.toString() ?? null,
  wrapped: environment.wrapped?.toString() ?? null,
});
const decodeRequest = (request: EncodedRequest): WrappingRequest => ({
  ...request,
  amount: BigInt(request.amount),
  gas: BigInt(request.gas),
  feePerGas: BigInt(request.feePerGas),
});
export const selectWrappedAddress = (tokens: Token[]): string | null =>
  globalThis.DEXWrapping.selectWrapped(JSON.stringify(tokens));

export function prepareWrapping(
  environment: WrappingEnvironment,
  amount: bigint,
  withdraw: boolean,
  gas = 0n,
  feePerGas = 0n,
): WrappingRequest {
  const result: Decision = JSON.parse(globalThis.DEXWrapping.plan(
    encodeEnvironment(environment), amount.toString(), gas.toString(), feePerGas.toString(), withdraw,
  ));
  if (result.kind === "rejected") throw new Error(result.error);
  return decodeRequest(result.request);
}

export class WrappingController {
  private readonly kernel = globalThis.DEXWrapping.create();
  view(environment: WrappingEnvironment): WrappingView {
    return JSON.parse(this.kernel.view(encodeEnvironment(environment)));
  }
  edit(text: string, environment: WrappingEnvironment): void {
    this.kernel.edit(text, encodeEnvironment(environment));
  }
  submit(withdraw: boolean, environment: WrappingEnvironment): WrappingRequest | null {
    const request: EncodedRequest | null = JSON.parse(this.kernel.submit(withdraw, encodeEnvironment(environment)));
    return request === null ? null : decodeRequest(request);
  }
}

export function requireWrappedAddress(tokens: Token[]): string {
  const result: { kind: "found"; token: string } | { kind: "missing"; error: string } =
    JSON.parse(globalThis.DEXWrapping.requiredWrapped(JSON.stringify(tokens)));
  if (result.kind === "missing") throw new Error(result.error);
  return result.token;
}
