//! zcash_tipbot_native — Node.js native addon
//!
//! Exposes Zcash cryptographic operations to the tipbot's Node.js layer
//! via napi-rs. All functions that would block (key derivation, tx building)
//! are exposed as async to avoid blocking the Node event loop.
//!
//! # Functions exported to JavaScript
//!
//! | JS name                    | Description                                      |
//! |----------------------------|--------------------------------------------------|
//! | `deriveUnifiedAddress`     | ZIP-316 diversified UA from seed + div_index     |
//! | `deriveUfvk`               | Unified Full Viewing Key for wallet scanning     |
//! | `validateAddress`          | Address validation with typed rejection reasons  |
//! | `calculateFee`             | ZIP-317 fee for N actions                        |
//! | `encodeMemo`               | Build + encode a 512-byte ZIP-302 memo           |
//! | `decodeMemo`               | Decode a hex-encoded 512-byte memo               |
//! | `phraseToSeedHex`          | BIP-39 mnemonic → hex seed bytes                 |
//!
//! # Usage from wallet.js
//!
//! ```js
//! const zcash = require('../native/zcash_tipbot_native.node');
//!
//! const address = await zcash.deriveUnifiedAddress(seedHex, divIndex, 'mainnet');
//! const fee     = zcash.calculateFee(2);
//! const { valid, reason } = zcash.validateAddress('u1abc...', 'mainnet');
//! ```

#![deny(clippy::all)]
#![allow(clippy::new_without_default)]

mod address;
mod error;
mod fees;
mod keys;
mod memo;
mod network;
mod seed;

use napi_derive::napi;

// ─── Types ────────────────────────────────────────────────────────────────────

/// Result of address validation — returned to JavaScript as a plain object.
#[napi(object)]
pub struct AddressValidationResult {
    pub valid: bool,
    /// Human-readable rejection reason, or null if valid.
    pub reason: Option<String>,
    /// Address type string: "unified" | "transparent_p2pkh" | "transparent_p2sh"
    ///                    | "sapling" | "sprout" | "unknown"
    pub address_type: String,
}

/// A decoded tipbot memo — returned to JavaScript as a plain object.
#[napi(object)]
pub struct DecodedMemo {
    pub version: u32,
    pub tx_type: String,
    pub from_handle: Option<String>,
    pub to_handle: Option<String>,
    pub group_name: Option<String>,
    pub community_uuid: String,
    pub message: Option<String>,
}

// ─── Key Derivation ───────────────────────────────────────────────────────────

/// Derives a ZIP-316 Unified Address for the given diversifier index.
///
/// Called once per new user during `/register`. The resulting u1... address
/// is stored in SQLite and shown to the user as their deposit address.
///
/// @param seed_hex   - 64-byte BIP-39 seed as a lowercase hex string
/// @param div_index  - diversifier index (u64); monotonically increasing per user
/// @param network    - "mainnet" or "testnet"
/// @returns          - Unified Address string (u1... or utest1...)
///
/// # Production
/// This function calls into librustzcash:
///   zcash_keys::keys::UnifiedSpendingKey::from_seed() →
///   orchard::keys::FullViewingKey::address_at(DiversifierIndex) →
///   UnifiedAddress::encode()
#[napi]
pub async fn derive_unified_address(
    seed_hex: String,
    div_index: String,
    network: String,
) -> napi::Result<String> {
    let seed = hex::decode(&seed_hex)
        .map_err(|e| napi::Error::new(napi::Status::InvalidArg, format!("Invalid seed hex: {e}")))?;

    let div_idx: u64 = div_index
        .parse()
        .map_err(|e| napi::Error::new(napi::Status::InvalidArg, format!("Invalid div_index: {e}")))?;

    let net = network::Network::from_str(&network)
        .map_err(napi::Error::from)?;

    keys::derive_unified_address(&seed, div_idx, net)
        .map_err(napi::Error::from)
}

/// Derives the bot's Unified Full Viewing Key (UFVK).
///
/// The UFVK allows the wallet scanner to detect all incoming deposits
/// without exposing the spending key. Derive once at startup and cache.
///
/// @param seed_hex - 64-byte seed as hex string
/// @param network  - "mainnet" or "testnet"
/// @returns        - UFVK encoded string
#[napi]
pub async fn derive_ufvk(seed_hex: String, network: String) -> napi::Result<String> {
    let seed = hex::decode(&seed_hex)
        .map_err(|e| napi::Error::new(napi::Status::InvalidArg, format!("Invalid seed hex: {e}")))?;

    let net = network::Network::from_str(&network)
        .map_err(napi::Error::from)?;

    keys::derive_ufvk(&seed, net)
        .map_err(napi::Error::from)
}

/// Converts a BIP-39 mnemonic phrase to a 64-byte seed (hex-encoded).
///
/// @param phrase - space-separated BIP-39 mnemonic (12 or 24 words)
/// @returns      - 64-byte seed as lowercase hex string
///
/// # Security
/// This function must only be called once at startup and the result held
/// in memory. Never log the return value.
#[napi]
pub fn phrase_to_seed_hex(phrase: String) -> napi::Result<String> {
    let seed = seed::phrase_to_seed(&phrase)
        .map_err(napi::Error::from)?;
    Ok(hex::encode(seed))
}

