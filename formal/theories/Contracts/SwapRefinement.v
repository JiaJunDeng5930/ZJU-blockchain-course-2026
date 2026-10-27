(* The existing SMT harness inherits the production AMMMath helper. This
   proof evaluates its compiler-generated optimized Yul with the upstream Run.t
   constructors, without using admitted simulation lemmas. The positive-input
   domain matches submitted frontend swaps. ABI decoding, MiniDEX storage,
   token transfers and optimized EVM bytecode are outside this theorem. *)
Require Import RocqOfSolidity.RocqOfSolidity.
Require Import RocqOfSolidity.simulations.RocqOfSolidity.
Require Import DEXFormal.Spec.AMM.
Require DEXFormal.Spec.Routing.
Require Import DEXFormal.Contracts.SwapGenerated.
Definition deployed_code := SwapGenerated.SwapProperties.deployed.code.
Definition program := [deployed_code].
Definition calculate_amount_out env rin rout input :=
  Codes.get_function program env "fun_calculateAmountOut" [rin;rout;input].
Lemma uint_word value : Types.uint256 value ->
  value mod 115792089237316195423570985008687907853269984665640564039457584007913129639936 = value.
Proof. unfold Types.uint256, Types.uint256_max. intro H. apply Z.mod_small; lia. Qed.
Ltac swap_normalize_closed :=
  match goal with
  | |- context [Z.eqb ?x ?y] =>
    let b := eval vm_compute in (Z.eqb x y) in
    lazymatch b with
    | true => progress change (Z.eqb x y) with true
    | false => progress change (Z.eqb x y) with false
    end
  | |- context [Z.lor ?x ?y] =>
    let v := eval vm_compute in (Z.lor x y) in
    lazymatch v with
    | Z0 => progress change (Z.lor x y) with v
    | Zpos _ => progress change (Z.lor x y) with v
    | Zneg _ => progress change (Z.lor x y) with v
    end
  end.
Lemma calculate_amount_out_runs env rin rout input state :
  Environment.code_name env = deployed_code.(Code.hex_name) ->
  bounded_reserves rin rout input -> 0 < input ->
  Run.t program env state (Result.Ok [amount_out rin rout input])
    (calculate_amount_out env rin rout input) state.
