From Coq Require Import ZArith String List Bool Lia.
From DEXFormal.Spec Require Import Types Assets.
From DEXFormal.Frontend Require Import Wallet Transactions.
Import ListNotations.
Open Scope Z_scope.
Open Scope string_scope.
Open Scope Z_scope.

(* The checkpoint belongs to one browser tab and contains only known broadcasts.
   Restoring it grants observation, never an operation or signing permission. *)
Module PendingTransactions.
Module T := Transactions.
Module R := T.R.
Inductive availability := Loading | Available | Unavailable (reason : string).
Inductive response := NoResponse | AcceptedId (id : Z) | AcceptedUnit
  | AcceptedIdentity (identity : Wallet.identity) | Refused (message : string).
Record checkpoint := Checkpoint {
  saved_scope : string;
  saved_serial : Z;
  saved_entries : list T.entry
}.
Record state := State {
  expected_chain : Z;
  instance : string;
  checkpoint_scope : string;
  transactions : T.state;
  storage : availability;
  warning : option string
}.
Definition initial chain page := State chain
  (match page with Some value => value | None => "page" end) "" T.initial Loading None.
Definition scope genesis deployment endpoint :=
  "twopool:pending:v1:" ++ Assets.lower genesis ++ ":" ++ deployment ++ ":" ++ endpoint.
Definition storage_key s := checkpoint_scope s.
Definition known_broadcast e := match T.entry_phase e with
  | T.Submitted _ _ => true | _ => false end.
Definition pending_entries s := filter known_broadcast (T.journal (transactions s)).
Definition visible_entries s := map (fun entry => (instance s,entry)) (T.journal (transactions s)).
Definition valid_entry chain serial e :=
  (0 <? T.entry_id e) && (T.entry_id e <=? serial) &&
  Z.eqb (Wallet.identity_chain (T.entry_identity e)) chain &&
  R.valid_address (Wallet.identity_address (T.entry_identity e)) &&
  R.valid_address (T.sender_of e) &&
  match T.entry_phase e with
  | T.Submitted hash _ => R.valid_hash hash && match T.entry_descriptor e with
      | None => true
      | Some d => R.valid_descriptor d && String.eqb (R.tx_hash d) hash &&
          String.eqb (R.tx_from d) (T.sender_of e) end
  | _ => false end.
Fixpoint unique_ids entries := match entries with
  | [] => true
  | e :: rest => negb (existsb (fun other => Z.eqb (T.entry_id e) (T.entry_id other)) rest) && unique_ids rest end.
Definition valid_checkpoint chain namespace saved :=
  String.eqb (saved_scope saved) namespace && (0 <=? saved_serial saved) &&
  forallb (valid_entry chain (saved_serial saved)) (saved_entries saved) &&
  unique_ids (saved_entries saved).
Definition restore_transactions saved := T.State (saved_serial saved) None (saved_entries saved) None.
Definition invalid_checkpoint := "Pending transaction recovery is unavailable: the saved checkpoint is invalid. Its contents were left unchanged.".
(* DEFENSE: sessionStorage may contain an edited checkpoint or one from another local-chain deployment. *)
Definition loaded s namespace decoded saved :=
  let next := match saved with
    | None => Some T.initial
    | Some value => if valid_checkpoint (expected_chain s) namespace value
        then Some (restore_transactions value) else None end in
  match decoded,next with
  | true,Some tx => State (expected_chain s) (instance s) namespace tx Available None
  | _,_ => State (expected_chain s) (instance s) namespace (transactions s)
      (Unavailable invalid_checkpoint) None end.
Definition load_failed s namespace message := State (expected_chain s) (instance s) namespace
  (transactions s) (Unavailable message) None.
Definition error s := match storage s with
  | Unavailable message => Some message | _ => warning s end.
Definition preference_warning s message := State (expected_chain s) (instance s) (checkpoint_scope s)
  (transactions s) (storage s) (Some message).
Definition stage s candidate := State (expected_chain s) (instance s) (checkpoint_scope s)
  candidate (storage s) (warning s).
