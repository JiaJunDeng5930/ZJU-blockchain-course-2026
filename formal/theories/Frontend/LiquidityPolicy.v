From Coq Require Import ZArith String Bool Lia.
From DEXFormal.Spec Require Import Types Units AMM Liquidity.
Open Scope string_scope.
Open Scope Z_scope.

Record deposit_ownership_quote := DepositOwnershipQuote {
  quote_total_shares : Z;
  quote_new_locked_shares : Z;
  quote_redeem0 : Z;
  quote_redeem1 : Z
}.

(* The NFT owns its minted shares, rather than the complete first deposit.
   This is the immediate burn quote for the same hypothetical post-mint state. *)
Definition deposit_ownership r0 r1 total (plan : deposit_plan) :=
  let after_total := mint_total total (minted plan) in
  let '(a0,a1) := redeem_amounts (r0 + used0 plan) (r1 + used1 plan)
    after_total (minted plan) in
  DepositOwnershipQuote after_total
    (if total =? 0 then locked_shares else 0) a0 a1.

Lemma first_deposit_ownership_includes_locked r0 r1 plan :
  quote_total_shares (deposit_ownership r0 r1 0 plan) - minted plan = locked_shares /\
  quote_new_locked_shares (deposit_ownership r0 r1 0 plan) = locked_shares.
Proof.
  change (locked_shares + minted plan - minted plan = locked_shares /\
    locked_shares = locked_shares). lia.
Qed.

Lemma deposit_ownership_keeps_pool_funded r0 r1 total plan :
  0 < r0 + used0 plan -> 0 < r1 + used1 plan ->
  (total = 0 \/ locked_shares <= total) -> 0 < minted plan ->
  let quote := deposit_ownership r0 r1 total plan in
  0 < r0 + used0 plan - quote_redeem0 quote /\
  0 < r1 + used1 plan - quote_redeem1 quote /\
  locked_shares <= quote_total_shares quote - minted plan.
Proof.
  intros Hr0 Hr1 Htotal Hmint.
  assert (Hshares : 0 <= minted plan <= mint_total total (minted plan) - locked_shares).
  { unfold mint_total. destruct (Z.eqb_spec total 0); subst;
      unfold locked_shares in *; lia. }
  exact (redeemed_locked_pool_stays_funded
    (r0 + used0 plan) (r1 + used1 plan) (mint_total total (minted plan))
    (minted plan) Hr0 Hr1 Hshares).
Qed.

Inductive deposit_decision :=
| DepositEmpty
| DepositRejected (message : string)
| DepositPrepared (plan : deposit_plan).
Definition analyze_deposit p0 p1 r0 r1 total b0 b1 text0 text1 tolerance :=
  if String.eqb text0 "" && String.eqb text1 "" then DepositEmpty else
  match amount_error p0 text0 (Some b0), amount_error p1 text1 (Some b1), slippage_error tolerance with
  | Some why, _, _ => DepositRejected why
  | _, Some why, _ => DepositRejected why
  | _, _, Some why => DepositRejected why
  | None, None, None =>
    match positive_units p0 text0, positive_units p1 text1, parse_slippage_bps tolerance with
    | Some d0, Some d1, Some slip =>
      match prepare_deposit r0 r1 total d0 d1 b0 b1 slip with
      | Some plan => DepositPrepared plan
      | None =>
        let '(a0,a1) := deposit_amounts r0 r1 total d0 d1 in
        if (max_reserve <? r0+a0) || (max_reserve <? r1+a1)
        then DepositRejected "This deposit exceeds the pool reserve capacity."
        else DepositRejected "This deposit cannot mint a positive, representable liquidity position."
      end
    | _, _, _ => DepositRejected "Enter valid token amounts and slippage."
    end
  end.

Lemma analyzed_deposit_uses_checked_plan p0 p1 r0 r1 total b0 b1 t0 t1 tolerance plan :
  analyze_deposit p0 p1 r0 r1 total b0 b1 t0 t1 tolerance = DepositPrepared plan ->
  exists d0 d1 slip, prepare_deposit r0 r1 total d0 d1 b0 b1 slip = Some plan.
Proof.
  unfold analyze_deposit.
  destruct (String.eqb t0 "" && String.eqb t1 ""); [discriminate|].
  destruct (amount_error p0 t0 (Some b0)); [discriminate|].
  destruct (amount_error p1 t1 (Some b1)); [discriminate|].
  destruct (slippage_error tolerance); [discriminate|].
  destruct (positive_units p0 t0) as [d0|]; [|discriminate].
  destruct (positive_units p1 t1) as [d1|]; [|discriminate].
  destruct (parse_slippage_bps tolerance) as [slip|]; [|discriminate].
  destruct (prepare_deposit r0 r1 total d0 d1 b0 b1 slip) as [prepared|] eqn:Hplan.
  - intros H. inversion H; subst. exists d0,d1,slip. exact Hplan.
  - destruct (deposit_amounts r0 r1 total d0 d1).
    destruct ((max_reserve <? r0+z) || (max_reserve <? r1+z0)); discriminate.
