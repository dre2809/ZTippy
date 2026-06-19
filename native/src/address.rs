//! Zcash address validation and classification.
//!
//! The tipbot enforces a strict address policy:
//!   - Only Unified Addresses (u1... / utest1...) are accepted
//!   - Transparent addresses (t1...) are rejected
//!   - Sapling addresses (zs1...) are rejected
//!   - Any other format is rejected
//!
//! Production uses zcash_address::ZcashAddress::try_from_encoded() for full
//! cryptographic validation. The stub validates structure only.

use crate::network::Network;

/// Classification of a Zcash address string.
#[derive(Debug, PartialEq, Eq)]
pub enum AddressType {
    /// Unified Address (ZIP-316) — the only type accepted for deposits/withdrawals.
    Unified,
    /// Transparent p2pkh (t1...) — rejected.
    TransparentP2PKH,
    /// Transparent p2sh (t3...) — rejected.
    TransparentP2SH,
    /// Sapling (zs1...) — rejected.
    Sapling,
    /// Sprout (zc...) — rejected.
    Sprout,
    /// Unknown / unrecognised format.
    Unknown,
}

/// Classifies a Zcash address string without fully validating it.
pub fn classify(address: &str) -> AddressType {
    if address.starts_with("u1") || address.starts_with("utest1") {
        AddressType::Unified
    } else if address.starts_with("t1") {
        AddressType::TransparentP2PKH
    } else if address.starts_with("t3") {
        AddressType::TransparentP2SH
    } else if address.starts_with("zs1") {
        AddressType::Sapling
    } else if address.starts_with("zc") {
        AddressType::Sprout
    } else {
        AddressType::Unknown
    }
}

/// Result of address validation.
#[derive(Debug)]
pub struct ValidationResult {
    pub valid: bool,
    pub address_type: AddressType,
    /// Human-readable rejection reason (None if valid).
    pub reason: Option<String>,
}

/// Validates an address, enforcing the Unified-only policy.
///
/// Returns a structured result so the bot can give helpful error messages.
///
/// # Production
/// Replace the body with:
/// ```ignore
/// use zcash_address::ZcashAddress;
/// match ZcashAddress::try_from_encoded(address) {
///     Ok(addr) if addr.is_unified() => ValidationResult { valid: true, ... },
///     Ok(_) => ValidationResult { valid: false, reason: Some("Not a Unified Address".into()), ... },
///     Err(e) => ValidationResult { valid: false, reason: Some(e.to_string()), ... },
/// }
/// ```
pub fn validate_for_withdrawal(address: &str, network: Network) -> ValidationResult {
    match classify(address) {
        AddressType::Unified => {
            // Check network prefix matches
            let ok = match network {
                Network::Mainnet => address.starts_with("u1"),
                Network::Testnet => address.starts_with("utest1"),
            };
            if ok {
                ValidationResult { valid: true, address_type: AddressType::Unified, reason: None }
            } else {
                ValidationResult {
                    valid: false,
                    address_type: AddressType::Unified,
                    reason: Some(format!(
                        "Address is for the wrong network. Expected {} address.",
                        network.as_str()
                    )),
                }
            }
        }
        AddressType::TransparentP2PKH | AddressType::TransparentP2SH => ValidationResult {
            valid: false,
            address_type: classify(address),
            reason: Some(
                "Transparent addresses (t1.../t3...) are not accepted. \
                 Please use a Unified Address (u1...) from a shielded wallet \
                 like Zashi, Ywallet, or Nighthawk.".into()
            ),
        },
        AddressType::Sapling => ValidationResult {
            valid: false,
            address_type: AddressType::Sapling,
            reason: Some(
                "Sapling addresses (zs1...) are not accepted. \
                 Please use a Unified Address (u1...) — upgrade your wallet to \
                 Zashi or Ywallet to generate one.".into()
            ),
        },
        AddressType::Sprout => ValidationResult {
            valid: false,
            address_type: AddressType::Sprout,
            reason: Some("Sprout addresses are deprecated. Please use a Unified Address (u1...).".into()),
        },
        AddressType::Unknown => ValidationResult {
            valid: false,
            address_type: AddressType::Unknown,
            reason: Some(
                "Unrecognised address format. \
                 A Zcash Unified Address starts with 'u1' (mainnet) or 'utest1' (testnet).".into()
            ),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify() {
        assert_eq!(classify("u1abc"), AddressType::Unified);
        assert_eq!(classify("utest1abc"), AddressType::Unified);
        assert_eq!(classify("t1abc"), AddressType::TransparentP2PKH);
        assert_eq!(classify("t3abc"), AddressType::TransparentP2SH);
        assert_eq!(classify("zs1abc"), AddressType::Sapling);
        assert_eq!(classify("zc1abc"), AddressType::Sprout);
        assert_eq!(classify("garbage"), AddressType::Unknown);
    }

    #[test]
    fn test_transparent_rejected() {
        let r = validate_for_withdrawal("t1abc123", Network::Mainnet);
        assert!(!r.valid);
        assert!(r.reason.unwrap().contains("Transparent"));
    }

    #[test]
    fn test_sapling_rejected() {
        let r = validate_for_withdrawal("zs1abc123", Network::Mainnet);
        assert!(!r.valid);
        assert!(r.reason.unwrap().contains("Sapling"));
    }

    #[test]
    fn test_ua_accepted_mainnet() {
        // Stub address from keys module
        let r = validate_for_withdrawal("u1qpzry9x8gf2tvdw0s3jn54khce6mua7lxyz", Network::Mainnet);
        assert!(r.valid);
    }

    #[test]
    fn test_wrong_network() {
        let r = validate_for_withdrawal("utest1abc", Network::Mainnet);
        assert!(!r.valid);
        assert!(r.reason.unwrap().contains("wrong network"));
    }
}
