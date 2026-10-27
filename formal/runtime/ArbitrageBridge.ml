open Js_of_ocaml
open ArbitrageModel
module A = ArbitrageModel.Arbitrage
module Json = Yojson.Safe
module Field = Yojson.Safe.Util

let text name value = Field.member name value |> Field.to_string
let integer name value = Big_int_Z.big_int_of_string (text name value)
let canonical value = String.lowercase_ascii value
let address name value = canonical (text name value)
let z value = `String (Big_int_Z.string_of_big_int value)

let pool_of_json value : A.pool = {
  exchange = address "exchange" value;
  pool_id = integer "id" value;
  token0 = address "token0" value;
  token1 = address "token1" value;
  reserve0 = integer "reserve0" value;
  reserve1 = integer "reserve1" value;
}

let pool_json (value : A.pool) = `Assoc [
  "exchange", `String value.exchange; "id", z value.pool_id;
  "token0", `String value.token0; "token1", `String value.token1;
  "reserve0", z value.reserve0; "reserve1", z value.reserve1;
]

let opportunity_of_json value : A.opportunity = {
  buy = pool_of_json (Field.member "buy" value);
  sell = pool_of_json (Field.member "sell" value);
  capital_token = address "tokenIn" value;
  capital = integer "amountIn" value;
  intermediate = integer "intermediateAmount" value;
  returned = integer "amountOut" value;
  profit = integer "profit" value;
}

let opportunity_json (value : A.opportunity) = `Assoc [
  "buy", pool_json value.buy; "sell", pool_json value.sell;
  "tokenIn", `String value.capital_token;
  "amountIn", z value.capital; "intermediateAmount", z value.intermediate;
  "amountOut", z value.returned; "profit", z value.profit;
]

let error = function
  | A.InvalidMinimum -> "Enter a nonnegative minimum profit within the principal token precision."
  | A.InvalidRoute -> "This route is no longer a profitable route between matching pools."
  | A.InsufficientCapital -> "Insufficient capital for this route."
  | A.ProfitBelowMinimum -> "The current quote does not meet your minimum profit."
  | A.InvalidTime -> "The transaction deadline cannot be represented."
  | A.InvalidArbitrage -> "The arbitrage contract address is missing."
  | A.InvalidAllowance -> "The token allowance cannot be represented."

let decision_json = function
  | A.Rejected why -> `Assoc ["ok", `Bool false; "error", `String (error why)]
  | A.Prepared plan -> `Assoc [
      "ok", `Bool true; "route", opportunity_json plan.execution_route;
      "minimumProfit", z plan.minimum_profit; "deadline", z plan.deadline;
      "requiresApproval", `Bool plan.approval_required;
    ]

let markets value =
  Field.member "pools" value |> Field.to_list |> List.map pool_of_json

let supported_tokens value =
  Field.to_list (Field.member "supportedTokens" value)
  |> List.map (fun token -> String.lowercase_ascii (Field.to_string token))

let scan value =
  let selected = pool_of_json (Field.member "selected" value) in
  match scan_supported_assets (integer "decimals" value) checked_amount_out selected (markets value) (address "tokenIn" value) (supported_tokens value) with
  | None -> `List []
  | Some result -> `List [opportunity_json result]

let capital_error = "Enter a positive capital amount within the token precision."

let capital value =
  match positive_units (integer "decimals" value) (text "amount" value) with
  | None -> `Assoc ["canQuote", `Bool false; "error", `String capital_error]
  | Some amount -> `Assoc ["canQuote", `Bool true; "error", `Null; "amountIn", z amount]

let quote_capital value =
  let selected = pool_of_json (Field.member "selected" value) in
  match quote_amount (integer "decimals" value) checked_amount_out selected
    (markets value) (address "tokenIn" value) (text "amount" value)
    (supports_asset_pool (supported_tokens value)) with
  | None -> `Assoc ["ok", `Bool false; "error", `String capital_error]
  | Some route -> `Assoc ["ok", `Bool true; "routes", (match route with
      | None -> `List []
      | Some result -> `List [opportunity_json result])]

let minimum value = parse_units (integer "decimals" value) (text "minimum" value)

let prepare value =
  prepare_supported_assets checked_amount_out (address "arbitrage" value)
    (pool_of_json (Field.member "buy" value))
    (pool_of_json (Field.member "sell" value))
    (markets value) (address "tokenIn" value) (integer "amountIn" value)
    (minimum value) (integer "balance" value) (integer "allowance" value)
    (integer "now" value) (supported_tokens value)
  |> decision_json

let preview value =
  let route = match Field.member "route" value with
    | `Null -> None | current -> Some (opportunity_of_json current) in
  let decision = A.preview (address "arbitrage" value) route
    (parse_units (integer "decimals" value) (text "minimum" value)) (integer "balance" value) in
  match decision with
  | None -> `Assoc ["canExecute", `Bool false; "error", `Null]
  | Some (A.Rejected why) ->
      `Assoc ["canExecute", `Bool false; "error", `String (error why)]
  | Some (A.Prepared _) -> `Assoc ["canExecute", `Bool true; "error", `Null]

let execution value =
  let summary = summarize_execution
    (integer "amountIn" value) (integer "amountOut" value) (integer "profit" value)
    (integer "gasUsed" value) (integer "gasPrice" value) in
  `Assoc [
    "amountIn", z summary.execution_amount_in;
    "amountOut", z summary.execution_amount_out;
    "profit", z summary.execution_profit;
    "gasCostWei", z summary.execution_gas_cost_wei;
  ]

let callback function_value = Js.wrap_callback (fun input ->
  Js.to_string input |> Json.from_string |> function_value |> Json.to_string |> Js.string)

let () = Js.Unsafe.set Js.Unsafe.global "DEXArbitrage" (Js.Unsafe.obj [|
  "scan", Js.Unsafe.inject (callback scan);
  "capital", Js.Unsafe.inject (callback capital);
  "quoteAmount", Js.Unsafe.inject (callback quote_capital);
  "prepare", Js.Unsafe.inject (callback prepare);
  "preview", Js.Unsafe.inject (callback preview);
  "execution", Js.Unsafe.inject (callback execution);
|])
