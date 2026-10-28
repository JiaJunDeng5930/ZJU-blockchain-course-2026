From Coq Require Import Extraction ExtrOcamlBasic ExtrOcamlNativeString ExtrOcamlNatInt.
From DEXFormal.Frontend Require Import SwapReceipt.
Extraction "formal/build/swapreceipt/SwapReceiptKernel.ml"
  SwapReceipt.select_swap SwapReceipt.result_with_wrapping SwapReceipt.available_with_wrapping
  SwapReceipt.select_wrapping SwapReceipt.output_asset
  SwapReceipt.select_pool_creation SwapReceipt.result_with_pool_creation
  SwapReceipt.available_with_pool_creation SwapReceipt.continue_created_pool.
