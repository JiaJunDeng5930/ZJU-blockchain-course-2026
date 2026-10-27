From Coq Require Import Extraction ExtrOcamlBasic ExtrOcamlNativeString ExtrOcamlZBigInt.
From DEXFormal.Spec Require Import Types Units AMM Arbitrage.

Extraction "formal/build/arbitrage/ArbitrageModel.ml"
  Arbitrage.scan Arbitrage.prepare_request Arbitrage.preview
  Units.parse_units_18 AMM.checked_amount_out.
