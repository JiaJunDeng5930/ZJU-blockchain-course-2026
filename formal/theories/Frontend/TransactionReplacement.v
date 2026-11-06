From Coq Require Import ZArith String Ascii List Bool Lia.
From DEXFormal.Spec Require Import Types Assets.
Import ListNotations.
Open Scope Z_scope.
Open Scope string_scope.
Open Scope Z_scope.

Module TransactionReplacement.
Record descriptor := Descriptor {
  tx_hash : string;
  tx_from : address;
  tx_nonce : Z;
  tx_to : option address;
  tx_input : string;
  tx_value : Z;
  observed_block : Z
}.
Inductive replacement_kind := Repriced | DifferentCall.
Record replacement := Replacement {
  previous_hash : string;
  replacement_hash : string;
  replacement_type : replacement_kind
}.
Definition valid_hash hash := match hash with
  | String prefix (String x payload) => Ascii.eqb prefix "0"%char && Ascii.eqb x "x"%char &&
      Nat.eqb (String.length payload) 64 && Assets.hexadecimal payload
  | _ => false end.
Definition valid_address value := match Assets.canonical_address value with Some _ => true | None => false end.
(* The native-string extraction mapping implements pattern matches through a
   callback. Convert long calldata with the standard extraction mapping first:
   recursion over the resulting list then remains a direct tail call in OCaml. *)
Fixpoint even_length_acc (value : list ascii) (parity : bool) : bool :=
  match value with
  | [] => parity
  | _ :: rest => even_length_acc rest (negb parity)
  end.
Fixpoint hexadecimal_ascii (value : list ascii) : bool :=
  match value with
  | [] => true
  | character :: rest => if Assets.hex_digit character then hexadecimal_ascii rest else false
  end.
Lemma even_length_acc_correct value : forall parity,
  even_length_acc (list_ascii_of_string value) parity =
  Bool.eqb (Nat.even (String.length value)) parity.
Proof.
  induction value as [|character rest IH]; intros parity.
  - destruct parity; reflexivity.
  - cbn [even_length_acc list_ascii_of_string String.length]. rewrite IH.
    rewrite Nat.even_succ, <- Nat.negb_even.
    destruct (Nat.even (String.length rest)), parity; reflexivity.
Qed.
Lemma even_length_correct value :
  even_length_acc (list_ascii_of_string value) true = Nat.even (String.length value).
Proof.
  rewrite even_length_acc_correct. destruct (Nat.even (String.length value)); reflexivity.
Qed.
Lemma hexadecimal_ascii_correct value :
  hexadecimal_ascii (list_ascii_of_string value) = Assets.hexadecimal value.
Proof.
  induction value as [|character rest IH]; [reflexivity|].
  cbn [hexadecimal_ascii list_ascii_of_string Assets.hexadecimal].
  rewrite IH. destruct (Assets.hex_digit character); reflexivity.
Qed.
Definition valid_input value := match value with
  | String prefix (String x payload) =>
      let characters := list_ascii_of_string payload in
      Ascii.eqb prefix "0"%char && Ascii.eqb x "x"%char &&
      even_length_acc characters true && hexadecimal_ascii characters
  | _ => false end.
Lemma valid_input_matches_length_test value :
  valid_input value = match value with
  | String prefix (String x payload) => Ascii.eqb prefix "0"%char && Ascii.eqb x "x"%char &&
      Nat.even (String.length payload) && Assets.hexadecimal payload
  | _ => false end.
Proof.
  destruct value as [|prefix rest]; [reflexivity|].
  destruct rest as [|x payload]; [reflexivity|].
  cbn [valid_input]. rewrite even_length_correct, hexadecimal_ascii_correct. reflexivity.
Qed.
(* KNOWN LIMITATION: viem represents account nonces as JavaScript numbers.
   Refuse a nonce outside its exact integer range instead of rounding a slot. *)
Definition valid_descriptor d := valid_hash (tx_hash d) && valid_address (tx_from d) &&
  (0 <=? tx_nonce d) && (tx_nonce d <=? 9007199254740991) && (0 <=? tx_value d) && (tx_value d <=? uint256_max) &&
  (0 <=? observed_block d) && valid_input (tx_input d) &&
  match tx_to d with Some target => valid_address target | None => true end.
