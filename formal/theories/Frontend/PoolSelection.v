From Coq Require Import String List Bool.
Import ListNotations.

Inductive pool_selection :=
  | SelectedPool (key : string)
  | MissingPool (requested : string)
  | NoPools.

(* A URL target is an explicit choice; only an absent target permits a default. *)
Definition select_pool (requested : option string) (available : list string) :=
  match requested with
  | Some key =>
      if existsb (String.eqb key) available then SelectedPool key
      else MissingPool key
  | None =>
      match available with first :: _ => SelectedPool first | [] => NoPools end
  end.

Lemma pool_key_membership key available :
  existsb (String.eqb key) available = true <-> In key available.
Proof.
  rewrite existsb_exists. split.
  - intros [found [Hin Heq]]. apply String.eqb_eq in Heq. subst. exact Hin.
  - intros Hin. exists key. split; [exact Hin | apply String.eqb_refl].
Qed.

Theorem explicit_pool_is_not_substituted requested available selected :
  select_pool (Some requested) available = SelectedPool selected ->
  selected = requested /\ In selected available.
Proof.
  unfold select_pool. destruct (existsb (String.eqb requested) available) eqn:H;
    [|discriminate].
  intros Heq. inversion Heq; subst. split; [reflexivity|].
  apply pool_key_membership. exact H.
Qed.

Theorem missing_pool_has_no_match requested available :
  select_pool (Some requested) available = MissingPool requested <->
  ~ In requested available.
Proof.
  unfold select_pool. destruct (existsb (String.eqb requested) available) eqn:H.
  - split; [discriminate|]. intros Hmissing.
    exfalso. apply Hmissing, pool_key_membership. exact H.
  - split; [|intros; reflexivity]. intros _ Hin.
    apply pool_key_membership in Hin. rewrite Hin in H. discriminate.
Qed.

Theorem default_pool_is_first first rest :
  select_pool None (first :: rest) = SelectedPool first.
Proof. reflexivity. Qed.

Theorem selected_pool_is_available requested available selected :
  select_pool requested available = SelectedPool selected -> In selected available.
Proof.
  destruct requested as [requested|].
  - intros H. exact (proj2 (explicit_pool_is_not_substituted _ _ _ H)).
  - destruct available as [|first rest]; [discriminate|].
    simpl. intros H. inversion H; subst. left. reflexivity.
Qed.
