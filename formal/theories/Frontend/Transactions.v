From Coq Require Import ZArith String List Bool Lia.
From DEXFormal.Spec Require Import Types.
From DEXFormal.Frontend Require Import Wallet ReplacementSearch ReceiptFees.
Import ListNotations.
Open Scope Z_scope.
Open Scope string_scope.
Open Scope Z_scope.

(* Signing permission is bound to the operation's captured identity. Transport
   adapters must encode the requested call and use that captured viem account.
   RPC receipt fields describe the actual transaction; matching hash and sender
   are checked below. A general submission error does not establish rollback. *)
Module Transactions.
Module R := ReplacementSearch.

Inductive phase :=
| AwaitingPreflight
| AwaitingSignature
| Submitted (hash : string) (observation_error : option string)
| Confirmed (hash : string) (block gas : Z)
| Reverted (hash : string) (block gas : Z)
| Superseded (hash : string) (receipt : option (Z * Z)) (observation_error : option string)
| Rejected (message : string)
| SubmissionUnknown (message : string).

Inductive authority := WalletAuthority | FaucetAuthority (sender : address).

Record entry := ObservedEntry {
  entry_id : Z;
  entry_label : string;
  entry_identity : Wallet.identity;
  entry_authority : authority;
  entry_phase : phase;
  entry_descriptor : option R.descriptor;
  entry_replacements : list R.replacement
}.
Definition Entry id label identity authority status :=
  ObservedEntry id label identity authority status None [].

Inductive operation_phase := CanWrite | Waiting (transaction : Z) | Stopped.
Record operation := Operation {
  operation_id : Z;
  operation_label : string;
  operation_identity : Wallet.identity;
  operation_status : operation_phase
}.
Inductive outcome := Completed (label : string) | Interrupted (label message : string).
Record state := State {
  serial : Z;
  active : option operation;
  journal : list entry;
  last_outcome : option outcome
}.

Definition initial := State 0 None [] None.
Inductive decision (A : Type) := Accepted (value : A) | Denied (message : string).
Arguments Accepted {A} _.
Arguments Denied {A} _.

Definition changed_phase (e : entry) (p : phase) :=
  ObservedEntry (entry_id e) (entry_label e) (entry_identity e) (entry_authority e) p
    (entry_descriptor e) (entry_replacements e).

Inductive entry_event :=
| Broadcast (hash : string)
| PreflightFailed (message : string)
| SignatureFailed (code : option Z) (message : string)
| Receipt (hash sender : string) (success : bool) (block gas_used gas_price : Z)
| ObservationFailed (message : string)
| Describe (value : R.descriptor)
| Replacement (original candidate : R.descriptor) (receipt_hash receipt_sender : string)
    (success : bool) (block gas_used gas_price : Z).

Definition advance (p : phase) (event : entry_event) : phase :=
  match p with
  | Confirmed _ _ _ | Reverted _ _ _ | Rejected _ | SubmissionUnknown _ => p
  | Superseded hash receipt error => match receipt,event with
      | Some _,_ => p
      | None,Receipt received _ _ block used price => if string_dec hash received
          then Superseded hash (Some (block,used*price)) None else p
      | None,ObservationFailed message => Superseded hash None (Some message)
      | _,_ => p end
  | AwaitingPreflight => match event with PreflightFailed message => Rejected message | _ => p end
  | AwaitingSignature => match event with
      | Broadcast hash => Submitted hash None
      | SignatureFailed code message => if Wallet.code_is code 4001 then Rejected message else SubmissionUnknown message
      | _ => p
      end
  | Submitted hash error => match event with
      | Receipt received _ success block gas_used gas_price =>
          if string_dec hash received then
            if success then Confirmed hash block (ReceiptFees.execution_fee gas_used gas_price)
            else Reverted hash block (ReceiptFees.execution_fee gas_used gas_price)
          else p
      | ObservationFailed message => Submitted hash (Some message)
      | _ => p
      end
  end.

