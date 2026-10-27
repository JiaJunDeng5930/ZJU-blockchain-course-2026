From Coq Require Import String ZArith Bool Lia.
From DEXFormal.Spec Require Import Simulation.
Open Scope string_scope.
Open Scope Z_scope.
Inductive job_phase := Idle | Starting | Running | Stopping | Completed | Stopped | Failed.
Definition active p := match p with Starting | Running | Stopping => true | _ => false end.
Record observation := { job_id : string; phase : job_phase; payload : string }.
Inductive command := Read | Start (o : simulation_options) | Stop (id : string).
Record request := { ticket : Z; operation : command }.
Record controller := { serial : Z; pending : option request;
  observed : option observation; uncertain : bool; draft : simulation_draft; error : string }.
Definition initial := {| serial := 0; pending := None; observed := None; uncertain := true;
 draft := {| rounds_text := "60"; seed_text := "2026"; duration_text := "30"; interval_text := "250" |}; error := "" |}.
Definition ready s := match pending s with None => true | Some _ => false end.
Definition command_ready s := match pending s with
 | None | Some {| operation := Read |} => true | _ => false end.
Definition is_active s := match observed s with Some o => active (phase o) | None => false end.
Definition can_edit s := command_ready s && negb (is_active s).
Definition can_start s := command_ready s && negb (uncertain s) &&
  match observed s, parse_options (draft s) with Some o, Some _ => negb (active (phase o)) | _,_ => false end.
Definition can_stop s := command_ready s && negb (uncertain s) &&
  match observed s with Some o => match phase o with Starting | Running => negb (String.eqb (job_id o) "") | _ => false end | _ => false end.
Definition issue s c := let r := {| ticket := serial s + 1; operation := c |} in
 ({| serial := ticket r; pending := Some r; observed := observed s; uncertain := uncertain s;
 draft := draft s; error := "" |}, Some r).
Inductive event := Poll | Begin | Halt | Edit (d : simulation_draft)
 | Success (id : Z) (o : observation) | Failure (id : Z) (message : string).
Definition matches s id := match pending s with Some r => Z.eqb (ticket r) id | None => false end.
Definition step s e : controller * option request :=
 match e with
 | Poll => if ready s then issue s Read else (s,None)
 | Begin => if can_start s then match parse_options (draft s) with Some o => issue s (Start o) | None => (s,None) end else (s,None)
 | Halt => if can_stop s then match observed s with Some o => issue s (Stop (job_id o)) | None => (s,None) end else (s,None)
 | Edit d => if can_edit s then
     ({| serial := serial s; pending := pending s; observed := observed s; uncertain := uncertain s; draft := d; error := error s |},None) else (s,None)
 | Success id o => if matches s id then
     ({| serial := serial s; pending := None; observed := Some o; uncertain := false; draft := draft s; error := "" |},None) else (s,None)
 | Failure id message => if matches s id then
     ({| serial := serial s; pending := None; observed := observed s; uncertain := true; draft := draft s; error := message |},None) else (s,None)
 end.
Theorem stale_success_ignored s id o : matches s id = false -> step s (Success id o) = (s,None).
Proof. intros H; cbn; rewrite H; reflexivity. Qed.
Theorem stale_failure_ignored s id message : matches s id = false -> step s (Failure id message) = (s,None).
Proof. intros H; cbn; rewrite H; reflexivity. Qed.
Theorem poll_only_reads s r : snd (step s Poll) = Some r -> operation r = Read.
Proof. cbn; destruct (ready s); inversion 1; reflexivity. Qed.
Theorem uncertain_never_starts s : uncertain s = true -> step s Begin = (s,None).
Proof. intros H; unfold step, can_start; rewrite H; cbn; destruct (command_ready s); reflexivity. Qed.
Theorem pending_command_excludes_commands s r : pending s = Some r -> operation r <> Read ->
 step s Begin = (s,None) /\ step s Halt = (s,None).
Proof. intros H N; unfold step, can_start, can_stop, command_ready; rewrite H.
 destruct r as [t c]; cbn in *; destruct c; try contradiction; cbn; auto. Qed.
Theorem emitted_ticket_fresh s c : ticket (match snd (issue s c) with Some r => r | None => {| ticket := 0; operation := Read |} end) > serial s.
Proof. cbn; lia. Qed.
Theorem start_uses_valid_options s r : snd (step s Begin) = Some r ->
 exists o, operation r = Start o /\ parse_options (draft s) = Some o.
Proof. cbn; destruct (can_start s); try discriminate; destruct (parse_options (draft s)) eqn:H; inversion 1; subst; eexists; split; reflexivity. Qed.
Theorem stop_targets_observed_job s r : snd (step s Halt) = Some r ->
 exists o, observed s = Some o /\ operation r = Stop (job_id o).
Proof. cbn; destruct (can_stop s); try discriminate; destruct (observed s) eqn:H; inversion 1; subst; eexists; split; reflexivity. Qed.
Theorem failure_requires_reconciliation s id msg : matches s id = true ->
 can_start (fst (step s (Failure id msg))) = false.
Proof. intros H; unfold step; rewrite H; unfold can_start; cbn; destruct (command_ready s); reflexivity. Qed.
Definition terminal p := match p with Completed | Stopped => true | _ => false end.
Definition refresh_assets s e := match e with
 | Success id o => matches s id && terminal (phase o) &&
     match observed s with
     | None => true
     | Some previous => negb (String.eqb (job_id previous) (job_id o)) || negb (terminal (phase previous))
     end
 | _ => false
 end.
Theorem stale_does_not_refresh s id o : matches s id = false -> refresh_assets s (Success id o) = false.
Proof. intros H; unfold refresh_assets; rewrite H; reflexivity. Qed.
Theorem only_terminal_success_refreshes s e : refresh_assets s e = true ->
 exists id o, e = Success id o /\ matches s id = true /\ terminal (phase o) = true.
Proof. destruct e; cbn; try discriminate. repeat rewrite andb_true_iff; intros [[H T] _]; eauto. Qed.
Theorem uncertain_never_stops s : uncertain s = true -> step s Halt = (s,None).
Proof. intros H; unfold step, can_stop; rewrite H; cbn; destruct (command_ready s); reflexivity. Qed.
Theorem invalid_options_never_start s : parse_options (draft s) = None -> step s Begin = (s,None).
Proof. intros H; unfold step, can_start; rewrite H; destruct (observed s); cbn;
 destruct (command_ready s), (uncertain s); reflexivity. Qed.
