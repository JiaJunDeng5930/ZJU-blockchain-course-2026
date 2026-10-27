open Js_of_ocaml
module Kernel = WrappingSettlementKernel
module Field = Yojson.Basic.Util

let summarize input =
  let value = Js.to_string input |> Yojson.Basic.from_string in
  let integer key = Field.member key value |> Field.to_string |> Z.of_string in
  let withdraw = Field.member "withdraw" value |> Field.to_bool in
  let result = Kernel.summarize (integer "amount") withdraw (integer "gasCostWei") in
  `Assoc ["nativeChangeWei", `String (Z.to_string result.native_change_wei);
    "wrappedChange", `String (Z.to_string result.wrapped_change)]
  |> Yojson.Basic.to_string |> Js.string

let () =
  Js.Unsafe.set Js.Unsafe.global "DEXWrappingSettlement"
    (Js.Unsafe.obj [|"summarize", Js.Unsafe.inject (Js.wrap_callback summarize)|])
