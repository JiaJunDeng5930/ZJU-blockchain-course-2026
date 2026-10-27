From Coq Require Import Extraction ExtrOcamlBasic ExtrOcamlNativeString ExtrOcamlZBigInt.
From DEXFormal.Frontend Require Import Wallet Transactions TransactionHistory Activity.

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
  Transactions.settlement_decision Transactions.sender_of
  TransactionHistory.initial TransactionHistory.storage_key TransactionHistory.scope TransactionHistory.valid_hash
  TransactionHistory.loaded TransactionHistory.load_failed TransactionHistory.error TransactionHistory.preference_warning
  TransactionHistory.stage TransactionHistory.saved TransactionHistory.save_failed
  TransactionHistory.retry_load TransactionHistory.retry_save TransactionHistory.pending_receipts
  TransactionHistory.needs_save TransactionHistory.can_refresh TransactionHistory.can_retry_load TransactionHistory.can_retry_save
  TransactionHistory.visible_entries TransactionHistory.flush_loaded
  TransactionHistory.receive_receipt TransactionHistory.receipt_unavailable
  Activity.initial Activity.view Activity.step.
