From Coq Require Import ZArith String Bool Lia.
From DEXFormal.Spec Require Import Types Units AMM Liquidity.
From DEXFormal.Frontend Require Import LiquidityPolicy.
Open Scope string_scope.
Open Scope Z_scope.

(* Balances are spending limits, not already rounded pool-ratio amounts. *)
Definition balance_deposit r0 r1 total (balance0 balance1 : option Z) tolerance :=
  if total =? 0 then
    DepositRejected "Enter both token amounts to set the starting price."
  else match balance0, balance1 with
  | Some b0, Some b1 =>
    if (b0 =? 0) || (b1 =? 0) then
      DepositRejected "Both token balances must be positive."
    else match slippage_error tolerance, parse_slippage_bps tolerance with
    | Some why, _ => DepositRejected why
    | None, Some slip =>
      match prepare_deposit r0 r1 total b0 b1 b0 b1 slip with
      | Some plan => DepositPrepared plan
      | None => DepositRejected "These balances cannot mint a positive, representable position within the pool capacity."
      end
    | None, None => DepositRejected "Enter valid slippage."
    end
  | _, _ => DepositRejected "Both wallet balances must be available."
  end.

Lemma balance_deposit_checked r0 r1 total balance0 balance1 tolerance plan :
  balance_deposit r0 r1 total balance0 balance1 tolerance = DepositPrepared plan ->
  exists b0 b1 slip,
    balance0 = Some b0 /\ balance1 = Some b1 /\ total <> 0 /\
    prepare_deposit r0 r1 total b0 b1 b0 b1 slip = Some plan.
Proof.
  unfold balance_deposit.
  destruct (total =? 0) eqn:Htotal; [discriminate|].
  destruct balance0 as [b0|], balance1 as [b1|]; try discriminate.
  destruct ((b0 =? 0) || (b1 =? 0)); [discriminate|].
  destruct (slippage_error tolerance); [discriminate|].
  destruct (parse_slippage_bps tolerance) as [slip|]; [|discriminate].
  destruct (prepare_deposit r0 r1 total b0 b1 b0 b1 slip) as [prepared|] eqn:Hplan; [|discriminate].
  intros H. inversion H; subst. exists b0,b1,slip.
  apply Z.eqb_neq in Htotal. auto.
Qed.

Theorem balance_deposit_preserves_limits r0 r1 total b0 b1 tolerance plan :
  balance_deposit r0 r1 total (Some b0) (Some b1) tolerance = DepositPrepared plan ->
  deposit0 plan = b0 /\ deposit1 plan = b1.
Proof.
  intros H. apply balance_deposit_checked in H.
  destruct H as [x [y [slip [Hx [Hy [_ Hplan]]]]]].
  injection Hx as Hx. injection Hy as Hy. subst x y.
  unfold prepare_deposit in Hplan.
  destruct (deposit_amounts r0 r1 total b0 b1).
  destruct (deposit_validb r0 r1 total b0 b1 b0 b1 slip); [|discriminate].
  inversion Hplan; auto.
Qed.

Theorem balance_deposit_within_wallet r0 r1 total b0 b1 tolerance plan :
  balance_deposit r0 r1 total (Some b0) (Some b1) tolerance = DepositPrepared plan ->
  0 < used0 plan <= b0 /\ 0 < used1 plan <= b1 /\
  used0 plan + unused0 plan = b0 /\ used1 plan + unused1 plan = b1 /\
  0 < minted plan.
Proof.
  intros H. apply balance_deposit_checked in H.
  destruct H as [x [y [slip [Hx [Hy [_ Hplan]]]]]].
  injection Hx as Hx. injection Hy as Hy. subst x y.
  apply prepare_deposit_budgets in Hplan. tauto.
Qed.

Theorem balance_deposit_requires_existing_pool r0 r1 total b0 b1 tolerance plan :
  balance_deposit r0 r1 total b0 b1 tolerance = DepositPrepared plan -> total <> 0.
Proof.
  intros H. apply balance_deposit_checked in H.
  destruct H as [x [y [slip [_ [_ [Htotal _]]]]]]. exact Htotal.
Qed.

Theorem balance_deposit_requires_observed_balances r0 r1 total b0 b1 tolerance plan :
  balance_deposit r0 r1 total b0 b1 tolerance = DepositPrepared plan ->
  exists x y, b0 = Some x /\ b1 = Some y.
Proof.
  intros H. apply balance_deposit_checked in H.
  destruct H as [x [y [slip [Hx [Hy _]]]]]. exists x,y. auto.
Qed.

Theorem balance_deposit_empty_pool r0 r1 b0 b1 tolerance :
  balance_deposit r0 r1 0 b0 b1 tolerance =
    DepositRejected "Enter both token amounts to set the starting price.".
Proof. reflexivity. Qed.

Theorem balance_deposit_zero_balance r0 r1 total b0 b1 tolerance plan :
  b0 = 0 \/ b1 = 0 ->
  balance_deposit r0 r1 total (Some b0) (Some b1) tolerance <> DepositPrepared plan.
Proof.
  intros [H|H]; subst; unfold balance_deposit;
    destruct (total =? 0); [discriminate| |discriminate|].
  - discriminate.
  - rewrite Z.eqb_refl, orb_true_r. discriminate.
Qed.
