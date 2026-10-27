open Js_of_ocaml

let transfer_of_json value =
  let open Yojson.Safe.Util in
  { LedgerKernel.transfer_token_id = Z.of_string (value |> member "tokenId" |> to_string);
    LedgerKernel.transfer_recipient = value |> member "to" |> to_string }

let owner_to_json (id, owner) =
  `Assoc ["id", `String (Z.to_string id); "owner", `String owner]

let active_owners json =
  let events =
    Yojson.Safe.from_string (Js.to_string json)
    |> Yojson.Safe.Util.to_list |> List.map transfer_of_json
  in
  LedgerKernel.active_owners events
  |> List.map owner_to_json |> fun owners -> Js.string (Yojson.Safe.to_string (`List owners))

let () =
  Js.Unsafe.set Js.Unsafe.global "DEXLedger"
    (Js.Unsafe.obj [| "activeOwners", Js.Unsafe.inject (Js.wrap_callback active_owners) |])
