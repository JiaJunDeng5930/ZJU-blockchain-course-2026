From Coq Require Import Extraction ExtrOcamlBasic ExtrOcamlNativeString ExtrOcamlZBigInt.
From DEXFormal.Frontend Require Import ReceiptFees.
Extraction "formal/build/receiptfees/ReceiptFeesKernel.ml" ReceiptFees.execution_fee.
