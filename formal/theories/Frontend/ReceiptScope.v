From Coq Require Import List String Bool.
Import ListNotations.

Definition operation_receipt_available known operations (descriptor_known : bool) target operation :=
  (* DEFENSE: transaction metadata can fail to load after its receipt confirmed. *)
  if descriptor_known then
    existsb (String.eqb target) known && existsb (String.eqb operation) operations
  else true.

Theorem known_receipt_target_is_configured known operations target operation :
  operation_receipt_available known operations true target operation = true -> In target known.
Proof.
  unfold operation_receipt_available. intros H. apply andb_true_iff in H as [H _].
  apply existsb_exists in H as [source [Hin Heq]].
  apply String.eqb_eq in Heq. now rewrite Heq.
Qed.

Theorem missing_descriptor_keeps_receipt_available known operations target operation :
  operation_receipt_available known operations false target operation = true.
Proof. reflexivity. Qed.
