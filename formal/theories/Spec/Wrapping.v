From Coq Require Import ZArith String List Bool Lia.
From DEXFormal.Spec Require Import Types.
Open Scope string_scope.
Open Scope Z_scope.

(* ETH principal movements exclude the transaction fee, which is separately bounded. *)
Record wrap_balances := { native_balance : Z; wrapped_balance : Z }.
Definition wrapping_balances_valid s :=
  uint256 (native_balance s) /\ uint256 (wrapped_balance s).
Definition wrapping_effect (withdraw : bool) (value : Z) (before : wrap_balances)
  : wrap_balances :=
  if withdraw then
    {| native_balance := native_balance before + value;
       wrapped_balance := wrapped_balance before - value |}
  else
    {| native_balance := native_balance before - value;
       wrapped_balance := wrapped_balance before + value |}.
Theorem wrapping_principal_conserved withdraw value before :
  native_balance (wrapping_effect withdraw value before) +
  wrapped_balance (wrapping_effect withdraw value before) =
  native_balance before + wrapped_balance before.
Proof. destruct withdraw; cbn; lia. Qed.

Record wrapping_request := {
  wrapping_token : address;
  wrapping_withdraw : bool;
  wrapping_amount : Z;
  wrapping_gas : Z;
  wrapping_fee_per_gas : Z
}.
Definition wrapping_fee request := wrapping_gas request * wrapping_fee_per_gas request.
Definition wrapping_value request := if wrapping_withdraw request then 0 else wrapping_amount request.
Definition wrapping_call request : contract_call :=
  if wrapping_withdraw request then UnwrapEther (wrapping_token request) (wrapping_amount request)
  else WrapEther (wrapping_token request) (wrapping_amount request).
Definition wrapping_valid request before : Prop :=
  0 < wrapping_amount request /\ uint256 (wrapping_amount request) /\
  wrapping_balances_valid before /\
  uint256 (wrapping_gas request) /\ uint256 (wrapping_fee_per_gas request) /\
  uint256 (wrapping_fee request) /\
  wrapping_value request + wrapping_fee request <= native_balance before /\
  (if wrapping_withdraw request
   then wrapping_amount request <= wrapped_balance before /\
        native_balance before + wrapping_amount request <= uint256_max
   else wrapped_balance before + wrapping_amount request <= uint256_max).
Definition wrapping_validb request before : bool :=
  (0 <? wrapping_amount request) && uint256b (wrapping_amount request) &&
  uint256b (native_balance before) && uint256b (wrapped_balance before) &&
  uint256b (wrapping_gas request) && uint256b (wrapping_fee_per_gas request) &&
  uint256b (wrapping_fee request) &&
  (wrapping_value request + wrapping_fee request <=? native_balance before) &&
  (if wrapping_withdraw request then
     (wrapping_amount request <=? wrapped_balance before) &&
     (native_balance before + wrapping_amount request <=? uint256_max)
   else (wrapped_balance before + wrapping_amount request <=? uint256_max)).
Theorem wrapping_validb_spec request before :
  wrapping_validb request before = true <-> wrapping_valid request before.
Proof.
  unfold wrapping_validb, wrapping_valid, wrapping_balances_valid.
  destruct (wrapping_withdraw request); rewrite !andb_true_iff, ?Z.ltb_lt,
    ?Z.leb_le, ?uint256b_spec; tauto.
Qed.
Theorem wrapping_effect_valid request before :
  wrapping_valid request before ->
  wrapping_balances_valid (wrapping_effect (wrapping_withdraw request) (wrapping_amount request) before).
Proof.
  unfold wrapping_valid, wrapping_balances_valid, wrapping_effect, wrapping_value,
    wrapping_fee, uint256.
  destruct (wrapping_withdraw request); cbn; intros H; repeat split; nia.
Qed.
Theorem wrapping_covers_gas request before :
  wrapping_valid request before ->
  wrapping_fee request <= native_balance before /\
  wrapping_value request + wrapping_fee request <= native_balance before.
Proof.
  unfold wrapping_valid, wrapping_value, uint256.
  destruct (wrapping_withdraw request); cbn; intros H; split; lia.
Qed.

Fixpoint select_wrapped (tokens : list (address * string)) : option address :=
  match tokens with
  | nil => None
  | (token, kind) :: rest =>
      if String.eqb kind "wrapped" then Some token else select_wrapped rest
  end.
Theorem select_wrapped_declared tokens token :
  select_wrapped tokens = Some token -> In (token, "wrapped") tokens.
Proof.
  induction tokens as [|[current kind] rest IH]; cbn; try discriminate.
  destruct (String.eqb kind "wrapped") eqn:Hkind.
  - apply String.eqb_eq in Hkind. subst kind. intro H. inversion H. now left.
  - intro H. right. now apply IH.
Qed.

Record weth_backing := {
  weth_reserve : Z;
  weth_supply : Z;
  weth_holder : Z
}.
Definition weth_backed state : Prop :=
  0 <= weth_holder state /\ weth_holder state <= weth_supply state /\
  weth_supply state <= weth_reserve state /\ weth_reserve state <= uint256_max.
Definition deposit_backing value state :=
  {| weth_reserve := weth_reserve state + value;
     weth_supply := weth_supply state + value;
     weth_holder := weth_holder state + value |}.
Definition burn_backing value state :=
  {| weth_reserve := weth_reserve state;
     weth_supply := weth_supply state - value;
     weth_holder := weth_holder state - value |}.
Definition withdraw_backing value state :=
  {| weth_reserve := weth_reserve state - value;
     weth_supply := weth_supply state - value;
     weth_holder := weth_holder state - value |}.
Theorem deposit_preserves_backing state value :
  weth_backed state -> 0 <= value -> weth_reserve state + value <= uint256_max ->
  weth_backed (deposit_backing value state).
Proof. unfold weth_backed, deposit_backing; cbn; intros; lia. Qed.
Theorem burn_preserves_backing state value :
  weth_backed state -> 0 <= value <= weth_holder state ->
  weth_backed (burn_backing value state).
Proof. unfold weth_backed, burn_backing; cbn; intros; lia. Qed.
Theorem withdraw_preserves_backing state value :
  weth_backed state -> 0 <= value <= weth_holder state ->
  weth_backed (withdraw_backing value state).
Proof. unfold weth_backed, withdraw_backing; cbn; intros; lia. Qed.
(* Failed native delivery rolls back the entire abstract transaction. This states
   the required external EVM contract; it is not an EVM semantics proof. *)
Definition settle_withdrawal (delivery_succeeded : bool) (value : Z) (state : weth_backing) :=
  if delivery_succeeded then withdraw_backing value state else state.
Theorem rejected_delivery_keeps_backing state value :
  settle_withdrawal false value state = state.
Proof. reflexivity. Qed.
Theorem backing_allows_forced_ether state donation :
  weth_backed state -> 0 <= donation -> weth_reserve state + donation <= uint256_max ->
  weth_backed {| weth_reserve := weth_reserve state + donation;
                 weth_supply := weth_supply state; weth_holder := weth_holder state |}.
Proof. unfold weth_backed; cbn; intros; lia. Qed.
