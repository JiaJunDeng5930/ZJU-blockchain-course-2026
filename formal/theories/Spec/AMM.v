From Coq Require Import ZArith Bool String Lia.
From DEXFormal.Spec Require Import Types Units Assets.

Open Scope Z_scope.

Definition fee_denominator : Z := 10000.
Definition fee_bps : Z := 30.
Definition fee_multiplier : Z := fee_denominator - fee_bps.
Definition max_reserve : Z := 2 ^ 112 - 1.

Lemma reserve_constants_fit :
  0 < max_reserve /\ max_reserve * fee_denominator * max_reserve <= uint256_max /\
  max_reserve * fee_denominator <= uint256_max.
Proof.
  unfold max_reserve, fee_denominator, uint256_max.
  vm_compute. intuition discriminate.
Qed.

Definition bounded_reserves reserve_in reserve_out input : Prop :=
  0 < reserve_in <= max_reserve /\ 0 < reserve_out <= max_reserve /\
  0 <= input <= max_reserve - reserve_in.

Lemma bounded_reserve_arithmetic reserve_in reserve_out input :
  bounded_reserves reserve_in reserve_out input ->
  uint256 (input * fee_multiplier) /\
  uint256 (input * fee_multiplier * reserve_out) /\
  uint256 (reserve_in * fee_denominator + input * fee_multiplier) /\
  0 < reserve_in * fee_denominator + input * fee_multiplier /\
  uint256 (reserve_in + input).
Proof.
  unfold bounded_reserves. intros [[Hri HriMax] [[Hro HroMax] [Hi HiMax]]].
  pose proof reserve_constants_fit as [HM [Hproduct Hdenominator]].
  assert (Hweighted : 0 <= input * fee_multiplier <= max_reserve * fee_denominator).
  { unfold fee_multiplier, fee_denominator, fee_bps. nia. }
  assert (Hnumerator : 0 <= input * fee_multiplier * reserve_out <=
    max_reserve * fee_denominator * max_reserve).
  { split; [nia|]. apply Z.mul_le_mono_nonneg; lia. }
  assert (HdenominatorBound : 0 < reserve_in * fee_denominator + input * fee_multiplier <=
    max_reserve * fee_denominator).
  { unfold fee_multiplier, fee_denominator, fee_bps. nia. }
  unfold uint256. repeat split; try lia.
  - unfold fee_multiplier, fee_denominator, fee_bps in *. nia.
Qed.

(* The mathematical quote uses exact integers and floors the quotient.
   bounded_reserve_arithmetic justifies the production uint256 intermediates. *)
Definition amount_out (reserve_in reserve_out input : Z) : Z :=
  input * fee_multiplier * reserve_out /
    (reserve_in * fee_denominator + input * fee_multiplier).

Definition quote_inputsb (reserve_in reserve_out input : Z) : bool :=
  (uint256b reserve_in && uint256b reserve_out && uint256b input &&
  Z.ltb 0 reserve_in && Z.ltb 0 reserve_out &&
  uint256b (reserve_in * fee_denominator + input * fee_multiplier)) &&
  (Z.leb reserve_in max_reserve && Z.leb reserve_out max_reserve &&
   Z.leb input (max_reserve - reserve_in)).

Definition checked_amount_out (reserve_in reserve_out input : Z) : option Z :=
  if quote_inputsb reserve_in reserve_out input
  then Some (amount_out reserve_in reserve_out input) else None.

Lemma quote_inputs_complete reserve_in reserve_out input :
  bounded_reserves reserve_in reserve_out input -> quote_inputsb reserve_in reserve_out input = true.
Proof.
  intro Hdomain.
  pose proof (bounded_reserve_arithmetic reserve_in reserve_out input Hdomain)
    as [Hweighted [Hnumerator [Hdenominator [Hpositive Hsum]]]].
  pose proof reserve_constants_fit as [HM [_ Hmax]].
  unfold bounded_reserves in Hdomain.
  destruct Hdomain as [[Hri HriMax] [[Hro HroMax] [Hi HiMax]]].
  unfold quote_inputsb. repeat rewrite andb_true_iff.
  repeat rewrite uint256b_spec. repeat rewrite Z.ltb_lt. repeat rewrite Z.leb_le.
  unfold uint256 in *. unfold fee_denominator in Hmax.
  repeat split; lia.