Qed.

Lemma prepared_deposit_ownership_keeps_pool_funded r0 r1 total d0 d1 b0 b1 slip plan :
  prepare_deposit r0 r1 total d0 d1 b0 b1 slip = Some plan ->
  let quote := deposit_ownership r0 r1 total plan in
  0 < r0 + used0 plan - quote_redeem0 quote /\
  0 < r1 + used1 plan - quote_redeem1 quote /\
  locked_shares <= quote_total_shares quote - minted plan.
Proof.
  intros Hplan.
  pose proof (prepare_deposit_budgets _ _ _ _ _ _ _ _ _ Hplan) as Hbudget.
  destruct Hbudget as [Hused0 [Hused1 [_ [_ [_ [_ [_ [_ Hmint]]]]]]]].
  assert (Hpool : pool_validb r0 r1 total = true).
  { unfold prepare_deposit in Hplan.
    destruct (deposit_amounts r0 r1 total d0 d1) as [a0 a1] eqn:Hamounts.
    destruct (deposit_validb r0 r1 total d0 d1 b0 b1 slip) eqn:Hvalid; [|discriminate].
    unfold deposit_validb in Hvalid. rewrite Hamounts in Hvalid.
    unpack_checks. assumption. }
  unfold pool_validb in Hpool. unpack_checks.
  assert (Htotal : total = 0 \/ locked_shares <= total).
  { destruct (total =? 0) eqn:Hfirst.
    - left. now apply Z.eqb_eq.
    - right. unpack_checks. assumption. }
  apply deposit_ownership_keeps_pool_funded; [lia|lia|exact Htotal|exact Hmint].
Qed.

Lemma analyzed_deposit_ownership_keeps_pool_funded p0 p1 r0 r1 total b0 b1 t0 t1 tolerance plan :
  analyze_deposit p0 p1 r0 r1 total b0 b1 t0 t1 tolerance = DepositPrepared plan ->
  let quote := deposit_ownership r0 r1 total plan in
  0 < r0 + used0 plan - quote_redeem0 quote /\
  0 < r1 + used1 plan - quote_redeem1 quote /\
  locked_shares <= quote_total_shares quote - minted plan.
Proof.
  intros Hdecision.
  destruct (analyzed_deposit_uses_checked_plan _ _ _ _ _ _ _ _ _ _ _ Hdecision)
    as [d0 [d1 [slip Hplan]]].
  exact (prepared_deposit_ownership_keeps_pool_funded _ _ _ _ _ _ _ _ _ Hplan).
Qed.

Definition position_is_ownedb owner current := String.eqb owner current.
Definition withdrawal_error r0 r1 total shares owner current slip :=
  if negb (position_is_ownedb owner current) then Some "This wallet does not own the position."
  else if withdraw_validb r0 r1 total shares slip then None
  else Some "This position cannot be redeemed with the selected tolerance.".
Lemma accepted_withdrawal_is_owned r0 r1 total shares owner current slip :
  withdrawal_error r0 r1 total shares owner current slip = None -> owner=current.
Proof.
  unfold withdrawal_error, position_is_ownedb.
  destruct (String.eqb owner current) eqn:H; cbn; [|discriminate].
  intros _. apply String.eqb_eq; exact H.
Qed.

Inductive write_deposit_decision :=
| WriteDepositRejected (reason : string)
| WriteDepositPrepared (plan : deposit_plan) (deadline : Z) (approve0 approve1 : bool).
Definition prepare_deposit_write r0 r1 total d0 d1 b0 b1 slip now allowance0 allowance1 :=
  if valid_call_time now then
    match prepare_deposit r0 r1 total d0 d1 b0 b1 slip with
    | Some plan => WriteDepositPrepared plan (call_deadline now)
        (approval_needed allowance0 d0) (approval_needed allowance1 d1)
    | None => WriteDepositRejected "The deposit exceeds its budget, capacity, or liquidity constraints."
    end
  else WriteDepositRejected "The transaction deadline cannot be represented.".

Lemma prepared_deposit_at_valid_time r0 r1 total d0 d1 b0 b1 slip before after
    allowance0 allowance1 plan deadline approve0 approve1 :
  prepare_deposit_write r0 r1 total d0 d1 b0 b1 slip before allowance0 allowance1 =
    WriteDepositPrepared plan deadline approve0 approve1 ->
  valid_call_time after = true ->
  prepare_deposit_write r0 r1 total d0 d1 b0 b1 slip after allowance0 allowance1 =
    WriteDepositPrepared plan (call_deadline after) approve0 approve1.
