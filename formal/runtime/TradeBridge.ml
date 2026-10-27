open Js_of_ocaml
open Yojson.Safe.Util

let integer json key = json |> member key |> to_string |> Z.of_string
let text json key = json |> member key |> to_string
let flag json key = json |> member key |> to_bool
let optional_integer = function None -> `Null | Some value -> `String (Z.to_string value)
let optional_text = function None -> `Null | Some value -> `String value
let read_optional_integer = function `Null -> None | value -> Some (Z.of_string (to_string value))
let json_string value = Js.string (Yojson.Safe.to_string value)

let preview_fields input_places output_places direction balance amount connected pending view = [
  "amount", optional_integer view.AMM.preview_amount;
  "output", optional_integer view.AMM.preview_output;
  "minimum", optional_integer view.AMM.preview_minimum;
  "slippage", optional_integer view.AMM.preview_slippage;
  "outputToken", `String direction.AMM.receive_token;
  "fee", optional_integer (AMM.preview_fee view);
  "feePercent", `String AMM.pool_fee_percent;
  "deadlineText", `String AMM.swap_deadline_text;
  "impactText", optional_text (AMM.preview_impact_text direction.AMM.input_reserve direction.AMM.output_reserve view);
  "highImpact", `Bool (AMM.preview_high_impact direction.AMM.input_reserve direction.AMM.output_reserve view);
  "rateText", optional_text (AMM.preview_rate_text input_places output_places view);
  "hasAmount", `Bool (AMM.preview_has_amount amount);
  "funded", `Bool (AMM.preview_pool_funded direction.AMM.input_reserve direction.AMM.output_reserve);
  "canSubmit", `Bool (AMM.swap_can_submit connected pending view);
  "disabled", `Bool (AMM.swap_disabled connected pending view);
  "actionLabel", `String (AMM.swap_action connected pending view);
  "message", optional_text (AMM.swap_error view);
  "canMax", `Bool (AMM.swap_can_max balance pending);
  "showMax", `Bool (AMM.swap_can_max balance false);
  "maxText", optional_text (AMM.swap_max_text input_places balance);
  "reverseText", `String (AMM.swap_reverse_text output_places view amount)
]

let parameters request =
  let json = Yojson.Safe.from_string (Js.to_string request) in
  let result = match AMM.make_swap_parameters (integer json "input") (integer json "quoted")
    (integer json "slippage") (integer json "now") with
  | None -> `Null
  | Some value -> `Assoc [
      "input", `String (Z.to_string value.AMM.parameter_input);
      "minimum", `String (Z.to_string value.AMM.parameter_minimum);
      "deadline", `String (Z.to_string value.AMM.parameter_deadline)
    ] in
  json_string result

let environment json = {
  AMM.environment_assets = json |> member "assets" |> to_list |> List.map to_string;
  AMM.environment_token0 = text json "token0";
  AMM.environment_token1 = text json "token1";
  AMM.environment_reserve0 = integer json "reserve0";
  AMM.environment_reserve1 = integer json "reserve1";
  AMM.environment_balance0 = read_optional_integer (member "balance0" json);
  AMM.environment_decimals0 = integer json "decimals0";
  AMM.environment_decimals1 = integer json "decimals1";
  AMM.environment_balance1 = read_optional_integer (member "balance1" json);
  AMM.environment_connected = flag json "connected";
  AMM.environment_pending = flag json "pending"
}

let event json = match text json "kind" with
  | "amount" -> AMM.EditAmount (text json "value")
  | "slippage" -> AMM.EditSlippage (text json "value")
  | "pay" -> AMM.SelectPay (text json "value")
  | "receive" -> AMM.SelectReceive (text json "value")
  | "reverse" -> AMM.ReverseSwap
  | "max" -> AMM.FillMax
  | "submit" -> AMM.SubmitDraft
  (* DEFENSE: The public JS method can be called without the typed event adapter. *)
  | _ -> invalid_arg "Unknown swap event"

