From Coq Require Import ZArith String List Bool Lia.
From DEXFormal.Spec Require Import Types Units Assets AMM.
Import ListNotations.
Open Scope string_scope.
Open Scope Z_scope.

Record pool := Pool {
  exchange : address;
  exchange_name : string;
  pool_id : Z;
  token0 : address;
  token1 : address;
  reserve0 : Z;
  reserve1 : Z;
  total_shares : Z;
  created_at : Z
}.

Record environment := Environment {
  base : AMM.swap_environment;
  pools : list pool;
  exchanges : list address;
  metadata : list (address * Z);
  block : Z
}.

Definition same_pair a b c d :=
  (String.eqb a c && String.eqb b d) ||
  (String.eqb a d && String.eqb b c).
Definition pool_key p := exchange p ++ ":" ++ integer_text (pool_id p).
Definition registered e p :=
  existsb (String.eqb (exchange p)) (exchanges e) &&
  (0 <? pool_id p) && uint256b (pool_id p).
Definition precision e token :=
  match find (fun item => String.eqb (fst item) token) (metadata e) with
  | Some item => snd item
  | None => -1
  end.
Definition asset_supported e token :=
  existsb (String.eqb token) (AMM.environment_assets (base e)) &&
  valid_precision (precision e token).
Definition catalog_pool e p :=
  registered e p && asset_supported e (token0 p) && asset_supported e (token1 p) &&
  negb (String.eqb (token0 p) (token1 p)).
Definition pair_catalog e := filter (catalog_pool e) (pools e).
Definition for_current_pair e p :=
  same_pair (token0 p) (token1 p)
    (AMM.environment_token0 (base e)) (AMM.environment_token1 (base e)).
Definition route_catalog e := filter (for_current_pair e) (pair_catalog e).

(* Filtering the tail changes its structural shape, so the bounded traversal
   carries the source length rather than pretending it is a recursive subterm. *)
Fixpoint pairs_with_fuel fuel (rows : list pool) : list pool :=
  match fuel, rows with
  | O, _ | _, [] => []
  | S remaining, p :: rest => p :: pairs_with_fuel remaining
      (filter (fun q => negb (same_pair (token0 p) (token1 p) (token0 q) (token1 q))) rest)
  end.
Definition pairs e := let rows := pair_catalog e in pairs_with_fuel (length rows) rows.

Definition balance_for e token :=
  if String.eqb token (AMM.environment_token0 (base e)) then
    AMM.environment_balance0 (base e)
  else if String.eqb token (AMM.environment_token1 (base e)) then
    AMM.environment_balance1 (base e) else None.
Definition pool_environment e p : AMM.swap_environment := {|
  AMM.environment_assets := AMM.environment_assets (base e);
  AMM.environment_token0 := token0 p;
  AMM.environment_token1 := token1 p;
  AMM.environment_reserve0 := reserve0 p;
  AMM.environment_reserve1 := reserve1 p;
  AMM.environment_balance0 := balance_for e (token0 p);
  AMM.environment_balance1 := balance_for e (token1 p);
  AMM.environment_decimals0 := precision e (token0 p);
  AMM.environment_decimals1 := precision e (token1 p);
  AMM.environment_connected := AMM.environment_connected (base e);
  AMM.environment_pending := AMM.environment_pending (base e)
|}.

Definition route_quote e draft p : option Z :=
  let current := pool_environment e p in
  let direction := AMM.draft_orientation current draft in
  match positive_units (AMM.draft_precision current draft) (AMM.draft_amount draft) with
  | None => None
  | Some input => match checked_amount_out (input_reserve direction) (output_reserve direction) input with
      | Some output => if 0 <? output then Some output else None
      | None => None
      end
  end.

Definition quoted_routes e draft : list (pool * Z) :=
  flat_map (fun p => match route_quote e draft p with
    | Some output => [(p, output)] | None => [] end) (route_catalog e).

(* Equal quotes retain source order. The client snapshot enumerates configured
   exchanges and their pool IDs deterministically. No float or spot-price
   comparison participates in this decision. *)
Fixpoint highest (rows : list (pool * Z)) : option (pool * Z) :=
  match rows with
  | [] => None
  | item :: rest => match highest rest with
      | None => Some item
      | Some other => if snd other <=? snd item then Some item else Some other
      end
  end.

