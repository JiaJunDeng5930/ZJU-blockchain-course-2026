From Coq Require Import ZArith String List Bool Lia.
From DEXFormal.Spec Require Import Types.
Import ListNotations.
Open Scope string_scope.
Open Scope Z_scope.
Open Scope list_scope.

Module Arbitrage.

Record pool := Pool {
  exchange : address;
  pool_id : Z;
  token0 : address;
  token1 : address;
  reserve0 : Z;
  reserve1 : Z
}.

Definition zero_address := "0x0000000000000000000000000000000000000000".
Definition nonzero_addressb (value : address) :=
  negb (String.eqb value "") && negb (String.eqb value zero_address).
Definition pool_eqb (left right : pool) :=
  String.eqb (exchange left) (exchange right) &&
  Z.eqb (pool_id left) (pool_id right).
Definition fundedb (market : pool) :=
  (0 <? reserve0 market) && (0 <? reserve1 market) &&
  uint256b (reserve0 market) && uint256b (reserve1 market).
Definition route_validb (buy sell : pool) (capital_token : address) :=
  nonzero_addressb (exchange buy) && nonzero_addressb (exchange sell) &&
  negb (String.eqb (exchange buy) (exchange sell)) &&
  nonzero_addressb (token0 buy) && nonzero_addressb (token1 buy) &&
  negb (String.eqb (token0 buy) (token1 buy)) &&
  String.eqb (token0 buy) (token0 sell) &&
  String.eqb (token1 buy) (token1 sell) &&
  (String.eqb capital_token (token0 buy) || String.eqb capital_token (token1 buy)) &&
  (0 <? pool_id buy) && (0 <? pool_id sell) && fundedb buy && fundedb sell.

Definition settlement (capital returned minimum : Z) : option Z :=
  if (capital <? returned) && (minimum <=? returned - capital)
  then Some (returned - capital) else None.

Theorem settlement_sound capital returned minimum profit :
  settlement capital returned minimum = Some profit ->
  capital < returned /\ 0 < profit /\ minimum <= profit /\
  returned = capital + profit.
Proof.
  unfold settlement. destruct (_ && _) eqn:guard; [|discriminate].
  apply andb_true_iff in guard as [positive threshold].
  apply Z.ltb_lt in positive. apply Z.leb_le in threshold.
  intros output. inversion output. lia.
Qed.

Theorem settlement_complete capital returned minimum :
  capital < returned -> minimum <= returned - capital ->
  settlement capital returned minimum = Some (returned - capital).
Proof.
  intros positive threshold. unfold settlement.
  apply Z.ltb_lt in positive. apply Z.leb_le in threshold.
  rewrite positive, threshold. reflexivity.
Qed.

(* These are exactly the four postconditions checked against the production
   helper by contracts/formal/ArbitrageProperties.sol. *)
Theorem settlement_smt_assertions capital returned minimum profit :
  settlement capital returned minimum = Some profit <->
  0 < profit /\ minimum <= profit /\ returned = capital + profit /\
  profit = returned - capital.
Proof.
  split.
  - intro accepted. apply settlement_sound in accepted as [_ [positive [threshold balance] ] ].
    repeat split; lia.
  - intros [positive [threshold [balance difference] ] ].
    replace profit with (returned - capital) by lia.
    apply settlement_complete; lia.
Qed.

Theorem settlement_rejects_loss capital returned minimum :
  returned <= capital -> settlement capital returned minimum = None.
Proof.
  intros loss. unfold settlement.
  assert ((capital <? returned) = false) by (apply Z.ltb_ge; lia).
  rewrite H. reflexivity.
Qed.

Record opportunity := Opportunity {
  buy : pool;
  sell : pool;
  capital_token : address;
  capital : Z;
  intermediate : Z;
  returned : Z;
  profit : Z
}.

