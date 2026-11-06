open Js_of_ocaml
module Kernel = ArbitrageReceiptKernel
module Field = Yojson.Basic.Util

let string key value = Field.member key value |> Field.to_string
let index value = Field.member "index" value |> Field.to_int

let select input =
  let value = Js.to_string input |> Yojson.Basic.from_string in
  let exchanges = Field.member "exchanges" value |> Field.to_list |> List.map Field.to_string in
  let executions = Field.member "executions" value |> Field.to_list |> List.map (fun event ->
    { Kernel.execution_index = index event;
      execution_source = string "source" event;
      execution_buy = string "buy" event;
      execution_sell = string "sell" event }) in
  let snapshots = Field.member "snapshots" value |> Field.to_list |> List.map (fun event ->
    { Kernel.reserves_index = index event;
      reserves_source = string "source" event;
      reserves_exchange = string "exchange" event }) in
  let successful = Field.member "successful" value |> Field.to_bool in
  let result = match Kernel.select_receipt successful (string "contract" value) exchanges executions snapshots with
    | Kernel.NoArbitrageEvent -> `Assoc ["kind", `String "none"]
    | Kernel.UnsupportedReceipt -> `Assoc ["kind", `String "unsupported"]
    | Kernel.RevertedReceipt -> `Assoc ["kind", `String "reverted"]
    | Kernel.Selected (execution, buy, sell) ->
        `Assoc ["kind", `String "selected";
          "execution", `Int execution.execution_index;
          "buy", `Int buy.reserves_index; "sell", `Int sell.reserves_index]
  in
  Yojson.Basic.to_string result |> Js.string

let intermediate input =
  let value = Js.to_string input |> Yojson.Basic.from_string in
  Kernel.intermediate_token (string "token0" value) (string "token1" value)
    (string "capital" value) |> Js.string

let () =
  Js.Unsafe.set Js.Unsafe.global "DEXArbitrageReceipt"
    (Js.Unsafe.obj [|"select", Js.Unsafe.inject (Js.wrap_callback select);
      "intermediate", Js.Unsafe.inject (Js.wrap_callback intermediate)|])
