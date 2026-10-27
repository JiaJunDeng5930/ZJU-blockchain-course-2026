open Js_of_ocaml
module K = LiquidityKernel
module Json = Yojson.Safe
module Field = Yojson.Safe.Util

let text key value = Field.member key value |> Field.to_string
let integer key value = Big_int_Z.big_int_of_string (text key value)
let canonical = String.lowercase_ascii
let address key value = canonical (text key value)
let z value = `String (Big_int_Z.string_of_big_int value)
let optional_text = function None -> `Null | Some value -> `String value
let pool value = integer "reserve0" value, integer "reserve1" value, integer "totalShares" value
let deposit_json (plan : K.deposit_plan) = [
  "desired0", z plan.deposit0; "desired1", z plan.deposit1;
  "used0", z plan.used0; "used1", z plan.used1;
  "unused0", z plan.unused0; "unused1", z plan.unused1;
  "shares", z plan.minted; "minimum0", z plan.minimum0; "minimum1", z plan.minimum1]
let rejected reason = `Assoc ["ok", `Bool false; "error", `String reason]
let analyze_deposit value =
  let r0,r1,total = pool value in
  match K.analyze_deposit (integer "decimals0" value) (integer "decimals1" value) r0 r1 total (integer "balance0" value) (integer "balance1" value)
    (text "amount0" value) (text "amount1" value) (text "slippage" value) with
  | K.DepositEmpty -> `Assoc ["ok", `Bool false; "error", `Null]
  | K.DepositRejected why -> rejected why
  | K.DepositPrepared plan -> `Assoc (("ok", `Bool true)::deposit_json plan)
let deposit_amounts value =
  let r0,r1,total = pool value in
  let a0,a1 = K.deposit_amounts r0 r1 total (integer "desired0" value) (integer "desired1" value) in
  `List [z a0; z a1]
let counterpart value =
  let r0,r1,total = pool value in
  K.counterpart (integer "decimals0" value) (integer "decimals1" value) r0 r1 total (Field.member "second" value |> Field.to_bool) (text "amount" value)
    |> optional_text
let position_view value =
  let r0,r1,total = pool value in
  let view = K.position_values r0 r1 total (integer "shares" value)
    (integer "original0" value) (integer "original1" value) in
  `Assoc ["amount0", z view.redeem0; "amount1", z view.redeem1;
    "heldValue", z view.held_value; "currentValue", z view.current_value;
    "valueChange", z view.value_change; "valueSign", `String (K.value_sign view);
    "sharePercent", `String view.share_percent]
let transfer_error value =
  let decoded = match Field.member "recipient" value with
    | `Null -> None | json -> Some (canonical (Field.to_string json)) in
  match K.prepare_transfer (address "owner" value) (address "current" value) decoded with
  | K.TransferRejected why -> `Assoc ["ok",`Bool false;"error",`String why]
  | K.TransferPrepared recipient -> `Assoc ["ok",`Bool true;"recipient",`String recipient]
let aggregate_activity value =
  let trades = Field.member "trades" value |> Field.to_list |> List.map (fun trade ->
    address "tokenIn" trade, integer "amountIn" trade) in
  let totals = K.fee_summary (address "token0" value) (integer "feeBps" value) trades in
  `Assoc ["volume0", z totals.volume0; "volume1", z totals.volume1;
    "fees0", z totals.fees0; "fees1", z totals.fees1]
let write_deposit value =
  let r0,r1,total = pool value in
  match K.prepare_deposit_write r0 r1 total (integer "desired0" value) (integer "desired1" value)
    (integer "balance0" value) (integer "balance1" value) (integer "slippageBps" value)
    (integer "now" value) (integer "allowance0" value) (integer "allowance1" value) with
  | K.WriteDepositRejected why -> rejected why
  | K.WriteDepositPrepared (plan, deadline, approve0, approve1) ->
    `Assoc (("ok", `Bool true)::("deadline",z deadline)::
      ("approve0",`Bool approve0)::("approve1",`Bool approve1)::deposit_json plan)
let write_withdraw value =
  let r0,r1,total = pool value in
  match K.prepare_position_withdraw (integer "expectedPool" value) (integer "actualPool" value)
    r0 r1 total (integer "shares" value) (address "owner" value) (address "current" value)
    (integer "slippageBps" value) (integer "now" value) (integer "expected0" value) (integer "expected1" value) with
  | K.WriteWithdrawRejected why -> rejected why
  | K.WriteWithdrawPrepared (a0,a1,m0,m1,deadline) ->
      `Assoc ["ok",`Bool true;"amount0",z a0;"amount1",z a1;
        "minimum0",z m0;"minimum1",z m1;"deadline",z deadline]
let references value = Field.member "positions" value |> Field.to_list |> List.map (fun item ->
  { K.reference_key = text "key" item; reference_owner = address "owner" item;
    reference_pool = text "pool" item; reference_created = integer "created" item;
    reference_id = integer "id" item })
let owned_positions value = K.owned_references (address "owner" value) (references value)
  |> List.map (fun item -> `String item.K.reference_key) |> fun items -> `List items
let pool_positions value = K.pool_references (text "pool" value) (references value)
  |> List.map (fun item -> `String item.K.reference_key) |> fun items -> `List items
let callback function_value = Js.wrap_callback (fun input ->
  Js.to_string input |> Json.from_string |> function_value |> Json.to_string |> Js.string)
let () = Js.Unsafe.set Js.Unsafe.global "DEXLiquidity" (Js.Unsafe.obj [|
  "ownedPositions", Js.Unsafe.inject (callback owned_positions);
  "poolPositions", Js.Unsafe.inject (callback pool_positions);
  "analyzeDeposit", Js.Unsafe.inject (callback analyze_deposit);
  "depositAmounts", Js.Unsafe.inject (callback deposit_amounts);
  "counterpart", Js.Unsafe.inject (callback counterpart);
  "positionView", Js.Unsafe.inject (callback position_view);
  "transferError", Js.Unsafe.inject (callback transfer_error);
  "aggregateActivity", Js.Unsafe.inject (callback aggregate_activity);
  "writeDeposit", Js.Unsafe.inject (callback write_deposit);
  "writeWithdraw", Js.Unsafe.inject (callback write_withdraw)
|])
