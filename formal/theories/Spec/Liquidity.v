From Coq Require Import ZArith String Ascii List Bool Lia.
From DEXFormal.Spec Require Import Types Units AMM.
Import ListNotations.
Open Scope string_scope.
Open Scope Z_scope.

(* A single ERC20 ledger; each asset has its own independent instance. *)
Definition token_balances := address -> Z.
Definition can_pay available requested := uint256b available && uint256b requested && (requested <=? available).
Definition set_balance (balances : token_balances) account value : token_balances :=
  fun queried => if String.eqb account queried then value else balances queried.
(* Address validity and allowance belong to the external token interface. This
   function specifies its balance effect once those interface checks pass. *)
Definition move_balance (balances : token_balances) sender recipient value : option token_balances :=
  if can_pay (balances sender) value then
    if String.eqb sender recipient then Some balances
    else if uint256b (balances recipient + value) then
      Some (set_balance (set_balance balances sender (balances sender-value))
        recipient (balances recipient+value))
    else None
  else None.
Lemma can_pay_spec available requested :
  can_pay available requested = true <->
  uint256 available /\ uint256 requested /\ requested <= available.
Proof. unfold can_pay; rewrite !andb_true_iff, !uint256b_spec, Z.leb_le; tauto. Qed.
Lemma self_transfer_preserves_balance balances sender value :
  can_pay (balances sender) value = true -> move_balance balances sender sender value = Some balances.
Proof. intros H. unfold move_balance. now rewrite H, String.eqb_refl. Qed.
Lemma distinct_transfer_conserves_balances balances sender recipient value after :
  sender <> recipient -> move_balance balances sender recipient value = Some after ->
  after sender + after recipient = balances sender + balances recipient.
Proof.
  intros Hneq. unfold move_balance.
  destruct (can_pay (balances sender) value); [|discriminate].
  assert (Hsr : String.eqb sender recipient = false) by (apply String.eqb_neq; exact Hneq).
  assert (Hrs : String.eqb recipient sender = false) by (apply String.eqb_neq; congruence).
  rewrite Hsr. destruct (uint256b (balances recipient+value)); [|discriminate].
  intros H; inversion H; subst. unfold set_balance.
  rewrite !String.eqb_refl, Hrs. lia.
Qed.
Lemma transfer_leaves_third_party_unchanged balances sender recipient value after third :
  third <> sender -> third <> recipient ->
  move_balance balances sender recipient value = Some after -> after third = balances third.
Proof.
  intros Hs Hr. unfold move_balance.
  destruct (can_pay (balances sender) value); [|discriminate].
  destruct (String.eqb sender recipient).
  - intros H; now inversion H.
  - destruct (uint256b (balances recipient+value)); [|discriminate].
    intros H; inversion H; subst. unfold set_balance.
    assert (String.eqb sender third = false) by (apply String.eqb_neq; congruence).
    assert (String.eqb recipient third = false) by (apply String.eqb_neq; congruence).
    now rewrite H0, H1.
Qed.

Definition locked_shares : Z := 1000.
Definition mint_total (total minted : Z) : Z :=
  (if total =? 0 then locked_shares else total) + minted.
Definition burn_total (total burned : Z) : Z := total - burned.

Lemma mint_total_retains_locked total minted :
  (total = 0 \/ locked_shares <= total) -> 0 < minted ->
  locked_shares < mint_total total minted.
Proof.
  intros H Hmint. unfold mint_total.
  destruct (Z.eqb_spec total 0); subst; unfold locked_shares in *; lia.
Qed.
Lemma burn_total_retains_locked total burned :
  0 <= burned <= total - locked_shares ->
  locked_shares <= burn_total total burned /\ burn_total total burned + burned = total.
Proof. unfold burn_total; lia. Qed.

Lemma quotient_bounds numerator denominator :
  0 <= numerator -> 0 < denominator ->
  0 <= numerator / denominator /\
  (numerator / denominator) * denominator <= numerator /\
  numerator < (numerator / denominator + 1) * denominator.
Proof.
  intros Hn Hd.
  pose proof (Z.div_mod numerator denominator ltac:(lia)) as Hdiv.
  pose proof (Z.mod_pos_bound numerator denominator Hd) as Hmod.
  split; [apply Z.div_pos; lia|nia].
Qed.

Definition deposit_amounts reserve0 reserve1 total desired0 desired1 : Z * Z :=
  if total =? 0 then (desired0, desired1)
  else let optimal1 := desired0 * reserve1 / reserve0 in
    if optimal1 <=? desired1 then (desired0, optimal1)
    else (desired1 * reserve0 / reserve1, desired1).
