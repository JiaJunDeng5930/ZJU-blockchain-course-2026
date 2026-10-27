From Coq Require Import List String Bool.
From DEXFormal.Spec Require Import Ledger.
From DEXFormal.Frontend Require Import ReceiptScope.
Import ListNotations.
Open Scope string_scope.

Inductive liquidity_event_kind := DepositEvent | RedeemEvent | TransferEvent.
Record liquidity_event := LiquidityEvent {
  event_index : nat;
  event_exchange : string;
  event_kind : liquidity_event_kind;
  event_from : string;
  event_to : string
}.

Definition available known (descriptor_known : bool) target operation :=
  operation_receipt_available known
    ["addLiquidity"; "removeLiquidity"; "safeTransferFrom"; "transferFrom"]
    descriptor_known target operation.

Theorem available_requires_configured_exchange known target operation :
  available known true target operation = true -> In target known.
Proof.
  apply known_receipt_target_is_configured.
Qed.

Theorem unknown_descriptor_allows_receipt_read known target operation :
  available known false target operation = true.
Proof. reflexivity. Qed.

Definition eligible known event :=
  existsb (String.eqb (event_exchange event)) known &&
  match event_kind event with
  | DepositEvent | RedeemEvent => true
  | TransferEvent =>
      negb (String.eqb (event_from event) Ledger.zero_address) &&
      negb (String.eqb (event_to event) Ledger.zero_address)
  end.

Inductive receipt_selection :=
| NoLiquidityEvent | Selected (event : liquidity_event)
| MultipleLiquidityEvents | RevertedReceipt.

Definition select_receipt (successful : bool) known events :=
  if successful then
    match filter (eligible known) events with
    | [] => NoLiquidityEvent
    | [event] => Selected event
    | _ => MultipleLiquidityEvents
    end
  else RevertedReceipt.

Theorem selected_event_is_observed successful known events event :
  select_receipt successful known events = Selected event ->
  In event events /\ eligible known event = true.
Proof.
  unfold select_receipt. destruct successful; try discriminate.
  remember (filter (eligible known) events) as selected eqn:Hselected.
  destruct selected as [|first rest]; try discriminate.
  destruct rest; try discriminate. intros H; inversion H; subst first.
  apply filter_In. rewrite <- Hselected. simpl; auto.
Qed.

Theorem selected_event_has_configured_exchange successful known events event :
  select_receipt successful known events = Selected event ->
  In (event_exchange event) known.
Proof.
  intros H. apply selected_event_is_observed in H as [_ H].
  unfold eligible in H. apply andb_true_iff in H as [H _].
  apply existsb_exists in H as [exchange [Hin Heq]].
  apply String.eqb_eq in Heq. now rewrite Heq.
Qed.

Theorem reverted_receipt_has_no_selection known events :
  select_receipt false known events = RevertedReceipt.
Proof. reflexivity. Qed.

Theorem mint_transfer_is_not_a_second_action known index exchange recipient :
  eligible known
    (LiquidityEvent index exchange TransferEvent Ledger.zero_address recipient) = false.
Proof. unfold eligible; simpl. apply andb_false_r. Qed.

Theorem burn_transfer_is_not_a_second_action known index exchange sender :
  eligible known
    (LiquidityEvent index exchange TransferEvent sender Ledger.zero_address) = false.
Proof.
  unfold eligible; simpl.
  rewrite andb_false_r. apply andb_false_r.
Qed.
