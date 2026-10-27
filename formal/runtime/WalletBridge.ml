open Js_of_ocaml

module Integer = Z
module K = WalletKernel
module W = K.Wallet
module T = K.Transactions
module Json = Yojson.Safe
module Field = Yojson.Safe.Util

module Protocol_v1 = struct

let object_ fields = `Assoc fields
let text value = `String value
let integer value = text (Integer.to_string value)
let optional encode = function None -> `Null | Some value -> encode value
let member_exn key value = Field.member key value
let string_exn key value = Field.to_string (member_exn key value)
let number_exn key value = Integer.of_string (string_exn key value)
let boolean_exn key value = Field.to_bool (member_exn key value)
let optional_number_exn key value = match member_exn key value with `Null -> None | v -> Some (Integer.of_string (Field.to_string v))
let optional_string_exn key value = match member_exn key value with `Null -> None | v -> Some (Field.to_string v)
let addresses_exn value = member_exn "accounts" value |> Field.to_list |> List.map Field.to_string
let source_json = function W.LocalWallet -> text "local" | W.BrowserWallet -> text "injected"
let source_exn = function "local" -> W.LocalWallet | "injected" -> W.BrowserWallet | _ -> invalid_arg "Invalid wallet source"
let preference_json value = object_ ["source", source_json value.W.preferred_source;
  "address", optional text value.W.preferred_address]
let identity_json value = object_ ["source", source_json value.W.identity_source;
  "address", text value.W.identity_address; "chain", integer value.W.identity_chain;
  "epoch", integer value.W.identity_epoch]
let identity_exn value : W.identity = {
  identity_source = source_exn (string_exn "source" value);
  identity_address = string_exn "address" value;
  identity_chain = number_exn "chain" value;
  identity_epoch = number_exn "epoch" value;
}
let optional_identity_exn = function `Null -> None | value -> Some (identity_exn value)

let funding_observation_exn = function
  | `Null -> None
  | value ->
      let tokens = member_exn "tokens" value |> Field.to_list |> List.map (fun token -> {
        W.funding_address = string_exn "address" token;
        funding_is_faucet = (match string_exn "kind" token with "faucet" -> true
          | "wrapped" | "external" -> false | _ -> invalid_arg "Invalid token capability");
        funding_balance = number_exn "balance" token;
      }) in
      Some { W.funding_identity = optional_identity_exn (member_exn "identity" value);
        native_balance = number_exn "ether" value; funding_tokens = tokens }

let funding_json = function
  | W.WalletRequired -> object_ ["kind", text "wallet-required"]
  | W.BalancesLoading -> object_ ["kind", text "loading"]
  | W.AssetsReady -> object_ ["kind", text "ready"]
  | W.FundingRequired (native, tokens) -> object_ ["kind", text "need-funding";
      "native", `Bool native; "tokens", `List (List.map text tokens)]

let reason_json = function
  | W.MissingProvider -> "missing-provider", "No browser wallet found. Install an EIP-1193 wallet or use a demo account."
  | W.NoAccounts -> "disconnected", "Wallet disconnected or locked. Connect browser wallet to continue."
  | W.SelectedAccountUnavailable -> "unavailable-account", "The selected demo account is not available on this node. Choose an available account."
  | W.WrongNetwork -> "wrong-network", "Wrong wallet network. Add / switch local network to continue."
  | W.Disconnected -> "disconnected", "Wallet disconnected. Reconnect to continue."
  | W.RequestFailed message -> "request-failed", message
  | W.NetworkRequestFailed message -> "wrong-network", message

let reason_exn value = match string_exn "reason" value with
  | "missing-provider" -> W.MissingProvider
  | "disconnected" -> W.Disconnected
  | "request-failed" -> W.RequestFailed (string_exn "message" value)
  | _ -> invalid_arg "Invalid wallet failure"

let wallet_json wallet =
  let common = ["source", source_json wallet.W.selected.W.preferred_source;
    "epoch", integer wallet.W.epoch; "expectedChain", integer wallet.W.expected_chain] in
  let status = match wallet.W.status with
    | W.Checking _ | W.Switching _ | W.Adding -> ["kind", text "connecting"]
    | W.Ready _ -> ["kind", text "ready"; "identity", optional identity_json (W.current_identity wallet)]
    | W.Unavailable why -> let code, message = reason_json why in
        ["kind", text "unavailable"; "reason", text code; "message", text message]
  in object_ (common @ status)

let effect_json = function
  | W.ObserveWallet (request, kind, authorize) -> object_ ["kind", text "observe";
      "request", integer request; "source", source_json kind; "requestAccess", `Bool authorize]
  | W.SwitchNetwork request -> object_ ["kind", text "switch-network"; "request", integer request]
  | W.AddNetwork request -> object_ ["kind", text "add-network"; "request", integer request]
  | W.PersistPreference preference -> object_ ["kind", text "persist"; "preference", preference_json preference]

