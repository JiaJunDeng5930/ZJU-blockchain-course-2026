From Coq Require Import String List Bool ZArith Lia.
From DEXFormal.Spec Require Import Types Units Assets.
Import ListNotations.
Open Scope string_scope.
Open Scope Z_scope.

Inductive field := Name | Symbol | Address | Exchange | First | Second.
Record draft := Draft { draft_name : string; draft_symbol : string; draft_address : string;
  draft_exchange : string; draft_first : string; draft_second : string }.
Record import_request := ImportRequest { import_id : Z; import_address : string }.
Record state := State { state_draft : draft; state_request : option import_request;
  state_next : Z; state_error : option string }.
Record environment := Environment { available_exchanges : list string; available_tokens : list string;
  available_markets : list market; wallet_connected : bool; wallet_pending : bool }.
Inductive event := Edit (input : field) (value : string) | BeginImport | SubmitDeployment | SubmitPool
  | ImportSucceeded (id : Z) (token : asset) | ImportFailed (id : Z) (message : string).
Inductive effect := NoEffect | ReadMetadata (request : import_request) | RegisterToken (token : asset)
  | WriteCall (call : contract_call).
Definition pick (xs : list string) := match xs with [] => "" | x :: _ => x end.
Definition initial (exchanges tokens : list string) :=
  State (Draft "Demo Token" "DEMO" "" (pick exchanges) (pick tokens) (pick (tl tokens))) None 0 None.
Definition edit_draft (d : draft) (input : field) (value : string) : draft :=
  match input with
  | Name => Draft value (draft_symbol d) (draft_address d) (draft_exchange d) (draft_first d) (draft_second d)
  | Symbol => Draft (draft_name d) value (draft_address d) (draft_exchange d) (draft_first d) (draft_second d)
  | Address => Draft (draft_name d) (draft_symbol d) value (draft_exchange d) (draft_first d) (draft_second d)
  | Exchange => Draft (draft_name d) (draft_symbol d) (draft_address d) value (draft_first d) (draft_second d)
  | First => Draft (draft_name d) (draft_symbol d) (draft_address d) (draft_exchange d) value (draft_second d)
  | Second => Draft (draft_name d) (draft_symbol d) (draft_address d) (draft_exchange d) (draft_first d) value
  end.
Definition can_write (env : environment) := wallet_connected env && negb (wallet_pending env).
Definition deployment_error (s : state) :=
  match deployment_call (draft_name (state_draft s)) (draft_symbol (state_draft s)) with
  | None => Some deployment_name_error | Some _ => None end.
Definition create_pool_error (s : state) (env : environment) :=
  let d := state_draft s in
  pool_error (available_exchanges env) (available_tokens env) (available_markets env)
    (draft_exchange d) (draft_first d) (draft_second d).
Definition import_error (s : state) :=
  match state_error s with Some e => Some e | None =>
    if empty_amount (draft_address (state_draft s)) then None
    else match canonical_address (draft_address (state_draft s)) with
    | None => Some "Enter a nonzero ERC20 contract address." | Some _ => None end end.
Definition import_pending (s : state) := match state_request s with Some _ => true | None => false end.
Definition can_import (s : state) :=
  negb (import_pending s) &&
    match canonical_address (draft_address (state_draft s)) with Some _ => true | None => false end.
Definition can_deploy s env := can_write env &&
  match deployment_error s with Some _ => false | None => true end.
Definition can_create_pool s env := can_write env &&
  match create_pool_error s env with Some _ => false | None => true end.
Definition matched_request (s : state) (id : Z) : bool :=
  match state_request s with Some r => Z.eqb (import_id r) id | None => false end.
Definition finish_import s error := State (state_draft s) None (state_next s) error.
Definition step (s : state) (env : environment) (input : event) : state * effect :=
  match input with
  | Edit f value => (State (edit_draft (state_draft s) f value) (state_request s) (state_next s) (match f with Address => None | _ => state_error s end), NoEffect)
  | BeginImport =>
      match state_request s, canonical_address (draft_address (state_draft s)) with
      | None, Some address =>
          let request := ImportRequest (state_next s) address in
          (State (state_draft s) (Some request) (state_next s + 1) None, ReadMetadata request)
      | _, _ => (s, NoEffect) end
  | SubmitDeployment =>
      if can_write env then
        match deployment_call (draft_name (state_draft s)) (draft_symbol (state_draft s)) with
        | Some call => (s, WriteCall call) | None => (s, NoEffect) end
      else (s, NoEffect)
  | SubmitPool =>
      let d := state_draft s in
      if can_write env then
        match pool_call (available_exchanges env) (available_tokens env) (available_markets env)
          (draft_exchange d) (draft_first d) (draft_second d) with
        | Some call => (s, WriteCall call) | None => (s, NoEffect) end
      else (s, NoEffect)
  | ImportSucceeded id token =>
      match state_request s with
      | Some request =>
          if Z.eqb (import_id request) id then
            if same_address (import_address request) (asset_address token)
            then (finish_import s None, RegisterToken token)
            else (finish_import s (Some "The token response does not match the requested address."), NoEffect)
          else (s, NoEffect)
      | None => (s, NoEffect) end
  | ImportFailed id message =>
      if matched_request s id then (finish_import s (Some message), NoEffect) else (s, NoEffect)
  end.

Lemma import_success_stale_is_ignored s env id token : matched_request s id = false ->
  step s env (ImportSucceeded id token) = (s, NoEffect).
Proof. unfold matched_request, step. destruct (state_request s); auto. intros H. rewrite H. reflexivity. Qed.
Lemma import_failure_stale_is_ignored s env id message : matched_request s id = false ->
  step s env (ImportFailed id message) = (s, NoEffect).
Proof. intros H. cbn [step]. now rewrite H. Qed.
Lemma import_success_registers_requested_address s env id token next :
  step s env (ImportSucceeded id token) = (next, RegisterToken token) ->
  exists request, state_request s = Some request /\ import_id request = id /\
    same_address (import_address request) (asset_address token) = true.
Proof.
  unfold step. destruct (state_request s) as [r|] eqn:H; try discriminate.
  destruct (Z.eqb (import_id r) id) eqn:E; try discriminate.
  destruct (same_address (import_address r) (asset_address token)) eqn:A; try discriminate.
  intros _. exists r. apply Z.eqb_eq in E. auto.
Qed.
Lemma no_parallel_import s env request : state_request s = Some request ->
  step s env BeginImport = (s, NoEffect).
Proof. intros H. cbn [step]. rewrite H. destruct (canonical_address (draft_address (state_draft s))); reflexivity. Qed.
Lemma deployment_requires_wallet s env next call :
  step s env SubmitDeployment = (next, WriteCall call) -> can_write env = true.
Proof. cbn [step]. destruct (can_write env) eqn:H; try discriminate. auto. Qed.
Lemma pool_requires_wallet s env next call :
  step s env SubmitPool = (next, WriteCall call) -> can_write env = true.
Proof. cbn [step]. destruct (can_write env) eqn:H; try discriminate. auto. Qed.
Lemma completed_import_clears_pending s env id token next :
  step s env (ImportSucceeded id token) = (next, RegisterToken token) -> state_request next = None.
Proof.
  cbn [step]. destruct (state_request s); try discriminate.
  destruct (Z.eqb (import_id i) id); try discriminate.
  destruct (same_address (import_address i) (asset_address token)); try discriminate.
  intros H. inversion H. reflexivity.
Qed.
