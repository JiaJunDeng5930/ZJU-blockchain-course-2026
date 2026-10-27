open Js_of_ocaml
module Integer = Z
module K = AssetsKernel
module J = Yojson.Safe
module F = Yojson.Safe.Util

module Protocol_v1 = struct
let text value = `String value
let number value = text (Integer.to_string value)
let object_ value = `Assoc value
let optional encode = function None -> `Null | Some value -> encode value
let member key value = F.member key value
let string key value = F.to_string (member key value)
let integer key value = Integer.of_string (string key value)
let strings key value = F.to_list (member key value) |> List.map F.to_string
let parse value = J.from_string (Js.to_string value)
let emit value = Js.string (J.to_string value)
let capability = function K.Faucet -> "faucet" | K.Wrapped -> "wrapped" | K.External -> "external"
let capability_of_string_exn = function "faucet" -> K.Faucet | "wrapped" -> K.Wrapped | "external" -> K.External
  | _ -> invalid_arg "asset capability protocol"
let asset ~stored value =
  { K.asset_address = string "address" value; asset_name = string "name" value;
    asset_symbol = string "symbol" value;
    asset_decimals = (match member "decimals" value with `Int n -> Some (Integer.of_int n) | `Null -> None | _ -> invalid_arg "asset decimals protocol");
    asset_capability = if stored then K.External else capability_of_string_exn (string "kind" value) }
let asset_json token = object_ ["address", text token.K.asset_address; "name", text token.K.asset_name;
  "symbol", text token.K.asset_symbol; "decimals", optional (fun n -> `Int (Integer.to_int n)) token.K.asset_decimals; "kind", text (capability token.K.asset_capability)]
let assets ~stored value = F.to_list value |> List.map (asset ~stored)
let markets value = F.to_list value |> List.map (fun market ->
  { K.market_exchange = string "exchange" market; market_first = string "token0" market; market_second = string "token1" market })