Definition sender_of (e : entry) : address :=
  match entry_authority e with
  | WalletAuthority => Wallet.identity_address (entry_identity e)
  | FaucetAuthority sender => sender
  end.

Definition event_phase (e : entry) (event : entry_event) : phase :=
  match event with
  | Receipt _ sender _ _ _ _ => if string_dec sender (sender_of e) then advance (entry_phase e) event
      else advance (entry_phase e) (ObservationFailed "Receipt sender differs from the requested authority.")
  | _ => advance (entry_phase e) event
  end.

Definition phase_hash status := match status with
  | Submitted hash _ | Confirmed hash _ _ | Reverted hash _ _ | Superseded hash _ _ => Some hash
  | _ => None end.
Definition original_hash e := match entry_replacements e with
  | first :: _ => Some (R.previous_hash first)
  | [] => phase_hash (entry_phase e) end.
Definition replace_observations e status descriptor replacements :=
  ObservedEntry (entry_id e) (entry_label e) (entry_identity e) (entry_authority e)
    status descriptor replacements.
Definition descriptor_agrees e original := match entry_descriptor e with
  | None => true
  | Some known => String.eqb (R.tx_hash known) (R.tx_hash original) && R.same_call known original end.
Definition observe_descriptor e value := match entry_phase e with
  | Submitted hash _ | Superseded hash None _ =>
      if R.valid_descriptor value && String.eqb (R.tx_hash value) hash &&
        String.eqb (R.tx_from value) (sender_of e) && descriptor_agrees e value
      then replace_observations e (entry_phase e) (Some value) (entry_replacements e) else e
  | _ => e end.
Definition observe_replacement e original candidate receipt_hash receipt_sender (success : bool) block used price :=
  match entry_phase e with
  | Submitted hash _ | Superseded hash None _ =>
      if R.matches (sender_of e) hash original candidate && descriptor_agrees e original &&
        String.eqb receipt_hash (R.tx_hash candidate) && String.eqb receipt_sender (sender_of e) &&
        Z.eqb block (R.observed_block candidate) && (0 <=? used) && (0 <=? price)
      then let kind := R.classify original candidate in
        let status := match entry_phase e,kind with
          | Superseded _ _ _,_ | _,R.DifferentCall => Superseded (R.tx_hash candidate) (Some (block,used*price)) None
          | _,R.Repriced => if success then Confirmed (R.tx_hash candidate) block (used*price)
              else Reverted (R.tx_hash candidate) block (used*price) end in
        replace_observations e status (Some candidate)
          (List.app (entry_replacements e) [R.Replacement hash (R.tx_hash candidate) kind])
      else e
  | _ => e end.
Definition apply_entry (id : Z) (event : entry_event) (e : entry) :=
  if Z.eqb id (entry_id e) then match event with
    | Describe value => observe_descriptor e value
    | Replacement original candidate hash sender success block used price =>
        observe_replacement e original candidate hash sender success block used price
    | _ => changed_phase e (event_phase e event) end else e.

Definition apply_journal (s : state) (id : Z) (event : entry_event) : state :=
  State (serial s) (active s) (map (apply_entry id event) (journal s)) (last_outcome s).

Fixpoint find_entry (id : Z) (entries : list entry) : option entry :=
  match entries with
  | [] => None
  | e :: rest => if Z.eqb id (entry_id e) then Some e else find_entry id rest
  end.

Definition begin_operation (s : state) (wallet : Wallet.state)
    (candidate : option Wallet.identity) (label : string) : state * decision Z :=
  match active s, candidate with
  | None, Some candidate => if Wallet.permits wallet candidate then
      let id := serial s + 1 in
      (State id (Some (Operation id label candidate CanWrite)) (journal s) None, Accepted id)
    else (State (serial s) None (journal s)
      (Some (Interrupted label "Wallet identity changed. Review the operation and submit again.")),
      Denied "Wallet identity changed. Review the operation and submit again.")
  | Some _, _ => (s, Denied "Another operation is still running.")
  | None, None =>
      (State (serial s) None (journal s)
        (Some (Interrupted label "Connect a wallet on the correct network before submitting.")),
       Denied "Connect a wallet on the correct network before submitting.")
  end.

