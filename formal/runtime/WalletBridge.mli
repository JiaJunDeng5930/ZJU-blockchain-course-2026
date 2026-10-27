(** Registers the extracted wallet and transaction-history kernel using its
    JSON protocol and version-two history archive. Version-one archives have no
    nonce descriptor or replacement lineage and are migrated without inferring
    either. Integer quantities cross the boundary as exact
    strings. Runtime closures retain all authority; archive DTOs contain public
    transaction metadata only and cannot reconstruct an executable operation.

    This codec is part of the trusted boundary. Storage ownership, recovery
    policy, authorization and receipt reconciliation come from the extracted
    model. Read-only activity queries consume those same canonical entries and
    never publish state or effects. JavaScript effects implement atomic per-key browser storage and RPC
    observation; they do not grant signing authority from an archive. *)