Qed.

Theorem bounded_quote_total reserve_in reserve_out input :
  bounded_reserves reserve_in reserve_out input ->
  checked_amount_out reserve_in reserve_out input = Some (amount_out reserve_in reserve_out input).
Proof. intro H. unfold checked_amount_out. now rewrite quote_inputs_complete. Qed.

Lemma quote_inputs_sound reserve_in reserve_out input :
  quote_inputsb reserve_in reserve_out input = true ->
  bounded_reserves reserve_in reserve_out input.
Proof.
  unfold quote_inputsb, bounded_reserves.
  repeat rewrite andb_true_iff. repeat rewrite uint256b_spec.
  repeat rewrite Z.ltb_lt. repeat rewrite Z.leb_le.
  unfold uint256. intuition lia.
Qed.

Lemma checked_amount_out_domain reserve_in reserve_out input output :
  checked_amount_out reserve_in reserve_out input = Some output ->
  bounded_reserves reserve_in reserve_out input.
Proof.
  unfold checked_amount_out. destruct (quote_inputsb reserve_in reserve_out input) eqn:H;
    [intros _; now apply quote_inputs_sound|discriminate].
Qed.

Definition minimum_received (quoted slippage : Z) : Z :=
  quoted * (fee_denominator - slippage) / fee_denominator.

Lemma amount_out_bounds reserve_in reserve_out input :
  0 < reserve_in -> 0 < reserve_out -> 0 <= input ->
  0 <= amount_out reserve_in reserve_out input < reserve_out.
Proof.
  intros Hin Hout Hinput.
  unfold amount_out, fee_multiplier, fee_denominator, fee_bps.
  split.
  - apply Z.div_pos; nia.
  - apply Z.div_lt_upper_bound; nia.
Qed.

Theorem amount_out_preserves_product reserve_in reserve_out input :
  0 < reserve_in -> 0 < reserve_out -> 0 <= input ->
  reserve_in * reserve_out <=
    (reserve_in + input) * (reserve_out - amount_out reserve_in reserve_out input).
Proof.
  intros Hin Hout Hinput.
  pose proof (amount_out_bounds reserve_in reserve_out input Hin Hout Hinput) as Hbounds.
  unfold amount_out, fee_multiplier, fee_denominator, fee_bps in *.
  pose proof (Z.div_mod (input * (10000 - 30) * reserve_out)
    (reserve_in * 10000 + input * (10000 - 30)) ltac:(nia)) as Hdiv.
  pose proof (Z.mod_pos_bound (input * (10000 - 30) * reserve_out)
    (reserve_in * 10000 + input * (10000 - 30)) ltac:(nia)) as Hmod.
  nia.
Qed.

Theorem checked_amount_out_sound reserve_in reserve_out input output :
  checked_amount_out reserve_in reserve_out input = Some output ->
  uint256 output /\ 0 <= output < reserve_out /\
  reserve_in * reserve_out <= (reserve_in + input) * (reserve_out - output).
Proof.
  unfold checked_amount_out, quote_inputsb.
  destruct (uint256b reserve_in && uint256b reserve_out && uint256b input &&
    Z.ltb 0 reserve_in && Z.ltb 0 reserve_out &&
    uint256b (reserve_in * fee_denominator + input * fee_multiplier) &&
    (Z.leb reserve_in max_reserve && Z.leb reserve_out max_reserve &&
     Z.leb input (max_reserve - reserve_in))) eqn:Hvalid;
    try discriminate.
  intro E. inversion E; subst.
  apply andb_true_iff in Hvalid as [Hvalid Hdomain].
  repeat rewrite andb_true_iff in Hvalid.
  destruct Hvalid as [[[[[Hri Hro] Hi] HriPositive] HroPositive] Hd].
  apply uint256b_spec in Hri, Hro, Hi, Hd.
  apply Z.ltb_lt in HriPositive, HroPositive.
  pose proof (amount_out_bounds reserve_in reserve_out input HriPositive HroPositive
    ltac:(destruct Hi; lia)) as Hbounds.
  split; [unfold uint256 in *; lia|]. split; [exact Hbounds|].
  apply amount_out_preserves_product; try assumption. destruct Hi. assumption.