Proof.
  intros Henv Hbounds HinputPos.
  pose proof (bounded_reserve_arithmetic rin rout input Hbounds) as [Hw [Hn [Hd [Hdp Hs] ] ] ].
  pose proof reserve_constants_fit as [HM [HMw HMn] ].
  unfold bounded_reserves in Hbounds.
  destruct Hbounds as [ [Hri HriMax] [ [Hro HroMax] [Hi HiMax] ] ].
  pose proof (amount_out_bounds rin rout input Hri Hro Hi) as Hquote.
  unfold amount_out,fee_multiplier,fee_bps,fee_denominator,max_reserve,Types.uint256 in *.
  assert (HriZero : (rin =? 0)=false) by (apply Z.eqb_neq;lia).
  assert (HroZero : (rout =? 0)=false) by (apply Z.eqb_neq;lia).
  assert (HinputZero : (input =? 0)=false) by (apply Z.eqb_neq;lia).
  assert (HweightedZero : (input*9970 =? 0)=false) by (apply Z.eqb_neq;nia).
  assert (HdenZero : (rin*10000+input*9970 =? 0)=false) by (apply Z.eqb_neq;nia).
  assert (HriMaxB : (rin >? 5192296858534827628530496329220095)=false) by (rewrite Z.gtb_ltb;apply Z.ltb_ge;lia).
  assert (HroMaxB : (rout >? 5192296858534827628530496329220095)=false) by (rewrite Z.gtb_ltb;apply Z.ltb_ge;lia).
  assert (HinputMaxB : (input >? 5192296858534827628530496329220095-rin)=false) by (rewrite Z.gtb_ltb;apply Z.ltb_ge;lia).
  assert (HdiffMaxB : (5192296858534827628530496329220095-rin >? 5192296858534827628530496329220095)=false) by (rewrite Z.gtb_ltb;apply Z.ltb_ge;lia).
  assert (HsumGT : (rin*10000 >? rin*10000+input*9970)=false) by (rewrite Z.gtb_ltb;apply Z.ltb_ge;nia).
  assert (HdivInput : (input*9970)/input=9970) by (rewrite Z.mul_comm;apply Z.div_mul;lia).
  assert (HdivWeighted : (input*9970*rout)/(input*9970)=rout) by (rewrite (Z.mul_comm (input*9970));apply Z.div_mul;nia).
  assert (HdivRi : (rin*10000)/rin=10000) by (rewrite Z.mul_comm;apply Z.div_mul;lia).
  unfold calculate_amount_out,Codes.get_function,program,deployed_code.
  rewrite Henv.
  cbn -[Z.ltb Z.gtb Z.leb Z.land Z.sub Z.modulo Z.mul Z.add Z.div Z.eqb Z.lor].
  repeat first [
    progress unfold Stdlib.Pure.gt
  | progress unfold Stdlib.Pure.lt
  | progress unfold Stdlib.Pure.sub
  | progress unfold Stdlib.Pure.mul
  | progress unfold Stdlib.Pure.add
  | progress unfold Stdlib.Pure.div
  | progress unfold Stdlib.Pure.eq
  | progress unfold Stdlib.Pure.iszero
  | progress unfold Stdlib.Pure.or
  | progress cbn -[Z.ltb Z.gtb Z.leb Z.land Z.sub Z.modulo Z.mul Z.add Z.div Z.eqb Z.lor]
  | progress rewrite ?Henv,?HriZero,?HroZero,?HinputZero,?HweightedZero,?HdenZero,?HriMaxB,?HroMaxB,?HinputMaxB,?HdiffMaxB,?HsumGT,?HdivInput,?HdivWeighted,?HdivRi,?Z.eqb_refl
  | progress rewrite uint_word by (unfold Types.uint256,Types.uint256_max in *;nia)
  | swap_normalize_closed
  | lazymatch goal with
    | |- Run.t _ _ ?current_state _ ?expression _ =>
      tryif has_evar current_state then fail else
      tryif has_evar expression then fail else
      let expression := eval hnf in expression in
      tryif is_evar expression then fail else
      lazymatch expression with
      | LowM.Primitive _ _ => eapply Run.Primitive; [reflexivity | cbn -[Z.ltb Z.gtb Z.leb Z.land Z.sub Z.modulo Z.mul Z.add Z.div Z.eqb Z.lor] ]
      | LowM.CallFunction _ _ _ => eapply Run.CallFunction; cbn -[Z.ltb Z.gtb Z.leb Z.land Z.sub Z.modulo Z.mul Z.add Z.div Z.eqb Z.lor]
      | LowM.Let _ _ => eapply Run.Let; cbn -[Z.ltb Z.gtb Z.leb Z.land Z.sub Z.modulo Z.mul Z.add Z.div Z.eqb Z.lor]
      | LowM.Call _ _ => eapply Run.Call; cbn -[Z.ltb Z.gtb Z.leb Z.land Z.sub Z.modulo Z.mul Z.add Z.div Z.eqb Z.lor]
      | LowM.Pure _ => apply Run.Pure
      end
    end
  ].
Qed.

Theorem frontend_swap_quote_matches_contract env environment draft token input output slippage state :
  Environment.code_name env = deployed_code.(Code.hex_name) ->
  draft_effect environment draft SubmitDraft = RequestSwapEffect token input output slippage ->
  Run.t program env state (Result.Ok [output])
    (calculate_amount_out env
      (input_reserve (draft_orientation environment draft))
      (output_reserve (draft_orientation environment draft)) input) state.
Proof.
  intros Henv Hrequest.
  apply request_swap_uses_shared_quote in Hrequest as [Hpositive Hquote].
  pose proof (checked_amount_out_domain _ _ _ _ Hquote) as Hdomain.
  rewrite (bounded_quote_total _ _ _ Hdomain) in Hquote.
  injection Hquote as Houtput. rewrite <- Houtput.
  now apply calculate_amount_out_runs.
Qed.

Theorem routed_swap_quote_matches_contract env environment draft plan state :
  Environment.code_name env = deployed_code.(Code.hex_name) ->
  Routing.next_effect environment draft (Routing.DraftEvent SubmitDraft) = Routing.Execute plan ->
  Run.t program env state (Result.Ok [Routing.prepared_output plan])
    (calculate_amount_out env
      (input_reserve (Routing.prepared_direction plan))
      (output_reserve (Routing.prepared_direction plan)) (Routing.prepared_input plan)) state.
Proof.
  intros Henv Hrequest.
  pose proof (Routing.execution_uses_shared_frontend _ _ _ _ Hrequest) as Hfrontend.
  pose proof (Routing.execution_environment_is_selected_pool _ _ _ _ Hrequest) as [_ Hcurrent].
  pose proof (Routing.frontend_request_keeps_token _ _ _ _ _ _ Hfrontend) as Htoken.
  pose proof (frontend_swap_quote_matches_contract env (Routing.prepared_environment plan)
    (Routing.draft draft) _ _ _ _ state Henv Hfrontend) as Hrun.
  unfold Routing.prepared_direction. unfold draft_orientation in Hrun.
  rewrite Hcurrent in Hrun. cbn [Routing.pool_environment] in Hrun.
  rewrite <- Htoken in Hrun. exact Hrun.
Qed.