Definition request_write (s : state) (wallet : Wallet.state) (operation_id : Z)
    (label : string) (sender : authority) : state * decision Z :=
  match active s with
  | Some operation =>
      if Z.eqb operation_id (Transactions.operation_id operation) then
        match operation_status operation with
        | CanWrite => if Wallet.permits wallet (operation_identity operation) then
            let id := serial s + 1 in
            let pending := Operation (Transactions.operation_id operation) (operation_label operation)
              (operation_identity operation) (Waiting id) in
            (State id (Some pending)
              (Entry id label (operation_identity operation) sender AwaitingPreflight :: journal s)
              (last_outcome s), Accepted id)
          else (s, Denied "Wallet identity changed. Review the operation and submit again.")
        | _ => (s, Denied "This operation cannot start another transaction.")
        end
      else (s, Denied "This operation is no longer active.")
  | None => (s, Denied "This operation is no longer active.")
  end.

Definition authorization_identity (s : state) (operation_id transaction_id : Z)
    : option Wallet.identity :=
  match active s with
  | Some operation => if Z.eqb operation_id (Transactions.operation_id operation) then
      match operation_status operation with
      | Waiting pending => if Z.eqb pending transaction_id then
          match find_entry transaction_id (journal s) with
          | Some e => match entry_phase e with
              | AwaitingPreflight => Some (operation_identity operation)
              | _ => None
              end
          | None => None
          end
        else None
      | _ => None
      end
    else None
  | None => None
  end.

Definition signing_entry (id : Z) (e : entry) :=
  if Z.eqb id (entry_id e) then
    match entry_phase e with
    | AwaitingPreflight => changed_phase e AwaitingSignature
    | _ => e
    end
  else e.

Definition authorize (s : state) (wallet : Wallet.state) (operation_id transaction_id : Z)
    (accounts : list address) (chain : chain_id) : state * decision Wallet.identity :=
  match authorization_identity s operation_id transaction_id with
  | Some identity => if Wallet.preflight wallet identity accounts chain then
      (State (serial s) (active s) (map (signing_entry transaction_id) (journal s))
        (last_outcome s), Accepted identity)
    else (s, Denied "Wallet account or network changed during the operation. Review and submit again.")
  | None => (s, Denied "This signing request is no longer active.")
  end.

Definition set_waiting_status (s : state) (transaction_id : Z) (phase : operation_phase) :=
  match active s with
  | Some operation => match operation_status operation with
      | Waiting pending => if Z.eqb pending transaction_id then
          State (serial s)
            (Some (Operation (operation_id operation) (operation_label operation)
              (operation_identity operation) phase))
            (journal s) (last_outcome s)
        else s
      | _ => s
      end
  | None => s
  end.

Definition broadcast (s : state) (transaction_id : Z) (hash : string) :=
  apply_journal s transaction_id (Broadcast hash).

Definition preflight_failed (s : state) (transaction_id : Z) (message : string) :=
  set_waiting_status (apply_journal s transaction_id (PreflightFailed message)) transaction_id Stopped.

Definition signature_failed (s : state) (transaction_id : Z) (code : option Z) (message : string) :=
  set_waiting_status (apply_journal s transaction_id (SignatureFailed code message)) transaction_id Stopped.