Definition quote_function := Z -> Z -> Z -> option Z.
Definition quote_pool (quote : quote_function) (market : pool)
    (input_token : address) (input : Z) : option Z :=
  if String.eqb input_token (token0 market)
  then quote (reserve0 market) (reserve1 market) input
  else quote (reserve1 market) (reserve0 market) input.

Definition candidate (quote : quote_function) (buy_market sell_market : pool)
    (input_token : address) (input : Z) : option opportunity :=
  if route_validb buy_market sell_market input_token &&
     (0 <? input) && uint256b input then
    match quote_pool quote buy_market input_token input with
    | None => None
    | Some bridge =>
        let bridge_token := if String.eqb input_token (token0 buy_market)
          then token1 buy_market else token0 buy_market in
        match quote_pool quote sell_market bridge_token bridge with
        | None => None
        | Some output =>
            if (0 <? bridge) && uint256b bridge && uint256b output then
              match settlement input output 0 with
              | None => None
              | Some gain => Some (Opportunity buy_market sell_market
                  input_token input bridge output gain)
              end
            else None
        end
    end
  else None.

Theorem candidate_profitable quote buy_market sell_market input_token input result :
  candidate quote buy_market sell_market input_token input = Some result ->
  0 < profit result /\ returned result = capital result + profit result /\
  route_validb (buy result) (sell result) (capital_token result) = true.
Proof.
  unfold candidate. destruct (_ && _) eqn:guard; [|discriminate].
  repeat rewrite andb_true_iff in guard.
  destruct guard as [[valid positive] bounded].
  destruct (quote_pool _ _ _ _) as [bridge|]; [|discriminate].
  destruct (quote_pool _ _ _ _) as [output|]; [|discriminate].
  destruct (_ && _) eqn:bounds; [|discriminate].
  destruct (settlement input output 0) as [gain|] eqn:settled; [|discriminate].
  intros equal. inversion equal; subst result. simpl.
  apply settlement_sound in settled. tauto.
Qed.

Lemma candidate_origins quote buy_market sell_market input_token input result :
  candidate quote buy_market sell_market input_token input = Some result ->
  buy result = buy_market /\ sell result = sell_market.
Proof.
  unfold candidate. destruct (_ && _); [|discriminate].
  destruct (quote_pool _ _ _ _) as [bridge|]; [|discriminate].
  destruct (quote_pool _ _ _ _) as [output|]; [|discriminate].
  destruct (_ && _); [|discriminate].
  destruct (settlement input output 0); [|discriminate].
  intros same. inversion same. auto.
Qed.

Definition capital_sizes places : list Z :=
  map (fun size => size * 10 ^ places) [1; 5; 10; 25; 50; 100; 200; 500].

Definition pair_candidates (places : Z) (quote : quote_function) (buy_market sell_market : pool)
    (input_token : address) : list opportunity :=
  flat_map (fun input =>
    match candidate quote buy_market sell_market input_token input with
    | Some result => [result] | None => [] end) (capital_sizes places).

Definition all_candidates (places : Z) (quote : quote_function) (selected : pool)
    (markets : list pool) (input_token : address) : list opportunity :=
  flat_map (fun other =>
    pair_candidates places quote selected other input_token ++
    pair_candidates places quote other selected input_token) markets.

Definition profitable (result : opportunity) : Prop :=
  0 < profit result /\ returned result = capital result + profit result.

Lemma pair_candidates_profitable places quote buy_market sell_market input_token result :
  In result (pair_candidates places quote buy_market sell_market input_token) -> profitable result.
Proof.
  unfold pair_candidates. rewrite in_flat_map.
  intros [input [size member]].
  destruct (candidate quote buy_market sell_market input_token input) as [found|] eqn:candidate_result;
    simpl in member; [|contradiction].
  destruct member as [same|member]; [subst found|contradiction].
  apply candidate_profitable in candidate_result. unfold profitable. tauto.
Qed.

Lemma all_candidates_profitable places quote selected markets input_token result :
  In result (all_candidates places quote selected markets input_token) -> profitable result.
