From Coq Require Import ZArith String Ascii List Bool Lia.
From DEXFormal.Spec Require Import Types Assets.
Import ListNotations.
Open Scope Z_scope.
Open Scope string_scope.
Open Scope Z_scope.

Module ReplacementSearch.
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

(* A nonce slot can already have been mined before a recovered page starts
   watching blocks. Search its consumption block using bounded RPC reads. *)
Inductive state :=
| Head (original : descriptor) (height : Z)
| Genesis (original : descriptor) (height : Z)
| Middle (original : descriptor) (low high : Z) (fuel : nat)
| Candidate (original : descriptor) (height : Z)
| Pending (original : descriptor) (height : Z)
| Unrecorded
| Found (original candidate : descriptor)
| Unavailable (message : string).
Inductive effect :=
| ReadNonce (owner : address) (height : Z)
| ReadBlock (height : Z)
| Waiting (height : Z)
| OriginalReceipt (candidate : descriptor)
| ReplacementReceipt (original candidate : descriptor)
| WaitOriginal
| Failed (message : string).
Definition midpoint low high := (low + high) / 2.
Definition interval original low high fuel :=
  if high <=? low + 1 then Candidate original high else
  match fuel with O => Unavailable "The bounded nonce lookup did not converge. Recheck the transaction."
  | S remaining => Middle original low high remaining end.
Definition initial original height :=
  if valid_descriptor original && (0 <=? height) && (height <=? uint256_max)
  then Head original height else Unavailable "Public transaction metadata is unavailable or invalid.".
Definition begin_observation (original:option descriptor) (live:bool) height := match original with
  | Some value => initial value height
  | None => if live then Unrecorded else Unavailable "The saved transaction has no nonce metadata and is unavailable. Its replacement cannot be identified safely; recheck or inspect the wallet." end.
Definition failed (_ : state) message := Unavailable message.
Definition request s := match s with
  | Head original height => ReadNonce (tx_from original) height
  | Genesis original _ => ReadNonce (tx_from original) 0
  | Middle original low high _ => ReadNonce (tx_from original) (midpoint low high)
  | Candidate _ height => ReadBlock height
  | Pending _ height => Waiting height
  | Unrecorded => WaitOriginal
  | Found original candidate => if String.eqb (tx_hash original) (tx_hash candidate)
      then OriginalReceipt candidate else ReplacementReceipt original candidate
  | Unavailable message => Failed message end.
Definition updated_bounds original low high count :=
  if tx_nonce original <? count then (low,midpoint low high) else (midpoint low high,high).
Definition nonce_observed s height count :=
  if count <? 0 then Unavailable "The RPC returned an invalid account nonce." else match s with
  | Head original head => if Z.eqb height head then
      if tx_nonce original <? count then
        if Z.eqb head 0 then Unavailable "This nonce has no transaction block after genesis."
        else Genesis original head
      else Pending original head else s
  | Genesis original head => if Z.eqb height 0 then
      if tx_nonce original <? count then Unavailable "Saved transaction metadata does not match this chain's initial nonce."
      else interval original 0 head 256 else s
  | Middle original low high fuel => if Z.eqb height (midpoint low high) then
      let '(next_low,next_high) := updated_bounds original low high count in
      interval original next_low next_high fuel else s
  | _ => s end.
Definition head_observed s height := match s with
  | Pending original previous => if previous <? height then initial original height else s
  | _ => s end.
Definition wait_timeout_ms : Z := 180000.
Definition expired (_ : state) := Unavailable "Receipt observation timed out. Recheck this transaction; it was not sent again.".
Definition block_observed s height candidates := match s with
  | Candidate original expected => if Z.eqb height expected then
      match find (fun candidate => same_nonce original candidate && valid_descriptor candidate &&
        Z.eqb (observed_block candidate) height) candidates with
      | Some candidate => Found original candidate
      | None => Unavailable "The nonce advanced, but no matching sender/nonce transaction was found in its block."
      end else s
  | _ => s end.

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
Theorem midpoint_inside low high : low + 1 < high -> low < midpoint low high < high.
Proof. unfold midpoint; intro H. pose proof (Z.mod_pos_bound (low+high) 2 ltac:(lia)).
  pose proof (Z.div_mod (low+high) 2 ltac:(lia)); lia. Qed.
Definition bracket (oracle : Z -> Z) original low high :=
  0 <= low /\ low < high /\ oracle low <= tx_nonce original /\ tx_nonce original < oracle high.
Theorem updated_bracket_correct oracle original low high : bracket oracle original low high -> low+1<high ->
  let '(next_low,next_high) := updated_bounds original low high (oracle (midpoint low high)) in
  bracket oracle original next_low next_high.
Proof. intros [Hlow [Hrange [Hleft Hright]]] Hgap; unfold updated_bounds.
  pose proof (midpoint_inside low high Hgap) as Hmid.
  destruct (tx_nonce original <? oracle (midpoint low high)) eqn:H;
  [apply Z.ltb_lt in H|apply Z.ltb_ge in H]; unfold bracket; repeat split; lia. Qed.
Theorem adjacent_bracket_is_consumption_block oracle original low high :
  (forall a b, 0 <= a -> a <= b -> oracle a <= oracle b) ->
  bracket oracle original low high -> high <= low+1 ->
  tx_nonce original < oracle high /\ forall block, 0 <= block < high -> oracle block <= tx_nonce original.
Proof. intros Hmono [Hlow [Hrange [Hleft Hright]]] Hgap; split; auto.
  intros block Hblock; specialize (Hmono block low ltac:(lia) ltac:(lia)); lia. Qed.
Theorem interval_request_inside original low high fuel a b remaining :
  interval original low high fuel = Middle original a b remaining -> a=low /\ b=high /\ (remaining < fuel)%nat.
Proof. unfold interval; destruct (high <=? low+1); try discriminate; destruct fuel; try discriminate.
  intro H; inversion H; subst; repeat split; lia. Qed.
Theorem wrong_nonce_response_is_ignored original low high fuel height count :
  0 <= count -> height <> midpoint low high ->
  nonce_observed (Middle original low high fuel) height count = Middle original low high fuel.
Proof. intros Hcount Hheight; unfold nonce_observed; assert ((count <? 0) = false) as -> by (apply Z.ltb_ge; lia).
  assert (Z.eqb height (midpoint low high) = false) as -> by (apply Z.eqb_neq; exact Hheight); reflexivity. Qed.
Theorem candidate_is_observed_member original block candidates candidate :
  block_observed (Candidate original block) block candidates = Found original candidate -> In candidate candidates /\ same_nonce original candidate = true.
Proof. unfold block_observed; rewrite Z.eqb_refl.
  destruct (find _ candidates) eqn:Hfind; try discriminate; intro H; inversion H; subst.
  apply find_some in Hfind as [Hin Hpredicate]; split; auto. repeat rewrite andb_true_iff in Hpredicate; tauto. Qed.
Theorem located_sender_matches original block candidates candidate :
  block_observed (Candidate original block) block candidates = Found original candidate -> tx_from candidate = tx_from original.
Proof. intro H; apply candidate_is_observed_member in H as [_ H]; apply same_nonce_sender in H; symmetry; exact H. Qed.
Theorem located_nonce_matches original block candidates candidate :
  block_observed (Candidate original block) block candidates = Found original candidate -> tx_nonce candidate = tx_nonce original.
Proof. intro H; apply candidate_is_observed_member in H as [_ H]; apply same_nonce_number in H; symmetry; exact H. Qed.
End ReplacementSearch.
