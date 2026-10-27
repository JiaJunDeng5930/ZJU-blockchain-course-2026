From Coq Require Import Extraction ExtrOcamlBasic ExtrOcamlNativeString ExtrOcamlZBigInt.
From DEXFormal.Spec Require Import Types Units AMM Assets Arbitrage.

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

Theorem scan_supported_assets_have_supported_assets places quote selected markets input_token tokens result :
  scan_supported_assets places quote selected markets input_token tokens = Some result ->
  supports_asset_pool tokens (Arbitrage.buy result) = true /\
  supports_asset_pool tokens (Arbitrage.sell result) = true.
Proof. unfold scan_supported_assets. apply Arbitrage.scan_supported_has_supported_pools. Qed.

Extraction "formal/build/arbitrage/ArbitrageModel.ml"
  scan_supported_assets prepare_supported_assets Arbitrage.preview
  Units.parse_units_18 AMM.checked_amount_out.
