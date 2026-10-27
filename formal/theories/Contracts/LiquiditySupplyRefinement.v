Require Import DEXFormal.Contracts.LiquiditySupplySupport.

Theorem mint_total_refines_supply total minted state :
  Types.uint256 total -> 0 < minted ->
  (total = 0 \/ Liquidity.locked_shares <= total) ->
  Liquidity.mint_total total minted <= Types.uint256_max ->
  Run.t supply_program supply_environment state
    (Result.Ok [Liquidity.mint_total total minted])
    (supply_call "fun_mintTotal" [total; minted; Liquidity.locked_shares]) state.
Proof.
  unfold Liquidity.mint_total, Liquidity.locked_shares.
  intros total_bounds positive domain sum_bounds.
  assert (mint_positive : (minted >? 0) = true) by (apply Z.gtb_lt; lia).
  unfold Types.uint256 in total_bounds.
  assert (word_positive : Stdlib.Pure.gt minted 0 = 1).
  { unfold Stdlib.Pure.gt. rewrite mint_positive. reflexivity. }
  destruct total as [|total_positive|total_negative].
  - cbn -[Z.add] in sum_bounds.
    assert (add_safe : (1000 >? 1000+minted) = false) by (rewrite Z.gtb_ltb; apply Z.ltb_ge; lia).
    assert (sum_mod : (1000+minted) mod (2^256) = 1000+minted).
    { apply Z.mod_small. unfold Types.uint256_max in *. lia. }
    change ((1000+minted) mod 115792089237316195423570985008687907853269984665640564039457584007913129639936 = 1000+minted) in sum_mod.
    assert (word_sum : Stdlib.Pure.add 1000 minted = 1000+minted).
    { unfold Stdlib.Pure.add. exact sum_mod. }
    assert (word_overflow : Stdlib.Pure.gt 1000 (1000+minted) = 0).
    { unfold Stdlib.Pure.gt. rewrite add_safe. reflexivity. }
    assert (word_nested : Stdlib.Pure.gt 1000 (Stdlib.Pure.add 1000 minted) = 0).
    { rewrite word_sum. exact word_overflow. }
    unfold supply_call.
    cbn -[Z.ltb Z.gtb Z.leb Z.land Z.sub Z.modulo supply_program supply_environment supply_code].
    Timeout 90 supply_run_cached ltac:(rewrite ?word_positive, ?word_nested, ?word_overflow, ?word_sum).
  - cbn -[Z.add] in sum_bounds.
    set (total := Z.pos total_positive) in *.
    assert (add_safe : (total >? total+minted) = false) by (rewrite Z.gtb_ltb; apply Z.ltb_ge; lia).
    assert (total_lt_locked : (total <? 1000) = false) by (apply Z.ltb_ge; lia).
    assert (sum_mod : (total+minted) mod (2^256) = total+minted).
    { apply Z.mod_small. unfold Types.uint256_max in *. lia. }
    change ((total+minted) mod 115792089237316195423570985008687907853269984665640564039457584007913129639936 = total+minted) in sum_mod.
    assert (word_sum : Stdlib.Pure.add total minted = total+minted).
    { unfold Stdlib.Pure.add. exact sum_mod. }
    assert (word_overflow : Stdlib.Pure.gt total (total+minted) = 0).
    { unfold Stdlib.Pure.gt. rewrite add_safe. reflexivity. }
    assert (word_nested : Stdlib.Pure.gt total (Stdlib.Pure.add total minted) = 0).
    { rewrite word_sum. exact word_overflow. }
    assert (word_enough : Stdlib.Pure.iszero (Stdlib.Pure.lt total 1000) = 1).
    { unfold Stdlib.Pure.iszero, Stdlib.Pure.lt. rewrite total_lt_locked. reflexivity. }
    (* Match the interpreter's exposed positive constructor rather than a local alias. *)
    subst total.
    unfold supply_call.
    cbn -[Z.ltb Z.gtb Z.leb Z.land Z.sub Z.modulo supply_program supply_environment supply_code].
    Timeout 90 supply_run_cached ltac:(rewrite ?word_positive, ?word_enough, ?word_nested, ?word_overflow, ?word_sum).
  - lia.
Qed.
Print Assumptions mint_total_refines_supply.
