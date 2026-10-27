From Coq Require Import ZArith String Ascii List Bool Lia.
From DEXFormal.Spec Require Import Types Assets.
From DEXFormal.Frontend Require Import Wallet Transactions.
Import ListNotations.
Open Scope string_scope.
Open Scope Z_scope.

Module TransactionHistory.
Module T := Transactions.
Inductive availability := Loading | Available | Unavailable (reason : string).
Inductive response := NoResponse | AcceptedId (id : Z) | AcceptedUnit
  | AcceptedIdentity (identity : Wallet.identity) | Refused (message : string).
Record saved_archive := SavedArchive {
  saved_scope : string;
  saved_instance : string;
  saved_serial : Z;
  saved_entries : list T.entry
}.
Record archive := Archive { owner : string; observed : T.state }.
Record state := State {
  expected_chain : Z;
  instance : string;
  archive_scope : string;
  transactions : T.state;
  previous : list archive;
  storage : availability;
  warning : option string;
  queued : option response
}.
Definition initial chain page := match page with
  | Some id => State chain id EmptyString T.initial [] Loading None None
  | None => State chain "memory" EmptyString T.initial []
      (Unavailable "Saved history is unavailable in this environment. Activity is kept only in this page.") None None end.
Definition restore_without_hash := "No transaction hash was saved. A request may still complete in the wallet or another page, or may already have been submitted. Check before sending again.".
Definition restore_receipt := "Checking the saved transaction on this chain.".
Definition invalid_archive := "Some saved history is unreadable. Those records have been left unchanged.".
Definition scope (genesis deployment endpoint : string) := "twopool:history:v1:" ++ Assets.lower genesis ++ ":" ++ deployment ++ ":" ++ endpoint.
(* The deployment key contains the chain id and the deployed exchange addresses.
   A fresh page instance writes its own atomic Storage value; old instances are read-only. *)
Definition valid_hash (hash : string) : bool :=
  match hash with
  | String prefix (String x payload) =>
      Ascii.eqb prefix "0"%char && Ascii.eqb x "x"%char &&
      Nat.eqb (String.length payload) 64 && Assets.hexadecimal payload
  | _ => false
  end.
Definition valid_address address :=
  match Assets.canonical_address address with Some _ => true | None => false end.
Definition valid_phase phase :=
  match phase with
  | T.AwaitingPreflight | T.AwaitingSignature | T.Rejected _ | T.SubmissionUnknown _ => true
  | T.Submitted hash _ => valid_hash hash
  | T.Confirmed hash block gas | T.Reverted hash block gas =>
      valid_hash hash && (0 <=? block) && (0 <=? gas)
  end.
Definition valid_entry chain serial (entry : T.entry) :=
  (0 <? T.entry_id entry) && (T.entry_id entry <=? serial) &&
  Z.eqb (Wallet.identity_chain (T.entry_identity entry)) chain &&
  valid_address (Wallet.identity_address (T.entry_identity entry)) &&
  valid_address (T.sender_of entry) && valid_phase (T.entry_phase entry).
Fixpoint unique_ids (entries : list T.entry) :=
  match entries with
  | [] => true
  | entry :: rest =>
      negb (existsb (fun other => Z.eqb (T.entry_id entry) (T.entry_id other)) rest) && unique_ids rest
  end.
Definition valid_archive chain serial entries :=
  (0 <=? serial) && forallb (valid_entry chain serial) entries && unique_ids entries.

Definition restore_entry (entry : T.entry) := T.changed_phase entry (match T.entry_phase entry with
  | T.AwaitingPreflight | T.AwaitingSignature => T.SubmissionUnknown restore_without_hash
  | T.Submitted hash _ | T.Confirmed hash _ _ | T.Reverted hash _ _ => T.Submitted hash (Some restore_receipt)
  | other => other end).
Definition restore_transactions serial entries := T.State serial None (map restore_entry entries) None.
Fixpoint instance_characters (name : string) : bool := match name with
  | EmptyString => true
  | String c rest => (Assets.hex_digit c || Ascii.eqb c "-"%char) && instance_characters rest end.