Definition save_failed s message := State (expected_chain s) (instance s) (checkpoint_scope s)
  (transactions s) (Unavailable message) (warning s).
Definition can_save s := match storage s with Available => true | _ => false end.
Definition pending_receipts s := flat_map (fun entry => match T.entry_phase entry with
  | T.Submitted hash _ => [(instance s,(T.entry_id entry,hash))] | _ => [] end) (T.journal (transactions s)).
Definition unit_response decision := match decision with
  | T.Accepted tt => AcceptedUnit | T.Denied message => Refused message end.
Definition receive_receipt s page id hash sender success block used price :=
  if String.eqb page (instance s) then
    let '(candidate,answer) := T.settle (transactions s) id hash sender success block used price in
    (stage s candidate,unit_response answer) else (s,NoResponse).
Definition receipt_unavailable s page id message :=
  if String.eqb page (instance s) then (stage s (T.observation_failed (transactions s) id message),NoResponse)
  else (s,NoResponse).
Definition receive_descriptor s page id descriptor :=
  if String.eqb page (instance s) then (stage s (T.describe (transactions s) id descriptor),AcceptedUnit)
  else (s,NoResponse).
Definition receive_replacement s page id original candidate hash sender success block used price :=
  if String.eqb page (instance s) then
    let next := T.replacement (transactions s) id original candidate hash sender success block used price in
    (stage s next,unit_response (T.settlement_decision next id)) else (s,NoResponse).
Definition receive_metadata_error s page id message :=
  if String.eqb page (instance s) then (stage s
    (T.apply_journal (transactions s) id (T.ObservationFailed message)),AcceptedUnit) else (s,NoResponse).

Theorem restore_has_no_operation saved : T.active (restore_transactions saved) = None.
Proof. reflexivity. Qed.
Theorem restored_entries_unchanged saved : T.journal (restore_transactions saved) = saved_entries saved.
Proof. reflexivity. Qed.
Theorem startup_restores_no_operation chain page namespace decoded checkpoint :
  T.active (transactions (loaded (initial chain page) namespace decoded checkpoint)) = None.
Proof.
  unfold loaded; destruct checkpoint as [checkpoint|].
  - destruct (valid_checkpoint (expected_chain (initial chain page)) namespace checkpoint);
      destruct decoded; reflexivity.
  - destruct decoded; reflexivity.
Qed.
Theorem checkpoint_contains_only_broadcasts s e : In e (pending_entries s) -> known_broadcast e = true.
Proof. unfold pending_entries; intro H; apply filter_In in H; tauto. Qed.
Theorem completed_is_not_checkpointed s e hash block gas :
  T.entry_phase e = T.Confirmed hash block gas -> ~ In e (pending_entries s).
Proof. intros Hphase Hin; apply checkpoint_contains_only_broadcasts in Hin.
  unfold known_broadcast in Hin; rewrite Hphase in Hin; discriminate. Qed.
Theorem reverted_is_not_checkpointed s e hash block gas :
  T.entry_phase e = T.Reverted hash block gas -> ~ In e (pending_entries s).
Proof. intros Hphase Hin; apply checkpoint_contains_only_broadcasts in Hin.
  unfold known_broadcast in Hin; rewrite Hphase in Hin; discriminate. Qed.
Theorem signature_is_not_checkpointed s e :
  T.entry_phase e = T.AwaitingSignature -> ~ In e (pending_entries s).
Proof. intros Hphase Hin; apply checkpoint_contains_only_broadcasts in Hin.
  unfold known_broadcast in Hin; rewrite Hphase in Hin; discriminate. Qed.
Theorem valid_checkpoint_bound_to_scope chain namespace checkpoint :
  valid_checkpoint chain namespace checkpoint = true -> saved_scope checkpoint = namespace.
Proof. unfold valid_checkpoint; repeat rewrite andb_true_iff; intros [[[H _] _] _].
  now apply String.eqb_eq. Qed.
End PendingTransactions.