Definition receipt (s : state) (transaction_id : Z) (hash sender : string) (success : bool)
    (block gas_used gas_price : Z) :=
  let updated := apply_journal s transaction_id (Receipt hash sender success block gas_used gas_price) in
  match find_entry transaction_id (journal updated) with
  | Some e => match entry_phase e with
      | Confirmed _ _ _ => set_waiting_status updated transaction_id CanWrite
      | Reverted _ _ _ | Superseded _ _ _ => set_waiting_status updated transaction_id Stopped
      | _ => updated
      end
  | None => updated
  end.

Definition describe s id descriptor := apply_journal s id (Describe descriptor).
Definition replacement s id original candidate hash sender success block used price :=
  let updated := apply_journal s id (Replacement original candidate hash sender success block used price) in
  match find_entry id (journal updated) with
  | Some e => match entry_phase e with
      | Confirmed _ _ _ => set_waiting_status updated id CanWrite
      | Reverted _ _ _ | Superseded _ _ _ => set_waiting_status updated id Stopped
      | _ => updated end
  | None => updated end.

Definition observation_failed (s : state) (transaction_id : Z) (message : string) :=
  set_waiting_status (apply_journal s transaction_id (ObservationFailed message)) transaction_id Stopped.

Definition finish_operation (s : state) (id : Z) (error : option string) :=
  match active s with
  | Some operation => if Z.eqb id (operation_id operation) then
      State (serial s) None (journal s) (Some (match error with
        | None => Completed (operation_label operation)
        | Some message => Interrupted (operation_label operation) message
        end))
    else s
  | None => s
  end.

Inductive activity :=
| Idle
| Preparing (label : string)
| AwaitingWallet (label : string)
| RequestingFaucet (label : string)
| Mining (label : string)
| ReceiptUncertain (label message : string)
| LastConfirmed (label : string) (block : Z)
| LastCompleted (label : string)
| OperationError (label message : string).

Definition pending (s : state) : bool :=
  match active s with Some _ => true | None => false end.

Definition current_error (s : state) : option string :=
  match active s, last_outcome s with
  | None, Some (Interrupted _ message) => Some message
  | _, _ => None
  end.

Definition current_activity (s : state) : activity :=
  match active s with
  | Some operation => match operation_status operation with
      | Waiting id => match find_entry id (journal s) with
          | Some e => match entry_phase e with
              | AwaitingPreflight | AwaitingSignature => match entry_authority e with
                  | WalletAuthority => AwaitingWallet (entry_label e)
                  | FaucetAuthority _ => RequestingFaucet (entry_label e)
                  end
              | Superseded _ _ _ => OperationError (entry_label e) "The original request was replaced by a different transaction."
              | Submitted _ None => Mining (entry_label e)
              | Submitted _ (Some message) => ReceiptUncertain (entry_label e) message
              | _ => Preparing (operation_label operation)
              end
          | None => Preparing (operation_label operation)
          end
      | _ => Preparing (operation_label operation)
      end
  | None => match last_outcome s with
      | Some (Interrupted label message) => OperationError label message
      | Some (Completed label) => match journal s with
          | e :: _ => match entry_phase e with
              | Confirmed _ block _ => LastConfirmed (entry_label e) block
              | _ => LastCompleted label
              end
          | [] => LastCompleted label
          end
      | None => Idle
      end
  end.

Definition settlement_decision (s : state) (id : Z) : decision unit :=
  match find_entry id (journal s) with
  | Some e => match entry_phase e with
      | Confirmed _ _ _ => Accepted tt
      | Reverted _ _ _ => Denied "Transaction reverted on chain."
      | Superseded _ _ _ => Denied "The original request was replaced by a different transaction. No following operation was sent."
      | Submitted _ (Some message) => Denied message
      | _ => Denied "The receipt does not confirm the submitted transaction."
      end
  | None => Denied "The transaction is not recorded in this operation."
  end.