Definition valid_instance name := Nat.eqb (String.length name) 36 && instance_characters name.
Definition storage_key s := archive_scope s ++ ":" ++ instance s.
Definition valid_saved (s : state) namespace actual saved :=
  String.eqb namespace (saved_scope saved) && String.eqb actual (saved_instance saved) &&
  valid_instance actual &&
  negb (String.eqb actual (instance s)) &&
  valid_archive (expected_chain s) (saved_serial saved) (saved_entries saved).
Definition decode_snapshot s namespace (raw : string * option saved_archive) :=
  match snd raw with
  | Some saved => if valid_saved s namespace (fst raw) saved
    then Some (Archive (saved_instance saved) (restore_transactions (saved_serial saved) (saved_entries saved))) else None
  | None => None end.
Definition collect_snapshots s namespace raw := flat_map (fun item =>
  match decode_snapshot s namespace item with Some archive => [archive] | None => [] end) raw.
Definition any_invalid s namespace raw := existsb (fun item =>
  if String.eqb (fst item) (instance s) then false else
  match decode_snapshot s namespace item with Some _ => false | None => true end) raw.
Definition merge_previous (old incoming : list archive) := List.app old (filter (fun item =>
  negb (existsb (fun known => String.eqb (owner item) (owner known)) old)) incoming).
Definition loaded (s : state) namespace raw := match storage s with
  | Loading => State (expected_chain s) (instance s) namespace (transactions s)
      (merge_previous (previous s) (collect_snapshots s namespace raw)) Available
      (if any_invalid s namespace raw then Some invalid_archive else warning s) None
  | _ => s end.
Definition load_failed s namespace message :=
  State (expected_chain s) (instance s) namespace (transactions s) (previous s) (Unavailable message) (warning s) None.
Definition error s := match storage s with Unavailable message => Some message | Loading | Available => warning s end.
Definition preference_warning s message := State (expected_chain s) (instance s) (archive_scope s)
  (transactions s) (previous s) (storage s)
  (match warning s with Some existing => Some existing | None => Some message end) (queued s).

Definition stage s candidate answer :=
  match queued s with
  | Some _ => (s, Refused "A transaction update is being saved.")
  | None => match storage s with
    | Available => (State (expected_chain s) (instance s) (archive_scope s) candidate (previous s)
        Available (warning s) (Some answer), NoResponse)
    | Loading | Unavailable _ =>
        (State (expected_chain s) (instance s) (archive_scope s) candidate (previous s)
          (storage s) (warning s) None, answer)
    end end.
Definition saved s := match queued s with
  | Some answer => (State (expected_chain s) (instance s) (archive_scope s) (transactions s)
      (previous s) Available (warning s) None, answer)
  | None => (s, NoResponse) end.
Definition save_failed s message :=
  (State (expected_chain s) (instance s) (archive_scope s) (transactions s) (previous s)
    (Unavailable message) (warning s) None,
   match queued s with Some answer => answer | None => NoResponse end).
Definition needs_save s := match queued s with Some _ => true | None => false end.
Definition can_retry_save s := match storage s with
  | Unavailable _ => negb (String.eqb (archive_scope s) EmptyString) && negb (String.eqb (instance s) "memory")
  | Loading | Available => false end.
Definition can_retry_load s := match storage s with Unavailable _ => negb (String.eqb (instance s) "memory") | Loading | Available => false end.
Definition retry_save s :=
  if can_retry_save s then State (expected_chain s) (instance s) (archive_scope s) (transactions s)
    (previous s) Available (warning s) (Some NoResponse) else s.
Definition retry_load s := match storage s with
  | Unavailable _ => State (expected_chain s) (instance s) (archive_scope s) (transactions s)
      (previous s) Loading (warning s) None
  | Loading | Available => s end.
Definition flush_loaded s := match storage s with
  | Available => if 0 <? T.serial (transactions s) then fst (stage s (transactions s) NoResponse) else s
  | Loading | Unavailable _ => s end.
Definition visible_entries s :=
  List.app (map (fun entry => (instance s, entry)) (T.journal (transactions s)))
  (flat_map (fun archive => map (fun entry => (owner archive, entry)) (T.journal (observed archive))) (previous s)).
Definition pending_receipts s := flat_map (fun item =>
  match T.entry_phase (snd item) with
  | T.Submitted hash _ => [(fst item, (T.entry_id (snd item), hash))]
  | _ => [] end) (visible_entries s).
