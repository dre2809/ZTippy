//! BIP-39 mnemonic → seed bytes.
//!
//! Production integration point:
//!   bip0039::Mnemonic::from_phrase(phrase, Language::English)
//!     .map_err(|e| TipbotError::Bip39(e.to_string()))?
//!     .to_seed("")   // empty passphrase per Zcash convention
//!
//! The 64-byte seed is then passed into the ZIP-32 derivation chain.

use crate::error::TipbotError;

/// Derive 64 raw seed bytes from a BIP-39 mnemonic phrase.
///
/// # Production
/// Replace the body with:
/// ```ignore
/// use bip0039::{Language, Mnemonic};
/// let mnemonic = Mnemonic::from_phrase(phrase, Language::English)
///     .map_err(|e| TipbotError::Bip39(e.to_string()))?;
/// Ok(mnemonic.to_seed("").to_vec())
/// ```
pub fn phrase_to_seed(phrase: &str) -> Result<Vec<u8>, TipbotError> {    // ── Validation (works without bip0039 crate) ──────────────────────────
    let words: Vec<&str> = phrase.split_whitespace().collect();
    let valid_lengths = [12, 15, 18, 21, 24];
    if !valid_lengths.contains(&words.len()) {
        return Err(TipbotError::Bip39(format!(
            "Invalid mnemonic: expected 12/15/18/21/24 words, got {}",
            words.len()
        )));
    }

    // ── Production: use bip0039 crate ────────────────────────────────────
    // Uncomment the block below and remove the PBKDF2 stub once
    // bip0039 = "0.14" is added back to Cargo.toml (requires Rust ≥ 1.85).
    //
    // use bip0039::{Language, Mnemonic};
    // let mnemonic = Mnemonic::from_phrase(phrase, Language::English)
    //     .map_err(|e| TipbotError::Bip39(e.to_string()))?;
    // return Ok(mnemonic.to_seed("").to_vec());

    // ── Stub: deterministic PBKDF2-HMAC-SHA512 (matches BIP-39 spec) ─────
    // This produces the correct bytes when the crate is unavailable.
    pbkdf2_hmac_sha512(phrase)
}

/// BIP-39 §5: seed = PBKDF2(HMAC-SHA512, mnemonic, "mnemonic", 2048, 64)
fn pbkdf2_hmac_sha512(mnemonic: &str) -> Result<Vec<u8>, TipbotError> {
    // Simple pure-Rust PBKDF2 with SHA-512.
    let password = mnemonic.as_bytes();
    let salt = b"mnemonic"; // BIP-39 spec: salt = "mnemonic" + optional passphrase
    let iterations: u32 = 2048;
    let mut seed = vec![0u8; 64];

    // Manual HMAC-SHA512 PBKDF2 — matches the BIP-39 test vectors.
    pbkdf2_inner(password, salt, iterations, &mut seed);
    Ok(seed)
}

/// Inner PBKDF2-HMAC-SHA512 implementation.
/// F(password, salt, c, i) = U1 XOR U2 XOR ... XOR Uc
/// where U1 = PRF(password, salt || INT(i))
fn pbkdf2_inner(password: &[u8], salt: &[u8], iterations: u32, output: &mut [u8]) {
    let hlen = 64usize; // SHA-512 output length
    let blocks = (output.len() + hlen - 1) / hlen;

    for block_idx in 1..=blocks {
        let start = (block_idx - 1) * hlen;
        let end = (start + hlen).min(output.len());

        // U1 = HMAC-SHA512(password, salt || BE32(block_idx))
        let mut u_prev = {
            let mut msg = salt.to_vec();
            msg.extend_from_slice(&(block_idx as u32).to_be_bytes());
            hmac_sha512(password, &msg)
        };

        let mut xor_result = u_prev.clone();

        for _ in 1..iterations {
            u_prev = hmac_sha512(password, &u_prev);
            for (a, b) in xor_result.iter_mut().zip(u_prev.iter()) {
                *a ^= b;
            }
        }

        output[start..end].copy_from_slice(&xor_result[..end - start]);
    }
}

/// HMAC-SHA512 using pure Rust (no external crate required for this stub).
fn hmac_sha512(key: &[u8], data: &[u8]) -> Vec<u8> {
    const BLOCK_SIZE: usize = 128; // SHA-512 block size

    // Key normalisation
    let mut k = vec![0u8; BLOCK_SIZE];
    if key.len() > BLOCK_SIZE {
        let hashed = sha512(key);
        k[..hashed.len()].copy_from_slice(&hashed);
    } else {
        k[..key.len()].copy_from_slice(key);
    }

    let ipad: Vec<u8> = k.iter().map(|b| b ^ 0x36).collect();
    let opad: Vec<u8> = k.iter().map(|b| b ^ 0x5c).collect();

    let inner = sha512(&[ipad.as_slice(), data].concat());
    sha512(&[opad.as_slice(), inner.as_slice()].concat())
}

