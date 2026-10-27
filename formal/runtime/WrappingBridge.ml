open Js_of_ocaml
module Kernel = WrappingKernel
module Json = Yojson.Basic.Util

let integer json = Z.of_string (Json.to_string json)
let integer_json value = `String (Z.to_string value)
let optional codec = function `Null -> None | value -> Some (codec value)
let optional_json codec = function None -> `Null | Some value -> codec value
let text_json value = `String value
let encode json = Js.string (Yojson.Basic.to_string json)
let decode text = Yojson.Basic.from_string (Js.to_string text)

let environment json : Kernel.wrapping_environment =
  { environment_connected = Json.to_bool (Json.member "connected" json);
    environment_pending = Json.to_bool (Json.member "pending" json);
    environment_token = optional Json.to_string (Json.member "token" json);
    environment_native = optional integer (Json.member "native" json);
    environment_wrapped = optional integer (Json.member "wrapped" json) }

let request_json (request : Kernel.wrapping_request) =
  `Assoc [ "token", `String request.wrapping_token;
           "withdraw", `Bool request.wrapping_withdraw;
           "amount", integer_json request.wrapping_amount;
           "gas", integer_json request.wrapping_gas;
           "feePerGas", integer_json request.wrapping_fee_per_gas ]

let decision_json = function
  | Kernel.WrappingRejected reason -> `Assoc [ "kind", `String "rejected"; "error", `String reason ]
  | Kernel.WrappingPrepared request -> `Assoc [ "kind", `String "prepared"; "request", request_json request ]

let view_json state =
  `Assoc [ "value", `String state.Kernel.wrapping_draft;
           "inputError", optional_json text_json (Kernel.wrapping_input_error state);
           "wrap", decision_json (Kernel.prepare_wrapping_draft state false);
           "unwrap", decision_json (Kernel.prepare_wrapping_draft state true) ]

let create_controller () =
  let state = ref Kernel.initial_wrapping in
  let dispatch event =
    let next, effect = Kernel.step_wrapping !state event in
    state := next;
    effect
  in
  Js.Unsafe.obj
    [| "view", Js.Unsafe.inject (Js.wrap_callback (fun json ->
         let observed, _ = Kernel.step_wrapping !state (Kernel.ObserveWrapping (environment (decode json))) in
         encode (view_json observed)));
       "edit", Js.Unsafe.inject (Js.wrap_callback (fun text json ->
         ignore (dispatch (Kernel.ObserveWrapping (environment (decode json))));
         ignore (dispatch (Kernel.EditWrapping (Js.to_string text)));
         encode (view_json !state)));
       "submit", Js.Unsafe.inject (Js.wrap_callback (fun withdraw json ->
         ignore (dispatch (Kernel.ObserveWrapping (environment (decode json))));
         encode (optional_json request_json (dispatch (Kernel.SubmitWrapping (Js.to_bool withdraw)))))) |]

let () =
  Js.Unsafe.set Js.Unsafe.global "DEXWrapping"
    (Js.Unsafe.obj
      [| "create", Js.Unsafe.inject (Js.wrap_callback create_controller);
         "plan", Js.Unsafe.inject (Js.wrap_callback (fun json value gas fee withdraw ->
           encode (decision_json (Kernel.prepare_wrapping (environment (decode json))
             (Z.of_string (Js.to_string value)) (Z.of_string (Js.to_string gas))
             (Z.of_string (Js.to_string fee)) (Js.to_bool withdraw)))));
         "selectWrapped", Js.Unsafe.inject (Js.wrap_callback (fun json ->
           let tokens = Json.to_list (decode json) |> List.map (fun token ->
             Json.to_string (Json.member "address" token), Json.to_string (Json.member "kind" token)) in
           match Kernel.select_wrapped tokens with
           | None -> Js.null
           | Some token -> Js.some (Js.string token)));
         "requiredWrapped", Js.Unsafe.inject (Js.wrap_callback (fun json ->
           let tokens = Json.to_list (decode json) |> List.map (fun token ->
             Json.to_string (Json.member "address" token), Json.to_string (Json.member "kind" token)) in
           encode (match Kernel.required_wrapped_address tokens with
           | Kernel.WrappingTokenFound token -> `Assoc [ "kind", `String "found"; "token", `String token ]
           | Kernel.WrappingTokenMissing reason -> `Assoc [ "kind", `String "missing"; "error", `String reason ]))) |])
