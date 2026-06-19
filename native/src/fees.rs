//! ZIP-317 fee calculation.
//!
//! ZIP-317 defines a proportional fee model:
//!   fee = max(GRACE_ACTIONS, logical_actions) × MARGINAL_FEE
//!
//! Where:
//!   MARGINAL_FEE  = 5_000 zatoshis  (0.00005 ZEC per action)
//!   GRACE_ACTIONS = 2               (minimum 2 actions charged)
//!
//! For an Orchard shielded-to-shielded send:
//!   - 1 Orchard input action   (spending the note)
//!   - 1 Orchard output action  (creating the new note)
//!   = 2 actions → fee = 2 × 5_000 = 10_000 zatoshis
//!
//! For a /rain with N recipients:
//!   - 1 Orchard input action
//!   - N Orchard output actions
//!   = N+1 actions
//!
//! Reference: https://zips.z.cash/zip-0317

/// ZIP-317 marginal fee per logical action (zatoshis).
pub const MARGINAL_FEE: u64 = 5_000;

/// Minimum number of actions charged (grace actions).
pub const GRACE_ACTIONS: u64 = 2;

/// Compute the ZIP-317 fee for a transaction with `num_actions` logical actions.
///
/// Always returns at least `GRACE_ACTIONS × MARGINAL_FEE = 10_000 zatoshis`.
///
/// # Arguments
/// * `num_actions` - number of logical Orchard actions in the transaction
///
/// # Examples
/// ```
/// assert_eq!(zip317_fee(2), 10_000);  // standard single tip
/// assert_eq!(zip317_fee(6), 30_000);  // rain to 5 users (1 input + 5 outputs)
/// ```
pub fn zip317_fee(num_actions: u64) -> u64 {
    let actions = num_actions.max(GRACE_ACTIONS);
    actions * MARGINAL_FEE
}

/// Convenience: fee for a standard single shielded send (2 actions).
pub fn standard_fee() -> u64 {
    zip317_fee(2)
}

/// Fee for a /rain transaction splitting to N recipients.
/// Actions = 1 input + N outputs.
pub fn rain_fee(num_recipients: u64) -> u64 {
    zip317_fee(1 + num_recipients)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_standard_fee() {
        assert_eq!(standard_fee(), 10_000);
    }

    #[test]
    fn test_grace_floor() {
        // Even 0 or 1 action charges at least GRACE_ACTIONS × MARGINAL_FEE
        assert_eq!(zip317_fee(0), 10_000);
        assert_eq!(zip317_fee(1), 10_000);
    }

    #[test]
    fn test_rain_fee() {
        // 5 recipients: 1 input + 5 outputs = 6 actions
        assert_eq!(rain_fee(5), 30_000);
        // 10 recipients: 11 actions
        assert_eq!(rain_fee(10), 55_000);
    }

    #[test]
    fn test_proportional_scaling() {
        for n in 2u64..=20 {
            assert_eq!(zip317_fee(n), n * MARGINAL_FEE);
        }
    }
}