Proof.
  unfold all_candidates. rewrite in_flat_map.
  intros [other [market member]]. apply in_app_iff in member.
  destruct member; eapply pair_candidates_profitable; eassumption.
Qed.

Lemma pair_candidates_origins places quote buy_market sell_market input_token result :
  In result (pair_candidates places quote buy_market sell_market input_token) ->
  buy result = buy_market /\ sell result = sell_market.
Proof.
  unfold pair_candidates. rewrite in_flat_map.
  intros [input [size member]].
  destruct (candidate quote buy_market sell_market input_token input) as [found|] eqn:candidate_result;
    simpl in member; [|contradiction].
  destruct member as [same|member]; [subst found|contradiction].
  apply candidate_origins in candidate_result. exact candidate_result.
Qed.

Lemma all_candidates_origins places quote selected markets input_token result :
  In selected markets ->
  In result (all_candidates places quote selected markets input_token) ->
  In (buy result) markets /\ In (sell result) markets.
Proof.
  intros selected_member. unfold all_candidates. rewrite in_flat_map.
  intros [other [other_member member]]. apply in_app_iff in member.
  destruct member as [forward|reverse]; apply pair_candidates_origins in forward ||
    apply pair_candidates_origins in reverse.
  - destruct forward as [buy_same sell_same]. rewrite buy_same, sell_same. auto.
  - destruct reverse as [buy_same sell_same]. rewrite buy_same, sell_same. auto.
Qed.

Fixpoint best (choices : list opportunity) : option opportunity :=
  match choices with
  | [] => None
  | head :: rest =>
      match best rest with
      | None => Some head
      | Some other => if profit other <=? profit head then Some head else Some other
      end
  end.

Theorem best_member choices result :
  best choices = Some result -> In result choices.
Proof.
  induction choices as [|head rest induction]; simpl; [discriminate|].
  destruct (best rest) as [other|] eqn:tail.
  - destruct (_ <=? _); intros equal; inversion equal; subst; auto.
  - intros equal; inversion equal; subst; auto.
Qed.

Lemma best_none choices : best choices = None -> choices = [].
Proof.
  destruct choices as [|head rest]; [reflexivity|].
  simpl. destruct (best rest) as [other|]; [destruct (_ <=? _)|]; discriminate.
Qed.

Theorem best_maximum choices result :
  best choices = Some result ->
  forall choice, In choice choices -> profit choice <= profit result.
Proof.
  revert result.
  induction choices as [|head rest induction]; intros result; simpl; [discriminate|].
  destruct (best rest) as [other|] eqn:tail.
  - specialize (induction other eq_refl).
    destruct (profit other <=? profit head) eqn:compare;
      intros equal choice member; inversion equal; subst result.
    + apply Z.leb_le in compare.
      destruct member as [same|member]; [subst choice; lia|].
      specialize (induction choice member). lia.
    + apply Z.leb_gt in compare.
      destruct member as [same|member]; [subst choice; lia|].
      apply induction. exact member.
  - apply best_none in tail. subst rest.
    intros equal choice member. inversion equal; subst result.
    destruct member as [same|member]; [subst choice; lia|contradiction].
Qed.

Definition find_pool (reference : pool) (markets : list pool) :=
  find (pool_eqb reference) markets.

Definition scan (places : Z) (quote : quote_function) (selected : pool)
    (markets : list pool) (input_token : address) :=
  match find_pool selected markets with
  | None => None
  | Some current => best (all_candidates places quote current markets input_token)
  end.

Definition supported_markets (supports : pool -> bool) (markets : list pool) :=
  filter supports markets.
Definition scan_supported (places : Z) (quote : quote_function) (selected : pool)
    (markets : list pool) (input_token : address) (supports : pool -> bool) :=
  scan places quote selected (supported_markets supports markets) input_token.

Lemma supported_markets_sound supports markets market :
  In market (supported_markets supports markets) -> supports market = true.
Proof. unfold supported_markets. rewrite filter_In. tauto. Qed.

