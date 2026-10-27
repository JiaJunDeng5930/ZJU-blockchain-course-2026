From Coq Require Import ZArith String List Bool Lia.

Open Scope Z_scope.

(* Amounts are raw token units. Decimal rendering never changes these values. *)
Definition amount := Z.
Definition address := string.
Definition chain_id := Z.
Definition request_id := Z.
Definition uint256_max : Z := 2 ^ 256 - 1.
Definition uint256 (value : Z) : Prop := 0 <= value <= uint256_max.
Definition uint256b (value : Z) : bool :=
  (0 <=? value) && (value <=? uint256_max).

Lemma uint256b_spec value : uint256b value = true <-> uint256 value.
Proof.
  unfold uint256b, uint256.
  rewrite andb_true_iff, !Z.leb_le. reflexivity.
Qed.

Definition approval_needed (allowance requested : Z) : bool := allowance <? requested.
Definition call_lifetime : Z := 1200.
Definition call_deadline (now : Z) : Z := now + call_lifetime.
Definition valid_call_time (now : Z) : bool :=
  (0 <=? now) && (call_deadline now <=? uint256_max).

Lemma approval_needed_spec allowance requested :
  approval_needed allowance requested = true <-> allowance < requested.
Proof. apply Z.ltb_lt. Qed.

Lemma valid_call_time_spec now :
  valid_call_time now = true <-> 0 <= now /\ call_deadline now <= uint256_max.
Proof. unfold valid_call_time. rewrite andb_true_iff, !Z.leb_le. reflexivity. Qed.

Lemma valid_call_time_bounds now :
  valid_call_time now = true ->
  uint256 now /\ uint256 (call_deadline now) /\ now < call_deadline now.
Proof.
  rewrite valid_call_time_spec.
  unfold uint256, call_deadline, call_lifetime. lia.
Qed.

Inductive contract_call :=
| ClaimToken (token : address)
| ApproveToken (token spender : address) (value : amount)
| CreatePool (exchange token0 token1 : address)
| Swap (exchange : address) (pool : Z) (input_token : address)
    (input minimum_output : Z) (recipient : address) (deadline : Z)
| AddLiquidity (exchange : address) (pool amount0 amount1 minimum0 minimum1 deadline : Z)
| RemoveLiquidity (exchange : address) (position minimum0 minimum1 deadline : Z)
| TransferPosition (exchange sender recipient : address) (position : Z)
| WrapEther (token : address) (value : amount)
| UnwrapEther (token : address) (value : amount)
| DeployToken (name symbol : string)
| ExecuteArbitrage (arbitrage buy_exchange sell_exchange : address)
    (buy_pool sell_pool : Z) (capital_token : address)
    (capital minimum_profit deadline : Z).

Inductive call_result (State Value : Type) :=
| Committed (state : State) (value : Value)
| Reverted (original : State) (reason : string).

Arguments Committed {State Value} _ _.
Arguments Reverted {State Value} _ _.

(* This is the shared rollback specification, not a new EVM implementation. *)
Definition atomic_call {State Value : Type} (original : State)
    (execution : option (State * Value)) (reason : string) : call_result State Value :=
  match execution with
  | Some (state, value) => Committed state value
  | None => Reverted original reason
  end.

Lemma atomic_call_failed_preserves_state {State Value} (original : State) reason :
  @atomic_call State Value original None reason = Reverted original reason.
Proof. reflexivity. Qed.