Qed.

Theorem minimum_received_bounds quoted slippage :
  0 <= quoted -> 0 <= slippage <= fee_denominator ->
  0 <= minimum_received quoted slippage <= quoted.
Proof.
  intros Hq Hs. unfold minimum_received, fee_denominator in *.
  split.
  - apply Z.div_pos; nia.
  - apply Z.div_le_upper_bound; nia.
Qed.

Theorem minimum_received_antitone quoted less_slippage more_slippage :
  0 <= quoted -> less_slippage <= more_slippage ->
  minimum_received quoted more_slippage <= minimum_received quoted less_slippage.
Proof.
  intros Hq Hslippage. unfold minimum_received, fee_denominator.
  apply Z.div_le_mono; nia.
Qed.

Record prepared_swap := {
  swap_input : Z;
  swap_output : Z;
  swap_minimum : Z;
  swap_slippage : Z
}.

Definition prepare_swap places reserve_in reserve_out balance amount_text slippage_text
    : option prepared_swap :=
  match positive_units places amount_text, parse_slippage_bps slippage_text with
  | Some input, Some slippage =>
      match checked_amount_out reserve_in reserve_out input with
      | Some output =>
          if Z.ltb 0 output && Z.leb input balance then
            Some {| swap_input := input; swap_output := output;
              swap_minimum := minimum_received output slippage;
              swap_slippage := slippage |}
          else None
      | None => None
      end
  | _, _ => None
  end.

Theorem prepare_swap_sound places reserve_in reserve_out balance amount_text slippage_text prepared :
  prepare_swap places reserve_in reserve_out balance amount_text slippage_text = Some prepared ->
  0 < swap_input prepared <= balance /\ uint256 (swap_input prepared) /\
  0 < swap_output prepared < reserve_out /\ uint256 (swap_output prepared) /\
  0 <= swap_slippage prepared <= 5000 /\
  swap_minimum prepared = minimum_received (swap_output prepared) (swap_slippage prepared) /\
  0 <= swap_minimum prepared <= swap_output prepared /\
  reserve_in * reserve_out <=
    (reserve_in + swap_input prepared) * (reserve_out - swap_output prepared).
Proof.
  unfold prepare_swap.
  destruct (positive_units places amount_text) as [input|] eqn:Ha; try discriminate.
  destruct (parse_slippage_bps slippage_text) as [slippage|] eqn:Hs; try discriminate.
  destruct (checked_amount_out reserve_in reserve_out input) as [output|] eqn:Hq;
    try discriminate.
  destruct (Z.ltb 0 output && Z.leb input balance) eqn:Hchecks; try discriminate.
  intro E. inversion E; subst; simpl.
  apply positive_units_sound in Ha as [Hpositive [Hinput _]].
  apply parse_slippage_bps_sound in Hs.
  apply checked_amount_out_sound in Hq as [Houtput [Hbounds Hproduct]].
  apply andb_true_iff in Hchecks as [HoutPositive Hbalance].
  apply Z.ltb_lt in HoutPositive. apply Z.leb_le in Hbalance.
  pose proof (minimum_received_bounds output slippage ltac:(lia)
    ltac:(unfold fee_denominator; lia)).
  tauto.
Qed.

Inductive swap_status :=
| EnterAmount | CheckAmount | PoolNeedsLiquidity | QuoteUnavailable
| CheckSlippage | ReadingBalance | InsufficientBalance | ReadyToSwap | UnsupportedPool.

Record swap_preview := {
  preview_status : swap_status;
  preview_amount : option Z;
  preview_output : option Z;
  preview_minimum : option Z;
  preview_slippage : option Z
}.

Definition preview status input output minimum slippage :=
  {| preview_status := status; preview_amount := input; preview_output := output;
     preview_minimum := minimum; preview_slippage := slippage |}.

