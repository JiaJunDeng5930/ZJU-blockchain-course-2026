From Coq Require Import ZArith String List Bool Lia.
From DEXFormal.Spec Require Import Types.
Import ListNotations.
Open Scope Z_scope.
Open Scope string_scope.

(* Wallet addresses enter through viem's canonical address codec. EIP-1193 replies
   belong to the request that receives them; RPC quantities are exact integers.
   The provider object and its account/network notifications are external interfaces.
   No theorem here verifies a wallet implementation or the JSON bridge. *)
Module Wallet.

Inductive source := LocalWallet | BrowserWallet.
Definition source_eq_dec (x y : source) : {x = y} + {x <> y}.
Proof. decide equality. Defined.

Record preference := Preference {
  preferred_source : source;
  preferred_address : option address
}.

Record identity := Identity {
  identity_source : source;
  identity_address : address;
  identity_chain : chain_id;
  identity_epoch : Z
}.

Definition identity_eq_dec (x y : identity) : {x = y} + {x <> y}.
Proof. decide equality; apply Z.eq_dec || apply string_dec || apply source_eq_dec. Defined.

Inductive reason :=
| MissingProvider | NoAccounts | SelectedAccountUnavailable
| WrongNetwork | Disconnected | RequestFailed (message : string)
| NetworkRequestFailed (message : string).

Inductive connection :=
| Checking (request_access : bool)
| Switching (may_add_network : bool)
| Adding
| Ready (account : address)
| Unavailable (why : reason).

Record state := State {
  expected_chain : chain_id;
  epoch : Z;
  selected : preference;
  status : connection
}.

Inductive effect :=
| ObserveWallet (request : Z) (kind : source) (request_access : bool)
| SwitchNetwork (request : Z)
| AddNetwork (request : Z)
| PersistPreference (value : preference).

Record transition := Transition { next : state; effects : list effect }.
Definition unchanged (s : state) := Transition s [].

Definition current_identity (s : state) : option identity :=
  match status s with
  | Ready account => Some (Identity (preferred_source (selected s)) account
      (expected_chain s) (epoch s))
  | _ => None
  end.

Definition permits (s : state) (candidate : identity) : bool :=
  match current_identity s with
  | Some current => if identity_eq_dec current candidate then true else false
  | None => false
  end.

Definition start (s : state) (choice : preference) (authorize : bool) : transition :=
  let revision := epoch s + 1 in
  Transition (State (expected_chain s) revision choice (Checking authorize))
    [ObserveWallet revision (preferred_source choice) authorize].

Definition restore (chain : chain_id) (choice : preference) : transition :=
  start (State chain 0 choice (Unavailable Disconnected)) choice false.

Definition restore_saved (chain : chain_id) (choice : option preference) : transition :=
  restore chain (match choice with Some saved => saved | None => Preference LocalWallet None end).

Definition select_local (s : state) (account : address) : transition :=
  let choice := Preference LocalWallet (Some account) in
  let result := start s choice false in
  Transition (next result) (PersistPreference choice :: effects result).

Definition connect_browser (s : state) : transition :=
  let choice := Preference BrowserWallet None in
  let result := start s choice true in
  Transition (next result) (PersistPreference choice :: effects result).

Definition invalidate (s : state) : transition := start s (selected s) false.

Fixpoint contains (account : address) (accounts : list address) : bool :=
  match accounts with
  | [] => false
  | current :: rest => if string_dec current account then true else contains account rest
  end.

Definition choose_account (choice : preference) (accounts : list address) : option address :=
  match preferred_source choice, preferred_address choice with
  | LocalWallet, Some account => if contains account accounts then Some account else None
  | _, _ => hd_error accounts
  end.

Definition observe (s : state) (request : Z) (accounts : list address)
    (chain : chain_id) : transition :=
  match status s with
  | Checking _ =>
      if Z.eqb request (epoch s) then
        if Z.eqb chain (expected_chain s) then
          match choose_account (selected s) accounts with
          | Some account =>
              let choice := match preferred_source (selected s) with
                | LocalWallet => Preference LocalWallet (Some account)
                | BrowserWallet => Preference BrowserWallet None
                end in
              Transition (State (expected_chain s) (epoch s) choice (Ready account))
                [PersistPreference choice]
          | None => Transition (State (expected_chain s) (epoch s) (selected s)
              (Unavailable (match accounts with [] => NoAccounts | _ => SelectedAccountUnavailable end))) []
          end
        else Transition (State (expected_chain s) (epoch s) (selected s) (Unavailable WrongNetwork)) []
      else unchanged s
  | _ => unchanged s
  end.

