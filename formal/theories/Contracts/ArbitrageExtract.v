From Coq Require Import ZArith Extraction ExtrOcamlBasic ExtrOcamlNativeString ExtrOcamlZBigInt.
From DEXFormal.Spec Require Import Types Units AMM Assets Arbitrage.
From DEXFormal.Frontend Require Import ArbitrageCapital ReceiptFees.
Local Open Scope Z_scope.

Record execution_summary := ExecutionSummary {
  execution_amount_in : Z;
  execution_amount_out : Z;
  execution_profit : Z;
  execution_gas_cost_wei : Z
}.

(* Amounts come from one execution event; gas fields come from its receipt.
   ETH cost is separate from the ERC20 settlement, without an exchange rate. *)
Definition summarize_execution amount_in amount_out profit gas_used gas_price :=
  ExecutionSummary amount_in amount_out profit (ReceiptFees.execution_fee gas_used gas_price).

Theorem execution_summary_settlement capital returned minimum profit gas_used gas_price :
  Arbitrage.settlement capital returned minimum = Some profit ->
  let summary := summarize_execution capital returned profit gas_used gas_price in
  execution_amount_out summary = execution_amount_in summary + execution_profit summary /\
  0 < execution_profit summary /\ minimum <= execution_profit summary.
Proof.
  intro H. apply Arbitrage.settlement_sound in H as [_ [positive [threshold balance]]].
  cbn. auto.
Qed.

Theorem execution_summary_fee_nonnegative capital returned profit gas_used gas_price :
  0 <= gas_used -> 0 <= gas_price ->
  0 <= execution_gas_cost_wei (summarize_execution capital returned profit gas_used gas_price).
Proof. cbn. apply ReceiptFees.execution_fee_nonnegative. Qed.

Theorem execution_summary_token_amounts_independent_of_gas capital returned profit used price used' price' :
  let before := summarize_execution capital returned profit used price in
  let after := summarize_execution capital returned profit used' price' in
  execution_amount_in before = execution_amount_in after /\
  execution_amount_out before = execution_amount_out after /\
  execution_profit before = execution_profit after.
Proof. repeat split; reflexivity. Qed.

(* Bind the asset capability policy here, so metadata/catalog changes do not
   invalidate the independent production settlement refinement. *)
Definition supports_asset_pool tokens (market : Arbitrage.pool) :=
  Assets.pool_assets_supported tokens (Arbitrage.token0 market) (Arbitrage.token1 market).
Definition scan_supported_assets places quote selected markets input_token tokens :=
  Arbitrage.scan_supported places quote selected markets input_token (supports_asset_pool tokens).
Definition prepare_supported_assets quote arbitrage buy_reference sell_reference markets
    input_token input minimum balance allowance now tokens :=
  Arbitrage.prepare_supported quote arbitrage buy_reference sell_reference markets
    input_token input minimum balance allowance now (supports_asset_pool tokens).

Theorem prepare_supported_assets_at_valid_time quote arbitrage buy_reference sell_reference
    markets input_token input minimum balance allowance before after tokens plan :
  prepare_supported_assets quote arbitrage buy_reference sell_reference markets
    input_token input minimum balance allowance before tokens = Arbitrage.Prepared plan ->
  Types.valid_call_time after = true ->
  exists current,
    prepare_supported_assets quote arbitrage buy_reference sell_reference markets
      input_token input minimum balance allowance after tokens = Arbitrage.Prepared current /\
    Arbitrage.execution_route current = Arbitrage.execution_route plan /\
    Arbitrage.minimum_profit current = Arbitrage.minimum_profit plan /\
    Arbitrage.approval_required current = Arbitrage.approval_required plan /\
    Arbitrage.deadline current = Types.call_deadline after.
Proof.
  unfold prepare_supported_assets, Arbitrage.prepare_supported, Arbitrage.prepare_request.
  destruct (andb (supports_asset_pool tokens buy_reference) (supports_asset_pool tokens sell_reference));
    [|discriminate].
  destruct (Arbitrage.find_pool buy_reference
    (Arbitrage.supported_markets (supports_asset_pool tokens) markets)); [|discriminate].
  destruct (Arbitrage.find_pool sell_reference
    (Arbitrage.supported_markets (supports_asset_pool tokens) markets)); [|discriminate].
  destruct (Arbitrage.candidate quote p p0 input_token input); [|discriminate].
  apply Arbitrage.prepare_at_valid_time.
Qed.

Theorem scan_supported_assets_have_supported_assets places quote selected markets input_token tokens result :
  scan_supported_assets places quote selected markets input_token tokens = Some result ->
  supports_asset_pool tokens (Arbitrage.buy result) = true /\
  supports_asset_pool tokens (Arbitrage.sell result) = true.
Proof. unfold scan_supported_assets. apply Arbitrage.scan_supported_has_supported_pools. Qed.

Extraction "formal/build/arbitrage/ArbitrageModel.ml"
  scan_supported_assets prepare_supported_assets summarize_execution Arbitrage.preview
  Units.parse_units_18 Units.positive_units ArbitrageCapital.quote_amount AMM.checked_amount_out.