Definition analyze_swap places reserve_in reserve_out (balance : option Z) amount_text slippage_text
    : swap_preview :=
  if (Z.leb reserve_in 0 || Z.leb reserve_out 0)%bool then
    preview PoolNeedsLiquidity None None None None
  else if empty_amount amount_text then
    preview EnterAmount None None None None
  else match positive_units places amount_text with
  | None => preview CheckAmount None None None None
  | Some input =>
      match checked_amount_out reserve_in reserve_out input with
      | None => preview QuoteUnavailable (Some input) None None None
      | Some output =>
          if Z.leb output 0 then
            preview QuoteUnavailable (Some input) (Some output) None None
          else match parse_slippage_bps slippage_text with
          | None => preview CheckSlippage (Some input) (Some output) None None
          | Some slippage =>
              let minimum := minimum_received output slippage in
              let status := match balance with
                | None => ReadingBalance
                | Some available => if Z.leb input available then ReadyToSwap
                    else InsufficientBalance
                end in
              preview status (Some input) (Some output) (Some minimum) (Some slippage)
          end
      end
  end.

Definition swap_can_submit connected pending (view : swap_preview) : bool :=
  connected && negb pending &&
  match preview_status view with ReadyToSwap => true | _ => false end.

Theorem analyze_ready_is_prepared places reserve_in reserve_out balance amount_text slippage_text :
  preview_status (analyze_swap places reserve_in reserve_out (Some balance) amount_text slippage_text)
    = ReadyToSwap ->
  exists prepared,
    prepare_swap places reserve_in reserve_out balance amount_text slippage_text = Some prepared.
Proof.
  unfold analyze_swap.
  destruct (Z.leb reserve_in 0 || Z.leb reserve_out 0)%bool; try discriminate.
  destruct (empty_amount amount_text); try discriminate.
  destruct (positive_units places amount_text) as [input|] eqn:Ha; try discriminate.
  destruct (checked_amount_out reserve_in reserve_out input) as [output|] eqn:Hq;
    try discriminate.
  destruct (Z.leb output 0) eqn:Hp; try discriminate.
  destruct (parse_slippage_bps slippage_text) as [slippage|] eqn:Hs; try discriminate.
  destruct (Z.leb input balance) eqn:Hb; try discriminate.
  intros _. unfold prepare_swap. rewrite Ha, Hs, Hq, Hb.
  apply Z.leb_gt in Hp. assert (Z.ltb 0 output = true) as Hpositive by now apply Z.ltb_lt.
  rewrite Hpositive. simpl. eexists. reflexivity.
Qed.

Theorem submit_requires_current_readiness connected pending view :
  swap_can_submit connected pending view = true ->
  connected = true /\ pending = false /\ preview_status view = ReadyToSwap.
Proof.
  unfold swap_can_submit.
  destruct connected, pending, (preview_status view); simpl; intuition discriminate.
Qed.

Definition swap_action (connected pending : bool) (view : swap_preview) : string :=
  if negb connected then "Connect wallet"%string
  else if pending then "Waiting for confirmation…"%string
  else match preview_status view with
  | EnterAmount => "Enter amount"%string
  | CheckAmount => "Check amount"%string
  | PoolNeedsLiquidity => "Pool needs liquidity"%string
  | QuoteUnavailable => "Quote unavailable"%string
  | CheckSlippage => "Check slippage"%string
  | ReadingBalance => "Reading balance…"%string
  | InsufficientBalance => "Insufficient balance"%string
  | ReadyToSwap => "Swap"%string
  | UnsupportedPool => "Unsupported pool"%string
  end.

Definition swap_error view : option string :=
  match preview_status view with
  | UnsupportedPool => Some Assets.unsupported_pool_error
  | CheckAmount => Some "Enter a positive uint256 amount within the selected token decimal precision."%string
  | QuoteUnavailable => Some "This amount cannot be exchanged by the pool."%string
  | CheckSlippage => Some "Slippage must be between 0% and 50%, with at most two decimal places."%string
  | InsufficientBalance => Some "Amount exceeds the available token balance."%string
  | _ => None
  end.