Inductive mode := BestQuote | ManualPool (key : string).
Record prepared := Prepared {
  prepared_pool : pool;
  prepared_environment : AMM.swap_environment;
  prepared_token : address;
  prepared_input : Z;
  prepared_output : Z;
  prepared_slippage : Z;
  prepared_minimum : Z;
  prepared_block : Z
}.
Definition prepared_direction plan := AMM.orient_trade
  (token0 (prepared_pool plan)) (token1 (prepared_pool plan)) (prepared_token plan)
  (reserve0 (prepared_pool plan)) (reserve1 (prepared_pool plan)).
Record state := State {
  draft : AMM.swap_draft;
  choice : mode;
  pair0 : address;
  pair1 : address;
  submitted : option prepared
}.
Definition initial token := State (AMM.initial_draft token) BestQuote token EmptyString None.
Definition reconcile e s :=
  let a := AMM.environment_token0 (base e) in
  let b := AMM.environment_token1 (base e) in
  let result :=
    if String.eqb (pair1 s) EmptyString then
      State (if AMM.draft_belongs (base e) (draft s) then draft s else AMM.initial_draft a)
        (choice s) a b (submitted s)
    else if same_pair (pair0 s) (pair1 s) a b then s
    else State (AMM.initial_draft a) BestQuote a b None in
  if AMM.environment_pending (base e) then result
  else State (draft result) (choice result) (pair0 result) (pair1 result) None.

Definition funded p :=
  (0 <? reserve0 p) && (0 <? reserve1 p) &&
  (reserve0 p <=? max_reserve) && (reserve1 p <=? max_reserve).
Definition fallback e :=
  match find funded (route_catalog e) with
  | Some p => Some p
  | None => hd_error (route_catalog e)
  end.
Definition live_pool e s :=
  match choice s with
  | ManualPool key => find (fun p => String.eqb (pool_key p) key) (route_catalog e)
  | BestQuote => match highest (quoted_routes e (draft s)) with
      | Some item => Some (fst item)
      | None => fallback e
      end
  end.
Definition selected_pool e s :=
  if AMM.environment_pending (base e) then
    match submitted s with Some plan => Some (prepared_pool plan) | None => live_pool e s end
  else live_pool e s.
Definition with_current_status e current : AMM.swap_environment := {|
  AMM.environment_assets := AMM.environment_assets current;
  AMM.environment_token0 := AMM.environment_token0 current;
  AMM.environment_token1 := AMM.environment_token1 current;
  AMM.environment_reserve0 := AMM.environment_reserve0 current;
  AMM.environment_reserve1 := AMM.environment_reserve1 current;
  AMM.environment_balance0 := AMM.environment_balance0 current;
  AMM.environment_balance1 := AMM.environment_balance1 current;
  AMM.environment_decimals0 := AMM.environment_decimals0 current;
  AMM.environment_decimals1 := AMM.environment_decimals1 current;
  AMM.environment_connected := AMM.environment_connected (base e);
  AMM.environment_pending := AMM.environment_pending (base e)
|}.
Definition selected_environment e s :=
  if AMM.environment_pending (base e) then
    match submitted s with
    | Some plan => with_current_status e (prepared_environment plan)
    | None => match live_pool e s with Some p => pool_environment e p | None => base e end
    end
  else match live_pool e s with Some p => pool_environment e p | None => base e end.

Inductive event := DraftEvent (value : AMM.swap_event) | ChooseRoute (value : mode).
Inductive effect := NoEffect | OpenWallet | Execute (plan : prepared).
Definition next_effect e s value :=
  match value with
  | ChooseRoute _ => NoEffect
  | DraftEvent input =>
      match selected_pool e s with
      | None => NoEffect
      | Some p =>
          let current := selected_environment e s in
          match AMM.draft_effect current (draft s) input with
          | NoSwapEffect => NoEffect
          | OpenWalletEffect => OpenWallet
          | RequestSwapEffect token amount output slippage =>
              Execute (Prepared p current token amount output slippage
                (minimum_received output slippage) (block e))
          end
      end
  end.
Definition step e s value :=
  let s := reconcile e s in
  if AMM.environment_pending (base e) then s else
  match value with
  | ChooseRoute next => State (draft s) next (pair0 s) (pair1 s) None
  | DraftEvent input =>
      let plan := match next_effect e s value with Execute plan => Some plan | _ => None end in
      State (AMM.step_draft (selected_environment e s) (draft s) input)
        (choice s) (pair0 s) (pair1 s) plan
  end.

