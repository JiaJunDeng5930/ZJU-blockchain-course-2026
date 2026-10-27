From Coq Require Import ZArith String List Bool Lia.
From DEXFormal.Frontend Require Import Wallet Transactions.
Import ListNotations.
Open Scope Z_scope.
Open Scope string_scope.

(* A read-only projection of the canonical transaction entries. No restored or
   filtered row can become an operation or produce a wallet/storage effect. *)
Module Activity.
Module T := Transactions.
Inductive account_filter := AllAccounts | CurrentAccount.
Inductive status_filter := AllStatuses | Pending | Successful | Failed | Unknown.
Record query := Query {
  account_selection : account_filter;
  status_selection : status_filter;
  requested_page : Z;
  observed_account : option string
}.
Definition initial := Query AllAccounts AllStatuses 1 None.
Inductive event := SelectAccount (value : account_filter)
  | SelectStatus (value : status_filter) | Previous | Next | Reset.
Definition entry := (string * T.entry)%type.
Definition page_size : nat := 20.

Definition status_matches (selected : status_filter) (phase : T.phase) : bool :=
  match selected, phase with
  | AllStatuses, _ => true
  | Pending, T.AwaitingPreflight | Pending, T.AwaitingSignature | Pending, T.Submitted _ _ => true
  | Successful, T.Confirmed _ _ _ => true
  | Failed, T.Reverted _ _ _ | Failed, T.Rejected _ => true
  | Unknown, T.SubmissionUnknown _ => true
  | _, _ => false
  end.
Definition account_matches selected account (transaction : T.entry) :=
  match selected, account with
  | AllAccounts, _ => true
  | CurrentAccount, Some address => String.eqb address
      (Wallet.identity_address (T.entry_identity transaction)) ||
      String.eqb address (T.sender_of transaction)
  | CurrentAccount, None => false
  end.
Definition matches q account (row : entry) :=
  account_matches (account_selection q) account (snd row) &&
  status_matches (status_selection q) (T.entry_phase (snd row)).
Definition matching q account rows := filter (matches q account) rows.
Definition same_account (left right : option string) :=
  match left, right with
  | None, None => true | Some a, Some b => String.eqb a b | _, _ => false end.
Definition pages (count : nat) := Nat.div (count + 19) 20.
Definition requested_index q account :=
  if same_account (observed_account q) account
  then Z.to_nat (Z.max 0 (requested_page q - 1)) else 0%nat.
Definition index q account count := Nat.min (requested_index q account) (Nat.pred (pages count)).
Definition slice (position : nat) (rows : list entry) :=
  firstn page_size (skipn (position * page_size) rows).
Record page := Page {
  normalized_query : query;
  entries : list entry;
  total : nat;
  filtered_total : nat;
  page_number : Z;
  page_count : nat;
  can_previous : bool;
  can_next : bool;
  can_current_account : bool;
  empty_message : string
}.
Definition view q account rows :=
  let selected := matching q account rows in
  let count := List.length selected in
  let position := index q account count in
  let number := if Nat.eqb count 0 then 0 else Z.of_nat (S position) in
  Page (Query (account_selection q) (status_selection q) number account)
    (slice position selected) (List.length rows) count number (pages count)
    (Nat.ltb 0 position) (Nat.ltb (S position) (pages count))
    (match account with None => false | Some _ => true end)
    (if Nat.eqb (List.length rows) 0 then "No transactions yet."
     else match account_selection q, account with
     | CurrentAccount, None => "Connect an account to see its transactions, or show all accounts."
     | _, _ => "No transactions match these filters."
     end).
Definition step q account rows action :=
  let current := normalized_query (view q account rows) in
  let candidate := match action with
  | SelectAccount value => Query value (status_selection current) 1 account
  | SelectStatus value => Query (account_selection current) value 1 account
  | Previous => Query (account_selection current) (status_selection current) (requested_page current - 1) account
  | Next => Query (account_selection current) (status_selection current) (requested_page current + 1) account
  | Reset => Query AllAccounts AllStatuses 1 account
  end in view candidate account rows.

