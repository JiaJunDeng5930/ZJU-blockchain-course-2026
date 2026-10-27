From Coq Require Import ZArith.
Open Scope Z_scope.

(* RPC receipt fields describe execution already included in a block. This fee
   excludes separate approval receipts and carries no ERC20 exchange rate. *)
Definition execution_fee (gas_used effective_gas_price : Z) : Z :=
  gas_used * effective_gas_price.

Theorem execution_fee_nonnegative gas_used effective_gas_price :
  0 <= gas_used -> 0 <= effective_gas_price ->
  0 <= execution_fee gas_used effective_gas_price.
Proof. unfold execution_fee. apply Z.mul_nonneg_nonneg. Qed.