Definition selection_message e s :=
  match selected_pool e s with
  | Some _ => None
  | None => Some (match choice s with
      | BestQuote => "No supported direct pool is available for this pair."
      | ManualPool _ => "The selected pool is unavailable for this pair. Choose another pool or Best quote."
      end)
  end.

Definition current_preview e s :=
  match selected_pool e s with
  | Some _ => AMM.draft_preview (selected_environment e s) (draft s)
  | None => AMM.preview AMM.QuoteUnavailable None None None None
  end.
Definition can_submit e s :=
  match selected_pool e s with
  | None => false
  | Some _ => AMM.swap_can_submit (AMM.environment_connected (base e))
      (AMM.environment_pending (base e)) (current_preview e s)
  end.
Definition disabled e s :=
  match selected_pool e s with
  | None => true
  | Some _ => AMM.swap_disabled (AMM.environment_connected (base e))
      (AMM.environment_pending (base e)) (current_preview e s)
  end.
Definition action e s :=
  match selected_pool e s with
  | None => "Pool unavailable"
  | Some _ => AMM.swap_action (AMM.environment_connected (base e))
      (AMM.environment_pending (base e)) (current_preview e s)
  end.
Definition message e s :=
  match selection_message e s with
  | Some value => Some value
  | None => AMM.swap_error (current_preview e s)
  end.
Definition manual_key s := match choice s with BestQuote => None | ManualPool key => Some key end.
Definition manual_unavailable e s :=
  match choice s with
  | BestQuote => false
  | ManualPool key => match find (fun p => String.eqb (pool_key p) key) (route_catalog e) with
      | Some _ => false | None => true end
  end.
Definition pair_key e :=
  match find (for_current_pair e) (pairs e) with Some p => Some (pool_key p) | None => None end.
Definition view_block e s :=
  if AMM.environment_pending (base e) then
    match submitted s with Some plan => prepared_block plan | None => block e end
  else block e.

Lemma highest_none_is_empty rows : highest rows = None -> rows = [].
Proof.
  destruct rows as [|item rest]; auto. simpl.
  destruct (highest rest) as [other|]; try discriminate.
  destruct (snd other <=? snd item); discriminate.
Qed.

Theorem highest_is_member rows item : highest rows = Some item -> In item rows.
Proof.
  induction rows as [|head rest IH]; simpl; try discriminate.
  destruct (highest rest) as [other|] eqn:Hrest.
  - destruct (snd other <=? snd head); intro H; inversion H; subst; auto.
  - intro H; inversion H; subst; auto.
Qed.

Theorem highest_dominates rows selected item :
  highest rows = Some selected -> In item rows -> snd item <= snd selected.
Proof.
  revert selected item. induction rows as [|head rest IH]; intros selected item; simpl; try discriminate.
  destruct (highest rest) as [other|] eqn:Hrest.
  - destruct (snd other <=? snd head) eqn:Hcompare.
    + intros Hselected Hitem. inversion Hselected; subst selected.
      destruct Hitem as [Hequal|Hin].
      * subst item. lia.
      * apply Z.leb_le in Hcompare. specialize (IH other item eq_refl Hin). lia.
    + intros Hselected Hitem. inversion Hselected; subst selected.
      destruct Hitem as [Hequal|Hin].
      * subst item. apply Z.leb_gt in Hcompare. lia.
      * exact (IH other item eq_refl Hin).
  - intros Hselected Hitem. inversion Hselected; subst selected.
    destruct Hitem as [Hequal|Hin].
    + subst item. lia.
    + apply highest_none_is_empty in Hrest. subst. contradiction.
Qed.

Theorem quoted_route_is_eligible e d p output :
  In (p, output) (quoted_routes e d) ->
  In p (route_catalog e) /\ route_quote e d p = Some output.
Proof.
  unfold quoted_routes. rewrite in_flat_map. intros [candidate [Hin Hquote]].
  destruct (route_quote e d candidate) eqn:Hvalue; simpl in Hquote; try contradiction.
  destruct Hquote as [Hequal|Hfalse]; try contradiction.
  inversion Hequal; subst. auto.
Qed.

Theorem automatic_quote_is_maximal e d p output candidate other :
  highest (quoted_routes e d) = Some (p, output) ->
  In (candidate, other) (quoted_routes e d) -> other <= output.
Proof. intros Hselected Hin. exact (highest_dominates _ _ _ Hselected Hin). Qed.

Theorem automatic_quote_is_member e d p output :
  highest (quoted_routes e d) = Some (p, output) ->
  In p (route_catalog e) /\ route_quote e d p = Some output.
