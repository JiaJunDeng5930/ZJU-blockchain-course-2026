import type { ReactNode } from "react";
import { positiveAmount, slippageBps } from "../chain/amounts";
import { useDex } from "../chain/DexProvider";

export function AmountField({
  label,
  value,
  onChange,
  name = label,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  name?: string;
}) {
  return (
    <label>
      {label}
      <input
        aria-label={name}
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
      />
    </label>
  );
}
export function TokenSelect({
  label,
  value,
  onChange,
  addresses,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  addresses?: string[];
}) {
  const { tokens, symbol } = useDex();
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {(addresses ?? tokens.map((token) => token.address)).map((address) => (
          <option key={address} value={address}>
            {symbol(address)}
          </option>
        ))}
      </select>
    </label>
  );
}
export function SubmitButton({
  children,
  disabled = false,
}: {
  children: ReactNode;
  disabled?: boolean;
}) {
  const { pending, session } = useDex();
  return (
    <button type="submit" disabled={pending || !session || disabled}>
      {pending ? "Waiting for confirmation…" : children}
    </button>
  );
}
export function amountError(
  value: string,
  balance?: bigint,
): string | undefined {
  try {
    const amount = positiveAmount(value);
    return balance !== undefined && amount > balance
      ? "Insufficient balance for this amount."
      : undefined;
  } catch (error) {
    return (error as Error).message;
  }
}
export function toleranceError(value: string): string | undefined {
  try {
    slippageBps(value);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}
export function FormError({ message }: { message: string | undefined }) {
  return message ? (
    <p role="alert" className="form-error">
      {message}
    </p>
  ) : null;
}
