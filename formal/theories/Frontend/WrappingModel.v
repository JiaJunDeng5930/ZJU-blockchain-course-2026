From Coq Require Import ZArith String List Bool Lia.
From DEXFormal.Spec Require Import Types Units Wrapping.
Open Scope string_scope.
Open Scope Z_scope.

Record wrapping_environment := {
  environment_connected : bool;
  environment_pending : bool;
  environment_token : option address;
  environment_native : option Z;
  environment_wrapped : option Z
}.
Record wrapping_state := { wrapping_draft : string; wrapping_touched : bool; wrapping_observation : wrapping_environment }.
Definition initial_wrapping :=
  {| wrapping_draft := ""; wrapping_touched := false;
     wrapping_observation := {| environment_connected := false; environment_pending := false;
       environment_token := None; environment_native := None; environment_wrapped := None |} |}.
Inductive wrapping_decision :=
| WrappingRejected (reason : string)
| WrappingPrepared (request : wrapping_request).

Definition missing_wrapped_message := "This deployment has no WETH contract.".

Definition prepare_wrapping (environment : wrapping_environment) (value gas fee : Z)
  (withdraw : bool) : wrapping_decision :=
  if negb (environment_connected environment) then WrappingRejected "Connect a wallet."
  else if environment_pending environment then WrappingRejected "Another operation is in progress."
  else match environment_token environment with
  | None => WrappingRejected missing_wrapped_message
  | Some token =>
    match environment_native environment, environment_wrapped environment with
    | Some native, Some wrapped =>
      let request := {| wrapping_token := token; wrapping_withdraw := withdraw;
        wrapping_amount := value; wrapping_gas := gas; wrapping_fee_per_gas := fee |} in
      if wrapping_validb request {| native_balance := native; wrapped_balance := wrapped |}
      then WrappingPrepared request
      else WrappingRejected
        (if withdraw then "Insufficient WETH or ETH for the amount and transaction fee."
         else "Insufficient ETH for the amount and transaction fee, or the amount exceeds token limits.")
    | _, _ => WrappingRejected "Waiting for current wallet balances."
    end
  end.
Definition prepare_wrapping_draft state withdraw : wrapping_decision :=
  match positive_units_18 (wrapping_draft state) with
  | Some value => prepare_wrapping (wrapping_observation state) value 0 0 withdraw
  | None => WrappingRejected "Enter a positive amount with at most 18 decimal places."
  end.
Inductive wrapping_event :=
| EditWrapping (text : string)
| ObserveWrapping (environment : wrapping_environment)
| SubmitWrapping (withdraw : bool).
Definition step_wrapping state event : wrapping_state * option wrapping_request :=
  match event with
  | EditWrapping text =>
    (if environment_pending (wrapping_observation state) then state
     else {| wrapping_draft := text; wrapping_touched := true; wrapping_observation := wrapping_observation state |}, None)
  | ObserveWrapping environment =>
    ({| wrapping_draft := wrapping_draft state; wrapping_touched := wrapping_touched state; wrapping_observation := environment |}, None)
  | SubmitWrapping withdraw =>
    match prepare_wrapping_draft state withdraw with
    | WrappingRejected _ => (state, None)
    | WrappingPrepared request => (state, Some request)
    end
  end.
Definition wrapping_decision_error decision :=
  match decision with WrappingRejected reason => Some reason | WrappingPrepared _ => None end.
Theorem prepare_wrapping_sound environment value gas fee withdraw request :
  prepare_wrapping environment value gas fee withdraw = WrappingPrepared request ->
  environment_connected environment = true /\ environment_pending environment = false /\
  environment_token environment = Some (wrapping_token request) /\
  wrapping_amount request = value /\ wrapping_withdraw request = withdraw /\
  wrapping_gas request = gas /\ wrapping_fee_per_gas request = fee /\
  exists native wrapped,
    environment_native environment = Some native /\ environment_wrapped environment = Some wrapped /\
    wrapping_valid request {| native_balance := native; wrapped_balance := wrapped |}.
Proof.
  unfold prepare_wrapping.
  destruct (environment_connected environment) eqn:C; cbn; try discriminate.
  destruct (environment_pending environment) eqn:P; try discriminate.
  destruct (environment_token environment) as [token|] eqn:T; try discriminate.
  destruct (environment_native environment) as [native|] eqn:N; try discriminate.
  destruct (environment_wrapped environment) as [wrapped|] eqn:W; try discriminate.
  destruct (wrapping_validb _ _) eqn:V; try discriminate.
  intro H. inversion H; subst. repeat split; try reflexivity.
  exists native, wrapped. split; [reflexivity|]. split; [reflexivity|].
  now apply wrapping_validb_spec.
Qed.
Theorem submitted_wrapping_sound state withdraw next request :
  step_wrapping state (SubmitWrapping withdraw) = (next, Some request) ->
  next = state /\
  positive_units_18 (wrapping_draft state) = Some (wrapping_amount request) /\
  environment_connected (wrapping_observation state) = true /\
  environment_pending (wrapping_observation state) = false.
Proof.
  cbn. unfold prepare_wrapping_draft.
  destruct (positive_units_18 (wrapping_draft state)) as [value|] eqn:E; try discriminate.
  destruct (prepare_wrapping _ _ _ _ _) as [reason|prepared] eqn:P; try discriminate.
  intro H. inversion H; subst. apply prepare_wrapping_sound in P.
  destruct P as [C [B [_ [A _]]]]. subst value. auto.
Qed.
Theorem pending_wrapping_keeps_draft state text :
  environment_pending (wrapping_observation state) = true ->
  step_wrapping state (EditWrapping text) = (state, None).
Proof. intro H; cbn; now rewrite H. Qed.
Theorem observations_preserve_wrapping_draft state environment :
  wrapping_draft (fst (step_wrapping state (ObserveWrapping environment))) = wrapping_draft state.
Proof. reflexivity. Qed.

Definition wrapping_input_error state :=
  if wrapping_touched state then amount_error (wrapping_draft state) None else None.

Inductive wrapping_token_result :=
| WrappingTokenFound (token : address)
| WrappingTokenMissing (reason : string).
Definition required_wrapped_address tokens :=
  match select_wrapped tokens with
  | Some token => WrappingTokenFound token
  | None => WrappingTokenMissing missing_wrapped_message
  end.
Theorem required_wrapper_is_declared tokens token :
  required_wrapped_address tokens = WrappingTokenFound token ->
  In (token, "wrapped") tokens.
Proof.
  unfold required_wrapped_address. destruct (select_wrapped tokens) eqn:H; try discriminate.
  intro E. inversion E; subst. now apply select_wrapped_declared.
Qed.

Theorem submitted_wrapping_amount_bound state withdraw next request :
  step_wrapping state (SubmitWrapping withdraw) = (next, Some request) ->
  0 < wrapping_amount request /\ uint256 (wrapping_amount request).
Proof.
  intro H. apply submitted_wrapping_sound in H as [_ [H _]].
  apply positive_units_18_sound in H. tauto.
Qed.
