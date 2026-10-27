From Coq Require Import ZArith List String Lia Bool.
From DEXFormal.Spec Require Import Types Units Arbitrage.
Import ListNotations.
Local Open Scope Z_scope.

(* Manual quotes compare the same caller-chosen capital on every route.
   Automated market simulation retains Arbitrage.scan's sampled capital sizes. *)
Definition pair_at quote buy sell token input :=
  match Arbitrage.candidate quote buy sell token input with
  | Some route => [route] | None => [] end.

Definition candidates_at quote selected markets token input :=
  flat_map (fun other =>
    pair_at quote selected other token input ++
    pair_at quote other selected token input) markets.

Definition scan_at quote selected markets token input :=
  match Arbitrage.find_pool selected markets with
  | Some current => Arbitrage.best (candidates_at quote current markets token input)
  | None => None end.

(* The outer option distinguishes malformed capital from a valid quote with no
   profitable route. Both the form and public quote entry use positive_units. *)
Definition quote_amount places quote selected markets token text supports :=
  match Units.positive_units places text with
  | None => None
  | Some input => Some (scan_at quote selected
      (Arbitrage.supported_markets supports markets) token input)
  end.

Lemma pair_at_member quote buy sell token input route :
  In route (pair_at quote buy sell token input) ->
  Arbitrage.candidate quote buy sell token input = Some route.
Proof.
  unfold pair_at. destruct (Arbitrage.candidate quote buy sell token input) as [found|] eqn:H;
    cbn; [|contradiction]. intros [same|empty]; [subst; reflexivity|contradiction].
Qed.

Lemma candidate_input quote buy sell token input route :
  Arbitrage.candidate quote buy sell token input = Some route ->
  Arbitrage.capital route = input /\ Arbitrage.capital_token route = token.
Proof.
  unfold Arbitrage.candidate. destruct (_ && _); [|discriminate].
  destruct (Arbitrage.quote_pool _ _ _ _); [|discriminate].
  destruct (Arbitrage.quote_pool _ _ _ _); [|discriminate].
  destruct (_ && _); [|discriminate].
  destruct (Arbitrage.settlement _ _ _); [|discriminate].
  intros same. inversion same. auto.
Qed.

Lemma candidates_at_member quote selected markets token input route :
  In route (candidates_at quote selected markets token input) ->
  exists other, In other markets /\
    (Arbitrage.candidate quote selected other token input = Some route \/
     Arbitrage.candidate quote other selected token input = Some route).
Proof.
  unfold candidates_at. rewrite in_flat_map. intros [other [member route_member]].
  exists other. split; [exact member|]. apply in_app_iff in route_member.
  destruct route_member as [forward|reverse];
    [left|right]; apply pair_at_member; assumption.
Qed.

Theorem scan_at_exact_capital quote selected markets token input route :
  scan_at quote selected markets token input = Some route ->
  Arbitrage.capital route = input /\ Arbitrage.capital_token route = token.
Proof.
  unfold scan_at. destruct (Arbitrage.find_pool selected markets); [|discriminate].
  intro found. apply Arbitrage.best_member in found.
  apply candidates_at_member in found as [other [_ [forward|reverse]]];
    eapply candidate_input; eassumption.
Qed.

Theorem scan_at_profitable quote selected markets token input route :
  scan_at quote selected markets token input = Some route -> Arbitrage.profitable route.
Proof.
  unfold scan_at. destruct (Arbitrage.find_pool selected markets); [|discriminate].
  intro found. apply Arbitrage.best_member in found.
  apply candidates_at_member in found as [other [_ [forward|reverse]]];
    apply Arbitrage.candidate_profitable in forward || apply Arbitrage.candidate_profitable in reverse;
    unfold Arbitrage.profitable; tauto.
Qed.

Theorem scan_at_members quote selected markets token input route :
  scan_at quote selected markets token input = Some route ->
  In (Arbitrage.buy route) markets /\ In (Arbitrage.sell route) markets.
Proof.
  unfold scan_at. destruct (Arbitrage.find_pool selected markets) as [current|] eqn:current_found;
    [|discriminate]. intro found. apply Arbitrage.best_member in found.
  unfold Arbitrage.find_pool in current_found. apply find_some in current_found.
  apply candidates_at_member in found as [other [other_member [forward|reverse]]];
    apply Arbitrage.candidate_origins in forward || apply Arbitrage.candidate_origins in reverse.
  - destruct forward as [buy sell]. rewrite buy,sell. tauto.
  - destruct reverse as [buy sell]. rewrite buy,sell. tauto.
Qed.

Theorem scan_at_maximum quote selected markets token input route :
  scan_at quote selected markets token input = Some route ->
  exists current, Arbitrage.find_pool selected markets = Some current /\
    forall other, In other (candidates_at quote current markets token input) ->
      Arbitrage.profit other <= Arbitrage.profit route.
Proof.
  unfold scan_at. destruct (Arbitrage.find_pool selected markets) as [current|] eqn:found;
    [|discriminate]. intro chosen. exists current. split; [reflexivity|].
  apply Arbitrage.best_maximum. exact chosen.
Qed.

Theorem quote_amount_exact places quote selected markets token text supports route :
  quote_amount places quote selected markets token text supports = Some (Some route) ->
  exists input, Units.positive_units places text = Some input /\
    Arbitrage.capital route = input /\ Arbitrage.capital_token route = token /\
    0 < input /\ Types.uint256 input.
Proof.
  unfold quote_amount. destruct (Units.positive_units places text) as [input|] eqn:parsed;
    [|discriminate]. intro found. inversion found as [same].
  apply scan_at_exact_capital in same as [capital token_same].
  pose proof (Units.positive_units_sound _ _ _ parsed) as [positive [bounded _]].
  exists input. auto.
Qed.

Theorem quote_amount_supported places quote selected markets token text supports route :
  quote_amount places quote selected markets token text supports = Some (Some route) ->
  supports (Arbitrage.buy route) = true /\ supports (Arbitrage.sell route) = true.
Proof.
  unfold quote_amount. destruct (Units.positive_units places text); [|discriminate].
  intro found. inversion found as [same]. apply scan_at_members in same as [buy sell].
  split; eapply Arbitrage.supported_markets_sound; eassumption.
Qed.

Theorem quote_amount_invalid places quote selected markets token text supports :
  Units.positive_units places text = None ->
  quote_amount places quote selected markets token text supports = None.
Proof. unfold quote_amount. intros invalid. rewrite invalid. reflexivity. Qed.
