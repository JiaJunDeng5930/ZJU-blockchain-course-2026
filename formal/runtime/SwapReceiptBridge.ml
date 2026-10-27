open Js_of_ocaml
module Kernel = SwapReceiptKernel
module Field = Yojson.Basic.Util

let text key value = Field.member key value |> Field.to_string
let strings key value = Field.member key value |> Field.to_list |> List.map Field.to_string
let boolean key value = Field.member key value |> Field.to_bool
let facts value =
  Field.member "facts" value |> Field.to_list |> List.map (fun fact ->
    let fact_type = match text "kind" fact with
      | "swap" -> Kernel.SwapFact | "liquidity" -> Kernel.LiquidityFact
      | "transfer" -> Kernel.TransferFact | "arbitrage" -> Kernel.ArbitrageFact
      | "wrapping" -> Kernel.WrappingFact
      | other -> invalid_arg ("Unknown receipt ABI fact: " ^ other) in
    { Kernel.fact_index = Field.member "index" fact |> Field.to_int;
      fact_source = text "source" fact; fact_type;
      fact_from = text "from" fact; fact_to = text "to" fact })
let value input = Js.to_string input |> Yojson.Basic.from_string
let encode result = Yojson.Basic.to_string result |> Js.string

let select input =
  let v = value input in
  let result = match Kernel.select_swap (boolean "successful" v)
      (strings "exchanges" v) (text "target" v) (facts v) with
    | Kernel.NoSwap -> `Assoc ["kind", `String "none"]
    | Kernel.RevertedSwap -> `Assoc ["kind", `String "reverted"]
    | Kernel.MultipleSwaps -> `Assoc ["kind", `String "multiple"]
    | Kernel.SelectedSwap fact -> `Assoc ["kind", `String "selected";
        "index", `Int fact.Kernel.fact_index] in
  encode result

let classify input =
  let v = value input in
  let kind = match Kernel.result_with_wrapping (boolean "successful" v) (boolean "creation" v)
      (strings "exchanges" v) (text "arbitrage" v) (text "wrapped" v)
      (text "target" v) (text "owner" v) (facts v) with
    | Kernel.NoResult -> "none" | Kernel.CreationResult -> "creation"
    | Kernel.SwapResult -> "swap" | Kernel.LiquidityResult -> "liquidity"
    | Kernel.ArbitrageResult -> "arbitrage" | Kernel.WrappingResult -> "wrapping"
    | Kernel.RevertedResult -> "reverted" in
  Js.string kind

let available input =
  let v = value input in
  Kernel.available_with_wrapping (strings "exchanges" v) (text "arbitrage" v) (text "wrapped" v)
    (boolean "descriptorKnown" v) (boolean "creation" v)
    (text "target" v) (text "operation" v) |> Js.bool

let output_asset input =
  let v = value input in
  Kernel.output_asset (text "input" v) (text "token0" v) (text "token1" v) |> Js.string

let select_wrapping input =
  let v = value input in
  let result = match Kernel.select_wrapping (boolean "successful" v)
      (text "wrapped" v) (text "target" v) (text "owner" v) (facts v) with
    | Kernel.NoWrapping -> `Assoc ["kind", `String "none"]
    | Kernel.RevertedWrapping -> `Assoc ["kind", `String "reverted"]
    | Kernel.MultipleWrappings -> `Assoc ["kind", `String "multiple"]
    | Kernel.SelectedWrapping (fact, withdraw) ->
        `Assoc ["kind", `String "selected"; "index", `Int fact.Kernel.fact_index;
          "withdraw", `Bool withdraw] in
  encode result

let () =
  Js.Unsafe.set Js.Unsafe.global "DEXSwapReceipt"
    (Js.Unsafe.obj [|"select", Js.Unsafe.inject (Js.wrap_callback select);
      "classify", Js.Unsafe.inject (Js.wrap_callback classify);
      "available", Js.Unsafe.inject (Js.wrap_callback available);
      "selectWrapping", Js.Unsafe.inject (Js.wrap_callback select_wrapping);
      "outputAsset", Js.Unsafe.inject (Js.wrap_callback output_asset)|])
