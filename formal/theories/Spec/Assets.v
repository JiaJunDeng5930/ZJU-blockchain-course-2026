From Coq Require Import String Ascii List Bool ZArith Lia.
From DEXFormal.Spec Require Import Types Units.
Import ListNotations.
Open Scope string_scope.
Open Scope Z_scope.

Inductive capability := Faucet | Wrapped | External.
Record asset := Asset { asset_address : string; asset_name : string;
  asset_symbol : string; asset_decimals : option Z; asset_capability : capability }.
Definition lowercase (c : ascii) : ascii :=
  let n := nat_of_ascii c in
  if (Nat.leb 65 n && Nat.leb n 90)%bool then ascii_of_nat (n + 32) else c.
Fixpoint lower (s : string) : string :=
  match s with EmptyString => EmptyString | String c rest => String (lowercase c) (lower rest) end.
Definition hex_digit (c : ascii) : bool :=
  let n := nat_of_ascii c in
  ((Nat.leb 48 n && Nat.leb n 57) || (Nat.leb 97 n && Nat.leb n 102))%bool.
Fixpoint hexadecimal (s : string) : bool :=
  match s with EmptyString => true | String c rest => hex_digit c && hexadecimal rest end.
Definition zero_address := "0x0000000000000000000000000000000000000000".
Definition canonical_address (s : string) : option string :=
  (* DEFENSE: pasted addresses are untrusted input; reject oversized text before recursive trimming. *)
  if within_length 100 s then let s := lower (trim s) in
  match s with
  | String a (String b rest) =>
      if Ascii.eqb a "0" && Ascii.eqb b "x" &&
         Nat.eqb (String.length rest) 40 && hexadecimal rest && negb (String.eqb s zero_address)
      then Some s else None
  | _ => None
  end else None.
Definition same_address (a b : string) := String.eqb (lower a) (lower b).
Definition address_member (a : string) (addresses : list string) := existsb (same_address a) addresses.
Definition has_runtime (code : string) := negb (String.eqb code "") && negb (String.eqb code "0x").
Definition runtime_code_matches (actual expected : string) := has_runtime actual && String.eqb actual expected.
Lemma runtime_code_matches_sound actual expected : runtime_code_matches actual expected = true ->
  actual = expected /\ actual <> "" /\ actual <> "0x".
Proof.
  unfold runtime_code_matches, has_runtime. rewrite !andb_true_iff, !negb_true_iff, !String.eqb_neq, String.eqb_eq. tauto.
Qed.
Definition pool_assets_supported (tokens : list string) (first second : string) :=
  address_member first tokens && address_member second tokens.
Definition unsupported_pool_error := "Both tokens must be verified ERC20 contracts with readable uint8 decimal metadata before using this pool.".
Lemma supported_pool_has_both_assets tokens first second : pool_assets_supported tokens first second = true ->
  address_member first tokens = true /\ address_member second tokens = true.
Proof. unfold pool_assets_supported. now rewrite andb_true_iff. Qed.
Definition supported_asset (a name symbol : string) (decimals : Z) (code expected : string) : option asset :=
  match canonical_address a with
  | None => None
  | Some address =>
      if valid_precision decimals && has_runtime code
      then Some (Asset address name symbol (Some decimals)
        (if String.eqb code expected then Faucet else External)) else None
  end.
Definition deployment_name_error := "Enter a name and symbol of at most 100 bytes each.".
Definition deployment_call (name symbol : string) : option contract_call :=
  (* DEFENSE: token names originate in editable text fields; bound them before recursive trimming. *)
  if within_length 100 name && within_length 100 symbol then
    let name := trim name in let symbol := trim symbol in
    if String.eqb name EmptyString || String.eqb symbol EmptyString
    then None else Some (DeployToken name symbol)
  else None.

Record market := Market { market_exchange : string; market_first : string; market_second : string }.
Definition same_pair (a b c d : string) :=
  (same_address a c && same_address b d) || (same_address a d && same_address b c).