Proof. intro H. apply quoted_route_is_eligible. now apply highest_is_member. Qed.

Theorem manual_choice_keeps_key e s key p :
  choice s = ManualPool key -> live_pool e s = Some p -> pool_key p = key.
Proof.
  intros Hchoice Hselected. unfold live_pool in Hselected. rewrite Hchoice in Hselected.
  apply find_some in Hselected as [_ Hkey]. now apply String.eqb_eq.
Qed.

Theorem missing_manual_pool_has_no_effect e s key value :
  choice s = ManualPool key -> AMM.environment_pending (base e) = false ->
  find (fun p => String.eqb (pool_key p) key) (route_catalog e) = None ->
  next_effect e s value = NoEffect.
Proof.
  intros Hchoice Hpending Hmissing. destruct value; auto.
  unfold next_effect, selected_pool, live_pool. rewrite Hpending, Hchoice, Hmissing. reflexivity.
Qed.

Theorem no_selected_pool_has_no_effect e s value :
  selected_pool e s = None -> next_effect e s value = NoEffect.
Proof. intro H. destruct value; auto. unfold next_effect. now rewrite H. Qed.

Theorem execution_uses_shared_frontend e s input plan :
  next_effect e s (DraftEvent input) = Execute plan ->
  AMM.draft_effect (prepared_environment plan) (draft s) input =
    RequestSwapEffect (prepared_token plan) (prepared_input plan)
      (prepared_output plan) (prepared_slippage plan).
Proof.
  unfold next_effect. destruct (selected_pool e s) as [p|]; try discriminate.
  destruct (AMM.draft_effect (selected_environment e s) (draft s) input) eqn:H; try discriminate.
  intro Hequal. inversion Hequal; subst. exact H.
Qed.

Theorem execution_captures_selected_pool e s input plan :
  next_effect e s (DraftEvent input) = Execute plan ->
  selected_pool e s = Some (prepared_pool plan).
Proof.
  unfold next_effect. destruct (selected_pool e s) as [p|] eqn:Hpool; try discriminate.
  destruct (AMM.draft_effect (selected_environment e s) (draft s) input); try discriminate.
  intro H. inversion H; subst. reflexivity.
Qed.

Theorem execution_minimum_is_quote_bound e s input plan :
  next_effect e s (DraftEvent input) = Execute plan ->
  prepared_minimum plan = minimum_received (prepared_output plan) (prepared_slippage plan).
Proof.
  unfold next_effect. destruct (selected_pool e s); try discriminate.
  destruct (AMM.draft_effect (selected_environment e s) (draft s) input); try discriminate.
  intro H. inversion H; subst. reflexivity.
Qed.

Theorem pending_keeps_captured_pool e s plan :
  AMM.environment_pending (base e) = true -> submitted s = Some plan ->
  selected_pool e s = Some (prepared_pool plan).
Proof. intros Hpending Hplan. unfold selected_pool. now rewrite Hpending, Hplan. Qed.

Theorem pending_step_does_not_edit e s value :
  AMM.environment_pending (base e) = true -> step e s value = reconcile e s.
Proof. intro H. unfold step. now rewrite H. Qed.

Lemma selected_environment_pending e s :
  AMM.environment_pending (selected_environment e s) = AMM.environment_pending (base e).
Proof.
  unfold selected_environment.
  destruct (AMM.environment_pending (base e)) eqn:Hpending;
    destruct (submitted s); destruct (live_pool e s);
    unfold with_current_status, pool_environment; simpl; now rewrite Hpending.
Qed.

Theorem execution_environment_is_selected_pool e s input plan :
  next_effect e s (DraftEvent input) = Execute plan ->
  AMM.environment_pending (base e) = false /\
  prepared_environment plan = pool_environment e (prepared_pool plan).
Proof.
  unfold next_effect. destruct (selected_pool e s) as [p|] eqn:Hpool; try discriminate.
  destruct (AMM.draft_effect (selected_environment e s) (draft s) input) eqn:Hrequest; try discriminate.
  intro H. inversion H; subst.
  apply AMM.request_swap_requires_ready in Hrequest as [_ [Hpending _]].
  rewrite selected_environment_pending in Hpending. split; [exact Hpending|].
  unfold selected_pool in Hpool. rewrite Hpending in Hpool.
  unfold selected_environment. rewrite Hpending, Hpool. reflexivity.
Qed.

