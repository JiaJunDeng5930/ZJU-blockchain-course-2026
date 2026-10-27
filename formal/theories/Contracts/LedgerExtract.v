From Coq Require Import Extraction ExtrOcamlBasic ExtrOcamlNativeString ExtrOcamlZBigInt.
From DEXFormal.Spec Require Import Ledger.

Extraction "build/ledger/LedgerKernel.ml" Ledger.active_owners.
