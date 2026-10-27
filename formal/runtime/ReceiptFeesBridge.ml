open Js_of_ocaml
module Kernel = ReceiptFeesKernel
module Field = Yojson.Basic.Util

let execution_fee input =
  let receipt = Js.to_string input |> Yojson.Basic.from_string in
  let integer key = Field.member key receipt |> Field.to_string |> Z.of_string in
  Kernel.execution_fee (integer "gasUsed") (integer "effectiveGasPrice")
  |> Z.to_string |> Js.string

let () =
  Js.Unsafe.set Js.Unsafe.global "DEXReceiptFees"
    (Js.Unsafe.obj [|"executionFeeWei", Js.Unsafe.inject (Js.wrap_callback execution_fee)|])