Definition pool_exists (exchange a b : string) (markets : list market) :=
  existsb (fun market => same_address exchange (market_exchange market) &&
    same_pair a b (market_first market) (market_second market)) markets.
Definition pool_error (exchanges tokens : list string) (markets : list market)
    (exchange a b : string) : option string :=
  if negb (address_member exchange exchanges) then Some "Choose an exchange."
  else if negb (pool_assets_supported tokens a b)
    then Some "Choose two supported tokens."
  else if same_address a b then Some "Choose two different tokens."
  else if pool_exists exchange a b markets then Some "This pair already has a pool on this exchange."
  else None.
Definition pool_call exchanges tokens markets exchange a b : option contract_call :=
  match pool_error exchanges tokens markets exchange a b with
  | Some _ => None | None => Some (CreatePool exchange a b)
  end.
Definition faucet_call (token : asset) : option contract_call :=
  match asset_capability token with
  | Faucet => Some (ClaimToken (asset_address token)) | _ => None
  end.

Lemma supported_asset_has_valid_decimals a name symbol decimals code expected token :
  supported_asset a name symbol decimals code expected = Some token ->
  asset_decimals token = Some decimals /\ 0 <= decimals <= 255.
Proof.
  unfold supported_asset. destruct (canonical_address a); try discriminate.
  destruct (valid_precision decimals && has_runtime code) eqn:H; try discriminate.
  intro E. inversion E; subst. split; [reflexivity|].
  apply andb_true_iff in H as [H _]. unfold valid_precision in H.
  apply andb_true_iff in H as [A B]. apply Z.leb_le in A. apply Z.leb_le in B. lia.
Qed.
Lemma faucet_capability_requires_code a name symbol decimals code expected token :
  supported_asset a name symbol decimals code expected = Some token ->
  asset_capability token = Faucet -> code = expected.
Proof.
  unfold supported_asset. destruct (canonical_address a); try discriminate.
  destruct (valid_precision decimals && has_runtime code); try discriminate.
  destruct (String.eqb code expected) eqn:H; intros E F; inversion E; subst; simpl in F; try discriminate.
  now apply String.eqb_eq in H.
Qed.
Lemma faucet_call_requires_capability token call :
  faucet_call token = Some call -> asset_capability token = Faucet.
Proof. unfold faucet_call. destruct (asset_capability token); intros H; try discriminate; reflexivity. Qed.
Lemma deployed_names_nonempty name symbol call : deployment_call name symbol = Some call ->
  trim name <> EmptyString /\ trim symbol <> EmptyString.
Proof.
  unfold deployment_call. destruct (within_length 100 name && within_length 100 symbol); try discriminate.
  destruct (String.eqb (trim name) "" || String.eqb (trim symbol) "") eqn:H; try discriminate.
  apply orb_false_iff in H as [Hname Hsymbol].
  apply String.eqb_neq in Hname. apply String.eqb_neq in Hsymbol. auto.
Qed.
Lemma pool_call_different_tokens exchanges tokens markets exchange a b call :
  pool_call exchanges tokens markets exchange a b = Some call -> same_address a b = false.
Proof.
  unfold pool_call, pool_error.
  destruct (negb (address_member exchange exchanges)); try discriminate.
  destruct (negb (pool_assets_supported tokens a b)); try discriminate.
  destruct (same_address a b) eqn:H; try discriminate. auto.
Qed.
Lemma pool_call_no_duplicate exchanges tokens markets exchange a b call :
  pool_call exchanges tokens markets exchange a b = Some call -> pool_exists exchange a b markets = false.
Proof.
  unfold pool_call, pool_error.
  destruct (negb (address_member exchange exchanges)); try discriminate.
  destruct (negb (pool_assets_supported tokens a b)); try discriminate.
  destruct (same_address a b); try discriminate.
  destruct (pool_exists exchange a b markets) eqn:H; try discriminate. auto.
Qed.

(* Stored metadata is display information; its capabilities are never trusted. *)
Fixpoint restore_assets (tokens : list asset) : list asset :=
  match tokens with
  | [] => []
  | token :: rest => match canonical_address (asset_address token) with
    | None => restore_assets rest
    | Some address => Asset address (asset_name token) (asset_symbol token) None External :: restore_assets rest
    end
  end.
