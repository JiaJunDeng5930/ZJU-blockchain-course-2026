From Coq Require Import Extraction ExtrOcamlBasic ExtrOcamlNativeString ExtrOcamlZBigInt.
From DEXFormal.Frontend Require Import Wallet Transactions.

Extraction Language OCaml.
Extraction "formal/build/wallet/WalletKernel.ml"
  Wallet.restore Wallet.restore_saved Wallet.select_local Wallet.connect_browser Wallet.invalidate
  Wallet.observe Wallet.observation_failed Wallet.disconnect Wallet.provider_changed Wallet.provider_disconnected
  Wallet.switch_network Wallet.switched Wallet.added Wallet.current_identity
  Wallet.preflight Wallet.reconcile_preflight Wallet.retains_snapshot Wallet.funding_plan Wallet.native_funding_plan
  Transactions.initial Transactions.begin_operation Transactions.request_write
  Transactions.authorize_and_reconcile Transactions.broadcast Transactions.preflight_failed Transactions.signature_failed
  Transactions.settle Transactions.observation_failed Transactions.finish_operation
  Transactions.pending Transactions.current_error Transactions.current_activity
  Transactions.settlement_decision Transactions.sender_of.