Record authorization_transition := AuthorizationTransition {
  authorization_transactions : state;
  authorization_wallet : Wallet.state;
  authorization_effects : list Wallet.effect;
  authorization_result : decision Wallet.identity
}.
Definition authorize_and_reconcile (s : state) (wallet : Wallet.state) (op tx : Z)
    (accounts : list address) (chain : chain_id) : authorization_transition :=
  let candidate := authorization_identity s op tx in
  let '(next, result) := authorize s wallet op tx accounts chain in
  let reconciled := match candidate with
    | None => Wallet.unchanged wallet
    | Some candidate_identity => Wallet.reconcile_preflight wallet candidate_identity accounts chain
    end in
  AuthorizationTransition next (Wallet.next reconciled) (Wallet.effects reconciled) result.

Definition settle (s : state) (tx : Z) (hash sender : string) (success : bool)
    (block gas_used gas_price : Z) : state * decision unit :=
  let next := receipt s tx hash sender success block gas_used gas_price in
  (next, settlement_decision next tx).

Lemma authorization_requires_current s wallet op tx accounts chain next identity :
  authorize s wallet op tx accounts chain = (next, Accepted identity) ->
  Wallet.current_identity wallet = Some identity.
Proof.
  unfold authorize. destruct (authorization_identity s op tx) as [candidate|] eqn:Hcandidate;
    try discriminate.
  destruct (Wallet.preflight wallet candidate accounts chain) eqn:Hpreflight; try discriminate.
  intros Hresult. inversion Hresult; subst.
  now apply Wallet.preflight_requires_current in Hpreflight.
Qed.

Lemma authorization_requires_expected_chain s wallet op tx accounts chain next identity :
  authorize s wallet op tx accounts chain = (next, Accepted identity) ->
  chain = Wallet.expected_chain wallet.
Proof.
  unfold authorize. destruct (authorization_identity s op tx) as [candidate|]; try discriminate.
  destruct (Wallet.preflight wallet candidate accounts chain) eqn:Hpreflight; try discriminate.
  intros _. now apply Wallet.preflight_requires_expected_chain in Hpreflight.
Qed.

Lemma stale_epoch_cannot_authorize s wallet op tx accounts chain next identity :
  Wallet.identity_epoch identity <> Wallet.epoch wallet ->
  authorize s wallet op tx accounts chain <> (next, Accepted identity).
Proof.
  intros Hstale Hgranted. apply authorization_requires_current in Hgranted.
  apply Wallet.current_identity_epoch in Hgranted. contradiction.
Qed.

Lemma confirmed_is_final hash block gas event :
  advance (Confirmed hash block gas) event = Confirmed hash block gas.
Proof. reflexivity. Qed.

Lemma observation_failure_is_not_reversion hash error message :
  advance (Submitted hash error) (ObservationFailed message) = Submitted hash (Some message).
Proof. reflexivity. Qed.

Lemma confirmation_uses_broadcast_hash hash error received sender success block gas_used gas_price :
  hash <> received ->
  advance (Submitted hash error) (Receipt received sender success block gas_used gas_price) = Submitted hash error.
Proof. intros Hneq. cbn. destruct (string_dec hash received); congruence. Qed.

Lemma entry_event_preserves_identity id event e :
  entry_identity (apply_entry id event e) = entry_identity e.
Proof. unfold apply_entry. destruct (Z.eqb id (entry_id e)); try reflexivity.
  destruct event; try reflexivity; unfold observe_descriptor,observe_replacement;
  destruct (entry_phase e); try reflexivity; try destruct o; try reflexivity;
  repeat match goal with |- context[if ?condition then _ else _] => destruct condition end; reflexivity. Qed.

Lemma confirmed_event_phase e event hash block gas :
  entry_phase e = Confirmed hash block gas -> event_phase e event = entry_phase e.
Proof. intro Hphase; unfold event_phase; destruct event; try (rewrite Hphase; reflexivity).
  destruct (string_dec sender (sender_of e)); rewrite Hphase; reflexivity. Qed.
Lemma confirmed_entry_preserved id event e hash block gas :
  entry_phase e = Confirmed hash block gas -> apply_entry id event e = e.
