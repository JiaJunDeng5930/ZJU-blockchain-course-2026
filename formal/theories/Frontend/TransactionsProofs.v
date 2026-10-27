From Coq Require Import ZArith String List Lia.
From DEXFormal.Frontend Require Import Wallet Transactions.
Import ListNotations.
Open Scope Z_scope.

Module TransactionProofs.
Module W := Wallet.
Module T := Transactions.

Definition keeps_confirmed (before after : T.state) : Prop :=
  forall entry hash block gas,
    In entry (T.journal before) ->
    T.entry_phase entry = T.Confirmed hash block gas ->
    In entry (T.journal after).

Lemma mapped_event_keeps_confirmed s id event : keeps_confirmed s (T.apply_journal s id event).
Proof.
  intros entry hash block gas Hin Hphase. cbn.
  apply in_map_iff. exists entry. split; auto.
  now apply T.confirmed_entry_preserved with hash block gas.
Qed.

Lemma unchanged_journal_keeps_confirmed before after :
  T.journal after = T.journal before -> keeps_confirmed before after.
Proof. intros Hjournal entry hash block gas Hin _. now rewrite Hjournal. Qed.

Lemma begin_keeps_confirmed s wallet identity label :
  keeps_confirmed s (fst (T.begin_operation s wallet identity label)).
Proof.
  apply unchanged_journal_keeps_confirmed.
  unfold T.begin_operation. destruct (T.active s); cbn; try reflexivity.
  destruct identity; cbn; try reflexivity.
  destruct (W.permits wallet i); reflexivity.
Qed.

Lemma request_keeps_confirmed s wallet op label authority :
  keeps_confirmed s (fst (T.request_write s wallet op label authority)).
Proof.
  intros entry hash block gas Hin Hphase.
  unfold T.request_write. destruct (T.active s) as [operation|]; cbn; auto.
  destruct (Z.eqb op (T.operation_id operation)); cbn; auto.
  destruct (T.operation_status operation); cbn; auto.
  destruct (W.permits wallet (T.operation_identity operation)); cbn; auto.
Qed.

Lemma authorize_keeps_confirmed s wallet op tx accounts chain :
  keeps_confirmed s (T.authorization_transactions (T.authorize_and_reconcile s wallet op tx accounts chain)).
Proof.
  intros entry hash block gas Hin Hphase.
  unfold T.authorize_and_reconcile, T.authorize.
  destruct (T.authorization_identity s op tx) as [identity|]; cbn; auto.
  destruct (W.preflight wallet identity accounts chain); cbn; auto.
  apply in_map_iff. exists entry. split; auto.
  unfold T.signing_entry. destruct (Z.eqb tx (T.entry_id entry)); try reflexivity.
  now rewrite Hphase.
Qed.

Lemma waiting_status_keeps_confirmed s id status : keeps_confirmed s (T.set_waiting_status s id status).
Proof. apply unchanged_journal_keeps_confirmed. apply T.set_waiting_status_preserves_journal. Qed.

Lemma keeps_confirmed_transitive first second third :
  keeps_confirmed first second -> keeps_confirmed second third -> keeps_confirmed first third.
Proof. intros Hfirst Hsecond entry hash block gas Hin Hphase. eauto. Qed.

Inductive lifecycle_step : T.state -> T.state -> Prop :=
| BeginStep s wallet identity label : lifecycle_step s (fst (T.begin_operation s wallet identity label))
| WriteStep s wallet op label authority : lifecycle_step s (fst (T.request_write s wallet op label authority))
| AuthorizeStep s wallet op tx accounts chain : lifecycle_step s
    (T.authorization_transactions (T.authorize_and_reconcile s wallet op tx accounts chain))
| BroadcastStep s tx hash : lifecycle_step s (T.broadcast s tx hash)
| PreflightFailedStep s tx message : lifecycle_step s (T.preflight_failed s tx message)
| SubmissionFailedStep s tx code message : lifecycle_step s (T.signature_failed s tx code message)
| ReceiptStep s tx hash sender success block used price : lifecycle_step s
    (fst (T.settle s tx hash sender success block used price))
| ReadFailedStep s tx message : lifecycle_step s (T.observation_failed s tx message)
| FinishStep s op error : lifecycle_step s (T.finish_operation s op error).

Theorem every_step_keeps_confirmed before after :
  lifecycle_step before after -> keeps_confirmed before after.
Proof.
  intros Hstep. destruct Hstep.
  - apply begin_keeps_confirmed.
  - apply request_keeps_confirmed.
  - apply authorize_keeps_confirmed.
  - apply mapped_event_keeps_confirmed.
  - unfold T.preflight_failed. eapply keeps_confirmed_transitive.
    + apply mapped_event_keeps_confirmed.
    + apply waiting_status_keeps_confirmed.
  - unfold T.signature_failed. eapply keeps_confirmed_transitive.
    + apply mapped_event_keeps_confirmed.
    + apply waiting_status_keeps_confirmed.
  - cbn. intros entry old_hash old_block gas Hin Hphase.
    rewrite T.receipt_journal. apply in_map_iff. exists entry. split; auto.
    now apply T.confirmed_entry_preserved with old_hash old_block gas.
  - unfold T.observation_failed. eapply keeps_confirmed_transitive.
    + apply mapped_event_keeps_confirmed.
    + apply waiting_status_keeps_confirmed.
  - apply unchanged_journal_keeps_confirmed. unfold T.finish_operation.
    destruct (T.active s) as [operation|]; try reflexivity.
    destruct (Z.eqb op (T.operation_id operation)); reflexivity.
Qed.

Inductive lifecycle_trace : T.state -> T.state -> Prop :=
| TraceRefl s : lifecycle_trace s s
| TraceNext first next last : lifecycle_step first next -> lifecycle_trace next last -> lifecycle_trace first last.

Theorem confirmed_survives_every_later_event first last :
  lifecycle_trace first last -> keeps_confirmed first last.
Proof.
  intros Htrace. induction Htrace.
  - intros entry hash block gas Hin _. exact Hin.
  - eapply keeps_confirmed_transitive; eauto using every_step_keeps_confirmed.
Qed.

End TransactionProofs.
