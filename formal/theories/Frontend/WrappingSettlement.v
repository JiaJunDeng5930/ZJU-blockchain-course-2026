From Coq Require Import ZArith Lia.
Local Open Scope Z_scope.

Record settlement := Settlement {
  native_change_wei : Z;
  wrapped_change : Z
}.

(* The principal is the observed mint/burn amount of the known 1:1 wrapper.
   Receipt fees change native ETH only, never the WETH principal. *)
Definition summarize (amount : Z) (withdraw : bool) (fee : Z) :=
  if withdraw then Settlement (amount - fee) (-amount)
  else Settlement (-amount - fee) amount.

Theorem settlement_preserves_wrapped_principal amount withdraw fee :
  0 <= amount -> Z.abs (wrapped_change (summarize amount withdraw fee)) = amount.
Proof.
  intros Hamount. destruct withdraw; cbn.
  - rewrite Z.abs_opp, Z.abs_eq by assumption. reflexivity.
  - apply Z.abs_eq. assumption.
Qed.

Theorem settlement_accounts_for_execution_fee amount withdraw fee :
  let result := summarize amount withdraw fee in
  native_change_wei result + wrapped_change result = -fee.
Proof. destruct withdraw; cbn; lia. Qed.
