From Coq Require Import List String Bool.
Import ListNotations.
Open Scope string_scope.

Record execution_event := ExecutionEvent {
  execution_index : nat;
  execution_source : string;
  execution_buy : string;
  execution_sell : string
}.
Record reserves_event := ReservesEvent {
  reserves_index : nat;
  reserves_source : string;
  reserves_exchange : string
}.

Definition intermediate_token token0 token1 capital :=
  if String.eqb capital token0 then token1 else token0.
Definition execution_eligible contract exchanges event :=
  String.eqb (execution_source event) contract &&
  existsb (String.eqb (execution_buy event)) exchanges &&
  existsb (String.eqb (execution_sell event)) exchanges.
Definition reserves_eligible contract event := String.eqb (reserves_source event) contract.
Definition route_matches execution buy sell :=
  String.eqb (execution_buy execution) (reserves_exchange buy) &&
  String.eqb (execution_sell execution) (reserves_exchange sell).

Inductive receipt_selection :=
| NoArbitrageEvent | Selected (execution : execution_event) (buy sell : reserves_event)
| UnsupportedReceipt | RevertedReceipt.

Definition select_receipt (successful : bool) contract exchanges executions snapshots :=
  if successful then
    match filter (execution_eligible contract exchanges) executions with
    | [] => NoArbitrageEvent
    | [execution] =>
        match filter (reserves_eligible contract) snapshots with
        | [buy; sell] =>
            if route_matches execution buy sell
            then Selected execution buy sell else UnsupportedReceipt
        | _ => UnsupportedReceipt
        end
    | _ => UnsupportedReceipt
    end
  else RevertedReceipt.

Theorem selected_facts_are_observed successful contract exchanges executions snapshots execution buy sell :
  select_receipt successful contract exchanges executions snapshots = Selected execution buy sell ->
  (In execution executions /\ execution_eligible contract exchanges execution = true) /\
  (In buy snapshots /\ reserves_eligible contract buy = true) /\
  (In sell snapshots /\ reserves_eligible contract sell = true) /\
  route_matches execution buy sell = true.
Proof.
  unfold select_receipt. destruct successful; try discriminate.
  remember (filter (execution_eligible contract exchanges) executions) as es eqn:He.
  destruct es as [|e es]; try discriminate. destruct es; try discriminate.
  remember (filter (reserves_eligible contract) snapshots) as ss eqn:Hs.
  destruct ss as [|b ss]; try discriminate. destruct ss as [|s ss]; try discriminate.
  destruct ss; try discriminate.
  destruct (route_matches e b s) eqn:Hr; try discriminate.
  intros H. inversion H; subst e b s.
  assert (Hex : In execution (filter (execution_eligible contract exchanges) executions)).
  { rewrite <- He. simpl; auto. }
  assert (Hb : In buy (filter (reserves_eligible contract) snapshots)).
  { rewrite <- Hs. simpl; auto. }
  assert (Hs' : In sell (filter (reserves_eligible contract) snapshots)).
  { rewrite <- Hs. simpl; auto. }
  apply filter_In in Hex. apply filter_In in Hb. apply filter_In in Hs'.
  tauto.
Qed.

Theorem selected_execution_has_configured_source successful contract exchanges executions snapshots execution buy sell :
  select_receipt successful contract exchanges executions snapshots = Selected execution buy sell ->
  execution_source execution = contract.
Proof.
  intros H. apply selected_facts_are_observed in H as [[_ H] _].
  unfold execution_eligible in H. repeat apply andb_true_iff in H as [H _].
  now apply String.eqb_eq in H.
Qed.

Theorem selected_reserves_have_configured_source successful contract exchanges executions snapshots execution buy sell :
  select_receipt successful contract exchanges executions snapshots = Selected execution buy sell ->
  reserves_source buy = contract /\ reserves_source sell = contract.
Proof.
  intros H. apply selected_facts_are_observed in H as [_ [[_ Hb] [[_ Hs] _]]].
  unfold reserves_eligible in *. now apply String.eqb_eq in Hb, Hs.
Qed.

Theorem selected_reserves_match_route successful contract exchanges executions snapshots execution buy sell :
  select_receipt successful contract exchanges executions snapshots = Selected execution buy sell ->
  execution_buy execution = reserves_exchange buy /\ execution_sell execution = reserves_exchange sell.
Proof.
  intros H. apply selected_facts_are_observed in H as [_ [_ [_ H]]].
  unfold route_matches in H. apply andb_true_iff in H as [Hb Hs].
  now apply String.eqb_eq in Hb, Hs.
Qed.

Theorem reverted_receipt_has_no_arbitrage contract exchanges executions snapshots :
  select_receipt false contract exchanges executions snapshots = RevertedReceipt.
Proof. reflexivity. Qed.
