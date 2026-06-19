//! Network selection helpers.
//!
//! Wraps zcash_primitives::consensus::{MainNetwork, TestNetwork}
//! behind a runtime enum so JS can pass "mainnet" / "testnet" as a string.

use crate::error::TipbotError;

/// Runtime Zcash network selector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Network {
    Mainnet,
    Testnet,
}

impl Network {
    /// Parse from the string values used in .env (ZCASH_NETWORK).
    pub fn from_str(s: &str) -> Result<Self, TipbotError> {
        match s.to_lowercase().as_str() {
            "mainnet" => Ok(Network::Mainnet),
            "testnet" => Ok(Network::Testnet),
            other => Err(TipbotError::InvalidNetwork(other.to_string())),
        }
    }

    /// Human-readable name, used in address encoding.
    pub fn as_str(&self) -> &'static str {
        match self {
            Network::Mainnet => "mainnet",
            Network::Testnet => "testnet",
        }
    }

    /// Hrp prefix for Unified Addresses on this network.
    /// ZIP-316: mainnet "u", testnet "utest"
    pub fn ua_hrp(&self) -> &'static str {
        match self {
            Network::Mainnet => "u",
            Network::Testnet => "utest",
        }
    }
}