Proof.
  intros Hphase. unfold apply_entry. destruct (Z.eqb id (entry_id e)); try reflexivity.
  destruct event;
    try (unfold observe_descriptor,observe_replacement; rewrite Hphase; reflexivity);
    rewrite (confirmed_event_phase e _ hash block gas Hphase); destruct e; reflexivity.
Qed.

Lemma entry_event_preserves_id id event e :
  entry_id (apply_entry id event e) = entry_id e.
Proof. unfold apply_entry. destruct (Z.eqb id (entry_id e)); try reflexivity.
  destruct event; try reflexivity; unfold observe_descriptor,observe_replacement;
  destruct (entry_phase e); try reflexivity; try destruct o; try reflexivity;
  repeat match goal with |- context[if ?condition then _ else _] => destruct condition end; reflexivity. Qed.

Lemma find_entry_after_event id event entries :
  find_entry id (map (apply_entry id event) entries) =
  option_map (apply_entry id event) (find_entry id entries).
Proof.
  induction entries as [|e rest IH]; cbn; try reflexivity.
  rewrite entry_event_preserves_id.
  destruct (Z.eqb id (entry_id e)); cbn; auto.
Qed.

Lemma set_waiting_status_preserves_journal s id status :
  journal (set_waiting_status s id status) = journal s.
Proof.
  unfold set_waiting_status. destruct (active s) as [operation|]; try reflexivity.
  destruct (operation_status operation); try reflexivity.
  destruct (Z.eqb transaction id); reflexivity.
Qed.

Lemma receipt_journal s id hash sender success block gas_used gas_price :
  journal (receipt s id hash sender success block gas_used gas_price) =
  map (apply_entry id (Receipt hash sender success block gas_used gas_price)) (journal s).
Proof.
  unfold receipt. destruct (find_entry id
    (journal (apply_journal s id (Receipt hash sender success block gas_used gas_price)))) as [e|];
    try reflexivity.
  destruct (entry_phase e); try reflexivity; apply set_waiting_status_preserves_journal.
Qed.

(* A broadcast transaction remains historical evidence after its operation is gone.
   No current-wallet premise is needed to accept a matching receipt. *)
Lemma matching_receipt_records_original_identity s id e hash error block gas_used gas_price :
  find_entry id (journal s) = Some e ->
  entry_phase e = Submitted hash error ->
  find_entry id (journal (receipt s id hash (sender_of e) true block gas_used gas_price)) =
    Some (changed_phase e (Confirmed hash block (ReceiptFees.execution_fee gas_used gas_price))).
Proof.
  intros Hfind Hphase. rewrite receipt_journal, find_entry_after_event, Hfind. cbn.
  assert (Hid : Z.eqb id (entry_id e) = true).
  { clear Hphase. induction (journal s) as [|head rest IH]; cbn in Hfind; try discriminate.
    destruct (Z.eqb id (entry_id head)) eqn:Hhead.
    - inversion Hfind; subst. exact Hhead.
    - now apply IH. }
  unfold apply_entry. rewrite Hid. unfold event_phase.
  destruct (string_dec (sender_of e) (sender_of e)); try contradiction.
  rewrite Hphase. cbn. destruct (string_dec hash hash); congruence.
Qed.

Lemma found_entry_matches_id id entries e :
  find_entry id entries = Some e -> Z.eqb id (entry_id e) = true.
Proof.
  induction entries as [|head rest IH]; cbn; intros Hfind; try discriminate.
  destruct (Z.eqb id (entry_id head)) eqn:Hhead.
  - inversion Hfind; subst. exact Hhead.
  - now apply IH.
Qed.

Lemma signing_preserves_id id e : entry_id (signing_entry id e) = entry_id e.
Proof.
  unfold signing_entry. destruct (Z.eqb id (entry_id e)); try reflexivity.
  destruct (entry_phase e); reflexivity.
