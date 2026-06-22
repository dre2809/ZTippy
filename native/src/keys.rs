//! ZIP-32 / ZIP-316 key derivation — PRODUCTION IMPLEMENTATION

use crate::error::TipbotError;
use crate::network::Network;

use zcash_keys::keys::UnifiedSpendingKey;
use zcash_keys::address::{UnifiedAddress, Address};
use zcash_address::ZcashAddress;
use zcash_protocol::consensus::{MainNetwork, TestNetwork, Parameters, NetworkType};
use orchard::keys::Scope;
use zip32::{AccountId, DiversifierIndex};

pub fn derive_unified_address(
    seed: &[u8],
    div_index: u64,
    network: Network,
) -> Result<String, TipbotError> {
    if seed.len() < 32 {
        return Err(TipbotError::KeyDerivation(
            "Seed must be at least 32 bytes".into(),
        ));
    }
    match network {
        Network::Mainnet => derive_ua_inner(&MainNetwork, seed, div_index),
        Network::Testnet => derive_ua_inner(&TestNetwork, seed, div_index),
    }
}

fn derive_ua_inner<P: Parameters>(
    params: &P,
    seed: &[u8],
    div_index: u64,
) -> Result<String, TipbotError> {
    let usk = UnifiedSpendingKey::from_seed(params, seed, AccountId::ZERO)
        .map_err(|e| TipbotError::KeyDerivation(format!("{:?}", e)))?;
    let ofvk = orchard::keys::FullViewingKey::from(usk.orchard());
    let di = DiversifierIndex::from(div_index);
    let orchard_addr = ofvk.address_at(di, Scope::External);
    let ua = UnifiedAddress::from_receivers(
        Some(orchard_addr),
        None,
    )
    .ok_or_else(|| TipbotError::KeyDerivation("Failed to construct Unified Address".into()))?;
    Ok(ua.encode(params))
}

pub fn derive_ufvk(seed: &[u8], network: Network) -> Result<String, TipbotError> {
    if seed.len() < 32 {
        return Err(TipbotError::KeyDerivation("Seed too short".into()));
    }
    match network {
        Network::Mainnet => derive_ufvk_inner(&MainNetwork, seed),
        Network::Testnet => derive_ufvk_inner(&TestNetwork, seed),
    }
}

fn derive_ufvk_inner<P: Parameters>(
    params: &P,
    seed: &[u8],
) -> Result<String, TipbotError> {
    let usk = UnifiedSpendingKey::from_seed(params, seed, AccountId::ZERO)
        .map_err(|e| TipbotError::KeyDerivation(format!("{:?}", e)))?;
    let ufvk = usk.to_unified_full_viewing_key();
    Ok(ufvk.encode(params))
}

pub fn validate_unified_address(address: &str, network: Network) -> bool {
    let expected = match network {
        Network::Mainnet => NetworkType::Main,
        Network::Testnet => NetworkType::Test,
    };
    match ZcashAddress::try_from_encoded(address) {
        Ok(addr) => addr.convert_if_network::<Address>(expected).is_ok(),
        Err(_) => false,
    }
}
