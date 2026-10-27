(* Production share-supply transitions in the upstream generated-IR semantics.
   The theorem covers successful pure helpers, not ERC721/storage composition,
   external token calls, or optimized EVM bytecode. *)
Require Export RocqOfSolidity.RocqOfSolidity.
Require Export RocqOfSolidity.simulations.RocqOfSolidity.
Require Export DEXFormal.Spec.Liquidity.
Require Export DEXFormal.Contracts.LiquidityGenerated.

Definition supply_code := LiquidityGenerated.LiquidityProperties.deployed.code.
Definition supply_program := [supply_code].
Definition supply_environment : Environment.t := {|
  Environment.caller := 1; Environment.callvalue := 0;
  Environment.calldata := []; Environment.address := 1;
  Environment.code_name := supply_code.(Code.hex_name)
|}.
Definition supply_call name inputs := Codes.get_function supply_program supply_environment name inputs.

Ltac expose_supply_head :=
  lazymatch goal with
  | |- Run.t ?codes ?environment ?initial ?output ?body ?final =>
    let exposed := eval hnf in body in
    tryif constr_eq body exposed then fail 0
    else change (Run.t codes environment initial output exposed final)
  end.
Ltac supply_run normalize :=
  repeat first [
    progress normalize
  | progress rewrite ?Z.eqb_refl
  | progress unfold Stdlib.Pure.gt
  | progress unfold Stdlib.Pure.lt
  | progress unfold Stdlib.Pure.eq
  | progress unfold Stdlib.Pure.iszero
  | progress unfold Stdlib.Pure.sub
  | progress unfold Stdlib.Pure.add
  | progress cbn -[Z.ltb Z.gtb Z.leb Z.land Z.sub Z.modulo supply_program supply_environment supply_code]
  | progress expose_supply_head
  | lazymatch goal with
    | |- Run.t _ _ _ _ (LowM.Primitive _ _) _ =>
      eapply Run.Primitive; [reflexivity |]
    | |- Run.t _ _ _ _ (LowM.CallFunction _ _ _) _ =>
      eapply Run.CallFunction;
        [solve [cbn -[Z.ltb Z.gtb Z.leb Z.land Z.sub Z.modulo supply_program supply_environment supply_code]; supply_run normalize] |]
    | |- Run.t _ _ _ _ (LowM.Let _ _) _ =>
      eapply Run.Let;
        [solve [cbn -[Z.ltb Z.gtb Z.leb Z.land Z.sub Z.modulo supply_program supply_environment supply_code]; supply_run normalize] |]
    | |- Run.t _ _ _ _ (LowM.Call _ _) _ =>
      eapply Run.Call;
        [solve [cbn -[Z.ltb Z.gtb Z.leb Z.land Z.sub Z.modulo supply_program supply_environment supply_code]; supply_run normalize] |]
    | |- Run.t _ _ _ _ (LowM.Pure _) _ => apply Run.Pure
    end
  ].


Lemma cleanup_uint256_runs value state :
  Run.t supply_program supply_environment state (Result.Ok [value])
    (Codes.get_function supply_program supply_environment "cleanup_uint256" [value]) state.
Proof. Timeout 25 supply_run ltac:(idtac). Qed.

Lemma identity_runs value state :
  Run.t supply_program supply_environment state (Result.Ok [value])
    (Codes.get_function supply_program supply_environment "identity" [value]) state.
Proof. Timeout 25 supply_run ltac:(idtac). Qed.

Lemma cleanup_rational_runs value state :
  Run.t supply_program supply_environment state (Result.Ok [value])
    (Codes.get_function supply_program supply_environment "cleanup_rational_by_1" [value]) state.
Proof. Timeout 25 supply_run ltac:(idtac). Qed.

Lemma convert_zero_rational_runs value state :
  Run.t supply_program supply_environment state (Result.Ok [value])
    (Codes.get_function supply_program supply_environment "convert_rational_0_by_1_to_uint256" [value]) state.
Proof. Timeout 25 supply_run ltac:(idtac). Qed.

Lemma zero_word_runs state :
  Run.t supply_program supply_environment state (Result.Ok [0])
    (Codes.get_function supply_program supply_environment "zero_value_for_split_uint256" []) state.
Proof. Timeout 25 supply_run ltac:(idtac). Qed.

(* Freeze word operands as equality-bound variables while VM-normalizing only
   the structural state update. Substitution restores their original terms before
   the primitive result fills any metavariables in the surrounding Run proof. *)