let effect_json = function
  | AMM.NoSwapEffect -> `Null
  | AMM.OpenWalletEffect -> `Assoc ["kind", `String "wallet"]
  | AMM.RequestSwapEffect (token, input, quoted, slippage) -> `Assoc [
      "kind", `String "swap"; "inputToken", `String token;
      "input", `String (Z.to_string input); "quoted", `String (Z.to_string quoted);
      "slippage", `String (Z.to_string slippage)
    ]

let render environment draft effect =
  let view = AMM.draft_preview environment draft in
  let direction = AMM.draft_orientation environment draft in
  json_string (`Assoc ((preview_fields (AMM.draft_precision environment draft) (AMM.draft_output_precision environment draft) direction (AMM.draft_balance environment draft)
    draft.AMM.draft_amount environment.AMM.environment_connected environment.AMM.environment_pending view) @ [
      "amountText", `String draft.AMM.draft_amount;
      "slippageText", `String draft.AMM.draft_slippage;
      "inputToken", `String draft.AMM.draft_token;
      "balance", optional_integer (AMM.draft_balance environment draft);
      "outputBalance", optional_integer (AMM.draft_output_balance environment draft);
      "effect", effect_json effect
    ]))

let create token0 =
  let state = ref (AMM.initial_draft (Js.to_string token0)) in
  Js.Unsafe.obj [|
    "view", Js.Unsafe.inject (Js.wrap_callback (fun context ->
      let environment = environment (Yojson.Safe.from_string (Js.to_string context)) in
      render environment !state AMM.NoSwapEffect));
    "dispatch", Js.Unsafe.inject (Js.wrap_callback (fun input context ->
      let environment = environment (Yojson.Safe.from_string (Js.to_string context)) in
      let event = event (Yojson.Safe.from_string (Js.to_string input)) in
      let effect = AMM.draft_effect environment !state event in
      state := AMM.step_draft environment !state event;
      render environment !state effect))
  |]

let route_pool json =
  let exchange = member "exchange" json in
  {
    Routing.exchange = text exchange "address";
    Routing.exchange_name = text exchange "name";
    Routing.pool_id = integer json "id";
    Routing.token0 = text json "token0";
    Routing.token1 = text json "token1";
    Routing.reserve0 = integer json "reserve0";
    Routing.reserve1 = integer json "reserve1";
    Routing.total_shares = integer json "totalShares";
    Routing.created_at = integer json "createdAt"
  }

let route_pool_json pool = `Assoc [
  "exchange", `Assoc ["address", `String pool.Routing.exchange;
    "name", `String pool.Routing.exchange_name];
  "id", `String (Z.to_string pool.Routing.pool_id);
  "token0", `String pool.Routing.token0;
  "token1", `String pool.Routing.token1;
  "reserve0", `String (Z.to_string pool.Routing.reserve0);
  "reserve1", `String (Z.to_string pool.Routing.reserve1);
  "totalShares", `String (Z.to_string pool.Routing.total_shares);
  "createdAt", `String (Z.to_string pool.Routing.created_at)
]

let routing_environment json = {
  Routing.base = environment json;
  Routing.pools = json |> member "pools" |> to_list |> List.map route_pool;
  Routing.exchanges = json |> member "exchanges" |> to_list |> List.map to_string;
  Routing.metadata = json |> member "metadata" |> to_list |> List.map (fun item ->
    text item "address", integer item "decimals");
  Routing.block = integer json "block"
}

let routing_event json =
  if text json "kind" = "route" then
    Routing.ChooseRoute (if text json "value" = "auto" then Routing.BestQuote
      else Routing.ManualPool (text json "value"))
  else Routing.DraftEvent (event json)

let routed_effect_json = function
  | Routing.NoEffect -> `Null
  | Routing.OpenWallet -> `Assoc ["kind", `String "wallet"]
  | Routing.Execute plan -> `Assoc [
      "kind", `String "swap";
      "pool", route_pool_json plan.Routing.prepared_pool;
      "inputToken", `String plan.Routing.prepared_token;
      "input", `String (Z.to_string plan.Routing.prepared_input);
      "quoted", `String (Z.to_string plan.Routing.prepared_output);
      "slippage", `String (Z.to_string plan.Routing.prepared_slippage);
      "minimum", `String (Z.to_string plan.Routing.prepared_minimum);
      "block", `String (Z.to_string plan.Routing.prepared_block)
    ]

let replace_fields replacements fields =
  List.filter (fun (key, _) -> not (List.mem_assoc key replacements)) fields @ replacements

let render_routing context state effect =
  let current = Routing.selected_environment context state in
  let draft = state.Routing.draft in
  let preview = Routing.current_preview context state in
  let fields = preview_fields (AMM.draft_precision current draft)
    (AMM.draft_output_precision current draft) (AMM.draft_orientation current draft)
    (AMM.draft_balance current draft) draft.AMM.draft_amount
    current.AMM.environment_connected current.AMM.environment_pending preview in
  let mode = match state.Routing.choice with Routing.BestQuote -> "auto" | Routing.ManualPool _ -> "manual" in
  let route = match Routing.selected_pool context state with
    | None -> `Null | Some pool -> route_pool_json pool in
  let routes = Routing.route_catalog context |> List.map (fun pool -> `Assoc [
    "key", `String (Routing.pool_key pool); "pool", route_pool_json pool;
    "quoted", optional_integer (Routing.route_quote context draft pool)
  ]) in
  let pairs = Routing.pairs context |> List.map (fun pool -> `Assoc [
    "key", `String (Routing.pool_key pool); "token0", `String pool.Routing.token0;
    "token1", `String pool.Routing.token1
  ]) in
  json_string (`Assoc (replace_fields [
    "canSubmit", `Bool (Routing.can_submit context state);
    "disabled", `Bool (Routing.disabled context state);
    "actionLabel", `String (Routing.action context state);
    "message", optional_text (Routing.message context state);
    "amountText", `String draft.AMM.draft_amount;
    "slippageText", `String draft.AMM.draft_slippage;
    "inputToken", `String draft.AMM.draft_token;
    "balance", optional_integer (AMM.draft_balance current draft);
    "outputBalance", optional_integer (AMM.draft_output_balance current draft);
    "mode", `String mode; "manualKey", optional_text (Routing.manual_key state);
    "manualUnavailable", `Bool (Routing.manual_unavailable context state);
    "route", route; "routes", `List routes; "pairs", `List pairs;
    "pairKey", optional_text (Routing.pair_key context);
    "block", `String (Z.to_string (Routing.view_block context state));
    "effect", routed_effect_json effect
  ] fields))

let create_routed token0 =
  let state = ref (Routing.initial (Js.to_string token0)) in
  Js.Unsafe.obj [|
    "view", Js.Unsafe.inject (Js.wrap_callback (fun context ->
      let context = routing_environment (Yojson.Safe.from_string (Js.to_string context)) in
      state := Routing.reconcile context !state;
      render_routing context !state Routing.NoEffect));
    "dispatch", Js.Unsafe.inject (Js.wrap_callback (fun input context ->
      let context = routing_environment (Yojson.Safe.from_string (Js.to_string context)) in
      let input = routing_event (Yojson.Safe.from_string (Js.to_string input)) in
      state := Routing.reconcile context !state;
      let effect = Routing.next_effect context !state input in
      state := Routing.step context !state input;
      render_routing context !state effect))
  |]

let () =
  Js.Unsafe.set Js.Unsafe.global "DEXTrade" (Js.Unsafe.obj [|
    "makeParameters", Js.Unsafe.inject (Js.wrap_callback parameters);
    "create", Js.Unsafe.inject (Js.wrap_callback create);
    "createRouted", Js.Unsafe.inject (Js.wrap_callback create_routed);
    "parameterError", Js.Unsafe.inject (Js.string AMM.swap_parameters_error)
  |])
