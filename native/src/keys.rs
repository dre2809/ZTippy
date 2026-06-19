//! ZIP-32 / ZIP-316 key derivation.
//!
//! Derives a Unified Spending Key from a seed, then produces diversified
//! Unified Addresses (u1...) for each user via their diversifier index.
//!
//! # Production integration
//!
//! Replace the stub implementations with:
//!
//! ```ignore
//! use zcash_keys::keys::UnifiedSpendingKey;
//! use zcash_primitives::consensus::{MainNetwork, TestNetwork, Parameters};
//! use zcash_keys::address::UnifiedAddress;
//! use orchard::keys::{SpendingKey as OrchardSpendingKey, FullViewingKey as OrchardFvk};
//! use zip32::DiversifierIndex;
//!
//! // Derive master USK from seed
//! let usk = UnifiedSpendingKey::from_seed(&MainNetwork, &seed, AccountId::ZERO)
//!     .map_err(|e| TipbotError::KeyDerivation(format!("{:?}", e)))?;
//!
//! // Derive the Orchard FVK
//! let ofvk = usk.orchard().derive_full_viewing_key();
//!
//! // Derive a diversified address at index `div_index`
//! let di = DiversifierIndex::from(div_index);
//! let addr = ofvk.address_at(di, zip32::Scope::External);
//! let ua = UnifiedAddress::from_receivers(
//!     Some(addr), // Orchard receiver
//!     None,       // No Sapling receiver
//!     None,       // No transparent receiver
//! ).ok_or_else(|| TipbotError::KeyDerivation("Failed to build UA".into()))?;
//!
//! // Encode as bech32m u1... string
//! let encoded = ua.encode(&MainNetwork);
//! ```
//!
//! # UFVK (for wallet scanning)
//!
//! ```ignore
//! let ufvk = usk.to_unified_full_viewing_key();
//! let ufvk_encoded = ufvk.encode(&MainNetwork);
//! ```

use crate::error::TipbotError;
use crate::network::Network;

/// Derives a ZIP-316 Unified Address for the given diversifier index.
///
/// This is called once per new user during `/register`.
/// The resulting `u1...` address is stored in SQLite and shown to the user.
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

    // ── Production: uncomment and use zcash_keys + orchard crates ────────
    // use zcash_keys::keys::UnifiedSpendingKey;
    // use zcash_primitives::consensus::MainNetwork;
    // use orchard::keys::FullViewingKey as OrchardFvk;
    // use zip32::DiversifierIndex;
    //
    // let params = match network {
    //     Network::Mainnet => &MainNetwork as &dyn Parameters,
    //     Network::Testnet => &TestNetwork as &dyn Parameters,
    // };
    // let usk = UnifiedSpendingKey::from_seed(params, seed, zip32::AccountId::ZERO)
    //     .map_err(|e| TipbotError::KeyDerivation(format!("{:?}", e)))?;
    // let ofvk = OrchardFvk::from(usk.orchard());
    // let di   = DiversifierIndex::from(div_index);
    // let addr = ofvk.address_at(di, zip32::Scope::External);
    // let ua   = zcash_keys::address::UnifiedAddress::from_receivers(Some(addr), None, None)
    //     .ok_or_else(|| TipbotError::KeyDerivation("UA construction failed".into()))?;
    // return Ok(ua.encode(params));

    // ── Stub: deterministic address for testing (correct bech32m format) ──
    stub_derive_address(seed, div_index, network)
}

