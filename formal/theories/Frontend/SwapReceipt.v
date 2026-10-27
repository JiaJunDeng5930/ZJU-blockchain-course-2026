From Coq Require Import List String Bool.
From DEXFormal.Spec Require Import Ledger.
From DEXFormal.Frontend Require Import ReceiptScope.
Import ListNotations.
Open Scope string_scope.

Inductive fact_kind := SwapFact | LiquidityFact | TransferFact | ArbitrageFact | WrappingFact.
Record receipt_fact := ReceiptFact {
  fact_index : nat; fact_source : string; fact_type : fact_kind;
  fact_from : string; fact_to : string
}.

Definition configured known source := existsb (String.eqb source) known.
Definition swap_fact known target fact :=
  configured known target && String.eqb (fact_source fact) target &&
  match fact_type fact with SwapFact => true | _ => false end.

Inductive swap_selection := NoSwap | SelectedSwap (fact : receipt_fact)
| MultipleSwaps | RevertedSwap.
Definition select_swap (successful : bool) known target facts :=
  if successful then match filter (swap_fact known target) facts with
    | [] => NoSwap | [fact] => SelectedSwap fact | _ => MultipleSwaps end
  else RevertedSwap.

Definition liquidity_fact known fact :=
  configured known (fact_source fact) &&
  match fact_type fact with
  | LiquidityFact => true
  | TransferFact => negb (String.eqb (fact_from fact) Ledger.zero_address) &&
                    negb (String.eqb (fact_to fact) Ledger.zero_address)
  | _ => false end.
Definition arbitrage_fact source fact :=
  String.eqb (fact_source fact) source &&
  match fact_type fact with ArbitrageFact => true | _ => false end.

Inductive result_kind := NoResult | CreationResult | SwapResult
| LiquidityResult | ArbitrageResult | WrappingResult | RevertedResult.
Definition result_for (successful creation : bool) known arbitrage target facts :=
  if successful then
    if creation then CreationResult
    else if existsb (arbitrage_fact arbitrage) facts then ArbitrageResult
    else if existsb (liquidity_fact known) facts then LiquidityResult
    else if existsb (swap_fact known target) facts then SwapResult
    else NoResult
  else RevertedResult.

Definition available known arbitrage descriptor_known creation target operation :=
  negb descriptor_known || creation ||
  operation_receipt_available known
    ["swap"; "addLiquidity"; "removeLiquidity"; "safeTransferFrom"; "transferFrom"]
    descriptor_known target operation ||
  operation_receipt_available [arbitrage] ["execute"]
    descriptor_known target operation.

Definition output_asset input token0 token1 :=
  if String.eqb input token0 then token1 else token0.

