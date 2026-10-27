import "../generated/dex_logic.js";

type OwnershipObservation = { tokenId: bigint; to: string };
type IndexedOwner = { id: bigint; owner: string };
type WireOwner = { id: string; owner: string };

declare global {
  var DEXLedger: { activeOwners(json: string): string };
}

/** Observations must be chronological, from one ERC721 contract at one fixed block. */
export function activeOwners(
  events: readonly OwnershipObservation[],
): IndexedOwner[] {
  const wire = events.map(({ tokenId, to }) => ({
    tokenId: tokenId.toString(),
    to,
  }));
  const result = JSON.parse(
    globalThis.DEXLedger.activeOwners(JSON.stringify(wire)),
  ) as WireOwner[];
  return result.map(({ id, owner }) => ({ id: BigInt(id), owner }));
}
