(** Version-one JSON adapter over the extracted allowance model. Identity and
    pending-operation authority come from the existing wallet closure. Addresses
    use the existing viem canonical codec; RPC values remain external inputs. *)
val create :
  current_identity:(unit -> WalletKernel.Wallet.identity option) ->
  pending:(unit -> bool) -> Js_of_ocaml.Js.js_string Js_of_ocaml.Js.t ->
  Js_of_ocaml.Js.Unsafe.any