let entry_json entry =
  let common = ["id", integer entry.T.entry_id; "label", text entry.T.entry_label;
    "account", text (T.sender_of entry); "beneficiary", text entry.T.entry_identity.W.identity_address;
    "authority", text (match entry.T.entry_authority with T.WalletAuthority -> "wallet" | T.FaucetAuthority _ -> "dev-faucet");
    "epoch", integer entry.T.entry_identity.W.identity_epoch] in
  let phase = match entry.T.entry_phase with
    | T.AwaitingPreflight | T.AwaitingSignature -> ["state", text "awaiting-wallet"]
    | T.Submitted (hash, error) -> ["state", text "submitted"; "hash", text hash; "message", optional text error]
    | T.Confirmed (hash, block, gas) -> ["state", text "confirmed"; "hash", text hash;
        "block", integer block; "gas", integer gas]
    | T.Reverted (hash, block, gas) -> ["state", text "failed"; "hash", text hash;
        "block", integer block; "gas", integer gas; "message", text "Transaction reverted on chain."]
    | T.Rejected message -> ["state", text "failed"; "message", text message]
    | T.SubmissionUnknown message -> ["state", text "submission-unknown"; "message", text message]
  in object_ (common @ phase)

let activity_json activity =
  let simple kind label = object_ ["kind", text kind; "label", text label] in
  match activity with
  | T.Idle -> object_ ["kind", text "idle"]
  | T.Preparing label -> simple "preparing" label
  | T.AwaitingWallet label -> simple "awaiting-wallet" label
  | T.RequestingFaucet label -> simple "requesting-faucet" label
  | T.Mining label -> simple "submitted" label
  | T.ReceiptUncertain (label, message) -> object_ ["kind", text "receipt-unavailable"; "label", text label; "message", text message]
  | T.LastConfirmed (label, block) -> object_ ["kind", text "confirmed"; "label", text label; "block", integer block]
  | T.LastCompleted label -> simple "completed" label
  | T.OperationError (label, message) -> object_ ["kind", text "interrupted"; "label", text label; "message", text message]

let decision_json encode = function
  | T.Accepted value -> object_ ["kind", text "accepted"; "value", encode value]
  | T.Denied message -> object_ ["kind", text "denied"; "message", text message]

