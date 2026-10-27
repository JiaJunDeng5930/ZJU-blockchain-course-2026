From Coq Require Import Extraction ExtrOcamlBasic ExtrOcamlNativeString ExtrOcamlNatInt.
From DEXFormal.Frontend Require Import SwapReceipt.
Extraction "formal/build/swapreceipt/SwapReceiptKernel.ml"
  SwapReceipt.select_swap SwapReceipt.result_with_wrapping SwapReceipt.available_with_wrapping
  SwapReceipt.select_wrapping SwapReceipt.output_asset.