Definition observation_failed (s : state) (request : Z) (why : reason) : transition :=
  match status s with
  | Checking _ => if Z.eqb request (epoch s)
      then Transition (State (expected_chain s) (epoch s) (selected s) (Unavailable why)) []
      else unchanged s
  | _ => unchanged s
  end.

Definition provider_changed (s : state) (kind : source) : transition :=
  if source_eq_dec (preferred_source (selected s)) kind then invalidate s else unchanged s.

Definition disconnect (s : state) : transition :=
  Transition (State (expected_chain s) (epoch s + 1) (selected s) (Unavailable Disconnected)) [].

Definition provider_disconnected (s : state) (kind : source) : transition :=
  if source_eq_dec (preferred_source (selected s)) kind then disconnect s else unchanged s.

Definition switch_network (s : state) : transition :=
  match preferred_source (selected s) with
  | LocalWallet => unchanged s
  | BrowserWallet =>
      let revision := epoch s + 1 in
      Transition (State (expected_chain s) revision (selected s) (Switching true)) [SwitchNetwork revision]
  end.

Definition code_is (code : option Z) (expected : Z) : bool :=
  match code with Some value => Z.eqb value expected | None => false end.

Definition network_failure (code : option Z) (message : string) : reason :=
  NetworkRequestFailed (if code_is code 4001 then
    "Network change rejected. You can retry or choose a demo account." else message).

Definition switched (s : state) (request : Z) (success : bool)
    (code : option Z) (message : string) : transition :=
  match status s with
  | Switching may_add => if Z.eqb request (epoch s) then
      if success then invalidate s
      else if may_add && code_is code 4902 then
        Transition (State (expected_chain s) (epoch s) (selected s) Adding) [AddNetwork request]
      else Transition (State (expected_chain s) (epoch s) (selected s)
        (Unavailable (network_failure code message))) []
    else unchanged s
  | _ => unchanged s
  end.

Definition added (s : state) (request : Z) (success : bool) (code : option Z) (message : string) : transition :=
  match status s with
  | Adding => if Z.eqb request (epoch s) then
      if success then Transition (State (expected_chain s) (epoch s) (selected s)
        (Switching false)) [SwitchNetwork request]
      else Transition (State (expected_chain s) (epoch s) (selected s)
        (Unavailable (network_failure code message))) []
    else unchanged s
  | _ => unchanged s
  end.

Definition preflight (s : state) (candidate : identity)
    (accounts : list address) (chain : chain_id) : bool :=
  permits s candidate && Z.eqb chain (expected_chain s) &&
    match identity_source candidate with
    | LocalWallet => contains (identity_address candidate) accounts
    | BrowserWallet => match accounts with
        | account :: _ => if string_dec account (identity_address candidate) then true else false
        | [] => false
        end
    end.

Definition reconcile_preflight (s : state) (candidate : identity)
    (accounts : list address) (chain : chain_id) : transition :=
  if permits s candidate then
    if preflight s candidate accounts chain then unchanged s
    else let restarting := next (invalidate s) in
      observe restarting (epoch restarting) accounts chain
  else unchanged s.

Definition retains_snapshot (s : state) (observed : option identity) : bool :=
  match observed with
  | Some owner => permits s owner
  | None => match current_identity s with None => true | Some _ => false end
  end.

Record funding_token := FundingToken {
  funding_address : address;
  funding_is_faucet : bool;
  funding_balance : amount
}.
Record funding_observation := FundingObservation {
  funding_identity : option identity;
  native_balance : amount;
  funding_tokens : list funding_token
}.
Inductive funding_status :=
| WalletRequired | BalancesLoading | AssetsReady
| FundingRequired (native : bool) (tokens : list address).
Definition minimum_gas_balance : amount := 10000000000000000.
Definition missing_funding_tokens (tokens : list funding_token) : list address :=
  map funding_address (filter (fun token => funding_is_faucet token && negb (Z.ltb 0 (funding_balance token))) tokens).
Definition funding_plan (s : state) (observation : option funding_observation) : funding_status :=
  match current_identity s with
  | None => WalletRequired
  | Some _ => match observation with
      | None => BalancesLoading
      | Some observed => if retains_snapshot s (funding_identity observed) then
          let native := negb (Z.leb minimum_gas_balance (native_balance observed)) in
          let missing := missing_funding_tokens (funding_tokens observed) in
          match native, missing with
          | false, [] => AssetsReady
          | _, _ => FundingRequired native missing
          end
        else BalancesLoading
      end
  end.

