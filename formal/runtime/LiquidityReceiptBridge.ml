open Js_of_ocaml
module Kernel = LiquidityReceiptKernel
module Field = Yojson.Basic.Util

let select input =
  let value = Js.to_string input |> Yojson.Basic.from_string in
  let string key record = Field.member key record |> Field.to_string in
  let known = Field.member "exchanges" value |> Field.to_list |> List.map Field.to_string in
  let events = Field.member "events" value |> Field.to_list |> List.map (fun event ->
    let event_kind = match string "kind" event with
      | "deposit" -> Kernel.DepositEvent
      | "redeem" -> Kernel.RedeemEvent
      | "transfer" -> Kernel.TransferEvent
      | other -> invalid_arg ("Unknown liquidity ABI event kind: " ^ other)
    in
    { Kernel.event_index = Field.member "index" event |> Field.to_int;
      event_exchange = string "exchange" event;
      event_kind;
      event_from = string "from" event;
      event_to = string "to" event }) in
  let successful = Field.member "successful" value |> Field.to_bool in
  let result = match Kernel.select_receipt successful known events with
    | Kernel.NoLiquidityEvent -> `Assoc ["kind", `String "none"]
    | Kernel.Selected event -> `Assoc ["kind", `String "selected"; "index", `Int event.event_index]
    | Kernel.MultipleLiquidityEvents -> `Assoc ["kind", `String "multiple"]
    | Kernel.RevertedReceipt -> `Assoc ["kind", `String "reverted"]
  in
  Yojson.Basic.to_string result |> Js.string

let available input =
  let value = Js.to_string input |> Yojson.Basic.from_string in
  let string key = Field.member key value |> Field.to_string in
  let known = Field.member "exchanges" value |> Field.to_list |> List.map Field.to_string in
  let descriptor_known = Field.member "descriptorKnown" value |> Field.to_bool in
  Kernel.available known descriptor_known (string "target") (string "operation") |> Js.bool

let () =
  Js.Unsafe.set Js.Unsafe.global "DEXLiquidityReceipt"
    (Js.Unsafe.obj [|"select", Js.Unsafe.inject (Js.wrap_callback select);
      "available", Js.Unsafe.inject (Js.wrap_callback available)|])