Lemma frontend_request_keeps_token current d token input output slippage :
  AMM.draft_effect current d SubmitDraft = RequestSwapEffect token input output slippage ->
  token = AMM.draft_token d.
Proof.
  unfold AMM.draft_effect.
  destruct (AMM.swap_submit_action (AMM.environment_connected current)
    (AMM.environment_pending current) (AMM.draft_preview current d)); try discriminate.
  destruct (AMM.preview_amount (AMM.draft_preview current d)); try discriminate.
  destruct (AMM.preview_output (AMM.draft_preview current d)); try discriminate.
  destruct (AMM.preview_slippage (AMM.draft_preview current d)); try discriminate.
  intro H. now inversion H.
Qed.

Lemma frontend_request_reproduces_route_quote e d p token input output slippage :
  AMM.draft_effect (pool_environment e p) d SubmitDraft = RequestSwapEffect token input output slippage ->
  route_quote e d p = Some output.
Proof.
  intro Heffect. pose proof Heffect as Hready.
  apply AMM.request_swap_requires_ready in Hready as [Hconnected [Hpending Hready]].
  unfold AMM.draft_effect, AMM.swap_submit_action, AMM.swap_can_submit in Heffect.
  rewrite Hconnected, Hpending, Hready in Heffect. cbn -[AMM.draft_preview] in Heffect.
  unfold AMM.draft_preview in Hready, Heffect.
  destruct (Assets.pool_assets_supported (AMM.environment_assets (pool_environment e p))
    (AMM.environment_token0 (pool_environment e p)) (AMM.environment_token1 (pool_environment e p))); [|discriminate].
  destruct (AMM.draft_belongs (pool_environment e p) d); [|discriminate].
  cbn zeta in Hready, Heffect. unfold AMM.analyze_swap in Hready, Heffect.
  destruct (Z.leb (input_reserve (AMM.draft_orientation (pool_environment e p) d)) 0 ||
    Z.leb (output_reserve (AMM.draft_orientation (pool_environment e p) d)) 0)%bool; try discriminate.
  destruct (empty_amount (AMM.draft_amount d)); try discriminate.
  destruct (positive_units (AMM.draft_precision (pool_environment e p) d) (AMM.draft_amount d)) as [amount|] eqn:Hamount; try discriminate.
  destruct (checked_amount_out (input_reserve (AMM.draft_orientation (pool_environment e p) d))
    (output_reserve (AMM.draft_orientation (pool_environment e p) d)) amount) as [quoted|] eqn:Hquote; try discriminate.
  destruct (Z.leb quoted 0) eqn:Hpositive; try discriminate.
  destruct (parse_slippage_bps (AMM.draft_slippage d)); try discriminate.
  destruct (AMM.draft_balance (pool_environment e p) d) as [balance|]; try discriminate.
  destruct (Z.leb amount balance); try discriminate.
  inversion Heffect; subst.
  unfold route_quote. rewrite Hamount, Hquote.
  assert (0 <? output = true) as Hgt by (apply Z.ltb_lt; apply Z.leb_gt in Hpositive; exact Hpositive).
  now rewrite Hgt.
Qed.

Lemma fallback_is_catalog_member e p : fallback e = Some p -> In p (route_catalog e).
Proof.
  unfold fallback. destruct (find funded (route_catalog e)) as [found|] eqn:Hfind.
  - intro H. inversion H; subst. now apply find_some in Hfind as [Hfind _].
  - destruct (route_catalog e) as [|head rest]; simpl; try discriminate.
    intro H. inversion H; subst. now left.
Qed.

Theorem live_selection_is_catalog_member e s p :
  live_pool e s = Some p -> In p (route_catalog e).
Proof.
  unfold live_pool. destruct (choice s).
  - destruct (highest (quoted_routes e (draft s))) as [[selected output]|] eqn:Hhighest.
    + intro H. inversion H; subst. now apply automatic_quote_is_member in Hhighest as [Hin _].
    + apply fallback_is_catalog_member.
  - intro H. now apply find_some in H as [Hin _].
Qed.

Theorem execution_is_registered e s input plan :
  next_effect e s (DraftEvent input) = Execute plan ->
  In (prepared_pool plan) (route_catalog e) /\
  registered e (prepared_pool plan) = true.
