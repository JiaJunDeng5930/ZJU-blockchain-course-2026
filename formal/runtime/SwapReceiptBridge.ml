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
      | "pool-creation" -> Kernel.PoolCreationFact
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
  let kind = match Kernel.result_with_pool_creation (boolean "successful" v) (boolean "creation" v)
      (strings "exchanges" v) (text "arbitrage" v) (text "wrapped" v)
      (text "target" v) (text "owner" v) (facts v) with
    | Kernel.NoResult -> "none" | Kernel.CreationResult -> "creation"
    | Kernel.SwapResult -> "swap" | Kernel.LiquidityResult -> "liquidity"
    | Kernel.ArbitrageResult -> "arbitrage" | Kernel.WrappingResult -> "wrapping"
    | Kernel.PoolCreationResult -> "pool-creation"
    | Kernel.RevertedResult -> "reverted" in
  Js.string kind

let available input =
  let v = value input in
  let previous = Kernel.available_with_pool_creation (strings "exchanges" v) (text "arbitrage" v) (text "wrapped" v)
    (boolean "descriptorKnown" v) (boolean "creation" v)
    (text "target" v) (text "operation" v) in
  Kernel.available_with_funding previous (boolean "descriptorKnown" v)
    (text "authority" v) (text "beneficiary" v) (text "target" v)
    (text "operation" v) |> Js.bool

let select_token_funding input =
  let v = value input in
  let result = match Kernel.select_token_funding (boolean "successful" v)
      (text "expectedTarget" v) (text "expectedOwner" v) (text "target" v) (text "owner" v) (facts v) with
    | Kernel.NoTokenFunding -> `Assoc ["kind", `String "none"]
    | Kernel.RevertedTokenFunding -> `Assoc ["kind", `String "reverted"]
    | Kernel.MultipleTokenFundings -> `Assoc ["kind", `String "multiple"]
    | Kernel.SelectedTokenFunding fact ->
        `Assoc ["kind", `String "selected"; "index", `Int fact.Kernel.fact_index] in
  encode result

let native_funding_candidate input =
  let v = value input in
  Kernel.native_funding_candidate (boolean "successful" v) (text "authority" v)
    (text "beneficiary" v) (text "target" v) (text "owner" v) |> Js.bool

let native_funding_value input =
  let v = value input in
  let result = match Kernel.native_funding_value (boolean "successful" v)
      (text "authority" v) (text "beneficiary" v) (text "target" v)
      (text "owner" v) (text "input" v) (text "amount" v |> Z.of_string) with
    | None -> `Assoc ["kind", `String "none"]
    | Some amount -> `Assoc ["kind", `String "selected";
        "amount", `String (Z.to_string amount)] in
  encode result

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

let select_pool_creation input =
  let v = value input in
  let result = match Kernel.select_pool_creation (boolean "successful" v)
      (strings "exchanges" v) (text "target" v) (facts v) with
    | Kernel.NoPoolCreation -> `Assoc ["kind", `String "none"]
    | Kernel.RevertedPoolCreation -> `Assoc ["kind", `String "reverted"]
    | Kernel.MultiplePoolCreations -> `Assoc ["kind", `String "multiple"]
    | Kernel.SelectedPoolCreation fact ->
        `Assoc ["kind", `String "selected"; "index", `Int fact.Kernel.fact_index] in
  encode result

let continue_created_pool input =
  let v = value input in
  let with_key kind key = `Assoc ["kind", `String kind; "key", `String key] in
  let result = match Kernel.continue_created_pool (text "requested" v)
      (strings "available" v) (strings "supported" v)
      (boolean "connected" v) (boolean "pending" v) with
    | Kernel.ReadCreatedPool -> `Assoc ["kind", `String "read-state"]
    | Kernel.ConnectCreatedPool key -> with_key "connect-wallet" key
    | Kernel.PendingCreatedPool key -> with_key "pending" key
    | Kernel.UnsupportedCreatedPool key -> with_key "unsupported-assets" key
    | Kernel.ReadyCreatedPool key -> with_key "ready" key in
  encode result

let () =
  Js.Unsafe.set Js.Unsafe.global "DEXSwapReceipt"
    (Js.Unsafe.obj [|"select", Js.Unsafe.inject (Js.wrap_callback select);
      "classify", Js.Unsafe.inject (Js.wrap_callback classify);
      "available", Js.Unsafe.inject (Js.wrap_callback available);
      "selectTokenFunding", Js.Unsafe.inject (Js.wrap_callback select_token_funding);
      "nativeFundingCandidate", Js.Unsafe.inject (Js.wrap_callback native_funding_candidate);
      "nativeFundingValue", Js.Unsafe.inject (Js.wrap_callback native_funding_value);
      "selectWrapping", Js.Unsafe.inject (Js.wrap_callback select_wrapping);
      "selectPoolCreation", Js.Unsafe.inject (Js.wrap_callback select_pool_creation);
      "continueCreatedPool", Js.Unsafe.inject (Js.wrap_callback continue_created_pool);
      "outputAsset", Js.Unsafe.inject (Js.wrap_callback output_asset)|])
