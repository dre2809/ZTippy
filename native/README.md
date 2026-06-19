# zcash-tipbot-native

Rust native addon (napi-rs) providing Zcash cryptographic primitives to the
tipbot's Node.js layer: ZIP-316 address derivation, ZIP-317 fees, ZIP-302
memo encoding, and address validation.

---

## Status

| Module | Status |
|---|---|
| `fees.rs` — ZIP-317 fee calculation | ✅ Production-ready, pure Rust, fully tested |
| `memo.rs` — ZIP-302 memo encode/decode | ✅ Production-ready, pure Rust, fully tested |
| `address.rs` — address classification & rejection | ✅ Production-ready (structural validation) |
| `seed.rs` — BIP-39 mnemonic → seed | ✅ Production-ready, verified against official BIP-39 test vector |
| `keys.rs` — ZIP-316 diversified address derivation | ⚠️ **Stub** — produces correctly-formatted but cryptographically fake addresses |

**Before mainnet deployment**, `keys.rs` must be wired to the real
`zcash_keys` / `orchard` crates — see "Upgrading to Real Key Derivation" below.
Everything else is real, tested, production-grade Rust.

---

## Why `keys.rs` is a stub

The real `librustzcash` crate ecosystem (`orchard 0.14`, `zcash_primitives 0.28`,
`zcash_keys 0.14`) requires **Rust edition 2024**, stabilized in **Rust 1.85**
(early 2025). This sandbox's build toolchain is pinned to Rust 1.75, which
cannot compile those crates — `cargo check` fails with:

```
error: package `unicode-segmentation v1.13.3` cannot be built because it
requires rustc 1.85.0 or newer
```

Rather than leave the addon entirely unbuildable, every module that *can*
be written in portable Rust was written for real:

- **`fees.rs`** has no external crate dependency — it's just arithmetic per
  the ZIP-317 spec. Fully real, fully tested.
- **`memo.rs`** is a hand-rolled JSON encoder/decoder with null-padding to
  512 bytes per ZIP-302. No crate needed. Fully real, fully tested.
- **`seed.rs`** implements PBKDF2-HMAC-SHA512 from scratch (the BIP-39 §5
  algorithm) because `bip0039` also pulls in edition-2024 transitive deps.
  **Verified against the official BIP-39 test vector** — see `cargo test`.
- **`address.rs`** does structural classification (prefix + bech32m charset
  check) rather than full cryptographic decode, since `zcash_address` also
  requires edition 2024.
- **`keys.rs`** is the one module that *cannot* be done without the real
  Orchard key derivation — diversified address generation requires actual
  elliptic curve operations from the `orchard` crate. The stub here produces
  addresses that are correctly *formatted* (so the rest of the bot — DB
  schema, Telegram UX, fee math — can be fully built and tested) but are
  **not spendable real Zcash addresses**.

---

## Upgrading to Real Key Derivation

### 1. Upgrade Rust

```bash
rustup update stable
rustc --version   # confirm ≥ 1.85.0
```

### 2. Uncomment the real dependencies in `Cargo.toml`

```toml
[dependencies]
napi        = { version = "2.16", features = ["napi4", "async"] }
napi-derive = "2.16"
hex         = "0.4"
thiserror   = "1"

# Uncomment these:
zcash_primitives     = "0.28"
zcash_client_backend = "0.23"
zcash_keys           = "0.14"
zcash_address        = "0.12"
orchard              = "0.14"
bip0039 = { version = "0.14", features = ["all-languages"] }
zip32   = "0.2"
```

Remove the `cargo update --precise` pins for `unicode-segmentation` and
`napi-build` from `Cargo.lock` (delete `Cargo.lock` and run `cargo build`
fresh) — those pins only existed to work around the Rust 1.75 ceiling.

### 3. Replace `keys.rs` with the real implementation

Every function in `keys.rs` has the exact production code already written
**as a comment directly above the stub call** — for example:

```rust
pub fn derive_unified_address(
    seed: &[u8],
    div_index: u64,
    network: Network,
) -> Result<String, TipbotError> {
    use zcash_keys::keys::UnifiedSpendingKey;
    use zcash_primitives::consensus::MainNetwork;
    use orchard::keys::FullViewingKey as OrchardFvk;
    use zip32::DiversifierIndex;

    let params = match network { /* MainNetwork or TestNetwork */ };
    let usk = UnifiedSpendingKey::from_seed(params, seed, zip32::AccountId::ZERO)
        .map_err(|e| TipbotError::KeyDerivation(format!("{:?}", e)))?;
    let ofvk = OrchardFvk::from(usk.orchard());
    let di   = DiversifierIndex::from(div_index);
    let addr = ofvk.address_at(di, zip32::Scope::External);
    let ua   = zcash_keys::address::UnifiedAddress::from_receivers(Some(addr), None, None)
        .ok_or_else(|| TipbotError::KeyDerivation("UA construction failed".into()))?;
    Ok(ua.encode(params))
}
```

Just delete the stub call (`stub_derive_address(...)`) and uncomment the
block above it. Same pattern for `derive_ufvk()` and `validate_unified_address()`.

### 4. Replace `seed.rs`'s manual PBKDF2 with the `bip0039` crate

```rust
pub fn phrase_to_seed(phrase: &str) -> Result<Vec<u8>, TipbotError> {
    use bip0039::{Language, Mnemonic};
    let mnemonic = Mnemonic::from_phrase(phrase, Language::English)
        .map_err(|e| TipbotError::Bip39(e.to_string()))?;
    Ok(mnemonic.to_seed("").to_vec())
}
```