// ─── Address Validation ───────────────────────────────────────────────────────

/// Validates a Zcash address for withdrawal.
///
/// Enforces the Unified-only policy: rejects transparent (t1.../t3...),
/// Sapling (zs1...), Sprout (zc...), and unknown formats.
///
/// @param address - the address string to validate
/// @param network - "mainnet" or "testnet"
/// @returns       - { valid: bool, reason: string|null, address_type: string }
#[napi]
pub fn validate_address(address: String, network: String) -> napi::Result<AddressValidationResult> {
    let net = network::Network::from_str(&network)
        .map_err(napi::Error::from)?;

    let result = address::validate_for_withdrawal(&address, net);

    let type_str = match result.address_type {
        address::AddressType::Unified            => "unified",
        address::AddressType::TransparentP2PKH   => "transparent_p2pkh",
        address::AddressType::TransparentP2SH    => "transparent_p2sh",
        address::AddressType::Sapling            => "sapling",
        address::AddressType::Sprout             => "sprout",
        address::AddressType::Unknown            => "unknown",
    };

    Ok(AddressValidationResult {
        valid: result.valid,
        reason: result.reason,
        address_type: type_str.to_string(),
    })
}

// ─── Fee Calculation ──────────────────────────────────────────────────────────

/// Calculates the ZIP-317 fee for a transaction with `num_actions` logical actions.
///
/// fee = max(2, num_actions) × 5_000 zatoshis
///
/// Standard single send: calculateFee(2) = "10000" zatoshis
/// Rain to 5 users:      calculateFee(6) = "30000" zatoshis
///
/// Returned as a string to avoid JS Number precision loss above 2^53 zatoshis
/// (zatoshi amounts can exceed Number.MAX_SAFE_INTEGER for very large sends).
/// Parse with `BigInt(result)` on the JS side.
///
/// @param num_actions - number of logical Orchard actions
/// @returns           - fee in zatoshis as a decimal string
#[napi]
pub fn calculate_fee(num_actions: u32) -> String {
    fees::zip317_fee(num_actions as u64).to_string()
}

/// Fee for a standard single shielded send (2 actions = 10000 zatoshis).
#[napi]
pub fn standard_fee() -> String {
    fees::standard_fee().to_string()
}

/// Fee for a /rain transaction to N recipients (1 + N actions).
#[napi]
pub fn rain_fee(num_recipients: u32) -> String {
    fees::rain_fee(num_recipients as u64).to_string()
}

// ─── Memo Encoding / Decoding ─────────────────────────────────────────────────

/// Builds and encodes a 512-byte ZIP-302 memo.
///
/// @param tx_type        - "tip" | "rain" | "withdrawal" | "deposit"
/// @param from_handle    - sender's Telegram handle (without @), or null
/// @param to_handle      - recipient's Telegram handle, or null
/// @param group_name     - Telegram group title, or null
/// @param community_uuid - bot's COMMUNITY_UUID from .env
/// @param message        - optional human-readable note (truncated if needed)
/// @returns              - hex-encoded 512-byte memo buffer
#[napi]
pub fn encode_memo(
    tx_type: String,
    from_handle: Option<String>,
    to_handle: Option<String>,
    group_name: Option<String>,
    community_uuid: String,
    message: Option<String>,
) -> napi::Result<String> {
    let m = memo::TipbotMemo {
        version: 1,
        tx_type,
        from_handle,
        to_handle,
        group_name,
        community_uuid,
        message,
    };

    let bytes = m.encode().map_err(napi::Error::from)?;
    Ok(hex::encode(bytes))
}

/// Decodes a hex-encoded 512-byte ZIP-302 memo.
///
/// @param memo_hex - hex string of the 512-byte memo field
/// @returns        - decoded memo object
#[napi]
pub fn decode_memo(memo_hex: String) -> napi::Result<DecodedMemo> {
    let bytes = hex::decode(&memo_hex)
        .map_err(|e| napi::Error::new(napi::Status::InvalidArg, format!("Invalid memo hex: {e}")))?;

    let m = memo::TipbotMemo::decode(&bytes)
        .map_err(napi::Error::from)?;

    Ok(DecodedMemo {
        version: m.version as u32,
        tx_type: m.tx_type,
        from_handle: m.from_handle,
        to_handle: m.to_handle,
        group_name: m.group_name,
        community_uuid: m.community_uuid,
        message: m.message,
    })
}

// ─── Version ──────────────────────────────────────────────────────────────────

/// Returns the addon version and build info.
#[napi]
pub fn version() -> String {
    format!(
        "zcash_tipbot_native v{} | rustc {} | napi-rs",
        env!("CARGO_PKG_VERSION"),
        "1.75+" // replaced by rustc --version at build time in production
    )
}
