From Coq Require Import Extraction ExtrOcamlBasic ExtrOcamlNativeString ExtrOcamlNatInt.
From DEXFormal.Frontend Require Import SwapReceipt.
Extraction "formal/build/swapreceipt/SwapReceiptKernel.ml"
  SwapReceipt.output_asset SwapReceipt.select_wrapping
  SwapReceipt.select_pool_creation SwapReceipt.continue_created_pool
  SwapReceipt.select_token_funding.
