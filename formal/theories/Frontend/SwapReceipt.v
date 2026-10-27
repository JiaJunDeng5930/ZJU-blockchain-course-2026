From Coq Require Import List String Bool.
From DEXFormal.Spec Require Import Ledger.
From DEXFormal.Frontend Require Import ReceiptScope.
Import ListNotations.
Open Scope string_scope.

Inductive fact_kind := SwapFact | LiquidityFact | TransferFact | ArbitrageFact.
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
| LiquidityResult | ArbitrageResult | RevertedResult.
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