Definition minted_shares reserve0 reserve1 total used0 used1 : Z :=
  if total =? 0 then Z.sqrt (used0 * used1) - locked_shares
  else Z.min (used0 * total / reserve0) (used1 * total / reserve1).
Definition redeem_amounts reserve0 reserve1 total shares : Z * Z :=
  (shares * reserve0 / total, shares * reserve1 / total).
Definition counterpart reserve0 reserve1 total (index : bool) (text : string) : option string :=
  if total =? 0 then None
  else if String.eqb text "" then Some ""
  else match positive_units_18 text with
  | None => None
  | Some value => Some (format_units_18
      (if index then value * reserve0 / reserve1 else value * reserve1 / reserve0))
  end.

Lemma deposit_amounts_within_desired r0 r1 total d0 d1 :
  0 < r0 -> 0 < r1 -> 0 <= d0 -> 0 <= d1 ->
  let used := deposit_amounts r0 r1 total d0 d1 in
  0 <= fst used <= d0 /\ 0 <= snd used <= d1.
Proof.
  intros Hr0 Hr1 Hd0 Hd1. unfold deposit_amounts.
  destruct (total =? 0); cbn; [lia|].
  destruct (Z.leb_spec (d0 * r1 / r0) d1); cbn.
  - pose proof (quotient_bounds (d0*r1) r0 ltac:(nia) Hr0); lia.
  - pose proof (quotient_bounds (d0*r1) r0 ltac:(nia) Hr0) as [_ [Hfloor _]].
    split; [|lia]. split; [apply Z.div_pos; nia|].
    apply Z.lt_le_incl. apply Z.div_lt_upper_bound; nia.
Qed.

Lemma redeem_amount_strict reserve total shares :
  0 < reserve -> 0 < total -> 0 <= shares < total ->
  0 <= shares * reserve / total < reserve.
Proof.
  intros Hr Ht Hs. split.
  - apply Z.div_pos; nia.
  - apply Z.div_lt_upper_bound; nia.
Qed.
Lemma redeemed_locked_pool_stays_funded r0 r1 total shares :
  0 < r0 -> 0 < r1 -> 0 <= shares <= total - locked_shares ->
  let '(a0,a1) := redeem_amounts r0 r1 total shares in
  0 < r0-a0 /\ 0 < r1-a1 /\ locked_shares <= total-shares.
Proof.
  intros Hr0 Hr1 Hs. unfold redeem_amounts.
  pose proof (redeem_amount_strict r0 total shares Hr0 ltac:(unfold locked_shares in *; lia)
    ltac:(unfold locked_shares in *; lia)).
  pose proof (redeem_amount_strict r1 total shares Hr1 ltac:(unfold locked_shares in *; lia)
    ltac:(unfold locked_shares in *; lia)). lia.
Qed.

Definition pool_validb r0 r1 total :=
  uint256b total && (0 <=? r0) && (r0 <=? max_reserve) &&
  (0 <=? r1) && (r1 <=? max_reserve) &&
  (if total =? 0 then (r0 =? 0) && (r1 =? 0)
   else (locked_shares <=? total) && (0 <? r0) && (0 <? r1)).

Record deposit_plan := DepositPlan {
  deposit0 : Z; deposit1 : Z;
  used0 : Z; used1 : Z;
  unused0 : Z; unused1 : Z;
  minted : Z; minimum0 : Z; minimum1 : Z
}.
Definition deposit_validb r0 r1 total d0 d1 b0 b1 slip :=
  let '(a0,a1) := deposit_amounts r0 r1 total d0 d1 in
  let shares := minted_shares r0 r1 total a0 a1 in
  pool_validb r0 r1 total && uint256b d0 && uint256b d1 &&
  (0 <? d0) && (0 <? d1) && can_pay b0 d0 && can_pay b1 d1 &&
  (0 <=? slip) && (slip <=? 5000) && (0 <? a0) && (0 <? a1) &&
  (a0 <=? d0) && (a1 <=? d1) &&
  (r0+a0 <=? max_reserve) && (r1+a1 <=? max_reserve) &&
  (0 <? shares) && uint256b (mint_total total shares) &&
  (if total =? 0 then true else
    uint256b (d0*r1/r0) && uint256b (a0*total/r0) && uint256b (a1*total/r1)).