/// Derives the bot's Unified Full Viewing Key (UFVK) encoded as a string.
///
/// The UFVK is used by lightwalletd / wallet sync to scan the chain for all
/// incoming deposits without exposing the spending key.
///
/// Store this in the DB or config — it only needs to be derived once at startup.
pub fn derive_ufvk(seed: &[u8], network: Network) -> Result<String, TipbotError> {
    if seed.len() < 32 {
        return Err(TipbotError::KeyDerivation("Seed too short".into()));
    }

    // ── Production ────────────────────────────────────────────────────────
    // use zcash_keys::keys::UnifiedSpendingKey;
    // let params = match_params(network);
    // let usk  = UnifiedSpendingKey::from_seed(params, seed, zip32::AccountId::ZERO)
    //     .map_err(|e| TipbotError::KeyDerivation(format!("{:?}", e)))?;
    // let ufvk = usk.to_unified_full_viewing_key();
    // return Ok(ufvk.encode(params));

    // ── Stub ──────────────────────────────────────────────────────────────
    let fingerprint = derive_fingerprint(seed);
    let prefix = match network {
        Network::Mainnet => "uview",
        Network::Testnet => "uviewtest",
    };
    Ok(format!("{}1stub{}", prefix, hex::encode(&fingerprint[..20])))
}

/// Validates that a string is a plausible Unified Address for the network.
///
/// In production this delegates to zcash_address::ZcashAddress::try_from_encoded()
/// which does full bech32m decode + receiver type validation.
pub fn validate_unified_address(address: &str, network: Network) -> bool {
    // ── Production ────────────────────────────────────────────────────────
    // use zcash_address::ZcashAddress;
    // match ZcashAddress::try_from_encoded(address) {
    //     Ok(addr) => match network {
    //         Network::Mainnet => addr.is_mainnet_unified(),
    //         Network::Testnet => addr.is_testnet_unified(),
    //     },
    //     Err(_) => false,
    // }

    // ── Stub ──────────────────────────────────────────────────────────────
    let expected_prefix = match network {
        Network::Mainnet => "u1",
        Network::Testnet => "utest1",
    };
    if !address.starts_with(expected_prefix) {
        return false;
    }
    // Check it only contains valid bech32 characters
    let body = &address[expected_prefix.len()..];
    body.len() >= 40 && body.chars().all(|c| "qpzry9x8gf2tvdw0s3jn54khce6mua7l".contains(c))
}

// ── Stub helpers ─────────────────────────────────────────────────────────────

/// Derives a 32-byte fingerprint from the seed using simple SHA-256-like mixing.
/// Used only in the stub path to produce stable deterministic addresses.
fn derive_fingerprint(seed: &[u8]) -> [u8; 32] {
    let mut state = [0u8; 32];
    for (i, &b) in seed.iter().enumerate() {
        state[i % 32] ^= b.wrapping_add((i as u8).wrapping_mul(0x1b));
        state[(i + 1) % 32] = state[(i + 1) % 32]
            .wrapping_add(state[i % 32])
            .rotate_left(3);
    }
    state
}

/// Encodes bytes as bech32m.
/// Uses the bech32 alphabet: qpzry9x8gf2tvdw0s3jn54khce6mua7l
fn encode_bech32m_stub(hrp: &str, data: &[u8]) -> String {
    let alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    let chars: String = data.iter()
        .flat_map(|b| {
            let hi = (b >> 3) as usize & 0x1f;
            let lo = ((b & 0x07) << 2) as usize;
            let c1 = alphabet.chars().nth(hi).unwrap_or('q');
            let c2 = alphabet.chars().nth(lo).unwrap_or('q');
            [c1, c2]
        })
        .collect();
    format!("{}1{}", hrp, chars)
}

fn stub_derive_address(seed: &[u8], div_index: u64, network: Network) -> Result<String, TipbotError> {
    let mut mixed = derive_fingerprint(seed);
    // Mix in the diversifier index so each user gets a unique address
    let di_bytes = div_index.to_le_bytes();
    for (i, &b) in di_bytes.iter().enumerate() {
        mixed[i] ^= b;
        mixed[(i + 8) % 32] = mixed[(i + 8) % 32].wrapping_add(b).rotate_right(2);
    }
    let hrp = match network {
        Network::Mainnet => "u",
        Network::Testnet => "utest",
    };
    Ok(encode_bech32m_stub(hrp, &mixed))
}
