From Stdlib Require Import ZArith String List Bool Lia.
From DEXFormal.Spec Require Import Types.
Import ListNotations.
Open Scope Z_scope.

Definition zero_address : address := "0x0000000000000000000000000000000000000000"%string.
Definition owner_index := list (Z * address).
Record transfer := Transfer {
  transfer_token_id : Z;
  transfer_recipient : address
}.

Fixpoint lookup_owner (id : Z) (owners : owner_index) : option address :=
  match owners with
  | [] => None
  | (key, owner) :: rest =>
      if Z.eqb id key then Some owner else lookup_owner id rest
  end.

Definition remove_owner (id : Z) (owners : owner_index) : owner_index :=
  filter (fun entry => negb (Z.eqb (fst entry) id)) owners.
Definition set_owner (id : Z) (owner : option address) (owners : owner_index) : owner_index :=
  match owner with
  | None => remove_owner id owners
  | Some value => (id, value) :: remove_owner id owners
  end.
Definition apply_transfer (owners : owner_index) (event : transfer) : owner_index :=
  set_owner (transfer_token_id event)
    (if String.eqb (transfer_recipient event) zero_address
     then None else Some (transfer_recipient event)) owners.
Definition active_owners (events : list transfer) : owner_index :=
  fold_left apply_transfer events [].

Lemma remove_owner_same id owners : lookup_owner id (remove_owner id owners) = None.
Proof.
  induction owners as [|[key owner] rest IH]; [reflexivity|].
  unfold remove_owner in *. simpl in *.
  destruct (Z.eqb key id) eqn:E; simpl; [exact IH|].
  rewrite Z.eqb_sym, E. exact IH.
Qed.

Lemma remove_owner_other query id owners : query <> id ->
  lookup_owner query (remove_owner id owners) = lookup_owner query owners.
Proof.
  intros different. induction owners as [|[key owner] rest IH]; [reflexivity|].
  unfold remove_owner in *. simpl in *.
  destruct (Z.eqb key id) eqn:E; simpl.
  - apply Z.eqb_eq in E. subst key. assert (Equery : Z.eqb query id = false) by (apply Z.eqb_neq; exact different). rewrite Equery. exact IH.
  - destruct (Z.eqb query key); [reflexivity|exact IH].
Qed.

Lemma lookup_set_same id owner owners : lookup_owner id (set_owner id owner owners) = owner.
Proof.
  destruct owner; unfold set_owner; simpl.
  - now rewrite Z.eqb_refl.
  - apply remove_owner_same.
Qed.

Lemma lookup_set_other query id owner owners : query <> id ->
  lookup_owner query (set_owner id owner owners) = lookup_owner query owners.
Proof.
  intros different. destruct owner; unfold set_owner; simpl.
  - assert (Equery : Z.eqb query id = false) by (apply Z.eqb_neq; exact different). rewrite Equery. now apply remove_owner_other.
  - now apply remove_owner_other.
Qed.

Lemma lookup_transfer_same owners event :
  lookup_owner (transfer_token_id event) (apply_transfer owners event) =
    if String.eqb (transfer_recipient event) zero_address then None
    else Some (transfer_recipient event).
Proof. unfold apply_transfer. apply lookup_set_same. Qed.

Lemma lookup_transfer_other owners event query : query <> transfer_token_id event ->
  lookup_owner query (apply_transfer owners event) = lookup_owner query owners.
Proof. unfold apply_transfer. apply lookup_set_other. Qed.

Lemma burn_removes_owner owners id :
  lookup_owner id (apply_transfer owners (Transfer id zero_address)) = None.
Proof. change (lookup_owner id (set_owner id None owners) = None). apply lookup_set_same. Qed.

Lemma removed_member id owners entry :
  In entry (remove_owner id owners) <-> In entry owners /\ fst entry <> id.
Proof.
  unfold remove_owner. rewrite filter_In, Bool.negb_true_iff, Z.eqb_neq. reflexivity.
Qed.

Lemma remove_owner_ids_subset id owners key :
  In key (map fst (remove_owner id owners)) -> In key (map fst owners).
Proof.
  rewrite !in_map_iff. intros [entry [Hkey Hin]].
  apply removed_member in Hin. exists entry. tauto.
Qed.

Lemma removed_id_absent id owners : ~ In id (map fst (remove_owner id owners)).
Proof.
  rewrite in_map_iff. intros [entry [Hkey Hin]].
  apply removed_member in Hin. destruct Hin as [_ Hne]. apply Hne. exact Hkey.
Qed.

Lemma remove_owner_unique id owners :
  NoDup (map fst owners) -> NoDup (map fst (remove_owner id owners)).
Proof.
  induction owners as [|[key owner] rest IH]; intros unique; [constructor|].
  inversion unique as [|? ? absent tail_unique]; subst.
  unfold remove_owner. simpl.
  destruct (Z.eqb key id); simpl.
  - now apply IH.
  - constructor.
    + intro present. apply absent. now apply remove_owner_ids_subset in present.
    + now apply IH.
Qed.

Lemma set_owner_unique id owner owners :
  NoDup (map fst owners) -> NoDup (map fst (set_owner id owner owners)).
Proof.
  intros unique. destruct owner; unfold set_owner; simpl.
  - constructor; [apply removed_id_absent|now apply remove_owner_unique].
  - now apply remove_owner_unique.
Qed.

Lemma transfer_unique owners event : NoDup (map fst owners) ->
  NoDup (map fst (apply_transfer owners event)).
Proof. unfold apply_transfer. apply set_owner_unique. Qed.

Lemma replay_unique events owners : NoDup (map fst owners) ->
  NoDup (map fst (fold_left apply_transfer events owners)).
Proof.
  revert owners. induction events as [|event rest IH]; intros owners unique; simpl.
  - exact unique.
  - apply IH. now apply transfer_unique.
Qed.

Theorem active_owners_unique events : NoDup (map fst (active_owners events)).
Proof. unfold active_owners. apply replay_unique. constructor. Qed.

Theorem active_owners_append events event :
  active_owners (events ++ [event]) = apply_transfer (active_owners events) event.
Proof. unfold active_owners. rewrite fold_left_app. reflexivity. Qed.

Theorem latest_transfer_controls_owner events event :
  lookup_owner (transfer_token_id event) (active_owners (events ++ [event])) =
    if String.eqb (transfer_recipient event) zero_address then None
    else Some (transfer_recipient event).
Proof. rewrite active_owners_append. apply lookup_transfer_same. Qed.

Theorem appended_transfer_preserves_other events event query : query <> transfer_token_id event ->
  lookup_owner query (active_owners (events ++ [event])) = lookup_owner query (active_owners events).
Proof. rewrite active_owners_append. apply lookup_transfer_other. Qed.

(* Replay assumes canonical, chronological ERC721 Transfer observations from the
   same ERC721 contract at one fixed block. Correspondence to ERC721 storage is an external contract,
   not a theorem about OpenZeppelin or EVM execution in this module. *)