Definition prepare_deposit r0 r1 total d0 d1 b0 b1 slip : option deposit_plan :=
  let '(a0,a1) := deposit_amounts r0 r1 total d0 d1 in
  let shares := minted_shares r0 r1 total a0 a1 in
  if deposit_validb r0 r1 total d0 d1 b0 b1 slip then
    Some (DepositPlan d0 d1 a0 a1 (d0-a0) (d1-a1) shares
      (minimum_received a0 slip) (minimum_received a1 slip))
  else None.

Ltac unpack_checks :=
  repeat match goal with
  | H : andb _ _ = true |- _ => apply andb_true_iff in H; destruct H
  | H : Z.leb _ _ = true |- _ => apply Z.leb_le in H
  | H : Z.ltb _ _ = true |- _ => apply Z.ltb_lt in H
  end.

Lemma prepare_deposit_budgets r0 r1 total d0 d1 b0 b1 slip plan :
  prepare_deposit r0 r1 total d0 d1 b0 b1 slip = Some plan ->
  0 < used0 plan <= d0 /\ 0 < used1 plan <= d1 /\
  d0 <= b0 /\ d1 <= b1 /\
  used0 plan + unused0 plan = d0 /\ used1 plan + unused1 plan = d1 /\
  r0 + used0 plan <= max_reserve /\ r1 + used1 plan <= max_reserve /\
  0 < minted plan.
Proof.
  unfold prepare_deposit.
  destruct (deposit_amounts r0 r1 total d0 d1) as [a0 a1] eqn:Hamounts.
  destruct (deposit_validb r0 r1 total d0 d1 b0 b1 slip) eqn:Hvalid; [|discriminate].
  intros H; inversion H; subst; cbn -[max_reserve].
  unfold deposit_validb, can_pay in Hvalid. rewrite Hamounts in Hvalid.
  unpack_checks. repeat split; lia.
Qed.

Record position_view := PositionView {
  redeem0 : Z; redeem1 : Z;
  held_value : Z; current_value : Z; value_change : Z;
  share_percent : string
}.
Definition position_values r0 r1 total shares original0 original1 : position_view :=
  let '(a0,a1) := redeem_amounts r0 r1 total shares in
  let held := original0*r1/r0+original1 in
  let current := a0*r1/r0+a1 in
  PositionView a0 a1 held current (current-held)
    (format_scaled 4 (shares*1000000/total)).

Definition address_hex_char c :=
  let n := Ascii.nat_of_ascii c in
  ((48 <=? n)%nat && (n <=? 57)%nat) ||
  ((65 <=? n)%nat && (n <=? 70)%nat) ||
  ((97 <=? n)%nat && (n <=? 102)%nat).
Fixpoint all_hex text :=
  match text with EmptyString => true | String c tail => address_hex_char c && all_hex tail end.
Definition zero_address := "0x0000000000000000000000000000000000000000".
Definition valid_recipientb text :=
  match text with
  | String c0 (String c1 tail) =>
      Ascii.eqb c0 "0"%char && Ascii.eqb c1 "x"%char &&
      Nat.eqb (String.length tail) 40 && all_hex tail && negb (String.eqb text zero_address)
  | _ => false
  end.
Definition transfer_error owner current recipient :=
  if negb (String.eqb owner current) then Some "This wallet does not own the position."
  else if negb (valid_recipientb recipient) then Some "Enter a valid, nonzero Ethereum recipient address."
  else if String.eqb owner recipient then Some "Choose a different recipient address."
  else None.
Lemma accepted_transfer_is_owner owner current recipient :
  transfer_error owner current recipient = None -> owner = current /\ valid_recipientb recipient = true.
Proof.
  unfold transfer_error.
  destruct (String.eqb owner current) eqn:Howner; cbn; [|discriminate].
  destruct (valid_recipientb recipient) eqn:Hvalid; cbn; [|discriminate].
  destruct (String.eqb owner recipient); [discriminate|].
  intros _. split; [apply String.eqb_eq; exact Howner|reflexivity].
Qed.

Definition withdraw_validb r0 r1 total shares slip :=
  pool_validb r0 r1 total && (0 <? shares) && (shares <=? total-locked_shares) &&
  (0 <=? slip) && (slip <=? 5000).
Definition withdraw_plan r0 r1 total shares slip : option (Z*Z*Z*Z) :=
  if withdraw_validb r0 r1 total shares slip then
    let '(a0,a1) := redeem_amounts r0 r1 total shares in
    Some (a0,a1,minimum_received a0 slip,minimum_received a1 slip)
  else None.