(* WrappedEther only mints to, or burns from, its direct caller. This selection
   preserves that scope so the existing settlement includes that owner's fee. *)
Definition wrapping_direction owner fact :=
  if String.eqb (fact_from fact) Ledger.zero_address && String.eqb (fact_to fact) owner
  then Some false
  else if String.eqb (fact_from fact) owner && String.eqb (fact_to fact) Ledger.zero_address
  then Some true else None.
Definition wrapping_fact wrapped target owner fact :=
  negb (String.eqb wrapped "") && String.eqb target wrapped &&
  String.eqb (fact_source fact) wrapped &&
  match fact_type fact with
  | WrappingFact => match wrapping_direction owner fact with Some _ => true | None => false end
  | _ => false end.
Inductive wrapping_selection := NoWrapping | SelectedWrapping (fact : receipt_fact) (withdraw : bool)
| MultipleWrappings | RevertedWrapping.
Definition select_wrapping (successful : bool) wrapped target owner facts :=
  if successful then match filter (wrapping_fact wrapped target owner) facts with
  | [] => NoWrapping
  | [fact] => match wrapping_direction owner fact with
      Some withdraw => SelectedWrapping fact withdraw | None => NoWrapping end
  | _ => MultipleWrappings end else RevertedWrapping.
Definition result_with_wrapping successful creation known arbitrage wrapped target owner facts :=
  match result_for successful creation known arbitrage target facts with
  | NoResult => if existsb (wrapping_fact wrapped target owner) facts then WrappingResult else NoResult
  | result => result end.
Definition available_with_wrapping known arbitrage wrapped descriptor_known creation target operation :=
  available known arbitrage descriptor_known creation target operation ||
  (negb (String.eqb wrapped "") &&
   operation_receipt_available [wrapped] ["deposit"; "withdraw"; "receive"]
     descriptor_known target operation).

Theorem selected_swap_was_observed successful known target facts fact :
  select_swap successful known target facts = SelectedSwap fact ->
  In fact facts /\ swap_fact known target fact = true.
Proof.
  unfold select_swap. destruct successful; try discriminate.
  remember (filter (swap_fact known target) facts) as selected eqn:Hselected.
  destruct selected as [|first rest]; try discriminate.
  destruct rest; try discriminate. intros H; inversion H; subst first.
  apply filter_In. rewrite <- Hselected. simpl; auto.
Qed.

Theorem selected_swap_target_is_configured successful known target facts fact :
  select_swap successful known target facts = SelectedSwap fact -> In target known.
Proof.
  intros H. apply selected_swap_was_observed in H as [_ H].
  unfold swap_fact in H. apply andb_true_iff in H as [H _].
  apply andb_true_iff in H as [H _]. unfold configured in H.
  apply existsb_exists in H as [source [Hin Heq]].
  apply String.eqb_eq in Heq. now rewrite Heq.
Qed.

Theorem failed_swap_is_not_successful known target facts :
  select_swap false known target facts = RevertedSwap.
Proof. reflexivity. Qed.
Theorem failed_result_is_not_successful creation known arbitrage target facts :
  result_for false creation known arbitrage target facts = RevertedResult.
Proof. reflexivity. Qed.
Theorem unknown_descriptor_keeps_result_available known arbitrage creation target operation :
  available known arbitrage false creation target operation = true.
Proof. reflexivity. Qed.
Theorem arbitrage_keeps_its_operation_kind known source target facts :
  existsb (arbitrage_fact source) facts = true ->
  result_for true false known source target facts = ArbitrageResult.
Proof. unfold result_for. intros H. now rewrite H. Qed.
Theorem output_for_first_asset token0 token1 :
  output_asset token0 token0 token1 = token1.
Proof. unfold output_asset. now rewrite String.eqb_refl. Qed.

Theorem selected_wrapping_was_observed successful wrapped target owner facts fact withdraw :
  select_wrapping successful wrapped target owner facts = SelectedWrapping fact withdraw ->
  In fact facts /\ wrapping_fact wrapped target owner fact = true /\
  wrapping_direction owner fact = Some withdraw.
Proof.
  unfold select_wrapping. destruct successful; try discriminate.
  remember (filter (wrapping_fact wrapped target owner) facts) as selected eqn:Hselected.
  destruct selected as [|first rest]; try discriminate.
  destruct rest; try discriminate.
  destruct (wrapping_direction owner first) as [direction|] eqn:Hdirection; try discriminate.
  intros H; inversion H; subst first direction.
  assert (Hin : In fact facts /\ wrapping_fact wrapped target owner fact = true).
  { apply filter_In. rewrite <- Hselected. simpl; auto. }
  tauto.
Qed.

Theorem selected_wrapping_is_configured successful wrapped target owner facts fact withdraw :
  select_wrapping successful wrapped target owner facts = SelectedWrapping fact withdraw ->
  target = wrapped /\ fact_source fact = wrapped.
Proof.
  intros H. apply selected_wrapping_was_observed in H as [_ [H _]].
  unfold wrapping_fact in H. apply andb_true_iff in H as [H _].
  apply andb_true_iff in H as [H Hsource]. apply andb_true_iff in H as [_ Htarget].
  apply String.eqb_eq in Hsource. apply String.eqb_eq in Htarget. auto.
Qed.

Theorem wrapping_direction_has_owner owner fact withdraw :
  wrapping_direction owner fact = Some withdraw ->
  if withdraw then fact_from fact = owner /\ fact_to fact = Ledger.zero_address
  else fact_from fact = Ledger.zero_address /\ fact_to fact = owner.
Proof.
  unfold wrapping_direction.
  destruct (String.eqb (fact_from fact) Ledger.zero_address && String.eqb (fact_to fact) owner)
    eqn:Hmint.
  - intros H; inversion H; subst withdraw. apply andb_true_iff in Hmint as [Hfrom Hto].
    apply String.eqb_eq in Hfrom. apply String.eqb_eq in Hto. auto.
  - destruct (String.eqb (fact_from fact) owner && String.eqb (fact_to fact) Ledger.zero_address)
      eqn:Hburn; try discriminate.
    intros H; inversion H; subst withdraw. apply andb_true_iff in Hburn as [Hfrom Hto].
    apply String.eqb_eq in Hfrom. apply String.eqb_eq in Hto. auto.
Qed.

Theorem missing_wrapped_asset_has_no_result successful target owner facts :
  select_wrapping successful "" target owner facts =
    if successful then NoWrapping else RevertedWrapping.
Proof.
  unfold select_wrapping. destruct successful; [|reflexivity].
  assert (H : filter (wrapping_fact "" target owner) facts = []).
  { induction facts as [|fact rest IH]; simpl; auto. }
  now rewrite H.
Qed.

Theorem failed_wrapping_is_not_successful wrapped target owner facts :
  select_wrapping false wrapped target owner facts = RevertedWrapping.
Proof. reflexivity. Qed.

Theorem wrapping_extension_keeps_existing_results successful creation known arbitrage wrapped target owner facts result :
  result_for successful creation known arbitrage target facts = result -> result <> NoResult ->
  result_with_wrapping successful creation known arbitrage wrapped target owner facts = result.
Proof. unfold result_with_wrapping. intros H Hnonempty. rewrite H. destruct result; auto; contradiction. Qed.

Theorem receive_keeps_wrapping_available known arbitrage wrapped :
  wrapped <> "" -> available_with_wrapping known arbitrage wrapped true false wrapped "receive" = true.
Proof.
  intros H. unfold available_with_wrapping, operation_receipt_available.
  apply orb_true_iff. right. apply andb_true_iff. split.
  - apply negb_true_iff. apply String.eqb_neq. exact H.
  - simpl. rewrite String.eqb_refl. reflexivity.
Qed.