Lemma in_firstn_original {A} (n : nat) (rows : list A) row :
  In row (firstn n rows) -> In row rows.
Proof. revert rows; induction n; intros [|x xs] H; simpl in *; try contradiction.
  destruct H; [now left|right; now apply IHn]. Qed.
Lemma in_skipn_original {A} (n : nat) (rows : list A) row :
  In row (skipn n rows) -> In row rows.
Proof. revert rows; induction n; intros [|x xs] H; simpl in *; try contradiction; auto. Qed.
Theorem page_contains_only_original_entries q account rows row :
  In row (entries (view q account rows)) -> In row rows.
Proof. unfold view; simpl; unfold slice; intro H.
  apply in_firstn_original in H; apply in_skipn_original in H.
  now apply filter_In in H as [H _]. Qed.
Theorem page_contains_only_matching_entries q account rows row :
  In row (entries (view q account rows)) -> matches q account row = true.
Proof. unfold view; simpl; unfold slice; intro H.
  apply in_firstn_original in H; apply in_skipn_original in H.
  now apply filter_In in H as [_ H]. Qed.
Theorem matching_is_complete q account rows row :
  In row (matching q account rows) <-> In row rows /\ matches q account row = true.
Proof. apply filter_In. Qed.
Theorem page_length_bounded q account rows :
  (List.length (entries (view q account rows)) <= page_size)%nat.
Proof. unfold view; simpl; apply firstn_le_length. Qed.
Theorem all_filters_preserve_every_entry account rows requested observed :
  matching (Query AllAccounts AllStatuses requested observed) account rows = rows.
Proof. induction rows as [|[owner transaction] rest IH]; simpl; now rewrite ?IH. Qed.
Theorem current_account_never_uses_disconnected_identity q rows :
  account_selection q = CurrentAccount -> matching q None rows = [].
Proof. intro H; unfold matching, matches; rewrite H.
  induction rows; simpl; assumption || reflexivity. Qed.
Theorem current_account_rows_involve_address q account rows owner transaction :
  account_selection q = CurrentAccount ->
  In (owner, transaction) (entries (view q (Some account) rows)) ->
  Wallet.identity_address (T.entry_identity transaction) = account \/ T.sender_of transaction = account.
Proof. intros H HIn; apply page_contains_only_matching_entries in HIn.
  unfold matches, account_matches in HIn; rewrite H in HIn; simpl in HIn.
  apply andb_true_iff in HIn as [HIn _]; apply orb_true_iff in HIn as [HIn|HIn];
  apply String.eqb_eq in HIn; [left|right]; symmetry; assumption. Qed.
Theorem current_faucet_belongs_to_beneficiary id label identity sender phase :
  account_matches CurrentAccount (Some (Wallet.identity_address identity))
    (T.Entry id label identity (T.FaucetAuthority sender) phase) = true.
Proof. simpl; rewrite String.eqb_refl; reflexivity. Qed.
Theorem account_change_resets_position q account count :
  same_account (observed_account q) account = false -> index q account count = 0%nat.
Proof. intro H; unfold index, requested_index; rewrite H; reflexivity. Qed.
Theorem page_index_is_bounded q account count :
  (index q account count <= Nat.pred (pages count))%nat.
Proof. apply Nat.le_min_r. Qed.
Theorem page_reassembly position rows :
  List.app (slice position rows) (skipn page_size (skipn (position * page_size) rows)) =
    skipn (position * page_size) rows.
Proof. unfold slice; apply firstn_skipn. Qed.
Theorem view_keeps_selected_filters q account rows :
  account_selection (normalized_query (view q account rows)) = account_selection q /\
  status_selection (normalized_query (view q account rows)) = status_selection q.
Proof. split; reflexivity. Qed.
Theorem receipt_update_keeps_requested_position q account count :
  same_account (observed_account q) account = true ->
  (requested_index q account <= Nat.pred (pages count))%nat ->
  index q account count = requested_index q account.
Proof. intros _ H; unfold index; now apply Nat.min_l. Qed.
End Activity.
