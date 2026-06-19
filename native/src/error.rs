//! Unified error type for the tipbot native addon.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum TipbotError {
    #[error("BIP-39 error: {0}")]
    Bip39(String),

    #[error("Key derivation error: {0}")]
    KeyDerivation(String),

    #[error("Invalid address: {0}")]
    InvalidAddress(String),

    #[error("Invalid network: expected 'mainnet' or 'testnet', got '{0}'")]
    InvalidNetwork(String),

    #[error("Invalid diversifier index: {0}")]
    InvalidDiversifier(String),

    #[error("Transaction build error: {0}")]
    TxBuild(String),

    #[error("Memo error: {0}")]
    Memo(String),

    #[error("Encoding error: {0}")]
    Encoding(String),

    #[error("Internal error: {0}")]
    Internal(String),
}

impl From<TipbotError> for napi::Error {
    fn from(e: TipbotError) -> napi::Error {
        napi::Error::new(napi::Status::GenericFailure, e.to_string())
    }
}
