//! ZIP-302 / ZIP-307 encrypted memo field handling.
//!
//! Zcash shielded transactions carry a 512-byte encrypted memo field.
//! This module encodes and decodes the structured JSON payloads the tipbot
//! stores in every on-chain transaction (withdrawals).
//!
//! The memo is encrypted in-circuit by the Orchard proving system —
//! only the holder of the incoming viewing key can read it.
//!
//! Reference: https://zips.z.cash/zip-0302

use crate::error::TipbotError;

/// Maximum memo size in bytes (ZIP-302).
pub const MAX_MEMO_BYTES: usize = 512;

/// The structured payload written into every tipbot transaction memo.
#[derive(Debug)]
pub struct TipbotMemo {
    /// Schema version — increment if the format changes.
    pub version: u8,
    /// Transaction type: "tip", "rain", "withdrawal", "deposit"
    pub tx_type: String,
    /// Sender's Telegram handle (without @).
    pub from_handle: Option<String>,
    /// Recipient's Telegram handle (without @).
    pub to_handle: Option<String>,
    /// Telegram group name where the tip originated.
    pub group_name: Option<String>,
    /// Community UUID — unique per ambassador community deployment.
    pub community_uuid: String,
    /// Optional human-readable message (truncated to fit in 512 bytes).
    pub message: Option<String>,
}

impl TipbotMemo {
    /// Encodes the memo as a UTF-8 JSON string padded to exactly 512 bytes.
    ///
    /// Padding uses null bytes as per ZIP-302 §3.
    /// If the JSON exceeds 512 bytes, the `message` field is first truncated,
    /// then removed entirely.
    pub fn encode(&self) -> Result<[u8; MAX_MEMO_BYTES], TipbotError> {
        let json = self.to_json(self.message.as_deref())?;

        if json.len() > MAX_MEMO_BYTES {
            // Try without message
            let json_no_msg = self.to_json(None)?;
            if json_no_msg.len() > MAX_MEMO_BYTES {
                return Err(TipbotError::Memo(format!(
                    "Memo too large even without message: {} bytes",
                    json_no_msg.len()
                )));
            }
            let mut buf = [0u8; MAX_MEMO_BYTES];
            buf[..json_no_msg.len()].copy_from_slice(json_no_msg.as_bytes());
            return Ok(buf);
        }

        let mut buf = [0u8; MAX_MEMO_BYTES];
        buf[..json.len()].copy_from_slice(json.as_bytes());
        Ok(buf)
    }

    /// Decodes a 512-byte memo buffer back into a TipbotMemo.
    pub fn decode(bytes: &[u8]) -> Result<Self, TipbotError> {
        // Strip null padding
        let end = bytes.iter().rposition(|&b| b != 0).map(|i| i + 1).unwrap_or(0);
        let json_str = std::str::from_utf8(&bytes[..end])
            .map_err(|e| TipbotError::Memo(format!("Invalid UTF-8: {e}")))?;

        // Minimal JSON parse without serde (avoids serde dep in this crate)
        let get = |key: &str| -> Option<String> {
            let pat = format!("\"{}\":", key);
            let start = json_str.find(&pat)? + pat.len();
            let rest = json_str[start..].trim_start();
            if rest.starts_with('"') {
                let inner = &rest[1..];
                let end = inner.find('"')?;
                Some(inner[..end].to_string())
            } else {
                None
            }
        };

        Ok(TipbotMemo {
            version: get("v").and_then(|v| v.parse().ok()).unwrap_or(1),
            tx_type: get("type").unwrap_or_else(|| "unknown".into()),
            from_handle: get("from"),
            to_handle: get("to"),
            group_name: get("group"),
            community_uuid: get("community").unwrap_or_default(),
            message: get("msg"),
        })
    }

    fn to_json(&self, msg: Option<&str>) -> Result<String, TipbotError> {
        let mut parts = vec![
            format!("\"v\":{}", self.version),
            format!("\"type\":\"{}\"", escape_json(&self.tx_type)),
        ];
        if let Some(f) = &self.from_handle {
            parts.push(format!("\"from\":\"{}\"", escape_json(f)));
        }
        if let Some(t) = &self.to_handle {
            parts.push(format!("\"to\":\"{}\"", escape_json(t)));
        }
        if let Some(g) = &self.group_name {
            parts.push(format!("\"group\":\"{}\"", escape_json(g)));
        }
        parts.push(format!("\"community\":\"{}\"", escape_json(&self.community_uuid)));
        if let Some(m) = msg {
            parts.push(format!("\"msg\":\"{}\"", escape_json(m)));
        }
        Ok(format!("{{{}}}", parts.join(",")))
    }
}

/// Escapes special characters in a JSON string value.
fn escape_json(s: &str) -> String {
    s.chars().flat_map(|c| match c {
        '"'  => vec!['\\', '"'],
        '\\' => vec!['\\', '\\'],
        '\n' => vec!['\\', 'n'],
        '\r' => vec!['\\', 'r'],
        '\t' => vec!['\\', 't'],
        c    => vec![c],
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_decode_roundtrip() {
        let memo = TipbotMemo {
            version: 1,
            tx_type: "tip".into(),
            from_handle: Some("alice".into()),
            to_handle: Some("bob".into()),
            group_name: Some("zcash-ng".into()),
            community_uuid: "550e8400-e29b-41d4-a716-446655440000".into(),
            message: None,
        };

        let encoded = memo.encode().unwrap();
        assert_eq!(encoded.len(), 512);

        let decoded = TipbotMemo::decode(&encoded).unwrap();
        assert_eq!(decoded.tx_type, "tip");
        assert_eq!(decoded.from_handle.as_deref(), Some("alice"));
        assert_eq!(decoded.to_handle.as_deref(), Some("bob"));
        assert_eq!(decoded.community_uuid, "550e8400-e29b-41d4-a716-446655440000");
    }

    #[test]
    fn test_null_padding() {
        let memo = TipbotMemo {
            version: 1,
            tx_type: "withdrawal".into(),
            from_handle: Some("dre".into()),
            to_handle: None,
            group_name: None,
            community_uuid: "abc-123".into(),
            message: None,
        };
        let encoded = memo.encode().unwrap();
        // Tail bytes should be null padding
        assert_eq!(encoded[511], 0);
    }

    #[test]
    fn test_zip317_fee_sanity() {
        // ZIP-317: standard send = 2 actions = 10_000 zatoshis
        assert_eq!(crate::fees::standard_fee(), 10_000);
    }
}