Qed.

Lemma find_entry_after_signing id entries :
  find_entry id (map (signing_entry id) entries) =
  option_map (signing_entry id) (find_entry id entries).
Proof.
  induction entries as [|e rest IH]; cbn; try reflexivity.
  rewrite signing_preserves_id. destruct (Z.eqb id (entry_id e)); cbn; auto.
Qed.

Lemma authorization_consumes_request s wallet op tx accounts chain next identity :
  authorize s wallet op tx accounts chain = (next, Accepted identity) ->
  authorization_identity next op tx = None.
Proof.
  unfold authorize. destruct (authorization_identity s op tx) as [candidate|] eqn:Hauthorization;
    try discriminate.
  destruct (Wallet.preflight wallet candidate accounts chain); try discriminate.
  intros Hresult. inversion Hresult; subst; clear Hresult.
  unfold authorization_identity in *. cbn in *.
  destruct (active s) as [operation|]; try discriminate.
  destruct (Z.eqb op (operation_id operation)); try discriminate.
  destruct (operation_status operation); try discriminate.
  destruct (Z.eqb transaction tx); try discriminate.
  rewrite find_entry_after_signing.
  destruct (find_entry tx (journal s)) as [e|] eqn:Hfind; try discriminate.
  destruct (entry_phase e) eqn:Hphase; try discriminate.
  cbn. unfold signing_entry.
  apply found_entry_matches_id in Hfind. rewrite Hfind, Hphase. reflexivity.
Qed.

Lemma begin_operation_binds_candidate s wallet candidate label next op :
  begin_operation s wallet (Some candidate) label = (next, Accepted op) ->
  Wallet.current_identity wallet = Some candidate /\
  active next = Some (Operation op label candidate CanWrite).
Proof.
  unfold begin_operation. destruct (active s); try discriminate.
  destruct (Wallet.permits wallet candidate) eqn:Hpermit; try discriminate.
  intros Hresult. inversion Hresult; subst. split; try reflexivity.
  now apply Wallet.permits_spec.
Qed.

Lemma preflight_cannot_broadcast hash :
  advance AwaitingPreflight (Broadcast hash) = AwaitingPreflight.
Proof. reflexivity. Qed.

Lemma receipt_without_broadcast_ignored hash sender success block used price :
  advance AwaitingSignature (Receipt hash sender success block used price) = AwaitingSignature.
Proof. reflexivity. Qed.

Lemma unclassified_submission_error_is_unknown code message :
  Wallet.code_is code 4001 = false ->
  advance AwaitingSignature (SignatureFailed code message) = SubmissionUnknown message.
Proof. cbn. intros Hcode. now rewrite Hcode. Qed.

Lemma wrong_sender_receipt_stays_unconfirmed id e hash error sender success block used price :
  Z.eqb id (entry_id e) = true -> entry_phase e = Submitted hash error ->
  sender <> sender_of e ->
  entry_phase (apply_entry id (Receipt hash sender success block used price) e) =
    Submitted hash (Some "Receipt sender differs from the requested authority.").
Proof.
  intros Hid Hphase Hsender. unfold apply_entry. rewrite Hid. cbn.
  unfold event_phase. destruct (string_dec sender (sender_of e)); try contradiction.
  now rewrite Hphase.
Qed.

Lemma request_write_requires_idle_operation s wallet op label authority next tx :
  request_write s wallet op label authority = (next, Accepted tx) ->
  exists operation, active s = Some operation /\ operation_id operation = op /\
    operation_status operation = CanWrite /\
    Wallet.current_identity wallet = Some (operation_identity operation).
Proof.
  unfold request_write. destruct (active s) as [operation|] eqn:Hactive; try discriminate.
  destruct (Z.eqb op (operation_id operation)) eqn:Hoperation; try discriminate.
  destruct (operation_status operation) eqn:Hstatus; try discriminate.
  destruct (Wallet.permits wallet (operation_identity operation)) eqn:Hpermit; try discriminate.
  intros _. apply Z.eqb_eq in Hoperation. apply Wallet.permits_spec in Hpermit.
  exists operation. auto.