Theorem scan_profitable places quote selected markets input_token result :
  scan places quote selected markets input_token = Some result -> profitable result.
Proof.
  unfold scan. destruct (find_pool selected markets); [|discriminate].
  intros selected_best. apply best_member in selected_best.
  eapply all_candidates_profitable. exact selected_best.
Qed.

Theorem scan_members places quote selected markets input_token result :
  scan places quote selected markets input_token = Some result ->
  In (buy result) markets /\ In (sell result) markets.
Proof.
  unfold scan. destruct (find_pool selected markets) as [current|] eqn:found;
    [|discriminate].
  intros selected_best. apply best_member in selected_best.
  unfold find_pool in found. apply find_some in found.
  eapply all_candidates_origins; [exact (proj1 found)|exact selected_best].
Qed.

Theorem scan_supported_has_supported_pools places quote selected markets input_token supports result :
  scan_supported places quote selected markets input_token supports = Some result ->
  supports (buy result) = true /\ supports (sell result) = true.
Proof.
  unfold scan_supported. intro found. apply scan_members in found as [buy_member sell_member].
  split.
  - eapply supported_markets_sound. exact buy_member.
  - eapply supported_markets_sound. exact sell_member.
Qed.

Theorem scan_maximum places quote selected markets input_token result :
  scan places quote selected markets input_token = Some result ->
  exists current, find_pool selected markets = Some current /\
    forall choice, In choice (all_candidates places quote current markets input_token) ->
      profit choice <= profit result.
Proof.
  unfold scan. destruct (find_pool selected markets) as [current|] eqn:found;
    [|discriminate].
  intros selected_best. exists current. split; [reflexivity|].
  apply best_maximum. exact selected_best.
Qed.

Inductive error := InvalidMinimum | InvalidRoute | InsufficientCapital
  | ProfitBelowMinimum | InvalidTime | InvalidArbitrage | InvalidAllowance.
Record execution := Execution {
  execution_route : opportunity;
  minimum_profit : Z;
  deadline : Z;
  approval_required : bool;
  calls : list contract_call
}.
Inductive decision := Rejected (why : error) | Prepared (plan : execution).

Definition prepare (arbitrage : address) (route : opportunity)
    (minimum : option Z) (balance allowance now : Z) : decision :=
  match minimum with
  | None => Rejected InvalidMinimum
  | Some required =>
      if negb (uint256b required) then Rejected InvalidMinimum else
      if negb (route_validb (buy route) (sell route) (capital_token route) &&
               (0 <? capital route) && uint256b (capital route) && uint256b (returned route))
      then Rejected InvalidRoute else
      if negb (uint256b balance && (capital route <=? balance))
      then Rejected InsufficientCapital else
      if negb (uint256b allowance) then Rejected InvalidAllowance else
      if negb (nonzero_addressb arbitrage) then Rejected InvalidArbitrage else
      if negb (Types.valid_call_time now) then Rejected InvalidTime else
      match settlement (capital route) (returned route) required with
      | None => Rejected ProfitBelowMinimum
      | Some gain =>
          let command := ExecuteArbitrage arbitrage
            (exchange (buy route)) (exchange (sell route))
            (pool_id (buy route)) (pool_id (sell route))
            (capital_token route) (capital route) required (Types.call_deadline now) in
          Prepared (Execution
            (Opportunity (buy route) (sell route) (capital_token route)
              (capital route) (intermediate route) (returned route) gain)
            required (Types.call_deadline now) (Types.approval_needed allowance (capital route))
            (if Types.approval_needed allowance (capital route)
             then [ApproveToken (capital_token route) arbitrage (capital route); command]
             else [command]))
      end
  end.

Theorem prepare_profitable arbitrage route minimum balance allowance now plan :
  prepare arbitrage route minimum balance allowance now = Prepared plan ->
  0 < profit (execution_route plan) /\
  minimum_profit plan <= profit (execution_route plan) /\
  returned (execution_route plan) =
    capital (execution_route plan) + profit (execution_route plan).
