From Coq Require Import ZArith String List Bool Lia.
From DEXFormal.Spec Require Import Types.
From DEXFormal.Frontend Require Import Wallet.
Import ListNotations.
Open Scope string_scope.
Open Scope Z_scope.
Module Allowances.
Record pair := Pair { token : string; spender : string }.
Definition pair_eq_dec (a b : pair) : {a=b}+{a<>b}.
Proof. decide equality; apply string_dec. Defined.
Record observation := Observation { observed_pair : pair; value : option Z; read_error : option string }.
Record plan := Plan { identity : Wallet.identity; target : pair; previous : Z }.
Inductive action := Idle | Verifying (hash : string) | Verified (hash : string)
 | Unverified (hash message : string) | Error (message : string).
Record verification := Verification { verification_plan : plan; verification_hash : string; minimum_block : Z }.
Record state := State { serial : Z; owner : option Wallet.identity; loading : bool;
 block : option Z; rows : list observation; review : option plan; result : action;
 verification_target : option verification }.
Definition initial := State 0 None false None [] None Idle None.
Definition same_owner (a b : option Wallet.identity) :=
 match a,b with Some x,Some y => if Wallet.identity_eq_dec x y then true else false
 | None,None => true | _,_ => false end.
Definition normalize current s := if same_owner current (owner s) then s
 else State (serial s) current false None [] None Idle None.
Fixpoint lookup p rs := match rs with [] => None | r::rest =>
 if pair_eq_dec p (observed_pair r) then Some r else lookup p rest end.
Definition pairs_for tokens spenders := flat_map (fun token => map (fun spender => Pair token spender) spenders) tokens.
Definition supported p pairs := if in_dec pair_eq_dec p pairs then true else false.
Definition can_revoke current pending pairs s p :=
 let s := normalize current s in
 supported p pairs && negb pending && negb (loading s) &&
 match current, lookup p (rows s) with Some _,Some r =>
 match value r with Some amount => 0 <? amount | None => false end
 | _,_ => false end.
Definition begin_read current s :=
 let s := normalize current s in
 match current with None => s | Some id =>
 State (serial s + 1) (Some id) true (block s) (rows s) None (result s) (verification_target s) end.
Definition matches_request current request s :=
 same_owner current (owner s) && loading s && Z.eqb request (serial s).
Definition verification_result v height rs :=
 if minimum_block v <=? height then
 match lookup (target (verification_plan v)) rs with
 | Some r => match value r with
   | Some amount => if Z.eqb amount 0 then Verified (verification_hash v)
       else Unverified (verification_hash v) "The authorization is still nonzero. Refresh to check again."
   | None => Unverified (verification_hash v) "Transaction confirmed; the remaining authorization could not be read."
   end
 | None => Unverified (verification_hash v) "Transaction confirmed; the remaining authorization was not observed."
 end
 else Unverified (verification_hash v) "The observation predates the confirmed transaction. Refresh to check again.".
Definition loaded current request height rs s :=
 if matches_request current request s then
 State (serial s) (owner s) false (Some height) rs None
 (match verification_target s with Some v => verification_result v height rs | None => result s end)
 (verification_target s)
 else normalize current s.
Definition failed current request message s :=
 if matches_request current request s then
 State (serial s) (owner s) false None [] None
 (match verification_target s with Some v => Unverified (verification_hash v) message | None => Error message end)
 (verification_target s)
 else normalize current s.
Definition select current pending pairs s p :=
 let s := normalize current s in
 if can_revoke current pending pairs s p then
 match current, lookup p (rows s) with
 | Some id,Some r => match value r with Some amount =>
 State (serial s) (owner s) (loading s) (block s) (rows s) (Some (Plan id p amount)) Idle None
 | None => s end
 | _,_ => s end
 else s.
Definition cancel s := State (serial s) (owner s) (loading s) (block s) (rows s) None (result s) (verification_target s).
Definition validate current pairs p :=
 match current with Some id =>
 (if Wallet.identity_eq_dec id (identity p) then true else false) &&
 supported (target p) pairs && (0 <? previous p)
 | None => false end.
Definition take current pending pairs s :=
 let s := normalize current s in
 match review s with Some p =>
 if validate current pairs p && negb pending && negb (loading s)
 then (cancel s,Some p) else (cancel s,None)
 | None => (s,None) end.
Definition can_refresh current s := match current with None => false | Some _ => negb (loading (normalize current s)) end.
Definition can_confirm current pending pairs s := match snd (take current pending pairs s) with None => false | Some _ => true end.
Definition simulation_allowed (accepted : bool) := accepted.
Definition submitted current p hash height s :=
 let s := normalize current s in
 if same_owner current (Some (identity p)) then
 State (serial s) (owner s) (loading s) (block s) (rows s) None (Verifying hash)
 (Some (Verification p hash height))
 else s.
Definition rejected current expected message s :=
 let s := normalize current s in
 if same_owner current (Some expected) then State (serial s) (owner s) (loading s) (block s) (rows s) None (Error message) None else s.