Qed.

Lemma combined_authorization_has_current_identity s wallet op tx accounts chain identity :
  authorization_result (authorize_and_reconcile s wallet op tx accounts chain) = Accepted identity ->
  Wallet.current_identity (authorization_wallet (authorize_and_reconcile s wallet op tx accounts chain)) = Some identity.
Proof.
  unfold authorize_and_reconcile, authorize.
  destruct (authorization_identity s op tx) as [candidate|] eqn:Hcandidate; cbn; try discriminate.
  destruct (Wallet.preflight wallet candidate accounts chain) eqn:Hpreflight; cbn; try discriminate.
  intros Hresult. inversion Hresult; subst.
  rewrite (Wallet.successful_preflight_keeps_wallet _ _ _ _ Hpreflight). cbn.
  now apply Wallet.preflight_requires_current in Hpreflight.
Qed.

Definition replaced_phase p := match p with Superseded _ _ _ => true | _ => false end.
Lemma replaced_advance_remains_replaced hash receipt error event :
  replaced_phase (advance (Superseded hash receipt error) event) = true.
Proof. destruct receipt; destruct event; cbn; try reflexivity.
  destruct (string_dec hash hash0); reflexivity. Qed.
Lemma replaced_observation_remains_replaced e original candidate hash sender success block used price :
  replaced_phase (entry_phase e) = true ->
  replaced_phase (entry_phase (observe_replacement e original candidate hash sender success block used price)) = true.
Proof. destruct (entry_phase e) as [| |old err|old b g|old b g|old received err|m|m] eqn:Hphase; cbn; try discriminate.
  intro H. unfold observe_replacement; rewrite Hphase; destruct received; try (rewrite Hphase; reflexivity).
  repeat match goal with |- context[if ?test then _ else _] => destruct test end;
    cbn; rewrite ?Hphase; reflexivity. Qed.
Lemma different_call_never_confirms_original e original candidate hash sender success block used price :
  R.classify original candidate = R.DifferentCall ->
  (exists current error,entry_phase e = Submitted current error) ->
  match entry_phase (observe_replacement e original candidate hash sender success block used price) with
  | Confirmed _ _ _ => False | _ => True end.
Proof. intros Hcall [current [error Hphase]]. unfold observe_replacement; rewrite Hphase.
  repeat match goal with |- context[if ?test then _ else _] => destruct test end;
    rewrite ?Hcall; cbn; rewrite ?Hphase; try trivial; congruence. Qed.
Lemma replaced_event_phase e event : replaced_phase (entry_phase e) = true ->
  replaced_phase (event_phase e event) = true.
Proof. unfold event_phase; destruct event; intro H;
  try (destruct (entry_phase e); cbn in H; try discriminate; apply replaced_advance_remains_replaced).
  destruct (string_dec sender (sender_of e)); destruct (entry_phase e); cbn in H;
    try discriminate; apply replaced_advance_remains_replaced. Qed.
Lemma replaced_entry_never_confirms_original id event e :
  replaced_phase (entry_phase e) = true ->
  replaced_phase (entry_phase (apply_entry id event e)) = true.
Proof. intro H. unfold apply_entry. destruct (Z.eqb id (entry_id e)); try assumption.
  destruct event; try (apply replaced_event_phase; assumption).
  - unfold observe_descriptor.
    destruct (entry_phase e) as [| |old err|old b g|old b g|old received err|m|m] eqn:Hp;
      cbn in H; try discriminate.
    destruct received; repeat match goal with |- context[if ?test then _ else _] => destruct test end;
      cbn; rewrite ?Hp; reflexivity.
  - apply replaced_observation_remains_replaced; assumption.
Qed.

End Transactions.
