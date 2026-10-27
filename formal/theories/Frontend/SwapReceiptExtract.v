From Coq Require Import Extraction ExtrOcamlBasic ExtrOcamlNativeString ExtrOcamlNatInt.
From DEXFormal.Frontend Require Import SwapReceipt.
Extraction "formal/build/swapreceipt/SwapReceiptKernel.ml"
  SwapReceipt.select_swap SwapReceipt.result_for SwapReceipt.available SwapReceipt.output_asset.
