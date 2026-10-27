(* Successful production reserve transitions under the upstream generated-IR
   execution relation. Storage/ERC721 composition, external effects and EVM
   bytecode are outside these pure execution theorems. *)
Require Import DEXFormal.Contracts.LiquiditySupplySupport.

Lemma reduce_reserve_runs reserve removed state :
  0 <= reserve <= Types.uint256_max -> 0 <= removed < reserve ->
  Run.t supply_program supply_environment state (Result.Ok [reserve-removed])
    (supply_call "fun_reduceReserve" [reserve;removed]) state.
Proof.
  intros reserve_bounds removed_bounds.
  assert (lt_removed : (removed <? reserve)=true) by (apply Z.ltb_lt; lia).
  assert (gt_difference : (reserve-removed >? reserve)=false) by (rewrite Z.gtb_ltb; apply Z.ltb_ge; lia).
  assert (difference_mod : (reserve-removed) mod (2^256)=reserve-removed).
  { apply Z.mod_small. unfold Types.uint256_max in *. lia. }
  assert (word_guard : Stdlib.Pure.lt removed reserve=1).
  { unfold Stdlib.Pure.lt. rewrite lt_removed. reflexivity. }
  assert (word_difference : Stdlib.Pure.sub reserve removed=reserve-removed).
  { unfold Stdlib.Pure.sub. exact difference_mod. }
  assert (word_overflow : Stdlib.Pure.gt (reserve-removed) reserve=0).
  { unfold Stdlib.Pure.gt. rewrite gt_difference. reflexivity. }
  assert (word_nested_overflow : Stdlib.Pure.gt (Stdlib.Pure.sub reserve removed) reserve=0).
  { rewrite word_difference. exact word_overflow. }
  unfold supply_call.
  Timeout 90 supply_run_cached ltac:(rewrite ?word_guard, ?word_nested_overflow, ?word_overflow, ?word_difference).
Qed.
Print Assumptions reduce_reserve_runs.

Lemma increase_reserve_runs reserve added limit state :
  0 <= reserve <= limit -> 0 <= added <= limit - reserve ->
  limit <= Types.uint256_max ->
  Run.t supply_program supply_environment state (Result.Ok [reserve + added])
    (supply_call "fun_increaseReserve" [reserve; added; limit]) state.
Proof.
  intros reserve_bounds added_bounds limit_bound.
  unfold Types.uint256_max in limit_bound.
  assert (difference_mod : (limit - reserve) mod (2^256) = limit-reserve).
  { apply Z.mod_small. lia. }
  assert (sum_mod : (reserve + added) mod (2^256) = reserve+added).
  { apply Z.mod_small. lia. }
  change ((limit-reserve) mod 115792089237316195423570985008687907853269984665640564039457584007913129639936 = limit-reserve) in difference_mod.
  change ((reserve+added) mod 115792089237316195423570985008687907853269984665640564039457584007913129639936 = reserve+added) in sum_mod.
  assert (gt_reserve_limit : (reserve >? limit) = false) by (rewrite Z.gtb_ltb; apply Z.ltb_ge; lia).
  assert (gt_difference_limit : (limit-reserve >? limit) = false) by (rewrite Z.gtb_ltb; apply Z.ltb_ge; lia).
  assert (gt_added_difference : (added >? limit-reserve) = false) by (rewrite Z.gtb_ltb; apply Z.ltb_ge; lia).
  assert (gt_reserve_sum : (reserve >? reserve+added) = false) by (rewrite Z.gtb_ltb; apply Z.ltb_ge; lia).
  assert (word_difference : Stdlib.Pure.sub limit reserve = limit-reserve) by (unfold Stdlib.Pure.sub; exact difference_mod).
  assert (word_sum : Stdlib.Pure.add reserve added = reserve+added) by (unfold Stdlib.Pure.add; exact sum_mod).
  assert (word_guard : Stdlib.Pure.iszero (Stdlib.Pure.gt reserve limit)=1).
  { unfold Stdlib.Pure.iszero, Stdlib.Pure.gt. rewrite gt_reserve_limit. reflexivity. }
  assert (word_difference_overflow : Stdlib.Pure.gt (limit-reserve) limit=0).
  { unfold Stdlib.Pure.gt. rewrite gt_difference_limit. reflexivity. }
  assert (word_added_guard : Stdlib.Pure.iszero (Stdlib.Pure.gt added (limit-reserve))=1).
  { unfold Stdlib.Pure.iszero, Stdlib.Pure.gt. rewrite gt_added_difference. reflexivity. }
  assert (word_sum_overflow : Stdlib.Pure.gt reserve (reserve+added)=0).
  { unfold Stdlib.Pure.gt. rewrite gt_reserve_sum. reflexivity. }
  assert (word_iszero0 : Stdlib.Pure.iszero 0=1) by reflexivity.
  assert (word_iszero1 : Stdlib.Pure.iszero 1=0) by reflexivity.
  assert (word_nested_difference_overflow : Stdlib.Pure.gt (Stdlib.Pure.sub limit reserve) limit=0).
  { rewrite word_difference. exact word_difference_overflow. }
  assert (word_nested_added_guard : Stdlib.Pure.iszero (Stdlib.Pure.gt added (Stdlib.Pure.sub limit reserve))=1).
  { rewrite word_difference. exact word_added_guard. }
  assert (word_nested_sum_overflow : Stdlib.Pure.gt reserve (Stdlib.Pure.add reserve added)=0).
  { rewrite word_sum. exact word_sum_overflow. }
  unfold supply_call.
  Timeout 90 supply_run_cached ltac:(rewrite ?word_guard, ?word_nested_difference_overflow,
    ?word_nested_added_guard, ?word_nested_sum_overflow, ?word_difference_overflow,
    ?word_added_guard, ?word_sum_overflow, ?word_difference, ?word_sum, ?word_iszero0, ?word_iszero1).
Qed.
Print Assumptions increase_reserve_runs.