Definition unlimited amount := Z.eqb amount uint256_max.
Definition amount_parameter (_ : plan) := 0.

Theorem same_owner_exact a b : same_owner a b = true <-> a = b.
Proof. destruct a as [x|], b as [y|]; cbn; try (split; congruence).
 destruct (Wallet.identity_eq_dec x y); split; congruence. Qed.
Theorem can_revoke_requires_positive current pending pairs s p :
 can_revoke current pending pairs s p = true ->
 exists id r amount, current = Some id /\ lookup p (rows (normalize current s)) = Some r /\ value r = Some amount /\ 0 < amount.
Proof. unfold can_revoke. destruct (supported p pairs); try discriminate.
 destruct pending; try discriminate. destruct (loading (normalize current s)); try discriminate. cbn.
 destruct current as [id|]; try discriminate. destruct (lookup p (rows (normalize (Some id) s))) as [r|] eqn:L; try discriminate.
 destruct (value r) as [amount|] eqn:V; try discriminate. intro H; apply Z.ltb_lt in H.
 exists id,r,amount; auto. Qed.
Theorem refresh_removes_review current s id : current = Some id -> review (begin_read current s) = None.
Proof. intro H; subst; reflexivity. Qed.
Theorem unlimited_exact amount : unlimited amount = true <-> amount = uint256_max.
Proof. apply Z.eqb_eq. Qed.

Theorem normalize_drops_foreign_observations current s :
 same_owner current (owner s) = false -> rows (normalize current s) = [].
Proof. intro H; unfold normalize; now rewrite H. Qed.
Theorem stale_request_ignored current request height rs s :
 matches_request current request s = false -> loaded current request height rs s = normalize current s.
Proof. intro H; unfold loaded; now rewrite H. Qed.
Theorem loaded_requires_current_owner current request s :
 matches_request current request s = true -> same_owner current (owner s) = true.
Proof. unfold matches_request; repeat rewrite andb_true_iff; tauto. Qed.
Theorem disconnected_cannot_revoke pending pairs s p :
 can_revoke None pending pairs s p = false.
Proof. unfold can_revoke; destruct (supported p pairs), pending, (loading (normalize None s)); reflexivity. Qed.
Theorem can_revoke_requires_registered_pair current pending pairs s p :
 can_revoke current pending pairs s p = true -> In p pairs.
Proof. unfold can_revoke, supported. destruct (in_dec pair_eq_dec p pairs); auto. discriminate. Qed.
Theorem zero_parameter p : amount_parameter p = 0.
Proof. reflexivity. Qed.
Theorem false_simulation_is_rejected : simulation_allowed false = false.
Proof. reflexivity. Qed.
Theorem validation_preserves_sender current pairs p :
 validate current pairs p = true -> current = Some (identity p).
Proof. destruct current as [id|]; cbn; try discriminate.
 destruct (Wallet.identity_eq_dec id (identity p)); subst; auto. discriminate. Qed.
Theorem validation_requires_registered_spender current pairs p :
 validate current pairs p = true -> In (target p) pairs.
Proof. destruct current as [id|]; cbn; try discriminate.
 destruct (Wallet.identity_eq_dec id (identity p)); cbn; try discriminate.
 unfold supported; destruct (in_dec pair_eq_dec (target p) pairs); auto; discriminate. Qed.
Theorem verification_needs_zero v height rs hash :
 verification_result v height rs = Verified hash ->
 minimum_block v <= height /\ exists r, lookup (target (verification_plan v)) rs = Some r /\ value r = Some 0.
Proof. unfold verification_result. destruct (minimum_block v <=? height) eqn:H; try discriminate.
 apply Z.leb_le in H. destruct (lookup (target (verification_plan v)) rs) as [r|] eqn:L; try discriminate.
 destruct (value r) as [amount|] eqn:V; try discriminate. destruct (Z.eqb amount 0) eqn:E; try discriminate.
 apply Z.eqb_eq in E; subst. intro Accepted. split; [exact H|]. exists r; auto.
Qed.
Theorem failed_read_has_no_observed_zero current request message s :
 matches_request current request s = true -> rows (failed current request message s) = [].
Proof. intro H; unfold failed; now rewrite H. Qed.
Theorem cancel_preserves_observations s : rows (cancel s) = rows s /\ block (cancel s) = block s.
Proof. split; reflexivity. Qed.
Theorem cancel_removes_confirmation s : review (cancel s) = None.
Proof. reflexivity. Qed.
Theorem unavailable_identity_cannot_validate pairs p : validate None pairs p = false.
Proof. reflexivity. Qed.
Theorem nonzero_observation_not_verified v height rs r amount :
 lookup (target (verification_plan v)) rs = Some r -> value r = Some amount -> amount <> 0 ->
 forall hash, verification_result v height rs <> Verified hash.
Proof. intros L V N hash E. apply verification_needs_zero in E. destruct E as [_ [r' [L' V']]].
 rewrite L in L'; inversion L'; subst. rewrite V in V'; inversion V'; contradiction.
Qed.
End Allowances.