let catalog value =
  { K.catalog_tokens = assets ~stored:false (member "tokens" value);
    catalog_verified = strings "verified" value;
    catalog_error = (match member "error" value with `Null -> None | x -> Some (F.to_string x)) }
let catalog_json value = object_ ["tokens", `List (List.map asset_json value.K.catalog_tokens);
  "verified", `List (List.map text value.K.catalog_verified); "error", optional text value.K.catalog_error]
let environment value =
  { K.available_exchanges = strings "exchanges" value; available_tokens = strings "tokens" value;
    available_markets = markets (member "markets" value); wallet_connected = F.to_bool (member "connected" value);
    wallet_pending = F.to_bool (member "pending" value) }
let draft value = { K.draft_name = string "name" value; draft_symbol = string "symbol" value;
  draft_address = string "address" value; draft_exchange = string "exchange" value;
  draft_first = string "first" value; draft_second = string "second" value }
let draft_json value = object_ ["name", text value.K.draft_name; "symbol", text value.K.draft_symbol;
  "address", text value.K.draft_address; "exchange", text value.K.draft_exchange;
  "first", text value.K.draft_first; "second", text value.K.draft_second]
let request value = { K.import_id = integer "id" value; import_address = string "address" value }
let request_json value = object_ ["id", number value.K.import_id; "address", text value.K.import_address]
let state value = { K.state_draft = draft (member "draft" value);
  state_request = (match member "request" value with `Null -> None | x -> Some (request x));
  state_next = integer "next" value;
  state_error = (match member "error" value with `Null -> None | x -> Some (F.to_string x)) }
let state_json value = object_ ["draft", draft_json value.K.state_draft;
  "request", optional request_json value.K.state_request; "next", number value.K.state_next;
  "error", optional text value.K.state_error]
let field_exn = function "name" -> K.Name | "symbol" -> K.Symbol | "address" -> K.Address
  | "exchange" -> K.Exchange | "first" -> K.First | "second" -> K.Second
  | _ -> invalid_arg "asset form field protocol"
let event value = match string "kind" value with
  | "edit" -> K.Edit (field_exn (string "field" value), string "value" value)
  | "import" -> K.BeginImport | "deploy" -> K.SubmitDeployment | "pool" -> K.SubmitPool
  | "imported" -> K.ImportSucceeded (integer "id" value, asset ~stored:false (member "token" value))
  | "failed" -> K.ImportFailed (integer "id" value, string "message" value)
  | _ -> invalid_arg "asset form event protocol"
let call_json = function
  | K.DeployToken (name, symbol) -> object_ ["kind", text "deploy"; "name", text name; "symbol", text symbol]
  | K.CreatePool (exchange, first, second) -> object_ ["kind", text "pool"; "exchange", text exchange;
      "first", text first; "second", text second]
  | K.ClaimToken token -> object_ ["kind", text "faucet"; "address", text token]
  | _ -> invalid_arg "unexpected asset call protocol"
let effect_json = function K.NoEffect -> `Null
  | K.ReadMetadata request -> object_ ["kind", text "read"; "request", request_json request]
  | K.RegisterToken token -> object_ ["kind", text "register"; "token", asset_json token]
  | K.WriteCall call -> call_json call
let plan_json error call = object_ ["error", optional text error; "call", optional call_json call]
end
open Protocol_v1

let initial_catalog deployed saved =
  let deployed = assets ~stored:false (parse deployed) in
  let saved, error =
    (* DEFENSE: localStorage is user-editable and may contain invalid JSON or an older schema. *)
    try assets ~stored:true (parse saved), None with
    | Yojson.Json_error _ | F.Type_error _ -> [], Some "Saved token metadata could not be read. Import the token addresses again."
  in K.initial_catalog deployed saved error |> catalog_json |> emit
let register_catalog current additions =
  K.register_assets (catalog (parse current)) (assets ~stored:false (parse additions)) |> catalog_json |> emit
let catalog_view current pools =
  let current = catalog (parse current) in
  object_ ["tokens", `List (List.map asset_json (K.active_assets current));
    "storedTokens", `List (List.map asset_json current.K.catalog_tokens);
    "discovery", `List (List.map text (K.discovery_targets current (markets (parse pools))));
    "error", optional text current.K.catalog_error] |> emit
let storage_error current message =
  K.catalog_storage_error (catalog (parse current)) (Js.to_string message) |> catalog_json |> emit
let initial_forms json =
  let env = environment (parse json) in K.initial env.K.available_exchanges env.K.available_tokens |> state_json |> emit
let step_forms current env input =
  let next, effect = K.step (state (parse current)) (environment (parse env)) (event (parse input)) in
  object_ ["state", text (J.to_string (state_json next)); "effect", effect_json effect] |> emit
let forms_view current env =
  let current = state (parse current) and env = environment (parse env) in
  object_ ["draft", draft_json current.K.state_draft; "canImport", `Bool (K.can_import current);
    "canDeploy", `Bool (K.can_deploy current env); "canCreatePool", `Bool (K.can_create_pool current env);
    "importing", `Bool (K.import_pending current); "importError", optional text (K.import_error current);
    "deploymentError", optional text (K.deployment_error current);
    "poolError", optional text (K.create_pool_error current env)] |> emit
let canonical raw = match K.canonical_address (Js.to_string raw) with
  | Some address -> object_ ["address", text address; "error", `Null] |> emit
  | None -> object_ ["address", `Null; "error", text K.address_error] |> emit
let metadata json =
  let value = parse json in
  let token = K.supported_asset (string "address" value) (string "name" value) (string "symbol" value)
    (integer "decimals" value) (string "code" value) (string "expectedCode" value) in
  object_ ["token", optional asset_json token; "error", (match token with Some _ -> `Null | None -> text K.metadata_error)] |> emit
let deployment name symbol =
  let call = K.deployment_call (Js.to_string name) (Js.to_string symbol) in
  let error = match call with Some _ -> None | None -> Some K.deployment_name_error in
  plan_json error call |> emit
let pool json =
  let value = parse json in let env = environment value in
  let exchange = string "exchange" value and first = string "first" value and second = string "second" value in
  plan_json (K.pool_error env.K.available_exchanges env.K.available_tokens env.K.available_markets exchange first second)
    (K.pool_call env.K.available_exchanges env.K.available_tokens env.K.available_markets exchange first second) |> emit
let faucet token = let token = asset ~stored:false (parse token) in
  let call = K.faucet_call token in
  plan_json (match call with Some _ -> None | None -> Some K.faucet_error) call |> emit
let deployed name symbol token =
  let matches = K.deployed_asset_matches (Js.to_string name) (Js.to_string symbol) (asset ~stored:false (parse token)) in
  optional text (if matches then None else Some K.deployment_verification_error) |> emit
let receipt raw =
  let address = match parse raw with `Null -> None | value -> K.canonical_address (F.to_string value) in
  object_ ["address", optional text address; "error", optional text (match address with Some _ -> None | None -> Some K.deployment_receipt_error)] |> emit
let pool_selection json =
  let value = parse json in
  let requested = match member "requested" value with
    | `Null -> None
    | raw -> Some (F.to_string raw)
  in
  let result = match K.select_pool requested (strings "available" value) with
    | K.SelectedPool key -> object_ ["kind", text "selected"; "key", text key]
    | K.MissingPool key -> object_ ["kind", text "missing"; "requested", text key]
    | K.NoPools -> object_ ["kind", text "empty"]
  in
  emit result
let pool_price first second decimals0 decimals1 symbol0 symbol1 = Js.string (K.pool_price_text (Integer.of_string (Js.to_string first)) (Integer.of_string (Js.to_string second)) (Integer.of_string (Js.to_string decimals0)) (Integer.of_string (Js.to_string decimals1)) (Js.to_string symbol0) (Js.to_string symbol1))
let pool_supported json =
  let value = parse json in
  Js.bool (K.pool_assets_supported (strings "tokens" value) (string "first" value) (string "second" value))
let runtime_matches actual expected = Js.bool (K.runtime_code_matches (Js.to_string actual) (Js.to_string expected))
let () = Js.Unsafe.set Js.Unsafe.global "DEXAssets" (Js.Unsafe.obj [|
  "poolSelection", Js.Unsafe.inject (Js.wrap_callback pool_selection);
  "poolAssetsSupported", Js.Unsafe.inject (Js.wrap_callback pool_supported);
  "runtimeCodeMatches", Js.Unsafe.inject (Js.wrap_callback runtime_matches);
  "unsupportedPoolError", Js.Unsafe.inject (Js.string K.unsupported_pool_error);
  "poolPrice", Js.Unsafe.inject (Js.wrap_callback pool_price);
  "initialCatalog", Js.Unsafe.inject (Js.wrap_callback initial_catalog);
  "registerCatalog", Js.Unsafe.inject (Js.wrap_callback register_catalog);
  "catalogView", Js.Unsafe.inject (Js.wrap_callback catalog_view);
  "storageError", Js.Unsafe.inject (Js.wrap_callback storage_error);
  "initialForms", Js.Unsafe.inject (Js.wrap_callback initial_forms);
  "stepForms", Js.Unsafe.inject (Js.wrap_callback step_forms);
  "formsView", Js.Unsafe.inject (Js.wrap_callback forms_view);
  "canonicalAddress", Js.Unsafe.inject (Js.wrap_callback canonical);
  "metadata", Js.Unsafe.inject (Js.wrap_callback metadata);
  "deployment", Js.Unsafe.inject (Js.wrap_callback deployment);
  "pool", Js.Unsafe.inject (Js.wrap_callback pool);
  "faucet", Js.Unsafe.inject (Js.wrap_callback faucet);
  "deployed", Js.Unsafe.inject (Js.wrap_callback deployed);
  "receipt", Js.Unsafe.inject (Js.wrap_callback receipt)
|])
