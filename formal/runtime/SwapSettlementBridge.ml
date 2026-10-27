open Js_of_ocaml
module Kernel = SwapSettlementKernel
module Field = Yojson.Basic.Util

let summarize input =
  let value = Js.to_string input |> Yojson.Basic.from_string in
  let integer key = Field.member key value |> Field.to_string |> Z.of_string in
  let result = Kernel.summarize (integer "amountIn") (integer "amountOut")
    (integer "quoted") (integer "inputPlaces") (integer "outputPlaces") in
  let execution_price = match result.execution_price with
    | None -> `Null | Some text -> `String text in
  let comparison = match result.quote_comparison with
    | Kernel.Same -> "same" | Kernel.More -> "more" | Kernel.Less -> "less" in
  `Assoc ["executionPrice", execution_price;
    "quoteDifference", `String (Z.to_string result.quote_difference);
    "comparison", `String comparison]
  |> Yojson.Basic.to_string |> Js.string

let () =
  Js.Unsafe.set Js.Unsafe.global "DEXSwapSettlement"
    (Js.Unsafe.obj [|"summarize", Js.Unsafe.inject (Js.wrap_callback summarize)|])