Lemma restored_assets_have_no_capabilities tokens :
  Forall (fun token => asset_capability token = External) (restore_assets tokens).
Proof.
  induction tokens as [|token rest IH]; simpl; [constructor|].
  destruct (canonical_address (asset_address token)); auto.
Qed.
Fixpoint merge_asset (token : asset) (tokens : list asset) : list asset :=
  match tokens with
  | [] => [token]
  | current :: rest =>
      if same_address (asset_address token) (asset_address current)
      then (match asset_capability current with Wrapped => current | _ => token end) :: rest
      else current :: merge_asset token rest
  end.
Definition merge_assets := fold_left (fun tokens token => merge_asset token tokens).
Record catalog := Catalog { catalog_tokens : list asset; catalog_verified : list string;
  catalog_error : option string }.
Definition initial_catalog (deployed saved : list asset) (error : option string) : catalog :=
  let restored := restore_assets saved in
  let error := if Nat.eqb (List.length restored) (List.length saved) then error
    else Some "Saved token metadata contained invalid addresses. Import those token addresses again." in
  Catalog (deployed ++ merge_assets
    (filter (fun token => negb (address_member (asset_address token) (map asset_address deployed)))
      restored) []) (map asset_address deployed) error.
Definition register_assets (state : catalog) (tokens : list asset) : catalog :=
  Catalog (merge_assets tokens (catalog_tokens state))
    (nodup string_dec (map asset_address tokens ++ catalog_verified state)) (catalog_error state).
Definition catalog_storage_error (state : catalog) (message : string) : catalog :=
  Catalog (catalog_tokens state) (catalog_verified state) (Some message).
Fixpoint unique_addresses (addresses : list string) : list string :=
  match addresses with [] => [] | a :: rest =>
    if address_member a rest then unique_addresses rest else a :: unique_addresses rest end.
Definition discovery_targets (state : catalog) (markets : list market) : list string :=
  filter (fun a => negb (address_member a (catalog_verified state)))
    (unique_addresses (map asset_address (catalog_tokens state) ++
       flat_map (fun market => [market_first market; market_second market]) markets)).
Lemma discovered_token_is_verified state tokens token : In token tokens ->
  In (asset_address token) (catalog_verified (register_assets state tokens)).
Proof. intros H. unfold register_assets; simpl. apply nodup_In. apply in_or_app; left. now apply in_map. Qed.
Lemma discovery_excludes_verified state markets address :
  In address (discovery_targets state markets) -> address_member address (catalog_verified state) = false.
Proof.
  unfold discovery_targets. rewrite filter_In. intros [_ H]. now apply negb_true_iff in H.
Qed.

Definition address_error := "Enter a nonzero ERC20 contract address.".
Definition metadata_error := "Token must be a deployed ERC20 contract with readable uint8 decimal metadata.".
Definition faucet_error := "This token does not expose the verified test-token faucet.".
Definition deployment_receipt_error := "Confirmed deployment did not return a contract address.".
Definition deployment_verification_error := "Deployed code or token metadata does not match the requested test token.".
Definition deployed_asset_matches (name symbol : string) (token : asset) :=
  match asset_capability token with
  | Faucet => String.eqb (asset_name token) (trim name) && String.eqb (asset_symbol token) (trim symbol)
  | _ => false end.
Lemma deployment_registration_checks_code_and_metadata name symbol token :
  deployed_asset_matches name symbol token = true ->
  asset_capability token = Faucet /\ asset_name token = trim name /\ asset_symbol token = trim symbol.
Proof.
  unfold deployed_asset_matches. destruct (asset_capability token) eqn:H; try discriminate.
  rewrite andb_true_iff, !String.eqb_eq. auto.
Qed.

Definition active_assets (state : catalog) : list asset :=
  filter (fun token => address_member (asset_address token) (catalog_verified state)) (catalog_tokens state).