Inductive native_funding_result :=
| NativeFunding (sender : address) (value : amount)
| NativeFundingError (message : string).
Fixpoint select_funder (beneficiary : address) (accounts : list address) : option address :=
  match accounts with
  | [] => None
  | sender :: rest => if string_dec sender beneficiary then select_funder beneficiary rest else Some sender
  end.
Definition native_funding_plan (chain : chain_id) (beneficiary : address)
    (accounts : list address) : native_funding_result :=
  if Z.eqb chain 31337 then
    match select_funder beneficiary accounts with
    | Some sender => NativeFunding sender 10000000000000000000
    | None => NativeFundingError "No other unlocked local account is available to fund this wallet."
    end
  else NativeFundingError "Native test funding is available only on local chain 31337.".

Lemma permits_spec s candidate :
  permits s candidate = true <-> current_identity s = Some candidate.
Proof.
  unfold permits. destruct (current_identity s) as [current|] eqn:Hcurrent.
  - destruct (identity_eq_dec current candidate) as [Heq|Hneq]; split; intros H;
      try discriminate; try congruence.
  - split; discriminate.
Qed.

Lemma preflight_requires_current s candidate accounts chain :
  preflight s candidate accounts chain = true -> current_identity s = Some candidate.
Proof.
  unfold preflight. rewrite !andb_true_iff. intros [[Hpermit _] _].
  now apply permits_spec.
Qed.

Lemma preflight_requires_expected_chain s candidate accounts chain :
  preflight s candidate accounts chain = true -> chain = expected_chain s.
Proof.
  unfold preflight. rewrite !andb_true_iff. intros [[_ Hchain] _].
  now apply Z.eqb_eq.
Qed.

Lemma current_identity_epoch s candidate :
  current_identity s = Some candidate -> identity_epoch candidate = epoch s.
Proof. unfold current_identity. destruct (status s); intros H; inversion H; reflexivity. Qed.

Lemma invalidation_revokes_identity s candidate : permits (next (invalidate s)) candidate = false.
Proof. reflexivity. Qed.

Lemma disconnected_has_no_identity s : current_identity (next (disconnect s)) = None.
Proof. reflexivity. Qed.

Lemma restoration_never_requests_access chain choice :
  effects (restore chain choice) = [ObserveWallet 1 (preferred_source choice) false].
Proof. reflexivity. Qed.

Lemma late_observation_ignored s request accounts chain :
  request <> epoch s -> observe s request accounts chain = unchanged s.
Proof.
  intros Hrequest. unfold observe. destruct (status s); try reflexivity.
  apply Z.eqb_neq in Hrequest. now rewrite Hrequest.
Qed.

Lemma restoration_keeps_source chain choice :
  preferred_source (selected (next (restore chain choice))) = preferred_source choice.
Proof. reflexivity. Qed.

Lemma failed_observation_keeps_source s request why :
  preferred_source (selected (next (observation_failed s request why))) =
  preferred_source (selected s).
Proof.
  unfold observation_failed. destruct (status s); try reflexivity.
  destruct (Z.eqb request (epoch s)); reflexivity.
Qed.

Lemma contains_spec account accounts : contains account accounts = true <-> In account accounts.
Proof.
  induction accounts as [|head rest IH].
  - cbn. split; intros H; [discriminate|contradiction].
  - cbn. destruct (string_dec head account) as [Heq|Hneq].
    + subst. split; auto.
    + rewrite IH. split; intros H; intuition congruence.
Qed.

Lemma choose_account_present choice accounts account :
  choose_account choice accounts = Some account -> In account accounts.
Proof.
  destruct choice as [kind preferred]; destruct kind; destruct preferred; cbn.
  - destruct (contains a accounts) eqn:Hcontains; intros H; try discriminate.
    inversion H; subst. now apply contains_spec.
  - destruct accounts; cbn; intros H; inversion H; subst; auto.
  - destruct accounts; cbn; intros H; inversion H; subst; auto.
  - destruct accounts; cbn; intros H; inversion H; subst; auto.
Qed.

Lemma observe_preserves_epoch s request accounts chain :
  epoch (next (observe s request accounts chain)) = epoch s.
Proof.
  unfold observe. destruct (status s); try reflexivity.
  destruct (Z.eqb request (epoch s)); try reflexivity.
  destruct (Z.eqb chain (expected_chain s)); try reflexivity.
  destruct (choose_account (selected s) accounts); reflexivity.
