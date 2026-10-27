Require Import DEXFormal.Contracts.LiquiditySupplySupport.

Theorem burn_total_refines_supply total burned state :
  Liquidity.locked_shares <= total <= Types.uint256_max ->
  0 < burned <= total - Liquidity.locked_shares ->
  Run.t supply_program supply_environment state
    (Result.Ok [Liquidity.burn_total total burned])
    (supply_call "fun_burnTotal" [total; burned; Liquidity.locked_shares]) state.
Proof.
  unfold Liquidity.burn_total, Liquidity.locked_shares.
  intros total_bounds burned_bounds.
  assert (total_lt_locked : (total <? 1000) = false) by (apply Z.ltb_ge; lia).
  assert (burn_positive : (burned >? 0) = true) by (apply Z.gtb_lt; lia).
  assert (locked_overflow : (total-1000 >? total) = false) by (rewrite Z.gtb_ltb; apply Z.ltb_ge; lia).
  assert (burn_within_unlocked : (burned >? total-1000) = false) by (rewrite Z.gtb_ltb; apply Z.ltb_ge; lia).
  assert (burn_overflow : (total-burned >? total) = false) by (rewrite Z.gtb_ltb; apply Z.ltb_ge; lia).
  assert (locked_mod : (total-1000) mod (2^256) = total-1000).
  { apply Z.mod_small. unfold Types.uint256_max in *. lia. }
  assert (burn_mod : (total-burned) mod (2^256) = total-burned).
  { apply Z.mod_small. unfold Types.uint256_max in *. lia. }
  change ((total-1000) mod 115792089237316195423570985008687907853269984665640564039457584007913129639936 = total-1000) in locked_mod.
  change ((total-burned) mod 115792089237316195423570985008687907853269984665640564039457584007913129639936 = total-burned) in burn_mod.
  assert (word_enough : Stdlib.Pure.iszero (Stdlib.Pure.lt total 1000) = 1).
  { unfold Stdlib.Pure.iszero, Stdlib.Pure.lt. rewrite total_lt_locked. reflexivity. }
  assert (word_positive : Stdlib.Pure.gt burned 0 = 1).
  { unfold Stdlib.Pure.gt. rewrite burn_positive. reflexivity. }
  assert (word_sub_locked : Stdlib.Pure.sub total 1000 = total-1000).
  { unfold Stdlib.Pure.sub. exact locked_mod. }
  assert (word_sub_burn : Stdlib.Pure.sub total burned = total-burned).
  { unfold Stdlib.Pure.sub. exact burn_mod. }
  assert (word_locked_overflow : Stdlib.Pure.gt (total-1000) total = 0).
  { unfold Stdlib.Pure.gt. rewrite locked_overflow. reflexivity. }
  assert (word_locked_nested : Stdlib.Pure.gt (Stdlib.Pure.sub total 1000) total = 0).
  { rewrite word_sub_locked. exact word_locked_overflow. }
  assert (word_within : Stdlib.Pure.iszero (Stdlib.Pure.gt burned (total-1000)) = 1).
  { unfold Stdlib.Pure.iszero, Stdlib.Pure.gt. rewrite burn_within_unlocked. reflexivity. }
  assert (word_within_nested : Stdlib.Pure.iszero (Stdlib.Pure.gt burned (Stdlib.Pure.sub total 1000)) = 1).
  { rewrite word_sub_locked. exact word_within. }
  assert (word_burn_overflow : Stdlib.Pure.gt (total-burned) total = 0).
  { unfold Stdlib.Pure.gt. rewrite burn_overflow. reflexivity. }
  assert (word_burn_nested : Stdlib.Pure.gt (Stdlib.Pure.sub total burned) total = 0).
  { rewrite word_sub_burn. exact word_burn_overflow. }
  unfold supply_call.
  cbn -[Z.ltb Z.gtb Z.leb Z.land Z.sub Z.modulo supply_program supply_environment supply_code].
  Timeout 90 supply_run_cached ltac:(rewrite ?word_enough, ?word_positive,
    ?word_locked_nested, ?word_locked_overflow, ?word_within_nested, ?word_within,
    ?word_burn_nested, ?word_burn_overflow, ?word_sub_locked, ?word_sub_burn).
Qed.
Print Assumptions burn_total_refines_supply.