Proof.
  unfold prepare. destruct minimum as [required|]; [|discriminate].
  destruct (negb (uint256b required)); [discriminate|].
  destruct (negb (route_validb (buy route) (sell route) (capital_token route) &&
    (0 <? capital route) && uint256b (capital route) && uint256b (returned route)));
    [discriminate|].
  destruct (negb (uint256b balance && (capital route <=? balance))); [discriminate|].
  destruct (negb (uint256b allowance)); [discriminate|].
  destruct (negb (nonzero_addressb arbitrage)); [discriminate|].
  destruct (negb (Types.valid_call_time now)); [discriminate|].
  destruct (settlement (capital route) (returned route) required) as [gain|] eqn:settled;
    [|discriminate].
  intros equal. inversion equal; subst plan. simpl.
  apply settlement_sound in settled. tauto.
Qed.

Theorem prepare_at_valid_time arbitrage route minimum balance allowance before after plan :
  prepare arbitrage route minimum balance allowance before = Prepared plan ->
  Types.valid_call_time after = true ->
  exists current,
    prepare arbitrage route minimum balance allowance after = Prepared current /\
    execution_route current = execution_route plan /\
    minimum_profit current = minimum_profit plan /\
    approval_required current = approval_required plan /\
    deadline current = Types.call_deadline after.
Proof.
  unfold prepare. destruct minimum as [required|]; [|discriminate].
  destruct (negb (uint256b required)); [discriminate|].
  destruct (negb (route_validb (buy route) (sell route) (capital_token route) &&
    (0 <? capital route) && uint256b (capital route) && uint256b (returned route)));
    [discriminate|].
  destruct (negb (uint256b balance && (capital route <=? balance))); [discriminate|].
  destruct (negb (uint256b allowance)); [discriminate|].
  destruct (negb (nonzero_addressb arbitrage)); [discriminate|].
  destruct (negb (Types.valid_call_time before)); [discriminate|].
  destruct (settlement (capital route) (returned route) required); [|discriminate].
  intros prepared valid. inversion prepared; subst plan.
  rewrite valid. cbn -[Types.call_deadline Types.approval_needed].
  eexists. split; [reflexivity|]. repeat split; reflexivity.
Qed.

Definition prepare_request (quote : quote_function) (arbitrage : address)
    (buy_reference sell_reference : pool) (markets : list pool)
    (input_token : address) (input : Z) (minimum : option Z)
    (balance allowance now : Z) : decision :=
  match find_pool buy_reference markets, find_pool sell_reference markets with
  | Some buy_current, Some sell_current =>
      match candidate quote buy_current sell_current input_token input with
      | Some current => prepare arbitrage current minimum balance allowance now
      | None => Rejected InvalidRoute
      end
  | _, _ => Rejected InvalidRoute
  end.

Definition prepare_supported (quote : quote_function) (arbitrage : address)
    (buy_reference sell_reference : pool) (markets : list pool)
    (input_token : address) (input : Z) (minimum : option Z)
    (balance allowance now : Z) (supports : pool -> bool) : decision :=
  if supports buy_reference && supports sell_reference
  then prepare_request quote arbitrage buy_reference sell_reference
    (supported_markets supports markets) input_token input minimum balance allowance now
  else Rejected InvalidRoute.

Theorem prepare_supported_rejects_unsupported quote arbitrage buy_reference sell_reference
    markets input_token input minimum balance allowance now supports :
  supports buy_reference && supports sell_reference = false ->
  prepare_supported quote arbitrage buy_reference sell_reference markets input_token
    input minimum balance allowance now supports = Rejected InvalidRoute.
Proof. intro unsupported. unfold prepare_supported. now rewrite unsupported. Qed.