Ltac normalize_primitive_state :=
  first [
    match goal with
    | |- context[Stdlib.Pure.gt ?x ?y] =>
      let operand := fresh "operand" in let equation := fresh "operand_eq" in
      remember (Stdlib.Pure.gt x y) as operand eqn:equation;
      normalize_primitive_state; subst operand
    | |- context[Stdlib.Pure.lt ?x ?y] =>
      let operand := fresh "operand" in let equation := fresh "operand_eq" in
      remember (Stdlib.Pure.lt x y) as operand eqn:equation;
      normalize_primitive_state; subst operand
    | |- context[Stdlib.Pure.eq ?x ?y] =>
      let operand := fresh "operand" in let equation := fresh "operand_eq" in
      remember (Stdlib.Pure.eq x y) as operand eqn:equation;
      normalize_primitive_state; subst operand
    | |- context[Stdlib.Pure.iszero ?x] =>
      let operand := fresh "operand" in let equation := fresh "operand_eq" in
      remember (Stdlib.Pure.iszero x) as operand eqn:equation;
      normalize_primitive_state; subst operand
    | |- context[Stdlib.Pure.sub ?x ?y] =>
      let operand := fresh "operand" in let equation := fresh "operand_eq" in
      remember (Stdlib.Pure.sub x y) as operand eqn:equation;
      normalize_primitive_state; subst operand
    | |- context[Stdlib.Pure.add ?x ?y] =>
      let operand := fresh "operand" in let equation := fresh "operand_eq" in
      remember (Stdlib.Pure.add x y) as operand eqn:equation;
      normalize_primitive_state; subst operand
    | |- context[Z.add ?x ?y] =>
      let operand := fresh "operand" in let equation := fresh "operand_eq" in
      remember (Z.add x y) as operand eqn:equation;
      normalize_primitive_state; subst operand
    | |- context[Z.sub ?x ?y] =>
      let operand := fresh "operand" in let equation := fresh "operand_eq" in
      remember (Z.sub x y) as operand eqn:equation;
      normalize_primitive_state; subst operand
    | |- context[Z.modulo ?x ?y] =>
      let operand := fresh "operand" in let equation := fresh "operand_eq" in
      remember (Z.modulo x y) as operand eqn:equation;
      normalize_primitive_state; subst operand
    end
  | vm_compute
  ].

(* Strip the interpreter's single-value list projections without reducing word
   arithmetic or traversing the accumulated execution state. *)
Ltac normalize_supply_body :=
  lazymatch goal with
  | |- Run.t ?codes ?environment ?initial ?output ?body ?final =>
    let normalized := eval cbv beta iota zeta delta [List.hd Literal.number] in body in
    tryif constr_eq body normalized then fail 0
    else change (Run.t codes environment initial output normalized final)
  end.

(* Reuse execution results for identity helpers without unfolding their caller's
   accumulated local state. Each cache entry is a kernel-checked Run proof. *)
Ltac supply_run_cached normalize :=
  repeat first [
    progress normalize
  | progress normalize_supply_body
  | progress rewrite ?Z.eqb_refl
  | progress hnf
  | progress expose_supply_head
  | lazymatch goal with
    | |- Run.t _ _ _ _ (LowM.Primitive _ _) _ =>
      eapply Run.Primitive;
      [normalize_primitive_state; reflexivity
      | idtac]
    | |- Run.t _ _ _ _ (LowM.CallFunction ?name _ _) _ =>
      eapply Run.CallFunction;
      [ lazymatch name with
        | "cleanup_uint256" => apply cleanup_uint256_runs
        | "identity" => apply identity_runs
        | "cleanup_rational_by_1" => apply cleanup_rational_runs
        | "convert_rational_0_by_1_to_uint256" => apply convert_zero_rational_runs
        | "zero_value_for_split_uint256" => apply zero_word_runs
        | _ => solve [supply_run_cached normalize]
        end
      | idtac ]
    | |- Run.t _ _ _ _ (LowM.Let _ _) _ =>
      eapply Run.Let; [solve [supply_run_cached normalize] | idtac]
    | |- Run.t _ _ _ _ (LowM.Call _ _) _ =>
      eapply Run.Call; [solve [supply_run_cached normalize] | idtac]
    | |- Run.t _ _ _ _ (LowM.Pure _) _ => apply Run.Pure
    end
  ].
