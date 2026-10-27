From Coq Require Import ZArith Bool Lia.
From DEXFormal.Frontend Require Import Wallet.
Import Wallet.
Local Open Scope Z_scope.

Record confirmation := Confirmation {
  confirmation_identity : identity;
  confirmation_block : Z
}.

Definition record_confirmation (s : state) who block previous :=
  if permits s who then
    Some (Confirmation who
      (match previous with
       | Some prior => if permits s (confirmation_identity prior)
           then Z.max block (confirmation_block prior) else block
       | None => block
       end))
  else previous.

Definition awaiting_confirmation (s : state) block latest :=
  match latest with
  | Some confirmed => permits s (confirmation_identity confirmed) &&
      (block <? confirmation_block confirmed)
  | None => false
  end.

Inductive synchronized_funding :=
| FundingObserved (plan : funding_status)
| FundingAwaitingBalances.

Definition synchronized_plan s observation observed_block latest :=
  match funding_plan s observation with
  | WalletRequired => FundingObserved WalletRequired
  | plan =>
      match observation, observed_block with
      | Some observed, Some block =>
          if retains_snapshot s (funding_identity observed) &&
              awaiting_confirmation s block latest
          then FundingAwaitingBalances else FundingObserved plan
      | Some _, None => FundingObserved BalancesLoading
      | None, _ => FundingObserved plan
      end
  end.

Theorem stale_confirmation_does_not_change_progress s who block previous :
  permits s who = false ->
  record_confirmation s who block previous = previous.
Proof. intros H. unfold record_confirmation. rewrite H. reflexivity. Qed.

Theorem recorded_confirmation_keeps_current_identity s who block previous latest :
  record_confirmation s who block previous = Some latest ->
  permits s who = true -> confirmation_identity latest = who /\
    block <= confirmation_block latest.
Proof.
  intros H Hp. unfold record_confirmation in H. rewrite Hp in H.
  destruct previous as [prior|]; [destruct (permits s (confirmation_identity prior))|];
    inversion H; subst; simpl; split; auto; try apply Z.le_max_l; lia.
Qed.

Theorem caught_up_confirmation_is_not_waiting s latest block :
  confirmation_block latest <= block ->
  awaiting_confirmation s block (Some latest) = false.
Proof.
  intros H. unfold awaiting_confirmation.
  assert ((block <? confirmation_block latest) = false) by (apply Z.ltb_ge; exact H).
  rewrite H0, andb_false_r. reflexivity.
Qed.

Theorem stale_confirmation_is_not_waiting s latest block :
  permits s (confirmation_identity latest) = false ->
  awaiting_confirmation s block (Some latest) = false.
Proof. intros H. unfold awaiting_confirmation. rewrite H. reflexivity. Qed.

Theorem pending_confirmation_waits_for_balance_read s observed block latest :
  funding_plan s (Some observed) <> WalletRequired ->
  retains_snapshot s (funding_identity observed) = true ->
  awaiting_confirmation s block latest = true ->
  synchronized_plan s (Some observed) (Some block) latest = FundingAwaitingBalances.
Proof.
  intros Hplan Hsnapshot Hpending. unfold synchronized_plan.
  destruct (funding_plan s (Some observed)); try contradiction;
    rewrite Hsnapshot, Hpending; reflexivity.
Qed.

Theorem caught_up_snapshot_uses_observed_plan s observed block latest :
  awaiting_confirmation s block latest = false ->
  synchronized_plan s (Some observed) (Some block) latest =
    FundingObserved (funding_plan s (Some observed)).
Proof.
  intros Hpending. unfold synchronized_plan.
  destruct (funding_plan s (Some observed)); try reflexivity;
    rewrite Hpending, andb_false_r; reflexivity.
Qed.