Proof.
  intro H. pose proof (execution_captures_selected_pool _ _ _ _ H) as Hpool.
  pose proof (execution_environment_is_selected_pool _ _ _ _ H) as [Hpending _].
  unfold selected_pool in Hpool. rewrite Hpending in Hpool.
  apply live_selection_is_catalog_member in Hpool. split; [exact Hpool|].
  unfold route_catalog, pair_catalog in Hpool.
  apply filter_In in Hpool as [Hpool _]. apply filter_In in Hpool as [_ Hcatalog].
  unfold catalog_pool in Hcatalog. repeat rewrite andb_true_iff in Hcatalog. tauto.
Qed.

Theorem automatic_execution_is_maximal e s plan candidate output :
  choice s = BestQuote ->
  next_effect e s (DraftEvent SubmitDraft) = Execute plan ->
  In (candidate, output) (quoted_routes e (draft s)) -> output <= prepared_output plan.
Proof.
  intros Hchoice Heffect Hin.
  pose proof (execution_captures_selected_pool _ _ _ _ Heffect) as Hpool.
  pose proof (execution_environment_is_selected_pool _ _ _ _ Heffect) as [Hpending Hcurrent].
  pose proof (execution_uses_shared_frontend _ _ _ _ Heffect) as Hrequest.
  rewrite Hcurrent in Hrequest.
  pose proof (frontend_request_reproduces_route_quote _ _ _ _ _ _ _ Hrequest) as Hquote.
  pose proof (execution_is_registered _ _ _ _ Heffect) as [Hmember _].
  assert (In (prepared_pool plan, prepared_output plan) (quoted_routes e (draft s))) as Hown.
  { unfold quoted_routes. apply in_flat_map. exists (prepared_pool plan). split; [exact Hmember|].
    rewrite Hquote. simpl. now left. }
  unfold selected_pool in Hpool. rewrite Hpending in Hpool.
  unfold live_pool in Hpool. rewrite Hchoice in Hpool.
  destruct (highest (quoted_routes e (draft s))) as [[selected quoted]|] eqn:Hhighest.
  - inversion Hpool; subst selected.
    pose proof (automatic_quote_is_member _ _ _ _ Hhighest) as [_ Hselected].
    rewrite Hquote in Hselected. inversion Hselected; subst quoted.
    exact (automatic_quote_is_maximal _ _ _ _ _ _ Hhighest Hin).
  - apply highest_none_is_empty in Hhighest. rewrite Hhighest in Hown. contradiction.
Qed.

Theorem manual_execution_keeps_pool e s key input plan :
  choice s = ManualPool key -> next_effect e s (DraftEvent input) = Execute plan ->
  pool_key (prepared_pool plan) = key.
Proof.
  intros Hchoice Heffect.
  pose proof (execution_captures_selected_pool _ _ _ _ Heffect) as Hpool.
  pose proof (execution_environment_is_selected_pool _ _ _ _ Heffect) as [Hpending _].
  unfold selected_pool in Hpool. rewrite Hpending in Hpool.
  exact (manual_choice_keeps_key _ _ _ _ Hchoice Hpool).
Qed.

Theorem changed_pair_resets_manual e s :
  String.eqb (pair1 s) EmptyString = false ->
  same_pair (pair0 s) (pair1 s) (AMM.environment_token0 (base e))
    (AMM.environment_token1 (base e)) = false ->
  choice (reconcile e s) = BestQuote /\ submitted (reconcile e s) = None.
Proof.
  intros Hinitialized Hpair. unfold reconcile. rewrite Hinitialized, Hpair.
  destruct (AMM.environment_pending (base e)); auto.
Qed.

Theorem equal_quotes_prefer_first head rest other :
  highest rest = Some other -> snd head = snd other ->
  highest (head :: rest) = Some head.
Proof. intros Hrest Hequal. simpl. rewrite Hrest, Hequal, Z.leb_refl. reflexivity. Qed.

Theorem execution_matches_verified_pair e s input plan :
  next_effect e s (DraftEvent input) = Execute plan ->
  for_current_pair e (prepared_pool plan) = true /\
  valid_precision (precision e (token0 (prepared_pool plan))) = true /\
  valid_precision (precision e (token1 (prepared_pool plan))) = true.
Proof.
  intro H. apply execution_is_registered in H as [Hmember _].
  unfold route_catalog, pair_catalog in Hmember.
  apply filter_In in Hmember as [Hmember Hpair].
  apply filter_In in Hmember as [_ Hcatalog].
  unfold catalog_pool, asset_supported in Hcatalog.
  repeat rewrite andb_true_iff in Hcatalog. tauto.
Qed.

