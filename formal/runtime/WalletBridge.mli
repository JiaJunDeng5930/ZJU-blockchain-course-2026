(** Registers the extracted wallet, transaction and pending-checkpoint kernel.
    Checkpoints are scoped to one tab and never contain signing permission or
    completed history. JSON conversion is confined to this bridge. *)
val native_funding_exn : Js_of_ocaml.Js.js_string Js_of_ocaml.Js.t -> Js_of_ocaml.Js.js_string Js_of_ocaml.Js.t
