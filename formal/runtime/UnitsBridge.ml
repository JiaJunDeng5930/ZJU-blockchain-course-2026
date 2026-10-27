open Js_of_ocaml

let integer text = Z.of_string (Js.to_string text)
let string value = Js.string (Z.to_string value)
let optional_integer = function None -> Js.null | Some value -> Js.some (string value)
let optional_text = function None -> Js.null | Some value -> Js.some (Js.string value)

let () =
  Js.Unsafe.set Js.Unsafe.global "DEXUnits"
    (Js.Unsafe.obj
       [| ("parseUnits18", Js.Unsafe.inject (Js.wrap_callback (fun text ->
              optional_integer (Units.parse_units_18 (Js.to_string text)))));
          ("approvalNeeded", Js.Unsafe.inject (Js.wrap_callback (fun allowance amount ->
              Js.bool (Types.approval_needed (integer allowance) (integer amount)))));
          ("positiveUnits18", Js.Unsafe.inject (Js.wrap_callback (fun text ->
              optional_integer (Units.positive_units_18 (Js.to_string text)))));
          ("parseSlippageBps", Js.Unsafe.inject (Js.wrap_callback (fun text ->
              optional_integer (Units.parse_slippage_bps (Js.to_string text)))));
          ("formatUnits18", Js.Unsafe.inject (Js.wrap_callback (fun value ->
              Js.string (Units.format_units_18 (integer value)))));
          ("minimumReceived", Js.Unsafe.inject (Js.wrap_callback (fun value slippage ->
              string (AMM.minimum_received (integer value) (integer slippage)))));
          ("amountError", Js.Unsafe.inject (Js.wrap_callback (fun text balance ->
              optional_text (Units.amount_error (Js.to_string text)
                (Option.map integer (Js.Opt.to_option balance))))));
          ("slippageError", Js.Unsafe.inject (Js.wrap_callback (fun text ->
              optional_text (Units.slippage_error (Js.to_string text))))) |])