Record fee_trade := FeeTrade { fee_token0 : bool; fee_input : Z }.
Record fee_totals := FeeTotals { volume0 : Z; volume1 : Z; fees0 : Z; fees1 : Z }.
Definition zero_fees := FeeTotals 0 0 0 0.
Definition accumulate_fees rate totals trade :=
  let fee := fee_input trade * rate / 10000 in
  if fee_token0 trade
  then FeeTotals (volume0 totals+fee_input trade) (volume1 totals) (fees0 totals+fee) (fees1 totals)
  else FeeTotals (volume0 totals) (volume1 totals+fee_input trade) (fees0 totals) (fees1 totals+fee).
Definition aggregate_fees rate trades := fold_left (accumulate_fees rate) trades zero_fees.
Lemma fee_accumulation_nonnegative rate totals trade :
  0 <= rate -> 0 <= fee_input trade ->
  0 <= volume0 totals -> 0 <= volume1 totals -> 0 <= fees0 totals -> 0 <= fees1 totals ->
  0 <= volume0 (accumulate_fees rate totals trade) /\
  0 <= volume1 (accumulate_fees rate totals trade) /\
  0 <= fees0 (accumulate_fees rate totals trade) /\
  0 <= fees1 (accumulate_fees rate totals trade).
Proof.
  intros. unfold accumulate_fees.
  assert (0 <= fee_input trade * rate / 10000) by (apply Z.div_pos; nia).
  destruct (fee_token0 trade); cbn; lia.
Qed.

Record liquidity_claim := LiquidityClaim { claim_id : Z; claim_owner : address; claim_shares : Z }.
Fixpoint share_sum (claims : list liquidity_claim) : Z :=
  match claims with [] => 0 | claim::tail => claim_shares claim + share_sum tail end.
Definition book_supply claims := locked_shares + share_sum claims.
Definition transfer_claim id recipient claims :=
  map (fun claim => if claim_id claim =? id
    then LiquidityClaim (claim_id claim) recipient (claim_shares claim) else claim) claims.
Fixpoint take_claim id claims : option (liquidity_claim * list liquidity_claim) :=
  match claims with
  | [] => None
  | claim::tail => if claim_id claim =? id then Some (claim,tail)
      else match take_claim id tail with
      | None => None | Some (found,rest) => Some (found,claim::rest) end
  end.
Definition burn_claim caller id claims :=
  match take_claim id claims with
  | None => None
  | Some (claim,rest) => if String.eqb (claim_owner claim) caller then Some rest else None
  end.
Lemma transfer_preserves_book_supply id recipient claims :
  book_supply (transfer_claim id recipient claims) = book_supply claims.
Proof.
  unfold book_supply, transfer_claim. f_equal.
  induction claims as [|claim tail IH]; [reflexivity|].
  cbn [map share_sum]. destruct (claim_id claim =? id); cbn; now rewrite IH.
Qed.
Lemma mint_increases_book_supply claim claims :
  book_supply (claim::claims) = book_supply claims + claim_shares claim.
Proof. unfold book_supply; cbn [share_sum]; lia. Qed.
Lemma taking_claim_conserves_shares id claims claim rest :
  take_claim id claims = Some (claim,rest) ->
  share_sum claims = claim_shares claim + share_sum rest.
Proof.
  revert claim rest. induction claims as [|head tail IH]; [discriminate|].
  cbn [take_claim]. destruct (claim_id head =? id).
  - intros claim rest H. inversion H; subst. reflexivity.
  - destruct (take_claim id tail) as [[found remaining]|] eqn:Htake; [|discriminate].
    specialize (IH found remaining eq_refl).
    intros claim rest H. inversion H; subst. cbn [share_sum]. lia.
Qed.
Lemma share_sum_nonnegative claims :
  Forall (fun claim => 0 <= claim_shares claim) claims -> 0 <= share_sum claims.
Proof. intros H; induction H; cbn [share_sum]; lia. Qed.
Lemma taking_preserves_nonnegative id claims claim rest :
  Forall (fun item => 0 <= claim_shares item) claims ->
  take_claim id claims = Some (claim,rest) ->
  0 <= claim_shares claim /\ Forall (fun item => 0 <= claim_shares item) rest.