Definition price_impact_bps reserve_in reserve_out input output : Z :=
  (input * reserve_out - output * reserve_in) * fee_denominator / (input * reserve_out).
Definition execution_rate input output : Z := output * 10 ^ 18 / input.
Definition pool_fee input : Z := input * fee_bps / fee_denominator.

Definition preview_impact reserve_in reserve_out view : option Z :=
  match preview_amount view, preview_output view with
  | Some input, Some output => Some (price_impact_bps reserve_in reserve_out input output)
  | _, _ => None
  end.
Definition preview_high_impact reserve_in reserve_out view : bool :=
  match preview_impact reserve_in reserve_out view with
  | Some value => Z.leb 500 value
  | None => false
  end.
Definition preview_rate view : option Z :=
  match preview_amount view, preview_output view with
  | Some input, Some output => Some (execution_rate input output)
  | _, _ => None
  end.
Definition preview_fee view : option Z :=
  match preview_amount view with Some input => Some (pool_fee input) | None => None end.
Definition preview_pool_funded reserve_in reserve_out : bool :=
  Z.ltb 0 reserve_in && Z.ltb 0 reserve_out.
Definition preview_has_amount amount_text := negb (empty_amount amount_text).

Definition swap_disabled connected pending view : bool :=
  pending || (connected && negb (swap_can_submit connected pending view)).
Definition swap_can_max (balance : option Z) pending : bool :=
  negb pending && match balance with Some value => Z.ltb 0 value | None => false end.
Definition swap_max_text places (balance : option Z) : option string :=
  match balance with Some value => Some (format_scaled (Z.to_nat places) value) | None => None end.
Definition swap_reverse_text places view current : string :=
  match preview_output view with
  | Some output => if Z.ltb 0 output then format_scaled (Z.to_nat places) output else current
  | None => current
  end.

Record trade_orientation := {
  receive_token : address;
  input_reserve : Z;
  output_reserve : Z
}.

(* The renderer's selected token comes from one of this pair's two options. *)
Definition orient_trade token0 token1 selected reserve0 reserve1 : trade_orientation :=
  if String.eqb selected token0 then
    {| receive_token := token1; input_reserve := reserve0; output_reserve := reserve1 |}
  else {| receive_token := token0; input_reserve := reserve1; output_reserve := reserve0 |}.

Lemma orient_trade_from_token0 token0 token1 reserve0 reserve1 :
  orient_trade token0 token1 token0 reserve0 reserve1 =
    {| receive_token := token1; input_reserve := reserve0; output_reserve := reserve1 |}.
Proof. unfold orient_trade. now rewrite String.eqb_refl. Qed.

Inductive submit_action := OpenWallet | SubmitSwap | IgnoreSubmit.
Definition swap_submit_action connected pending view :=
  if negb connected then OpenWallet
  else if swap_can_submit connected pending view then SubmitSwap else IgnoreSubmit.

Theorem swap_submit_action_safe connected pending view :
  swap_submit_action connected pending view = SubmitSwap ->
  connected = true /\ pending = false /\ preview_status view = ReadyToSwap.
Proof.
  unfold swap_submit_action.
  destruct (negb connected); try discriminate.
  destruct (swap_can_submit connected pending view) eqn:H; try discriminate.
  intros _. now apply submit_requires_current_readiness.
Qed.

Definition preview_rate_text input_places output_places view : option string :=
  match preview_amount view, preview_output view with
  | Some input, Some output => price_text output output_places input input_places
  | _, _ => None
  end.
Definition preview_impact_text reserve_in reserve_out view : option string :=
  match preview_impact reserve_in reserve_out view with
  | Some impact => Some (format_scaled 2 impact)
  | None => None
  end.

Definition swap_parameters_error : string := "The swap parameters are outside the supported ranges."%string.
Definition pool_fee_percent : string := format_scaled 2 fee_bps.
Definition swap_deadline_text : string := (integer_text (call_lifetime / 60) ++ " minutes")%string.