Definition can_refresh s := negb (Nat.eqb (List.length (pending_receipts s)) 0).

Definition observe_archive (s : state) page update :=
  State (expected_chain s) (instance s) (archive_scope s) (transactions s)
    (map (fun archive => if String.eqb (owner archive) page
      then Archive (owner archive) (update (observed archive)) else archive) (previous s))
    (storage s) (warning s) (queued s).
Definition observe_receipt s page id hash sender success block used price :=
  observe_archive s page (fun tx => fst (T.settle tx id hash sender success block used price)).
Definition observation_failed s page id message :=
  observe_archive s page (fun tx => T.observation_failed tx id message).

Definition unit_response decision := match decision with
  | T.Accepted tt => AcceptedUnit | T.Denied message => Refused message end.
Definition receive_receipt s page id hash sender success block used price :=
  if String.eqb page (instance s) then
    let '(candidate, answer) := T.settle (transactions s) id hash sender success block used price in
    stage s candidate (unit_response answer)
  else (observe_receipt s page id hash sender success block used price, NoResponse).
Definition receipt_unavailable s page id message :=
  if String.eqb page (instance s) then stage s (T.observation_failed (transactions s) id message) NoResponse
  else (observation_failed s page id message, NoResponse).

Theorem restore_has_no_operation serial entries : T.active (restore_transactions serial entries) = None.
Proof. reflexivity. Qed.
Theorem restored_identity_unchanged entry : T.entry_identity (restore_entry entry) = T.entry_identity entry.
Proof. destruct entry as [id label identity authority phase]; destruct phase; reflexivity. Qed.
Theorem restored_authority_unchanged entry : T.entry_authority (restore_entry entry) = T.entry_authority entry.
Proof. destruct entry as [id label identity authority phase]; destruct phase; reflexivity. Qed.
Theorem restored_id_unchanged entry : T.entry_id (restore_entry entry) = T.entry_id entry.
Proof. destruct entry as [id label identity authority phase]; destruct phase; reflexivity. Qed.
Theorem restored_sender_unchanged entry : T.sender_of (restore_entry entry) = T.sender_of entry.
Proof. unfold T.sender_of; rewrite restored_identity_unchanged, restored_authority_unchanged; reflexivity. Qed.
Theorem restored_signature_is_unknown entry : T.entry_phase entry = T.AwaitingSignature ->
  T.entry_phase (restore_entry entry) = T.SubmissionUnknown restore_without_hash.
Proof. intros H; unfold restore_entry; rewrite H; reflexivity. Qed.
Theorem restored_preflight_is_unknown entry :
  T.entry_phase entry = T.AwaitingPreflight ->
  T.entry_phase (restore_entry entry) = T.SubmissionUnknown restore_without_hash.
Proof. intro H; unfold restore_entry; rewrite H; reflexivity. Qed.
Theorem restore_never_waits_for_signature entry :
  T.entry_phase (restore_entry entry) <> T.AwaitingSignature /\ T.entry_phase (restore_entry entry) <> T.AwaitingPreflight.
Proof. destruct entry as [id label identity authority phase]; destruct phase; simpl; split; discriminate. Qed.
Theorem archive_chain_and_scope_checked s namespace actual saved :
  valid_saved s namespace actual saved = true -> saved_scope saved = namespace /\ saved_instance saved = actual.
Proof.
  unfold valid_saved; intros H; repeat rewrite andb_true_iff in H.
  destruct H as [[[[Hscope Howner] _] _] _]. apply String.eqb_eq in Hscope; apply String.eqb_eq in Howner; auto.
Qed.
Theorem restore_id_bounded chain serial entries entry :
  valid_archive chain serial entries = true -> In entry (map restore_entry entries) -> 0 < T.entry_id entry <= serial.
Proof.
  unfold valid_archive; intros H Hin; apply andb_true_iff in H as [H _].
  apply andb_true_iff in H as [_ Hall].
  pose proof (proj1 (@List.forallb_forall T.entry (valid_entry chain serial) entries) Hall) as HallEntries.
  apply in_map_iff in Hin as [original [<- Hin]]. rewrite restored_id_unchanged.
  specialize (HallEntries original Hin). unfold valid_entry in HallEntries.
  repeat rewrite andb_true_iff in HallEntries. destruct HallEntries as [[[[[Hpositive Hbound] _] _] _] _].
  apply Z.ltb_lt in Hpositive; apply Z.leb_le in Hbound; lia.