Proof.
  revert claim rest. induction claims as [|head tail IH]; [discriminate|].
  intros claim rest Hvalid Htake. inversion Hvalid as [|item items Hhead Htailvalid]; subst.
  cbn [take_claim] in Htake. destruct (claim_id head =? id).
  - inversion Htake; subst. auto.
  - destruct (take_claim id tail) as [[found remaining]|] eqn:Htail; [|discriminate].
    specialize (IH found remaining Htailvalid eq_refl).
    inversion Htake; subst. destruct IH; split; [assumption|constructor; assumption].
Qed.
Lemma burn_authority_and_supply caller id claims remaining :
  Forall (fun item => 0 <= claim_shares item) claims ->
  burn_claim caller id claims = Some remaining ->
  exists burned,
    claim_owner burned = caller /\
    book_supply claims = book_supply remaining + claim_shares burned /\
    locked_shares <= book_supply remaining.
Proof.
  intros Hvalid. unfold burn_claim.
  destruct (take_claim id claims) as [[burned rest]|] eqn:Htake; [|discriminate].
  destruct (String.eqb (claim_owner burned) caller) eqn:Howner; [|discriminate].
  intros H; inversion H; subst. exists burned.
  apply String.eqb_eq in Howner. split; [exact Howner|].
  pose proof (taking_claim_conserves_shares _ _ _ _ Htake).
  pose proof (taking_preserves_nonnegative _ _ _ _ Hvalid Htake) as [_ Hrest].
  pose proof (share_sum_nonnegative remaining Hrest).
  unfold book_supply. split; lia.
Qed.

Definition fee_summary token0 rate trades :=
  aggregate_fees rate (map (fun input => FeeTrade (String.eqb token0 (fst input)) (snd input)) trades).
Definition value_sign view := if 0 <=? value_change view then "+" else "".

Lemma initial_geometric_supply amount0 amount1 :
  0 <= amount0 -> 0 <= amount1 -> locked_shares < Z.sqrt (amount0*amount1) ->
  let minted := minted_shares 0 0 0 amount0 amount1 in
  mint_total 0 minted = Z.sqrt (amount0*amount1) /\
  let total := mint_total 0 minted in
  total*total <= amount0*amount1 < (total+1)*(total+1).
Proof.
  intros H0 H1 Hsqrt.
  unfold minted_shares, mint_total. cbn -[Z.sqrt locked_shares].
  assert (Heq : locked_shares + (Z.sqrt (amount0*amount1)-locked_shares) = Z.sqrt (amount0*amount1)) by lia.
  rewrite Heq. split; [reflexivity|].
  rewrite !Z.add_1_r. apply Z.sqrt_spec. nia.
Qed.

Record position_reference := PositionReference {
  reference_key : string; reference_owner : address; reference_pool : string;
  reference_created : Z; reference_id : Z
}.
Definition newer_reference a b :=
  (reference_created b <? reference_created a) ||
  ((reference_created a =? reference_created b) && (reference_id b <? reference_id a)).
Fixpoint insert_reference item items :=
  match items with
  | [] => [item]
  | head::tail => if newer_reference item head then item::items
      else head::insert_reference item tail
  end.
Fixpoint sort_references items :=
  match items with [] => [] | head::tail => insert_reference head (sort_references tail) end.
Definition owned_references owner items :=
  sort_references (filter (fun item => String.eqb (reference_owner item) owner) items).
Definition pool_references key items :=
  filter (fun item => String.eqb (reference_pool item) key) items.
Lemma insertion_preserves_property (P : position_reference -> Prop) item items :
  P item -> Forall P items -> Forall P (insert_reference item items).
Proof.
  intros Hitem Hall. induction Hall; cbn [insert_reference]; [auto|].
  destruct (newer_reference item x); constructor; auto.
Qed.
Lemma sorting_preserves_property (P : position_reference -> Prop) items :
  Forall P items -> Forall P (sort_references items).
Proof. intros H; induction H; cbn [sort_references]; auto using insertion_preserves_property. Qed.
Lemma owned_references_are_owned owner items :
  Forall (fun item => reference_owner item=owner) (owned_references owner items).
Proof.
  unfold owned_references. apply sorting_preserves_property.
  apply Forall_forall. intros item Hin. apply filter_In in Hin. destruct Hin as [_ H].
  now apply String.eqb_eq.
Qed.
Lemma owned_references_are_input_members owner items :
  Forall (fun item => In item items) (owned_references owner items).
Proof.
  unfold owned_references. apply sorting_preserves_property.
  apply Forall_forall. intros item Hin. now apply filter_In in Hin.
Qed.
