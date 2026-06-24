use napi_derive::napi;
use napi::Error;
use orchard::{
    keys::{FullViewingKey, Scope},
    note_encryption::{CompactAction, OrchardDomain},
    note::ExtractedNoteCommitment,
};
use orchard::note::Nullifier;
use zcash_note_encryption::{try_compact_note_decryption, EphemeralKeyBytes};

#[napi]
pub fn trial_decrypt_compact_action(
    seed_hex: String,
    nullifier_hex: String,
    cmx_hex: String,
    epk_hex: String,
    enc_cipher_hex: String,
    network: String,
) -> napi::Result<Option<i64>> {
    let seed = hex::decode(&seed_hex)
        .map_err(|e| Error::from_reason(format!("Invalid seed hex: {}", e)))?;
    if seed.len() != 64 {
        return Err(Error::from_reason("Seed must be 64 bytes"));
    }

    let net = crate::network::Network::from_str(&network).map_err(|e| Error::from_reason(format!("Invalid network: {:?}", e)))?;
    let fvk = match net {
        crate::network::Network::Mainnet => {
            let usk = zcash_keys::keys::UnifiedSpendingKey::from_seed(&zcash_protocol::consensus::MainNetwork, &seed, zip32::AccountId::ZERO)
                .map_err(|e| Error::from_reason(format!("USK derivation failed: {:?}", e)))?;
            orchard::keys::FullViewingKey::from(usk.orchard())
        },
        crate::network::Network::Testnet => {
            let usk = zcash_keys::keys::UnifiedSpendingKey::from_seed(&zcash_protocol::consensus::TestNetwork, &seed, zip32::AccountId::ZERO)
                .map_err(|e| Error::from_reason(format!("USK derivation failed: {:?}", e)))?;
            orchard::keys::FullViewingKey::from(usk.orchard())
        },
    };
    let ivk = fvk.to_ivk(Scope::External).prepare();

    let nullifier_bytes: [u8; 32] = hex::decode(&nullifier_hex)
        .map_err(|e| Error::from_reason(format!("Invalid nullifier: {}", e)))?
        .try_into()
        .map_err(|_| Error::from_reason("Nullifier must be 32 bytes"))?;

    let cmx_bytes: [u8; 32] = hex::decode(&cmx_hex)
        .map_err(|e| Error::from_reason(format!("Invalid cmx: {}", e)))?
        .try_into()
        .map_err(|_| Error::from_reason("cmx must be 32 bytes"))?;

    let epk_bytes: [u8; 32] = hex::decode(&epk_hex)
        .map_err(|e| Error::from_reason(format!("Invalid epk: {}", e)))?
        .try_into()
        .map_err(|_| Error::from_reason("epk must be 32 bytes"))?;

    let enc_bytes: [u8; 52] = hex::decode(&enc_cipher_hex)
        .map_err(|e| Error::from_reason(format!("Invalid enc_ciphertext: {}", e)))?
        .try_into()
        .map_err(|_| Error::from_reason("enc_ciphertext must be 52 bytes"))?;

    let nullifier = Option::from(Nullifier::from_bytes(&nullifier_bytes))
        .ok_or_else(|| Error::from_reason("Invalid nullifier bytes"))?;

    let cmx = Option::from(ExtractedNoteCommitment::from_bytes(&cmx_bytes))
        .ok_or_else(|| Error::from_reason("Invalid cmx bytes"))?;

    let ephemeral_key = EphemeralKeyBytes(epk_bytes);
    let compact_action = CompactAction::from_parts(nullifier, cmx, ephemeral_key, enc_bytes);
    let domain = OrchardDomain::for_compact_action(&compact_action);

    match try_compact_note_decryption(&domain, &ivk, &compact_action) {
        Some((note, _)) => Ok(Some(note.value().inner() as i64)),
        None => Ok(None),
    }
}
