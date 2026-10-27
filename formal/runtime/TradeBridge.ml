open Js_of_ocaml
open Yojson.Safe.Util

let integer json key = json |> member key |> to_string |> Z.of_string
let text json key = json |> member key |> to_string
let flag json key = json |> member key |> to_bool
let optional_integer = function None -> `Null | Some value -> `String (Z.to_string value)
let optional_text = function None -> `Null | Some value -> `String value
let read_optional_integer = function `Null -> None | value -> Some (Z.of_string (to_string value))
let json_string value = Js.string (Yojson.Safe.to_string value)

let preview_fields direction balance amount connected pending view = [
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
  "rateText", optional_text (AMM.preview_rate_text view);
  "hasAmount", `Bool (AMM.preview_has_amount amount);
  "funded", `Bool (AMM.preview_pool_funded direction.AMM.input_reserve direction.AMM.output_reserve);
  "canSubmit", `Bool (AMM.swap_can_submit connected pending view);
  "disabled", `Bool (AMM.swap_disabled connected pending view);
  "actionLabel", `String (AMM.swap_action connected pending view);
  "message", optional_text (AMM.swap_error view);
  "canMax", `Bool (AMM.swap_can_max balance pending);
  "showMax", `Bool (AMM.swap_can_max balance false);
  "maxText", optional_text (AMM.swap_max_text balance);
  "reverseText", `String (AMM.swap_reverse_text view amount)
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
  json_string (`Assoc ((preview_fields direction (AMM.draft_balance environment draft)
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

let () =
  Js.Unsafe.set Js.Unsafe.global "DEXTrade" (Js.Unsafe.obj [|
    "makeParameters", Js.Unsafe.inject (Js.wrap_callback parameters);
    "create", Js.Unsafe.inject (Js.wrap_callback create);
    "parameterError", Js.Unsafe.inject (Js.string AMM.swap_parameters_error)
  |])
