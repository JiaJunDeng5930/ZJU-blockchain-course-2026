From Coq Require Import Extraction ExtrOcamlBasic ExtrOcamlNativeString ExtrOcamlZBigInt ExtrOcamlNatInt.
From DEXFormal.Frontend Require Import LiquidityReceipt.
Extraction "formal/build/liquidityreceipt/LiquidityReceiptKernel.ml" LiquidityReceipt.select_receipt LiquidityReceipt.available.