Proof.
  unfold prepare_deposit_write.
  destruct (valid_call_time before); [|discriminate].
  destruct (prepare_deposit r0 r1 total d0 d1 b0 b1 slip); [|discriminate].
  intros prepared valid. inversion prepared; subst.
  now rewrite valid.
Qed.

Definition withdrawal_message r0 r1 total shares owner current slip now :=
  if valid_call_time now then withdrawal_error r0 r1 total shares owner current slip
  else Some "The transaction deadline cannot be represented.".

Inductive write_withdraw_decision :=
| WriteWithdrawRejected (reason : string)
| WriteWithdrawPrepared (amount0 amount1 minimum0 minimum1 deadline : Z).
Definition prepare_withdraw_write r0 r1 total shares owner current slip now :=
  match withdrawal_message r0 r1 total shares owner current slip now with
  | Some why => WriteWithdrawRejected why
  | None => match withdraw_plan r0 r1 total shares slip with
      | Some (a0,a1,m0,m1) => WriteWithdrawPrepared a0 a1 m0 m1 (call_deadline now)
      | None => WriteWithdrawRejected "The position no longer has a valid redemption plan."
    end
  end.
Lemma prepared_withdrawal_is_owned r0 r1 total shares owner current slip now a0 a1 m0 m1 deadline :
  prepare_withdraw_write r0 r1 total shares owner current slip now =
    WriteWithdrawPrepared a0 a1 m0 m1 deadline -> owner=current.
Proof.
  unfold prepare_withdraw_write, withdrawal_message.
  destruct (valid_call_time now); [|discriminate].
  destruct (withdrawal_error r0 r1 total shares owner current slip) eqn:Howned; [discriminate|].
  intros _. now apply (accepted_withdrawal_is_owned r0 r1 total shares owner current slip).
Qed.

Definition prepare_position_withdraw expected_pool actual_pool r0 r1 total shares owner current slip now expected0 expected1 :=
  if expected_pool =? actual_pool then
    match prepare_withdraw_write r0 r1 total shares owner current slip now with
    | WriteWithdrawPrepared a0 a1 m0 m1 deadline =>
      if (a0 =? expected0) && (a1 =? expected1)
      then WriteWithdrawPrepared a0 a1 m0 m1 deadline
      else WriteWithdrawRejected "Review the position's current redemption amounts."
    | rejected => rejected
    end
  else WriteWithdrawRejected "The position belongs to another pool.".
Lemma prepared_position_matches_review expected_pool actual_pool r0 r1 total shares owner current slip now expected0 expected1 a0 a1 m0 m1 deadline :
  prepare_position_withdraw expected_pool actual_pool r0 r1 total shares owner current slip now expected0 expected1 =
    WriteWithdrawPrepared a0 a1 m0 m1 deadline ->
  expected_pool = actual_pool /\ owner=current /\ a0=expected0 /\ a1=expected1.
Proof.
  unfold prepare_position_withdraw.
  destruct (expected_pool =? actual_pool) eqn:Hpool; [|discriminate].
  destruct (prepare_withdraw_write r0 r1 total shares owner current slip now)
    as [why|calculated0 calculated1 minimum0 minimum1 expires] eqn:Hwrite; [discriminate|].
  pose proof (prepared_withdrawal_is_owned _ _ _ _ _ _ _ _ _ _ _ _ _ Hwrite) as Howner.
  destruct ((calculated0 =? expected0) && (calculated1 =? expected1)) eqn:Hreview; [|discriminate].
  intros H; inversion H; subst.
  apply Z.eqb_eq in Hpool. apply andb_true_iff in Hreview.
  destruct Hreview as [H0 H1]. apply Z.eqb_eq in H0,H1. repeat split; assumption.
Qed.

Inductive transfer_decision := TransferRejected (reason : string) | TransferPrepared (recipient : address).
(* The viem boundary decodes Ethereum/checksummed text into an address or a parse failure. *)
Definition prepare_transfer owner current (decoded : option address) :=
  match decoded with
  | None => TransferRejected "Enter a valid Ethereum recipient address."
  | Some recipient => match transfer_error owner current recipient with
    | Some why => TransferRejected why
    | None => TransferPrepared recipient
    end
  end.
Lemma prepared_transfer_preserves_decoded_address owner current decoded recipient :
  prepare_transfer owner current decoded = TransferPrepared recipient ->
  decoded = Some recipient /\ owner=current /\ valid_recipientb recipient = true.
Proof.
  unfold prepare_transfer. destruct decoded as [target|]; [|discriminate].
  destruct (transfer_error owner current target) eqn:Hvalid; [discriminate|].
  intros H; inversion H; subst.
  pose proof (accepted_transfer_is_owner _ _ _ Hvalid). tauto.
Qed.