Lemma active_assets_are_verified state token : In token (active_assets state) ->
  address_member (asset_address token) (catalog_verified state) = true.
Proof. unfold active_assets. rewrite filter_In. tauto. Qed.
Definition pool_price_text (reserve0 reserve1 decimals0 decimals1 : Z) (symbol0 symbol1 : string) : string :=
  if (0 <? reserve0) && (0 <? reserve1)
  then "1 " ++ symbol0 ++ " = " ++ match price_text reserve1 decimals1 reserve0 decimals0 with Some price => price | None => "Unavailable" end ++ " " ++ symbol1
  else "Unfunded".

Lemma pool_call_uses_known_exchange exchanges tokens markets exchange a b call :
  pool_call exchanges tokens markets exchange a b = Some call -> address_member exchange exchanges = true.
Proof.
  unfold pool_call, pool_error.
  destruct (negb (address_member exchange exchanges)) eqn:H; try discriminate.
  apply negb_false_iff in H. auto.
Qed.
Lemma pool_pair_is_unordered a b c d : same_pair a b c d = same_pair b a c d.
Proof.
  unfold same_pair. destruct (same_address a c), (same_address b d),
    (same_address a d), (same_address b c); reflexivity.
Qed.
Lemma pool_exists_is_unordered exchange a b markets :
  pool_exists exchange a b markets = pool_exists exchange b a markets.
Proof.
  unfold pool_exists. induction markets as [|market rest IH]; simpl; auto.
  now rewrite pool_pair_is_unordered, IH.
Qed.
Lemma imported_asset_has_checked_address a name symbol decimals code expected token :
  supported_asset a name symbol decimals code expected = Some token ->
  canonical_address a = Some (asset_address token).
Proof.
  unfold supported_asset. destruct (canonical_address a) as [address|] eqn:H; try discriminate.
  destruct (valid_precision decimals && has_runtime code); try discriminate.
  intro E. inversion E; subst. reflexivity.
Qed.
Lemma canonical_address_is_nonzero raw address :
  canonical_address raw = Some address -> address <> zero_address.
Proof.
  unfold canonical_address. destruct (within_length 100 raw); try discriminate.
  destruct (lower (trim raw)) as [|a rest]; try discriminate.
  destruct rest as [|b body]; try discriminate.
  destruct (Ascii.eqb a "0" && Ascii.eqb b "x" && Nat.eqb (String.length body) 40 &&
    hexadecimal body && negb (String.eqb (String a (String b body)) zero_address)) eqn:H; try discriminate.
  intros E. inversion E; subst.
  repeat rewrite andb_true_iff in H.
  rewrite negb_true_iff, String.eqb_neq in H. tauto.
Qed.

Definition test_faucet_amount : Z := 10000 * 10 ^ 18.
Lemma test_faucet_amount_is_positive : 0 < test_faucet_amount.
Proof. unfold test_faucet_amount. vm_compute. reflexivity. Qed.

Lemma pool_call_requires_supported_assets exchanges tokens markets exchange a b call :
  pool_call exchanges tokens markets exchange a b = Some call -> pool_assets_supported tokens a b = true.
Proof.
  unfold pool_call, pool_error. destruct (negb (address_member exchange exchanges)); try discriminate.
  destruct (negb (pool_assets_supported tokens a b)) eqn:H; try discriminate.
  now apply negb_false_iff in H.
Qed.
Lemma pool_call_preserves_parameters exchanges tokens markets exchange a b call :
  pool_call exchanges tokens markets exchange a b = Some call -> call = CreatePool exchange a b.
Proof. unfold pool_call. destruct (pool_error exchanges tokens markets exchange a b); congruence. Qed.
Lemma deployment_call_preserves_parameters name symbol call :
  deployment_call name symbol = Some call -> call = DeployToken (trim name) (trim symbol).
Proof. unfold deployment_call. destruct (within_length 100 name && within_length 100 symbol); try discriminate.
  destruct (String.eqb (trim name) "" || String.eqb (trim symbol) ""); congruence. Qed.