Record swap_environment := {
  environment_assets : list address;
  environment_token0 : address;
  environment_token1 : address;
  environment_reserve0 : Z;
  environment_reserve1 : Z;
  environment_balance0 : option Z;
  environment_balance1 : option Z;
  environment_decimals0 : Z;
  environment_decimals1 : Z;
  environment_connected : bool;
  environment_pending : bool
}.

Record swap_draft := {
  draft_token : address;
  draft_amount : string;
  draft_slippage : string
}.

Definition initial_draft token0 :=
  {| draft_token := token0; draft_amount := EmptyString; draft_slippage := "0.5"%string |}.
Definition draft_belongs environment draft : bool :=
  String.eqb (draft_token draft) (environment_token0 environment) ||
  String.eqb (draft_token draft) (environment_token1 environment).
Definition draft_orientation environment draft :=
  orient_trade (environment_token0 environment) (environment_token1 environment)
    (draft_token draft) (environment_reserve0 environment) (environment_reserve1 environment).
Definition draft_balance environment draft : option Z :=
  if environment_connected environment then
    if String.eqb (draft_token draft) (environment_token0 environment)
    then environment_balance0 environment else environment_balance1 environment
  else None.
Definition draft_output_balance environment draft : option Z :=
  if environment_connected environment then
    if String.eqb (draft_token draft) (environment_token0 environment)
    then environment_balance1 environment else environment_balance0 environment
  else None.
Definition draft_precision environment draft : Z :=
  if String.eqb (draft_token draft) (environment_token0 environment)
  then environment_decimals0 environment else environment_decimals1 environment.
Definition draft_output_precision environment draft : Z :=
  if String.eqb (draft_token draft) (environment_token0 environment)
  then environment_decimals1 environment else environment_decimals0 environment.
Definition draft_preview environment draft : swap_preview :=
  if Assets.pool_assets_supported (environment_assets environment)
    (environment_token0 environment) (environment_token1 environment) then
  if draft_belongs environment draft then
    let direction := draft_orientation environment draft in
    analyze_swap (draft_precision environment draft) (input_reserve direction) (output_reserve direction)
      (draft_balance environment draft) (draft_amount draft) (draft_slippage draft)
  else preview QuoteUnavailable None None None None
  else preview UnsupportedPool None None None None.

Inductive swap_event :=
| EditAmount (text : string)
| EditSlippage (text : string)
| SelectPay (token : address)
| SelectReceive (token : address)
| ReverseSwap
| FillMax
| SubmitDraft.

Definition step_draft environment draft event : swap_draft :=
  if environment_pending environment then draft else
  let rebuild token amount slippage :=
    {| draft_token := token; draft_amount := amount; draft_slippage := slippage |} in
  match event with
  | EditAmount text => rebuild (draft_token draft) text (draft_slippage draft)
  | EditSlippage text => rebuild (draft_token draft) (draft_amount draft) text
  | SelectPay token =>
      if String.eqb token (environment_token0 environment) ||
        String.eqb token (environment_token1 environment) then
        rebuild token (draft_amount draft) (draft_slippage draft) else draft
  | SelectReceive token =>
      if String.eqb token (environment_token0 environment) ||
        String.eqb token (environment_token1 environment) then
        rebuild (receive_token (orient_trade (environment_token0 environment)
          (environment_token1 environment) token 0 0))
          (draft_amount draft) (draft_slippage draft) else draft
  | ReverseSwap =>
      rebuild (receive_token (draft_orientation environment draft))
        (swap_reverse_text (draft_output_precision environment draft) (draft_preview environment draft) (draft_amount draft))
        (draft_slippage draft)
  | FillMax =>
      if swap_can_max (draft_balance environment draft) false then
        match swap_max_text (draft_precision environment draft) (draft_balance environment draft) with
        | Some text => rebuild (draft_token draft) text (draft_slippage draft)
        | None => draft
        end
      else draft
  | SubmitDraft => draft
  end.

Inductive swap_effect :=
| NoSwapEffect
| OpenWalletEffect
| RequestSwapEffect (token : address) (input quoted slippage : Z).