This produces byte-identical output to the manual implementation (verified
by `test_bip39_official_vector` in `seed.rs`), so swapping it is a drop-in
replacement with zero behavior change — just better-audited code.

### 5. Replace `address.rs`'s structural check with full crate validation

```rust
pub fn validate_for_withdrawal(address: &str, network: Network) -> ValidationResult {
    use zcash_address::ZcashAddress;
    match ZcashAddress::try_from_encoded(address) {
        Ok(addr) => {
            // inspect addr's receiver types, confirm it's Unified + Orchard
        }
        Err(e) => ValidationResult { valid: false, reason: Some(e.to_string()), .. }
    }
}
```

### 6. Implement transaction building (new module: `tx_builder.rs`)

This is the one piece with no stub at all yet, since it requires real key
material to test meaningfully. Production implementation sketch:

```rust
use zcash_client_backend::{
    wallet::OvkPolicy,
    zip321::TransactionRequest,
};
use zcash_primitives::transaction::builder::Builder;

pub async fn build_orchard_tx(
    seed: &[u8],
    to_address: &str,
    amount_zats: u64,
    fee_zats: u64,
    memo_bytes: [u8; 512],
    network: Network,
) -> Result<Vec<u8>, TipbotError> {
    // 1. Derive USK from seed
    // 2. Select Orchard notes covering amount + fee
    // 3. Build Builder with input notes, output (to_address, amount, memo)
    // 4. Generate Halo 2 proof (orchard::Bundle::create_proof)
    // 5. Sign with spending key
    // 6. Serialize to raw transaction bytes
    // 7. Return bytes for lightwalletd SendTransaction
}
```

Wire this into `lib.rs` as a new `#[napi]` export `buildOrchardTx`, then
call it from `wallet.js`'s `broadcastWithdrawal()`.

### 7. Rebuild

```bash
cd native
rm Cargo.lock
npm run build
```

The resulting `.node` binary replaces the stub one — no changes needed to
`wallet.js`, `bot.js`, or any other JS file. The napi function signatures
are identical; only the Rust implementation changes.

---

## Building (current, stub mode)

Works today on Rust 1.75+:

```bash
cd native
npm install
npm run build        # napi build --platform --release
npm test              # cargo test — 16 tests, including BIP-39 vector
```

## Building (production, real crypto)

Requires Rust ≥ 1.85:

```bash
rustup update stable
# Follow "Upgrading to Real Key Derivation" above first
cd native
rm Cargo.lock
npm install
npm run build
```

---

## Test Coverage

```bash
cargo test
```

```
running 16 tests
test address::tests::test_classify ... ok
test address::tests::test_sapling_rejected ... ok
test address::tests::test_transparent_rejected ... ok
test address::tests::test_ua_accepted_mainnet ... ok
test address::tests::test_wrong_network ... ok
test fees::tests::test_grace_floor ... ok
test fees::tests::test_proportional_scaling ... ok
test fees::tests::test_rain_fee ... ok
test fees::tests::test_standard_fee ... ok
test memo::tests::test_encode_decode_roundtrip ... ok
test memo::tests::test_null_padding ... ok
test memo::tests::test_zip317_fee_sanity ... ok
test seed::tests::test_bip39_official_vector ... ok      ← verified against Trezor's BIP-39 vectors.json
test seed::tests::test_invalid_word_count_rejected ... ok
test seed::tests::test_seed_is_64_bytes ... ok
test seed::tests::test_sha512_known_vector ... ok        ← verified against FIPS 180-4 known answer

test result: ok. 16 passed; 0 failed; 0 ignored
```

---

## Exported Functions

All functions are camelCase in JS (napi-rs auto-converts from Rust snake_case).
See `index.d.ts` for full TypeScript signatures.

| JS function | Rust source | Real or stub? |
|---|---|---|
| `deriveUnifiedAddress(seedHex, divIndex, network)` | `keys.rs` | ⚠️ Stub |
| `deriveUfvk(seedHex, network)` | `keys.rs` | ⚠️ Stub |
| `phraseToSeedHex(phrase)` | `seed.rs` | ✅ Real (verified) |
| `validateAddress(address, network)` | `address.rs` | ✅ Real (structural) |
| `calculateFee(numActions)` | `fees.rs` | ✅ Real |
| `standardFee()` | `fees.rs` | ✅ Real |
| `rainFee(numRecipients)` | `fees.rs` | ✅ Real |
| `encodeMemo(...)` | `memo.rs` | ✅ Real |
| `decodeMemo(memoHex)` | `memo.rs` | ✅ Real |
| `version()` | `lib.rs` | ✅ Real |

---

## File Structure

```
native/
├── Cargo.toml          # dependencies (zcash crates commented out — see above)
├── build.rs             # napi-build setup
├── package.json         # npm scripts: build, test, artifacts
├── index.js              # platform-aware .node loader
├── index.d.ts            # TypeScript definitions
└── src/
    ├── lib.rs            # napi #[napi] exports — the JS↔Rust boundary
    ├── error.rs          # unified TipbotError type
    ├── network.rs        # Mainnet/Testnet enum
    ├── seed.rs            # BIP-39 → seed (real, hand-rolled PBKDF2)
    ├── keys.rs            # ZIP-316 derivation (STUB — see above)
    ├── fees.rs            # ZIP-317 fee calculation (real)
    ├── memo.rs            # ZIP-302 memo encode/decode (real)
    └── address.rs         # address classification & validation (real, structural)
```
