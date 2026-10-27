From Coq Require Import Extraction ExtrOcamlBasic ExtrOcamlNativeString ExtrOcamlZBigInt.
From DEXFormal.Spec Require Import Wrapping.
From DEXFormal.Frontend Require Import WrappingModel.
Extraction Language OCaml.
Extraction "formal/build/wrapping/WrappingKernel.ml"
  initial_wrapping step_wrapping prepare_wrapping prepare_wrapping_draft
  wrapping_decision_error wrapping_input_error select_wrapped required_wrapped_address.
