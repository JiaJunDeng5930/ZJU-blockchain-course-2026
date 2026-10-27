From Coq Require Import Extraction ExtrOcamlNativeString ExtrOcamlZBigInt.
From DEXFormal.Spec Require Import Types Units AMM.

Extraction Language OCaml.
Extraction Blacklist String List.
Set Extraction Output Directory "formal/build/trade".
Separate Extraction
  Types.approval_needed
  Units.parse_units_18 Units.positive_units_18 Units.parse_slippage_bps
  Units.format_units_18 Units.format_scaled Units.amount_error Units.slippage_error
  AMM.minimum_received AMM.amount_out AMM.checked_amount_out
  AMM.analyze_swap AMM.orient_trade AMM.swap_can_submit AMM.swap_disabled
  AMM.swap_submit_action AMM.swap_action AMM.swap_error
  AMM.preview_impact AMM.preview_high_impact AMM.preview_rate AMM.preview_fee
  AMM.preview_rate_text AMM.preview_impact_text AMM.preview_has_amount
  AMM.preview_pool_funded AMM.swap_can_max AMM.swap_max_text AMM.swap_reverse_text
  AMM.make_swap_parameters AMM.swap_parameters_error AMM.pool_fee_percent
  AMM.swap_deadline_text AMM.initial_draft AMM.draft_orientation AMM.draft_balance
  AMM.draft_output_balance AMM.draft_preview AMM.step_draft AMM.draft_effect.
