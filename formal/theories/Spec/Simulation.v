From Coq Require Import ZArith String Ascii List Bool Lia.
Import ListNotations.
Open Scope string_scope.
Open Scope Z_scope.

Record simulation_options := { rounds : Z; seed : Z; duration : Z; interval : Z }.
Definition bounded (lo hi n : Z) := (lo <=? n) && (n <=? hi).
Definition options_valid o := bounded 20 1000 (rounds o) &&
  bounded 0 4294967295 (seed o) && bounded 0 600 (duration o) &&
  bounded 0 5000 (interval o).
Fixpoint decimal_acc (s : string) (acc : Z) : option Z :=
  match s with
  | EmptyString => Some acc
  | String c rest => let n := Z.of_nat (nat_of_ascii c) in
      if (48 <=? n) && (n <=? 57) then decimal_acc rest (10 * acc + n - 48) else None
  end.
Definition decimal s := match s with EmptyString => None | _ => decimal_acc s 0 end.
Record simulation_draft := { rounds_text : string; seed_text : string;
  duration_text : string; interval_text : string }.
Definition parse_options d :=
  match decimal (rounds_text d), decimal (seed_text d), decimal (duration_text d), decimal (interval_text d) with
  | Some r, Some s, Some d, Some i =>
      let o := {| rounds := r; seed := s; duration := d; interval := i |} in
      if options_valid o then Some o else None
  | _, _, _, _ => None
  end.
Lemma bounded_spec lo hi n : bounded lo hi n = true <-> lo <= n <= hi.
Proof. unfold bounded; rewrite andb_true_iff, !Z.leb_le; tauto. Qed.
Theorem parsed_options_bounded d o : parse_options d = Some o ->
  20 <= rounds o <= 1000 /\ 0 <= seed o <= 4294967295 /\
  0 <= duration o <= 600 /\ 0 <= interval o <= 5000.
Proof.
  unfold parse_options; destruct (decimal (rounds_text d)); try discriminate;
  destruct (decimal (seed_text d)); try discriminate;
  destruct (decimal (duration_text d)); try discriminate;
  destruct (decimal (interval_text d)); try discriminate.
  destruct (options_valid _) eqn:H; inversion 1; subst.
  unfold options_valid in H; repeat rewrite andb_true_iff in H.
  repeat rewrite bounded_spec in H; exact (conj (proj1 (proj1 (proj1 H)))
    (conj (proj2 (proj1 (proj1 H))) (conj (proj2 (proj1 H)) (proj2 H)))).
Qed.