Theorem prepare_request_profitable quote arbitrage buy_reference sell_reference
    markets input_token input minimum balance allowance now plan :
  prepare_request quote arbitrage buy_reference sell_reference markets input_token
    input minimum balance allowance now = Prepared plan ->
  0 < profit (execution_route plan) /\
  minimum_profit plan <= profit (execution_route plan) /\
  returned (execution_route plan) =
    capital (execution_route plan) + profit (execution_route plan).
Proof.
  unfold prepare_request.
  destruct (find_pool buy_reference markets); [|discriminate].
  destruct (find_pool sell_reference markets); [|discriminate].
  destruct (candidate quote p p0 input_token input); [|discriminate].
  apply prepare_profitable.
Qed.

Definition preview (arbitrage : address) (route : option opportunity)
    (minimum : option Z) (balance : Z) : option decision :=
  match minimum with
  | None => Some (Rejected InvalidMinimum)
  | Some _ =>
      match route with
      | None => None
      | Some current => Some (prepare arbitrage current minimum balance 0 0)
      end
  end.

Section AtomicRoundTrip.
  Context {State : Type}.
  Variable buy_step : State -> option (State * Z).
  Variable sell_step : State -> Z -> option (State * Z).

  (* State contains contract/ERC20 state; gas charges and sender nonces are outside it.
     The continuations denote the two external calls, not an implementation of EVM. *)
  Definition speculative_roundtrip (original : State) (input minimum : Z) :=
    match buy_step original with
    | None => None
    | Some (after_buy, bridge) =>
        match sell_step after_buy bridge with
        | None => None
        | Some (after_sell, output) =>
            match settlement input output minimum with
            | None => None
            | Some gain => Some (after_sell, gain)
            end
        end
    end.

  Definition atomic_roundtrip (original : State) (input minimum : Z) :=
    atomic_call original (speculative_roundtrip original input minimum)
      "Arbitrage: unsuccessful round trip".

  Theorem failed_second_leg_rolls_back original input minimum after_buy bridge :
    buy_step original = Some (after_buy, bridge) ->
    sell_step after_buy bridge = None ->
    atomic_roundtrip original input minimum =
      Reverted original "Arbitrage: unsuccessful round trip".
  Proof.
    intros first second. unfold atomic_roundtrip, speculative_roundtrip.
    rewrite first, second. reflexivity.
  Qed.

  Theorem insufficient_return_rolls_back original input minimum after_buy bridge after_sell output :
    buy_step original = Some (after_buy, bridge) ->
    sell_step after_buy bridge = Some (after_sell, output) ->
    (output <= input \/ output - input < minimum) ->
    atomic_roundtrip original input minimum =
      Reverted original "Arbitrage: unsuccessful round trip".
  Proof.
    intros first second loss. unfold atomic_roundtrip, speculative_roundtrip.
    rewrite first, second. unfold settlement.
    destruct loss as [loss|threshold].
    - assert ((input <? output) = false) by (apply Z.ltb_ge; lia).
      rewrite H. reflexivity.
    - assert ((minimum <=? output - input) = false) by (apply Z.leb_gt; lia).
      rewrite H, andb_false_r. reflexivity.
  Qed.

  Theorem committed_roundtrip_profit original input minimum final gain :
    atomic_roundtrip original input minimum = Committed final gain ->
    exists after_buy bridge output,
      buy_step original = Some (after_buy, bridge) /\
      sell_step after_buy bridge = Some (final, output) /\
      0 < gain /\ minimum <= gain /\ output = input + gain.
  Proof.
    unfold atomic_roundtrip, speculative_roundtrip.
    destruct (buy_step original) as [[after_buy bridge]|] eqn:first; [|discriminate].
    destruct (sell_step after_buy bridge) as [[after_sell output]|] eqn:second;
      [|discriminate].
    destruct (settlement input output minimum) as [profit_value|] eqn:settled;
      [|discriminate].
    simpl. intros committed. inversion committed; subst final gain.
    exists after_buy, bridge, output. apply settlement_sound in settled.
    repeat split; tauto.
  Qed.
End AtomicRoundTrip.

End Arbitrage.
