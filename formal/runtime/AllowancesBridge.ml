open Js_of_ocaml
module A = WalletKernel.Allowances
module W = WalletKernel.Wallet
module J = Yojson.Safe
module U = Yojson.Safe.Util
let text s = `String s
let integer z = text (Z.to_string z)
let member k j = U.member k j
let string k j = U.to_string (member k j)
let number k j = Z.of_string (string k j)
let optional f = function None -> `Null | Some x -> f x
let pair j = { A.token = string "token" j; spender = string "spender" j }
let identity j = { W.identity_source = (if string "source" j = "local" then W.LocalWallet else W.BrowserWallet);
 identity_address = string "address" j; identity_chain = number "chain" j; identity_epoch = number "epoch" j }
let identity_json id = `Assoc ["source",text (match id.W.identity_source with W.LocalWallet -> "local" | W.BrowserWallet -> "injected");
 "address",text id.W.identity_address; "chain",integer id.W.identity_chain; "epoch",integer id.W.identity_epoch]
let plan j = { A.identity = identity (member "identity" j); target = pair j; previous = number "allowance" j }
let plan_json p = `Assoc ["identity",identity_json p.A.identity; "owner",text p.A.identity.W.identity_address;
 "token",text p.A.target.A.token; "spender",text p.A.target.A.spender; "allowance",integer p.A.previous; "unlimited",`Bool (A.unlimited p.A.previous)]
let action_json = function
 | A.Idle -> `Assoc ["kind",text "idle";"message",text ""]
 | A.Verifying hash -> `Assoc ["kind",text "verifying";"hash",text hash;"message",text "Transaction confirmed; checking the remaining authorization."]
 | A.Verified hash -> `Assoc ["kind",text "verified";"hash",text hash;"message",text "Authorization revoked. The confirmed allowance is zero."]
 | A.Unverified (hash,message) -> `Assoc ["kind",text "unverified";"hash",text hash;"message",text message]
 | A.Error message -> `Assoc ["kind",text "error";"message",text message]
let create ~current_identity ~pending encoded =
 let configuration = J.from_string (Js.to_string encoded) in
 let tokens = U.to_list (member "tokens" configuration) |> List.map U.to_string in
 let spenders = U.to_list (member "spenders" configuration) |> List.map U.to_string in
 let pairs = A.pairs_for tokens spenders in
 let state = ref A.initial in
 let normalize () = state := A.normalize (current_identity ()) !state in
 let view () =
  normalize ();
  let current = current_identity () in
  let phase = match current with None -> "disconnected" | Some _ ->
   if (!state).A.loading then "loading" else match (!state).A.block, (!state).A.result with
   | Some _,_ -> "ready" | None,A.Error _ -> "error" | None,_ -> "idle" in
  let row p =
   let observed = A.lookup p (!state).A.rows in
   let amount = Option.bind observed (fun r -> r.A.value) in
   let error = Option.bind observed (fun r -> r.A.read_error) in
   `Assoc ["token",text p.A.token;"spender",text p.A.spender;
    "allowance",optional integer amount;"error",optional text error;
    "unlimited",`Bool (match amount with None -> false | Some value -> A.unlimited value);
    "canRevoke",`Bool (A.can_revoke current (pending ()) pairs !state p)] in
  `Assoc ["phase",text phase;"owner",optional (fun id -> text id.W.identity_address) current;
   "block",optional integer (!state).A.block;"rows",`List (List.map row pairs);
   "canRefresh",`Bool (A.can_refresh current !state);
   "canConfirm",`Bool (A.can_confirm current (pending ()) pairs !state);
   "review",optional plan_json (!state).A.review;"action",action_json (!state).A.result]
 in
 let encode j = J.to_string j |> Js.string in
 let command encoded =
  let input = J.from_string (Js.to_string encoded) in
  let current = current_identity () in
  normalize ();
  let result = match string "kind" input with
  | "refresh" -> state := A.begin_read current !state;
    (match current with None -> `Null | Some id -> `Assoc ["request",integer (!state).A.serial;
     "identity",identity_json id;"owner",text id.W.identity_address;
     "pairs",`List (List.map (fun p -> `Assoc ["token",text p.A.token;"spender",text p.A.spender]) pairs)])
  | "loaded" ->
    let rows = U.to_list (member "rows" input) |> List.map (fun r ->
      { A.observed_pair = pair r; value = (match member "allowance" r with `Null -> None | v -> Some (Z.of_string (U.to_string v)));
        read_error = (match member "error" r with `Null -> None | v -> Some (U.to_string v)) }) in
    state := A.loaded current (number "request" input) (number "block" input) rows !state; `Null
  | "failed" -> state := A.failed current (number "request" input) (string "message" input) !state; `Null
  | "review" -> state := A.select current (pending ()) pairs !state (pair input); `Null
  | "cancel" -> state := A.cancel !state; `Null
  | "take" -> let next, chosen = A.take current (pending ()) pairs !state in state := next; optional plan_json chosen
  | "submitted" -> state := A.submitted current (plan (member "plan" input)) (string "hash" input) (number "block" input) !state; `Null
  | "rejected" -> state := A.rejected current (identity (member "identity" input)) (string "message" input) !state; `Null
  | value -> invalid_arg ("Unknown allowance command: " ^ value)
  in encode (`Assoc ["view",view ();"result",result])
 in
 Js.Unsafe.obj [|"view",Js.Unsafe.inject (Js.wrap_callback (fun () -> encode (view ())));
 "command",Js.Unsafe.inject (Js.wrap_callback command);
 "writePlan",Js.Unsafe.inject (Js.wrap_callback (fun encoded ->
   let input = J.from_string (Js.to_string encoded) in
   let chosen = plan (member "plan" input) in
   let id = identity (member "identity" input) in
   let valid = A.validate (Some id) pairs chosen in
   encode (if valid then `Assoc ["kind",text "prepared";"token",text chosen.A.target.A.token;
    "spender",text chosen.A.target.A.spender;"amount",integer (A.amount_parameter chosen)]
    else `Assoc ["kind",text "rejected";"message",text "The reviewed authorization does not belong to this wallet or deployment."])));
 "simulation",Js.Unsafe.inject (Js.wrap_callback (fun accepted ->
   encode (if A.simulation_allowed (Js.to_bool accepted) then `Null
   else text "The token refused to revoke this authorization; no transaction was sent.")))|]