Definition draft_effect environment draft event : swap_effect :=
  match event with
  | SubmitDraft =>
      let view := draft_preview environment draft in
      match swap_submit_action (environment_connected environment)
        (environment_pending environment) view with
      | OpenWallet => OpenWalletEffect
      | SubmitSwap =>
          match preview_amount view, preview_output view, preview_slippage view with
          | Some input, Some output, Some slippage =>
              RequestSwapEffect (draft_token draft) input output slippage
          | _, _, _ => NoSwapEffect
          end
      | IgnoreSubmit => NoSwapEffect
      end
  | _ => NoSwapEffect
  end.

Theorem pending_preserves_draft environment draft event :
  environment_pending environment = true -> step_draft environment draft event = draft.
Proof. intros H. unfold step_draft. now rewrite H. Qed.

Definition valid_draft environment draft : Prop :=
  draft_token draft = environment_token0 environment \/
  draft_token draft = environment_token1 environment.

Theorem initial_draft_valid environment :
  valid_draft environment (initial_draft (environment_token0 environment)).
Proof. left. reflexivity. Qed.

Theorem step_draft_valid environment draft event :
  valid_draft environment draft -> valid_draft environment (step_draft environment draft event).
Proof.
  intro H. unfold step_draft.
  destruct (environment_pending environment); [exact H|].
  destruct event; cbn; try exact H.
  - destruct (String.eqb token (environment_token0 environment) ||
      String.eqb token (environment_token1 environment)) eqn:Htoken; [|exact H].
    apply orb_true_iff in Htoken as [Htoken|Htoken]; apply String.eqb_eq in Htoken;
      unfold valid_draft; cbn; auto.
  - destruct (String.eqb token (environment_token0 environment) ||
      String.eqb token (environment_token1 environment)); [|exact H].
    unfold valid_draft, orient_trade.
    destruct (String.eqb token (environment_token0 environment)); cbn; auto.
  - unfold valid_draft, draft_orientation, orient_trade.
    destruct (String.eqb (draft_token draft) (environment_token0 environment)); cbn; auto.
  - destruct (draft_balance environment draft) as [value|]; cbn; [|exact H].
    destruct (Z.ltb 0 value); exact H.
Qed.

Theorem request_swap_requires_ready environment draft event token input output slippage :
  draft_effect environment draft event = RequestSwapEffect token input output slippage ->
  environment_connected environment = true /\ environment_pending environment = false /\
  preview_status (draft_preview environment draft) = ReadyToSwap.
Proof.
  destruct event; cbn; try discriminate.
  destruct (swap_submit_action (environment_connected environment)
    (environment_pending environment) (draft_preview environment draft)) eqn:Haction;
    try discriminate.
  destruct (preview_amount (draft_preview environment draft)); try discriminate.
  destruct (preview_output (draft_preview environment draft)); try discriminate.
  destruct (preview_slippage (draft_preview environment draft)); try discriminate.
  intros _. now apply swap_submit_action_safe in Haction.
Qed.

Theorem request_swap_requires_supported_assets environment draft event token input output slippage :
  draft_effect environment draft event = RequestSwapEffect token input output slippage ->
  Assets.pool_assets_supported (environment_assets environment)
    (environment_token0 environment) (environment_token1 environment) = true.
Proof.
  destruct event; try discriminate.
  intro H. apply request_swap_requires_ready in H as [_ [_ Hready]].
  unfold draft_preview in Hready.
  destruct (Assets.pool_assets_supported (environment_assets environment)
    (environment_token0 environment) (environment_token1 environment));
    [reflexivity|discriminate].
Qed.

Theorem request_swap_uses_shared_quote environment draft token input output slippage :
  draft_effect environment draft SubmitDraft = RequestSwapEffect token input output slippage ->
  0 < input /\ checked_amount_out
    (input_reserve (draft_orientation environment draft))
    (output_reserve (draft_orientation environment draft)) input = Some output.
