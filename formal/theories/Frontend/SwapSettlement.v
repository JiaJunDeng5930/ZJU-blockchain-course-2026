From Coq Require Import ZArith String Lia.
From DEXFormal.Spec Require Import Units.
Local Open Scope Z_scope.

Inductive comparison := Same | More | Less.

Record settlement_view := SettlementView {
  execution_price : option string;
  quote_difference : Z;
  quote_comparison : comparison
}.

(* Amounts come from the confirmed event, while quoted is the reviewed quote.
   Gas is deliberately absent: a quote difference has output-token units. *)
Definition actual_price input output input_places output_places :=
  price_text output output_places input input_places.

Definition summarize input output quoted input_places output_places :=
  SettlementView (actual_price input output input_places output_places)
    (output - quoted)
    (match Z.compare output quoted with
     | Eq => Same | Gt => More | Lt => Less
     end).

Theorem quote_difference_reconstructs_received input output quoted p0 p1 :
  output = quoted + quote_difference (summarize input output quoted p0 p1).
Proof. cbn. lia. Qed.

Theorem quote_comparison_matches_received input output quoted p0 p1 :
  match quote_comparison (summarize input output quoted p0 p1) with
  | Same => output = quoted
  | More => quoted < output
  | Less => output < quoted
  end.
Proof.
  unfold summarize. cbn.
  destruct (Z.compare_spec output quoted); cbn; lia.
Qed.
