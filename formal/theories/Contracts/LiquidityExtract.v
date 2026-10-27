From Coq Require Import Extraction ExtrOcamlBasic ExtrOcamlNativeString ExtrOcamlZBigInt.
From DEXFormal.Spec Require Import Types Units AMM Liquidity.
From DEXFormal.Frontend Require Import LiquidityPolicy.
Extraction "build/liquidity/LiquidityKernel.ml"
  LiquidityPolicy.analyze_deposit Types.approval_needed
  LiquidityPolicy.prepare_transfer
  LiquidityPolicy.prepare_position_withdraw LiquidityPolicy.prepare_withdraw_write
  LiquidityPolicy.prepare_deposit_write LiquidityPolicy.withdrawal_message
  Types.call_deadline Types.valid_call_time LiquidityPolicy.withdrawal_error
  Liquidity.owned_references Liquidity.pool_references
  Liquidity.deposit_amounts Liquidity.counterpart Liquidity.position_values
  Liquidity.transfer_error Liquidity.withdraw_plan Liquidity.fee_summary Liquidity.value_sign
  Units.integer_text Units.format_scaled.