/// SHA-512 using the Rust standard integer arithmetic — no deps needed.
/// This is the standard FIPS 180-4 implementation.
fn sha512(msg: &[u8]) -> Vec<u8> {
    // Initial hash values (first 64 bits of fractional parts of sqrt of first 8 primes)
    let mut h: [u64; 8] = [
        0x6a09e667f3bcc908, 0xbb67ae8584caa73b,
        0x3c6ef372fe94f82b, 0xa54ff53a5f1d36f1,
        0x510e527fade682d1, 0x9b05688c2b3e6c1f,
        0x1f83d9abfb41bd6b, 0x5be0cd19137e2179,
    ];

    // Round constants
    let k: [u64; 80] = [
        0x428a2f98d728ae22, 0x7137449123ef65cd, 0xb5c0fbcfec4d3b2f, 0xe9b5dba58189dbbc,
        0x3956c25bf348b538, 0x59f111f1b605d019, 0x923f82a4af194f9b, 0xab1c5ed5da6d8118,
        0xd807aa98a3030242, 0x12835b0145706fbe, 0x243185be4ee4b28c, 0x550c7dc3d5ffb4e2,
        0x72be5d74f27b896f, 0x80deb1fe3b1696b1, 0x9bdc06a725c71235, 0xc19bf174cf692694,
        0xe49b69c19ef14ad2, 0xefbe4786384f25e3, 0x0fc19dc68b8cd5b5, 0x240ca1cc77ac9c65,
        0x2de92c6f592b0275, 0x4a7484aa6ea6e483, 0x5cb0a9dcbd41fbd4, 0x76f988da831153b5,
        0x983e5152ee66dfab, 0xa831c66d2db43210, 0xb00327c898fb213f, 0xbf597fc7beef0ee4,
        0xc6e00bf33da88fc2, 0xd5a79147930aa725, 0x06ca6351e003826f, 0x142929670a0e6e70,
        0x27b70a8546d22ffc, 0x2e1b21385c26c926, 0x4d2c6dfc5ac42aed, 0x53380d139d95b3df,
        0x650a73548baf63de, 0x766a0abb3c77b2a8, 0x81c2c92e47edaee6, 0x92722c851482353b,
        0xa2bfe8a14cf10364, 0xa81a664bbc423001, 0xc24b8b70d0f89791, 0xc76c51a30654be30,
        0xd192e819d6ef5218, 0xd69906245565a910, 0xf40e35855771202a, 0x106aa07032bbd1b8,
        0x19a4c116b8d2d0c8, 0x1e376c085141ab53, 0x2748774cdf8eeb99, 0x34b0bcb5e19b48a8,
        0x391c0cb3c5c95a63, 0x4ed8aa4ae3418acb, 0x5b9cca4f7763e373, 0x682e6ff3d6b2b8a3,
        0x748f82ee5defb2fc, 0x78a5636f43172f60, 0x84c87814a1f0ab72, 0x8cc702081a6439ec,
        0x90befffa23631e28, 0xa4506cebde82bde9, 0xbef9a3f7b2c67915, 0xc67178f2e372532b,
        0xca273eceea26619c, 0xd186b8c721c0c207, 0xeada7dd6cde0eb1e, 0xf57d4f7fee6ed178,
        0x06f067aa72176fba, 0x0a637dc5a2c898a6, 0x113f9804bef90dae, 0x1b710b35131c471b,
        0x28db77f523047d84, 0x32caab7b40c72493, 0x3c9ebe0a15c9bebc, 0x431d67c49c100d4c,
        0x4cc5d4becb3e42b6, 0x597f299cfc657e2a, 0x5fcb6fab3ad6faec, 0x6c44198c4a475817,
    ];

    // Pre-processing: padding
    let bit_len = (msg.len() as u128) * 8;
    let mut padded = msg.to_vec();
    padded.push(0x80);
    while padded.len() % 128 != 112 {
        padded.push(0x00);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    // Process each 1024-bit block
    for chunk in padded.chunks(128) {
        let mut w = [0u64; 80];
        for i in 0..16 {
            w[i] = u64::from_be_bytes(chunk[i*8..(i+1)*8].try_into().unwrap());
        }
        for i in 16..80 {
            let s0 = w[i-15].rotate_right(1) ^ w[i-15].rotate_right(8) ^ (w[i-15] >> 7);
            let s1 = w[i-2].rotate_right(19) ^ w[i-2].rotate_right(61) ^ (w[i-2] >> 6);
            w[i] = w[i-16].wrapping_add(s0).wrapping_add(w[i-7]).wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] =
            [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]];

        for i in 0..80 {
            let s1 = e.rotate_right(14) ^ e.rotate_right(18) ^ e.rotate_right(41);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(k[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(28) ^ a.rotate_right(34) ^ a.rotate_right(39);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            hh = g; g = f; f = e;
            e = d.wrapping_add(temp1);
            d = c; c = b; b = a;
            a = temp1.wrapping_add(temp2);
        }

        h[0] = h[0].wrapping_add(a); h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c); h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e); h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g); h[7] = h[7].wrapping_add(hh);
    }

    h.iter().flat_map(|v| v.to_be_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Official BIP-39 test vector (no passphrase).
    /// Source: https://github.com/trezor/python-mnemonic/blob/master/vectors.json
    ///
    /// mnemonic: "abandon abandon abandon abandon abandon abandon abandon
    ///            abandon abandon abandon abandon about"
    /// expected seed (hex):
    ///   5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc
    ///   19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38
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
    fn test_seed_is_64_bytes() {
        let phrase = "abandon abandon abandon abandon abandon abandon abandon \
                       abandon abandon abandon abandon about";
        let seed = phrase_to_seed(phrase).unwrap();
        assert_eq!(seed.len(), 64);
    }

    #[test]
    fn test_invalid_word_count_rejected() {
        let result = phrase_to_seed("only three words");
        assert!(result.is_err());
    }

    #[test]
    fn test_sha512_known_vector() {
        // SHA-512("") official FIPS test vector
        let digest = sha512(b"");
        let expected = "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9c\
                         e47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e";
        assert_eq!(hex::encode(&digest), expected);
    }
}
