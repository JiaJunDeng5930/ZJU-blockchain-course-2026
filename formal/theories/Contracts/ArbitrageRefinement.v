(* This is the production checkedProfit helper converted by rocq-of-solidity,
   evaluated with its official Run.t relation. The theorem covers successful
   pure settlement, not external DEX calls, EVM transaction rollback or solc's
   optimized deployed bytecode. *)
Require Import RocqOfSolidity.RocqOfSolidity.
Require Import RocqOfSolidity.simulations.RocqOfSolidity.
Require Import DEXFormal.Spec.Arbitrage.
Require Import DEXFormal.Contracts.ArbitrageGenerated.

Definition deployed_code := ArbitrageGenerated.ArbitrageProperties.deployed.code.
Definition program := [deployed_code].
Definition environment : Environment.t := {|
  Environment.caller := 1; Environment.callvalue := 0;
  Environment.calldata := []; Environment.address := 1;
  Environment.code_name := deployed_code.(Code.hex_name)
|}.
Definition checked_profit input output minimum :=
  Codes.get_function program environment "fun_checkedProfit" [input; output; minimum].
Lemma checked_profit_runs input output minimum state :
  0 <= input <= Types.uint256_max -> 0 <= output <= Types.uint256_max ->
  0 <= minimum <= Types.uint256_max -> input < output -> minimum <= output - input ->
  Run.t program environment state (Result.Ok [output - input])
    (checked_profit input output minimum) state.
Proof.
  intros input_bounds output_bounds minimum_bounds positive threshold.
  assert (gt_output_input : (output >? input) = true) by (apply Z.gtb_lt; lia).
  assert (gt_input_output : (input >? output) = false) by (rewrite Z.gtb_ltb; apply Z.ltb_ge; lia).
  assert (lt_gain_minimum : (output - input <? minimum) = false) by (apply Z.ltb_ge; lia).
  assert (gt_gain_output : (output - input >? output) = false) by (rewrite Z.gtb_ltb; apply Z.ltb_ge; lia).
  assert (gain_mod : (output - input) mod (2 ^ 256) = output - input).
  { apply Z.mod_small. unfold Types.uint256_max in *. lia. }
  change ((output - input) mod 115792089237316195423570985008687907853269984665640564039457584007913129639936 = output - input) in gain_mod.
  unfold checked_profit.
  unfold Codes.get_function, program, environment, deployed_code.
  cbn -[Z.ltb Z.gtb Z.leb Z.land Z.sub Z.modulo].
  repeat first [
    progress unfold Stdlib.Pure.gt
  | progress unfold Stdlib.Pure.lt
  | progress unfold Stdlib.Pure.sub
  | progress cbn -[Z.ltb Z.gtb Z.leb Z.land Z.sub Z.modulo]
  | progress rewrite ?gt_output_input, ?gt_input_output, ?lt_gain_minimum, ?gt_gain_output, ?gain_mod
  | eapply Run.Primitive; [reflexivity | cbn -[Z.ltb Z.gtb Z.leb Z.land Z.sub Z.modulo] ]
  | eapply Run.CallFunction; cbn -[Z.ltb Z.gtb Z.leb Z.land Z.sub Z.modulo]
  | eapply Run.Let; cbn -[Z.ltb Z.gtb Z.leb Z.land Z.sub Z.modulo]
  | eapply Run.Call; cbn -[Z.ltb Z.gtb Z.leb Z.land Z.sub Z.modulo]
  | apply Run.Pure
  ].
Qed.

Theorem checked_profit_refines_settlement input output minimum profit state :
  0 <= input <= Types.uint256_max ->
  0 <= output <= Types.uint256_max ->
  0 <= minimum <= Types.uint256_max ->
  Arbitrage.settlement input output minimum = Some profit ->
  Run.t program environment state (Result.Ok [profit])
    (checked_profit input output minimum) state.
Proof.
  intros input_bounds output_bounds minimum_bounds accepted.
  apply Arbitrage.settlement_sound in accepted as [positive [_ [threshold balance] ] ].
  assert (profit = output - input) by lia. subst profit.
  now apply checked_profit_runs.
Qed.

Print Assumptions checked_profit_runs.
Print Assumptions checked_profit_refines_settlement.