Definition same_target left right := match left,right with
  | None,None => true
  | Some a,Some b => String.eqb a b
  | _,_ => false end.
Definition same_nonce original candidate := String.eqb (tx_from original) (tx_from candidate) &&
  Z.eqb (tx_nonce original) (tx_nonce candidate).
Definition same_call original candidate := same_nonce original candidate &&
  same_target (tx_to original) (tx_to candidate) && String.eqb (tx_input original) (tx_input candidate) &&
  Z.eqb (tx_value original) (tx_value candidate).
Definition classify original candidate := if same_call original candidate then Repriced else DifferentCall.
Definition matches expected hash original candidate :=
  valid_descriptor original && valid_descriptor candidate &&
  String.eqb (tx_hash original) hash && String.eqb (tx_from original) expected &&
  same_nonce original candidate && negb (String.eqb (tx_hash original) (tx_hash candidate)).

Lemma same_nonce_sender original candidate : same_nonce original candidate = true -> tx_from original = tx_from candidate.
Proof. unfold same_nonce; rewrite andb_true_iff; intros [H _]; now apply String.eqb_eq. Qed.
Lemma same_nonce_number original candidate : same_nonce original candidate = true -> tx_nonce original = tx_nonce candidate.
Proof. unfold same_nonce; rewrite andb_true_iff; intros [_ H]; now apply Z.eqb_eq. Qed.
Lemma same_call_nonce original candidate : same_call original candidate = true -> same_nonce original candidate = true.
Proof. unfold same_call; repeat rewrite andb_true_iff; tauto. Qed.
Lemma same_call_input original candidate : same_call original candidate = true -> tx_input original = tx_input candidate.
Proof. unfold same_call; repeat rewrite andb_true_iff; intros [[[_ _] H] _]; now apply String.eqb_eq. Qed.
Lemma same_call_value original candidate : same_call original candidate = true -> tx_value original = tx_value candidate.
Proof. unfold same_call; repeat rewrite andb_true_iff; intros [_ H]; now apply Z.eqb_eq. Qed.
Lemma same_target_equal left right : same_target left right = true -> left = right.
Proof. destruct left,right; simpl; try discriminate; intro H; auto; now apply String.eqb_eq in H; subst. Qed.
Lemma same_call_target original candidate : same_call original candidate = true -> tx_to original = tx_to candidate.
Proof. unfold same_call; repeat rewrite andb_true_iff; intros [[[ _ H] _] _]; now apply same_target_equal. Qed.
Theorem repriced_keeps_call original candidate : classify original candidate = Repriced ->
  tx_from original = tx_from candidate /\ tx_nonce original = tx_nonce candidate /\
  tx_to original = tx_to candidate /\ tx_input original = tx_input candidate /\ tx_value original = tx_value candidate.
Proof. unfold classify; destruct (same_call original candidate) eqn:H; try discriminate; intros _.
  repeat split; eauto using same_nonce_sender,same_nonce_number,same_call_nonce,same_call_target,same_call_input,same_call_value. Qed.
Theorem different_call_not_repriced original candidate : same_call original candidate = false -> classify original candidate = DifferentCall.
Proof. unfold classify; intros ->; reflexivity. Qed.
Theorem replacement_bound_to_known_hash sender hash original candidate : matches sender hash original candidate = true -> tx_hash original = hash.
Proof. unfold matches; repeat rewrite andb_true_iff; intros [[[[[_ _] H] _] _] _]; now apply String.eqb_eq. Qed.
Theorem replacement_bound_to_sender sender hash original candidate : matches sender hash original candidate = true -> tx_from candidate = sender.
Proof. unfold matches; repeat rewrite andb_true_iff; intros [[[[_ _] H] Hnonce] _].
  apply String.eqb_eq in H; apply same_nonce_sender in Hnonce; congruence. Qed.
Theorem replacement_bound_to_nonce sender hash original candidate :
  matches sender hash original candidate = true -> tx_nonce original = tx_nonce candidate.
Proof. unfold matches; repeat rewrite andb_true_iff; intros [[[[_ _] _] Hnonce] _].
  now apply same_nonce_number in Hnonce. Qed.
End TransactionReplacement.