Qed.

Lemma old_epoch_stays_revoked s candidate request accounts chain :
  identity_epoch candidate = epoch s ->
  permits (next (observe (next (invalidate s)) request accounts chain)) candidate = false.
Proof.
  intros Hold.
  destruct (permits (next (observe (next (invalidate s)) request accounts chain)) candidate) eqn:Hpermit;
    try reflexivity.
  apply permits_spec in Hpermit. apply current_identity_epoch in Hpermit.
  rewrite observe_preserves_epoch in Hpermit. cbn in Hpermit. lia.
Qed.

Lemma browser_preflight_matches_first_account s candidate accounts chain :
  identity_source candidate = BrowserWallet ->
  preflight s candidate accounts chain = true ->
  hd_error accounts = Some (identity_address candidate).
Proof.
  intros Hbrowser Hpreflight. unfold preflight in Hpreflight.
  rewrite Hbrowser, !andb_true_iff in Hpreflight.
  destruct Hpreflight as [[_ _] Haccounts].
  destruct accounts as [|head rest]; try discriminate.
  destruct (string_dec head (identity_address candidate)); try discriminate.
  subst. reflexivity.
Qed.

Lemma retained_owned_snapshot_is_current s owner :
  retains_snapshot s (Some owner) = true -> current_identity s = Some owner.
Proof. cbn. apply permits_spec. Qed.

Lemma ready_funding_has_gas s observed :
  funding_plan s (Some observed) = AssetsReady ->
  minimum_gas_balance <= native_balance observed.
Proof.
  unfold funding_plan. destruct (current_identity s); try discriminate.
  destruct (retains_snapshot s (funding_identity observed)); try discriminate.
  destruct (Z.leb minimum_gas_balance (native_balance observed)) eqn:Hgas; cbn; try discriminate.
  intros _. now apply Z.leb_le.
Qed.

Lemma selected_funder_is_other_account beneficiary accounts sender :
  select_funder beneficiary accounts = Some sender -> In sender accounts /\ sender <> beneficiary.
Proof.
  induction accounts as [|head rest IH]; cbn; intros Hselected; try discriminate.
  destruct (string_dec head beneficiary) as [Heq|Hneq].
  - apply IH in Hselected. destruct Hselected as [Hin Hother]. split; auto.
  - inversion Hselected; subst. split; auto.
Qed.

Lemma native_funding_roles_and_amount chain beneficiary accounts sender value :
  native_funding_plan chain beneficiary accounts = NativeFunding sender value ->
  chain = 31337 /\ In sender accounts /\ sender <> beneficiary /\ value = 10000000000000000000.
Proof.
  unfold native_funding_plan. destruct (Z.eqb chain 31337) eqn:Hchain; try discriminate.
  destruct (select_funder beneficiary accounts) as [selected|] eqn:Hselected; try discriminate.
  intros Hresult. inversion Hresult; subst.
  apply Z.eqb_eq in Hchain. apply selected_funder_is_other_account in Hselected.
  tauto.
Qed.

Lemma unrelated_provider_change_ignored s kind :
  preferred_source (selected s) <> kind -> provider_changed s kind = unchanged s.
Proof.
  intros Hother. unfold provider_changed.
  destruct (source_eq_dec (preferred_source (selected s)) kind); congruence.
Qed.

Lemma missing_funding_address_is_configured tokens account :
  In account (missing_funding_tokens tokens) ->
  exists token, In token tokens /\ funding_address token = account /\ funding_is_faucet token = true.
Proof.
  unfold missing_funding_tokens. intros Hmissing.
  apply in_map_iff in Hmissing. destruct Hmissing as [token [Heq Hin]].
  apply filter_In in Hin. destruct Hin as [Hin Hflag].
  apply andb_true_iff in Hflag. exists token. tauto.
Qed.

Lemma successful_preflight_keeps_wallet s candidate accounts chain :
  preflight s candidate accounts chain = true ->
  reconcile_preflight s candidate accounts chain = unchanged s.
Proof.
  intros Hpreflight.
  assert (Hpermit : permits s candidate = true).
  { unfold preflight in Hpreflight. apply andb_true_iff in Hpreflight.
    destruct Hpreflight as [Hprefix _]. now apply andb_true_iff in Hprefix as [Hpermit _]. }
  unfold reconcile_preflight. now rewrite Hpermit, Hpreflight.
Qed.

End Wallet.