let authority_exn value = match member_exn "authority" value with
  | `Null -> T.WalletAuthority
  | other -> match string_exn "kind" other with
      | "dev-faucet" -> T.FaucetAuthority (string_exn "sender" other)
      | _ -> invalid_arg "Invalid transaction authority"

end

open Protocol_v1

let create_exn configuration =
  let configuration = Json.from_string (Js.to_string configuration) in
  let saved = match member_exn "source" configuration with
    | `Null -> None
    | value -> Some { W.preferred_source = source_exn (Field.to_string value);
        preferred_address = optional_string_exn "address" configuration }
  in
  let initialized = W.restore_saved (number_exn "chain" configuration) saved in
  let wallet = ref initialized.W.next in
  let transactions = ref T.initial in
  let initial_effects = ref initialized.W.effects in
  let view () = object_ ["wallet", wallet_json !wallet;
    "journal", `List (List.map entry_json !transactions.T.journal);
    "pending", `Bool (T.pending !transactions);
    "error", optional text (T.current_error !transactions);
    "activity", activity_json (T.current_activity !transactions)] in
  let reply effects result = object_ ["view", view (); "effects", `List (List.map effect_json effects); "result", result]
    |> Json.to_string |> Js.string in
  let wallet_result transition = wallet := transition.W.next; reply transition.W.effects `Null in
  let transaction_result encode (next, decision) = transactions := next; reply [] (decision_json encode decision) in
  let dispatch encoded =
    let event = Json.from_string (Js.to_string encoded) in
    match string_exn "kind" event with
    | "select-local" -> wallet_result (W.select_local !wallet (string_exn "address" event))
    | "connect-browser" -> wallet_result (W.connect_browser !wallet)
    | "invalidate" -> wallet_result (W.invalidate !wallet)
    | "disconnect" -> wallet_result (W.disconnect !wallet)
    | "provider-changed" -> wallet_result (W.provider_changed !wallet (source_exn (string_exn "source" event)))
    | "provider-disconnected" -> wallet_result (W.provider_disconnected !wallet (source_exn (string_exn "source" event)))
    | "observed" -> wallet_result (W.observe !wallet (number_exn "request" event) (addresses_exn event) (number_exn "chain" event))
    | "observation-failed" -> wallet_result (W.observation_failed !wallet (number_exn "request" event) (reason_exn event))
    | "switch-network" -> wallet_result (W.switch_network !wallet)
    | "switched" -> wallet_result (W.switched !wallet (number_exn "request" event)
        (boolean_exn "success" event) (optional_number_exn "code" event) (string_exn "message" event))
    | "added" -> wallet_result (W.added !wallet (number_exn "request" event)
        (boolean_exn "success" event) (optional_number_exn "code" event) (string_exn "message" event))
    | "begin-operation" -> transaction_result integer (T.begin_operation !transactions !wallet
        (optional_identity_exn (member_exn "identity" event)) (string_exn "label" event))
    | "request-write" -> transaction_result integer (T.request_write !transactions !wallet
        (number_exn "operation" event) (string_exn "label" event) (authority_exn event))
    | "authorize" ->
        let result = T.authorize_and_reconcile !transactions !wallet
          (number_exn "operation" event) (number_exn "transaction" event) (addresses_exn event) (number_exn "chain" event) in
        transactions := result.T.authorization_transactions;
        wallet := result.T.authorization_wallet;
        reply result.T.authorization_effects (decision_json identity_json result.T.authorization_result)
    | "broadcast" -> transactions := T.broadcast !transactions (number_exn "transaction" event) (string_exn "hash" event); reply [] `Null
    | "preflight-failed" -> transactions := T.preflight_failed !transactions (number_exn "transaction" event) (string_exn "message" event); reply [] `Null
    | "signature-failed" -> transactions := T.signature_failed !transactions (number_exn "transaction" event) (optional_number_exn "code" event) (string_exn "message" event); reply [] `Null
    | "receipt" ->
        let success = match string_exn "status" event with "success" -> true | "reverted" -> false | _ -> invalid_arg "Invalid receipt status" in
        let id = number_exn "transaction" event in
        transaction_result (fun () -> `Null) (T.settle !transactions id (string_exn "hash" event) (string_exn "sender" event)
          success (number_exn "block" event) (number_exn "gasUsed" event) (number_exn "gasPrice" event))
    | "receipt-unavailable" -> transactions := T.observation_failed !transactions
        (number_exn "transaction" event) (string_exn "message" event); reply [] `Null
    | "finish-operation" -> transactions := T.finish_operation !transactions
        (number_exn "operation" event) (optional_string_exn "error" event); reply [] `Null
    | _ -> invalid_arg "Unknown wallet kernel event"
  in
  Js.Unsafe.obj [|
    "view", Js.Unsafe.inject (Js.wrap_callback (fun () -> Json.to_string (view ()) |> Js.string));
    "start", Js.Unsafe.inject (Js.wrap_callback (fun () -> let effects = !initial_effects in initial_effects := []; reply effects `Null));
    "dispatch", Js.Unsafe.inject (Js.wrap_callback dispatch);
    "retainsSnapshot", Js.Unsafe.inject (Js.wrap_callback (fun encoded ->
      Json.from_string (Js.to_string encoded) |> optional_identity_exn |> W.retains_snapshot !wallet |> Js.bool));
    "fundingPlan", Js.Unsafe.inject (Js.wrap_callback (fun encoded ->
      Json.from_string (Js.to_string encoded) |> funding_observation_exn |> W.funding_plan !wallet
      |> funding_json |> Json.to_string |> Js.string))
  |]

let native_funding_exn encoded =
  let input = Json.from_string (Js.to_string encoded) in
  let result = W.native_funding_plan (number_exn "chain" input) (string_exn "beneficiary" input) (addresses_exn input) in
  (match result with
  | W.NativeFunding (sender, amount) -> object_ ["kind", text "accepted"; "value", object_ ["sender", text sender; "amountWei", integer amount]]
  | W.NativeFundingError message -> object_ ["kind", text "denied"; "message", text message])
  |> Json.to_string |> Js.string

let () =
  let exports = Js.Unsafe.obj [|
    "create", Js.Unsafe.inject (Js.wrap_callback create_exn);
    "planNativeFunding", Js.Unsafe.inject (Js.wrap_callback native_funding_exn)
  |] in
  Js.Unsafe.set Js.Unsafe.global "DEXWallet" exports
