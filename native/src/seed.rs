//! BIP-39 mnemonic → seed bytes — PRODUCTION IMPLEMENTATION

use crate::error::TipbotError;
use bip0039::{English, Mnemonic};

pub fn phrase_to_seed(phrase: &str) -> Result<Vec<u8>, TipbotError> {
    let mnemonic = Mnemonic::<English>::from_phrase(phrase)
        .map_err(|e| TipbotError::Bip39(e.to_string()))?;
    Ok(mnemonic.to_seed("").to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bip39_official_vector() {
        let phrase = "abandon abandon abandon abandon abandon abandon abandon \
                       abandon abandon abandon abandon about";
        let seed = phrase_to_seed(phrase).unwrap();
        let expected = "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc\
                         19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4";
        assert_eq!(hex::encode(&seed), expected);
    }

    #[test]
    fn test_invalid_mnemonic_rejected() {
        let result = phrase_to_seed("only three words");
        assert!(result.is_err());
    }

    #[test]
    fn test_seed_is_64_bytes() {
        let phrase = "abandon abandon abandon abandon abandon abandon abandon \
                       abandon abandon abandon abandon about";
        let seed = phrase_to_seed(phrase).unwrap();
        assert_eq!(seed.len(), 64);
    }
}
