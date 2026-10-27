From Coq Require Import Extraction ExtrOcamlBasic ExtrOcamlNativeString ExtrOcamlZBigInt.
From DEXFormal.Spec Require Import Assets.
From DEXFormal.Frontend Require Import AssetsForms PoolSelection.
Extraction Language OCaml.
Extraction "formal/build/assets/AssetsKernel.ml"
  Assets.runtime_code_matches Assets.pool_assets_supported Assets.unsupported_pool_error Assets.active_assets Assets.pool_price_text Assets.canonical_address Assets.supported_asset Assets.deployment_call Assets.pool_error Assets.pool_call
  Assets.faucet_call Assets.deployed_asset_matches
  Assets.deployment_name_error Assets.address_error Assets.metadata_error Assets.faucet_error Assets.deployment_receipt_error Assets.deployment_verification_error
  Assets.initial_catalog Assets.register_assets Assets.catalog_storage_error Assets.discovery_targets
  AssetsForms.initial AssetsForms.step AssetsForms.deployment_error AssetsForms.create_pool_error
  AssetsForms.import_error AssetsForms.import_pending AssetsForms.can_import AssetsForms.can_deploy AssetsForms.can_create_pool
  PoolSelection.select_pool.
