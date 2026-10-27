From Coq Require Import Extraction ExtrOcamlBasic ExtrOcamlNativeString ExtrOcamlZBigInt.
From DEXFormal.Spec Require Import Simulation.

From DEXFormal.Frontend Require Import SimulationModel.
Extraction Language OCaml.
Extraction "formal/build/simulation/SimulationKernel.ml" initial step ready can_start can_stop parse_options refresh_assets active command_ready can_edit is_active.
