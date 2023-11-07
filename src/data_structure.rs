use std::time::{SystemTime, UNIX_EPOCH};
use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Addr, Coin, Timestamp};

use crate::ContractError;

#[cw_serde]
pub struct EmptyStruct {}

#[cw_serde]
pub struct Tranche {
    pub denom: String,
    pub vesting_timestamps: Vec<Timestamp>,
    pub vesting_amounts: Vec<u128>,
    pub unlocked_token_distribution_address: Addr,
    pub staking_reward_distribution_address: Addr,
}

impl Tranche {
    pub fn validate(&self, funds: Vec<Coin>) -> Result<(), ContractError> {
        if self.vesting_amounts.len() != self.vesting_timestamps.len() {
            return Err(ContractError::InvalidTranche(
                "mismatched vesting amounts and schedule".to_string(),
            ));
        }
        if self.vesting_amounts.is_empty() {
            return Err(ContractError::InvalidTranche("nothing to vest".to_string()));
        }
        let mut total_vesting_amount = 0u128;
        for amount in self.vesting_amounts.iter() {
            if *amount == 0 {
                return Err(ContractError::InvalidTranche(
                    "zero vesting amount is not allowed".to_string(),
                ));
            }
            total_vesting_amount += *amount;
        }
        let mut deposited_amount = 0u128;
        for fund in funds.iter() {
            if fund.denom == self.denom {
                deposited_amount += fund.amount.u128();
            }
        }
        if total_vesting_amount > deposited_amount {
            return Err(ContractError::InvalidTranche(
                "insufficient deposit for the vesting plan".to_string(),
            ));
        }
        self.validate_timestamps().expect("TODO: panic message");

        Ok(())
    }

    pub fn validate_timestamps(&self) -> Result<(), ContractError> {
        let mut last_ts_nanos = Timestamp::from_seconds(0).nanos();
        for ts in &self.vesting_timestamps {
            let ts_nanos = ts.nanos();
            if ts_nanos <= last_ts_nanos {
                return Err(ContractError::InvalidTranche(
                    "vesting schedule must be monotonic increasing".to_string(),
                ));
            }

            // Check if the nanoseconds are in the valid range (e.g., between 0 and 999,999,999)
            if ts_nanos < 0 || ts_nanos > 999_999_999 {
                return Err(ContractError::InvalidTranche(
                    "Timestamp nanoseconds are out of range".to_string(),
                ));
            }

            // ts should not be before the Unix epoch
            if ts.seconds() < 0 {
                return Err(ContractError::InvalidTimestamp(
                    "Timestamp is before the Unix epoch".to_string(),
                ));
            }

            // ts should not be too far in the future (e.g. example not more than 100 years)
            let hundred_years_in_seconds = 100 * 365 * 24 * 60 * 60;
            if ts.seconds() > current_time_seconds() + hundred_years_in_seconds {
                return Err(ContractError::InvalidTimestamp(
                    "Timestamp is too far in the future".to_string(),
                ));
            }
            last_ts_nanos = ts_nanos
        }

        Ok(())
    }

}

#[cfg(test)]
mod tests {
    use cosmwasm_std::Uint128;
    use super::*;

    const UNLOCK_ADDR1: &str = "unlock0001";

    #[test]
    fn test_validate_success() {
        let tranche = Tranche {
            vesting_amounts: vec![100, 200, 300],
            unlocked_token_distribution_address: Addr::unchecked(UNLOCK_ADDR1),
            vesting_timestamps: vec![
                Timestamp::from_seconds(1),
                Timestamp::from_seconds(2),
                Timestamp::from_seconds(3),
            ],
            denom: "token".to_string(),
            staking_reward_distribution_address: Addr::unchecked(UNLOCK_ADDR1),
        };
        let funds = vec![
            Coin { denom: "token".to_string(), amount: Uint128::from(600u128) },
        ];
        assert!(tranche.validate(funds).is_ok());
    }

    #[test]
    fn test_validate_mismatched_amount_timestamp_lengths() {
        let tranche = Tranche {
            vesting_amounts: vec![100, 200],
            unlocked_token_distribution_address: Addr::unchecked(UNLOCK_ADDR1),
            vesting_timestamps: vec![
                Timestamp::from_seconds(1),
                Timestamp::from_seconds(2),
                Timestamp::from_seconds(3),
            ],
            denom: "token".to_string(),
            staking_reward_distribution_address: Addr::unchecked(UNLOCK_ADDR1)
        };
        let funds = vec![
        ];
        assert!(matches!(
            tranche.validate(funds),
            Err(ContractError::InvalidTranche(msg)) if msg.contains("mismatched vesting amounts and schedule")
        ));
    }

    #[test]
    fn test_validate_empty_amounts_and_timestamps() {
        let tranche = Tranche {
            vesting_amounts: vec![],
            unlocked_token_distribution_address: Addr::unchecked(UNLOCK_ADDR1),
            vesting_timestamps: vec![],
            denom: "token".to_string(),
            staking_reward_distribution_address: Addr::unchecked(UNLOCK_ADDR1)
        };
        let funds = vec![
        ];
        assert!(matches!(
            tranche.validate(funds),
            Err(ContractError::InvalidTranche(msg)) if msg.contains("nothing to vest")
        ));
    }

    #[test]
    fn test_validate_zero_vesting_amount() {
        let tranche = Tranche {
            vesting_amounts: vec![0, 100],
            unlocked_token_distribution_address: Addr::unchecked(UNLOCK_ADDR1),
            vesting_timestamps: vec![Timestamp::from_seconds(1), Timestamp::from_seconds(2)],
            denom: "token".to_string(),
            staking_reward_distribution_address: Addr::unchecked(UNLOCK_ADDR1)
        };
        let funds = vec![Coin { denom: "token".to_string(), amount: Uint128::new(100) }];
        let result = tranche.validate(funds);
        assert!(matches!(
            result,
            Err(ContractError::InvalidTranche(msg)) if msg.contains("zero vesting amount is not allowed")
        ));
    }

    #[test]
    fn test_validate_insufficient_deposit() {
        let tranche = Tranche {
            vesting_amounts: vec![200, 200],
            unlocked_token_distribution_address: Addr::unchecked(UNLOCK_ADDR1),
            vesting_timestamps: vec![Timestamp::from_seconds(1), Timestamp::from_seconds(2)],
            denom: "token".to_string(),
            staking_reward_distribution_address: Addr::unchecked(UNLOCK_ADDR1)
        };
        let funds = vec![Coin { denom: "token".to_string(), amount: Uint128::new(300) }];
        let result = tranche.validate(funds);
        assert!(matches!(
            result,
            Err(ContractError::InvalidTranche(msg)) if msg.contains("insufficient deposit for the vesting plan")
        ));
    }

    #[test]
    fn test_validate_non_monotonic_vesting_timestamps() {
        let tranche = Tranche {
            vesting_amounts: vec![100, 100],
            unlocked_token_distribution_address: Addr::unchecked(UNLOCK_ADDR1),
            vesting_timestamps: vec![Timestamp::from_seconds(2), Timestamp::from_seconds(1)],
            denom: "token".to_string(),
            staking_reward_distribution_address: Addr::unchecked(UNLOCK_ADDR1)
        };
        let funds = vec![Coin { denom: "token".to_string(), amount: Uint128::new(200) }];
        let result = tranche.validate(funds);
        assert!(matches!(
            result,
            Err(ContractError::InvalidTranche(msg)) if msg.contains("vesting schedule must be monotonic increasing")
        ));
    }

    #[test]
    fn test_validate_timestamps() {
   }
}