Proof.
  intro Heffect.
  pose proof (request_swap_requires_ready environment draft SubmitDraft token input output slippage Heffect)
    as [Hconnected [Hpending Hready]].
  unfold draft_effect, swap_submit_action, swap_can_submit in Heffect.
  rewrite Hconnected, Hpending, Hready in Heffect. cbn -[draft_preview] in Heffect.
  unfold draft_preview in Hready, Heffect.
  destruct (Assets.pool_assets_supported (environment_assets environment)
    (environment_token0 environment) (environment_token1 environment)); [|discriminate].
  destruct (draft_belongs environment draft); [|discriminate].
  cbn zeta in Hready, Heffect. unfold analyze_swap in Hready, Heffect.
  destruct (Z.leb (input_reserve (draft_orientation environment draft)) 0 ||
    Z.leb (output_reserve (draft_orientation environment draft)) 0)%bool; try discriminate.
  destruct (empty_amount (draft_amount draft)); try discriminate.
  destruct (positive_units (draft_precision environment draft) (draft_amount draft)) as [amount|] eqn:Hamount; try discriminate.
  destruct (checked_amount_out (input_reserve (draft_orientation environment draft))
    (output_reserve (draft_orientation environment draft)) amount) as [quoted|] eqn:Hquote;
    try discriminate.
  destruct (Z.leb quoted 0); try discriminate.
  destruct (parse_slippage_bps (draft_slippage draft)); try discriminate.
  destruct (draft_balance environment draft) as [balance|]; try discriminate.
  destruct (Z.leb amount balance); try discriminate.
  inversion Heffect; subst. split; [|exact Hquote].
  apply positive_units_sound in Hamount. tauto.
Qed.

Record swap_parameters := {
  parameter_input : Z;
  parameter_minimum : Z;
  parameter_deadline : Z
}.

Definition make_swap_parameters input quoted slippage now : option swap_parameters :=
  if (uint256b input && uint256b quoted && valid_call_time now &&
      Z.ltb 0 input && Z.ltb 0 quoted && Z.leb 0 slippage && Z.leb slippage 5000)%bool
  then Some {| parameter_input := input;
    parameter_minimum := minimum_received quoted slippage;
    parameter_deadline := call_deadline now |}
  else None.

Theorem make_swap_parameters_sound input quoted slippage now parameters :
  make_swap_parameters input quoted slippage now = Some parameters ->
  parameter_input parameters = input /\ 0 < input /\ uint256 input /\
  uint256 (parameter_minimum parameters) /\
  parameter_minimum parameters = minimum_received quoted slippage /\
  0 <= parameter_minimum parameters <= quoted /\
  parameter_deadline parameters = call_deadline now /\
  now < parameter_deadline parameters /\ uint256 (parameter_deadline parameters).
Proof.
  unfold make_swap_parameters.
  destruct (uint256b input && uint256b quoted && valid_call_time now &&
      Z.ltb 0 input && Z.ltb 0 quoted && Z.leb 0 slippage && Z.leb slippage 5000) eqn:H;
    try discriminate.
  intro E. inversion E; subst. simpl.
  repeat rewrite andb_true_iff in H.
  destruct H as [[[[[[Hi Hq] Htime] Hip] Hqp] Hs0] Hs1].
  apply uint256b_spec in Hi, Hq.
  apply valid_call_time_bounds in Htime as [Hnow [Hd Hafter]].
  apply Z.ltb_lt in Hip, Hqp. apply Z.leb_le in Hs0, Hs1.
  pose proof (minimum_received_bounds quoted slippage ltac:(lia)
    ltac:(unfold fee_denominator; lia)) as Hminimum.
  unfold uint256 in *. repeat split; auto; lia.
Qed.

Theorem price_impact_bounded reserve_in reserve_out input :
  0 < reserve_in -> 0 < reserve_out -> 0 < input ->
  0 <= price_impact_bps reserve_in reserve_out input
    (amount_out reserve_in reserve_out input) <= fee_denominator.
Proof.
  intros Hri Hro Hi.
  pose proof (amount_out_bounds reserve_in reserve_out input Hri Hro ltac:(lia)) as Hq.
  pose proof (amount_out_preserves_product reserve_in reserve_out input Hri Hro ltac:(lia)) as Hk.
  unfold price_impact_bps, fee_denominator.
  split.
  - apply Z.div_pos; nia.
  - apply Z.div_le_upper_bound; nia.
Qed.