Qed.
Theorem loading_does_not_replace_current_operation s namespace raw :
  transactions (loaded s namespace raw) = transactions s.
Proof. unfold loaded; destruct (storage s); reflexivity. Qed.
Theorem foreign_observation_cannot_change_current_state s page update :
  transactions (observe_archive s page update) = transactions s.
Proof. reflexivity. Qed.
Theorem foreign_observation_never_creates_archive_write s page update :
  queued (observe_archive s page update) = queued s.
Proof. reflexivity. Qed.
Theorem saved_preserves_current_state s : transactions (fst (saved s)) = transactions s.
Proof. unfold saved; destruct (queued s); reflexivity. Qed.
Theorem failed_storage_preserves_current_state s reason :
  transactions (fst (save_failed s reason)) = transactions s.
Proof. reflexivity. Qed.
Theorem failed_storage_preserves_authorization_result s reason answer :
  queued s = Some answer -> snd (save_failed s reason) = answer.
Proof. intros H; unfold save_failed; rewrite H; reflexivity. Qed.
Theorem memory_mode_preserves_core_result s tx answer reason :
  storage s = Unavailable reason -> queued s = None ->
  snd (stage s tx answer) = answer /\ transactions (fst (stage s tx answer)) = tx /\
  queued (fst (stage s tx answer)) = None.
Proof. intros Hs Hq; unfold stage; rewrite Hq, Hs; repeat split; reflexivity. Qed.
Theorem separate_instances_have_distinct_visible_ids (page1 page2 : string) (id1 id2 : Z) :
  page1 <> page2 -> (page1, id1) <> (page2, id2).
Proof. intros Hneq Heq; inversion Heq; contradiction. Qed.
Theorem foreign_receipt_is_read_only s page id hash sender success block used price :
  page <> instance s -> queued s = None ->
  transactions (fst (receive_receipt s page id hash sender success block used price)) = transactions s /\
  needs_save (fst (receive_receipt s page id hash sender success block used price)) = false.
Proof.
  intros Hpage Hqueue; unfold receive_receipt; apply String.eqb_neq in Hpage; rewrite Hpage.
  split; [reflexivity|]. unfold needs_save, observe_receipt, observe_archive; simpl; rewrite Hqueue; reflexivity.
Qed.
Theorem foreign_failed_observation_is_read_only s page id message :
  page <> instance s -> queued s = None ->
  transactions (fst (receipt_unavailable s page id message)) = transactions s /\
  needs_save (fst (receipt_unavailable s page id message)) = false.
Proof.
  intros Hpage Hqueue; unfold receipt_unavailable; apply String.eqb_neq in Hpage; rewrite Hpage.
  split; [reflexivity|]. unfold needs_save, observation_failed, observe_archive; simpl; rewrite Hqueue; reflexivity.
Qed.
Theorem confirmed_entry_cannot_be_downgraded_by_observation id entry hash block gas message :
  T.entry_phase entry = T.Confirmed hash block gas ->
  T.entry_phase (T.apply_entry id (T.ObservationFailed message) entry) = T.Confirmed hash block gas.
Proof.
  intros Hphase; unfold T.apply_entry; destruct (Z.eqb id (T.entry_id entry)); [|exact Hphase].
  unfold T.changed_phase, T.event_phase; simpl; rewrite Hphase; reflexivity.
Qed.
Theorem load_failure_keeps_inflight_operation s namespace reason :
  transactions (load_failed s namespace reason) = transactions s.
Proof. reflexivity. Qed.
Theorem restored_archive_cannot_request_a_write serial entries wallet op label authority :
  exists reason, snd (T.request_write (restore_transactions serial entries) wallet op label authority) = T.Denied reason.
Proof. unfold T.request_write, restore_transactions; simpl; eexists; reflexivity. Qed.
Theorem restored_archive_cannot_authorize serial entries wallet op tx accounts chain :
  exists reason, snd (T.authorize (restore_transactions serial entries) wallet op tx accounts chain) = T.Denied reason.
Proof. unfold T.authorize, T.authorization_identity, restore_transactions; simpl; eexists; reflexivity. Qed.

End TransactionHistory.
