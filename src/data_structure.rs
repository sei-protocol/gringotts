use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Addr, Coin, Timestamp, Env};

use crate::ContractError;

const HUNDRED_YEARS_IN_SECONDS: u64 = 100 * 365 * 24 * 60 * 60;

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
    pub fn validate(&self, env: Env, funds: Vec<Coin>) -> Result<(), ContractError> {
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
        self.validate_timestamps(env)?;

        Ok(())
    }

    pub fn validate_timestamps(&self, env: Env) -> Result<(), ContractError> {
        let mut last_ts_nanos = Timestamp::from_seconds(0).nanos();
        for ts in &self.vesting_timestamps {
            let ts_nanos = ts.nanos();
            if ts_nanos <= last_ts_nanos {
                return Err(ContractError::InvalidTranche(
                    "vesting schedule must be monotonic increasing".to_string(),
                ));
            }

            // Check if the nanoseconds are at least current
            if ts_nanos < env.block.time.nanos() {
                return Err(ContractError::InvalidTranche(
                    "Timestamp nanoseconds are out of range".to_string(),
                ));
            }

            // ts should not be too far in the future (e.g. example not more than 100 years)
            if ts.seconds() > env.block.time.seconds() + HUNDRED_YEARS_IN_SECONDS {
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
    use cosmwasm_std::{Uint128, testing::mock_env};
    use super::*;

    const UNLOCK_ADDR1: &str = "unlock0001";

    #[test]
    fn test_validate_success() {
        let env = mock_env();
        let tranche = Tranche {
            vesting_amounts: vec![100, 200, 300],
            unlocked_token_distribution_address: Addr::unchecked(UNLOCK_ADDR1),
            vesting_timestamps: vec![
                Timestamp::from_seconds(1).plus_nanos(env.block.time.nanos()),
                Timestamp::from_seconds(2).plus_nanos(env.block.time.nanos()),
                Timestamp::from_seconds(3).plus_nanos(env.block.time.nanos()),
            ],
            denom: "token".to_string(),
            staking_reward_distribution_address: Addr::unchecked(UNLOCK_ADDR1),
        };
        let funds = vec![
            Coin { denom: "token".to_string(), amount: Uint128::from(600u128) },
        ];
        assert!(tranche.validate(env, funds).is_ok());
    }

    #[test]
    fn test_validate_mismatched_amount_timestamp_lengths() {
        let env = mock_env();
        let tranche = Tranche {
            vesting_amounts: vec![100, 200],
            unlocked_token_distribution_address: Addr::unchecked(UNLOCK_ADDR1),
            vesting_timestamps: vec![
                Timestamp::from_seconds(1).plus_nanos(env.block.time.nanos()),
                Timestamp::from_seconds(2).plus_nanos(env.block.time.nanos()),
                Timestamp::from_seconds(3).plus_nanos(env.block.time.nanos()),
            ],
            denom: "token".to_string(),
            staking_reward_distribution_address: Addr::unchecked(UNLOCK_ADDR1)
        };
        let funds = vec![
        ];
        assert!(matches!(
            tranche.validate(env, funds),
            Err(ContractError::InvalidTranche(msg)) if msg.contains("mismatched vesting amounts and schedule")
        ));
    }

    #[test]
    fn test_validate_empty_amounts_and_timestamps() {
        let env = mock_env();
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
            tranche.validate(env, funds),
            Err(ContractError::InvalidTranche(msg)) if msg.contains("nothing to vest")
        ));
    }

    #[test]
    fn test_validate_zero_vesting_amount() {
        let env = mock_env();
        let tranche = Tranche {
            vesting_amounts: vec![0, 100],
            unlocked_token_distribution_address: Addr::unchecked(UNLOCK_ADDR1),
            vesting_timestamps: vec![Timestamp::from_seconds(1).plus_nanos(env.block.time.nanos()), Timestamp::from_seconds(2).plus_nanos(env.block.time.nanos())],
            denom: "token".to_string(),
            staking_reward_distribution_address: Addr::unchecked(UNLOCK_ADDR1)
        };
        let funds = vec![Coin { denom: "token".to_string(), amount: Uint128::new(100) }];
        let result = tranche.validate(env, funds);
        assert!(matches!(
            result,
            Err(ContractError::InvalidTranche(msg)) if msg.contains("zero vesting amount is not allowed")
        ));
    }

    #[test]
    fn test_validate_insufficient_deposit() {
        let env = mock_env();
        let tranche = Tranche {
            vesting_amounts: vec![200, 200],
            unlocked_token_distribution_address: Addr::unchecked(UNLOCK_ADDR1),
            vesting_timestamps: vec![Timestamp::from_seconds(1).plus_nanos(env.block.time.nanos()), Timestamp::from_seconds(2).plus_nanos(env.block.time.nanos())],
            denom: "token".to_string(),
            staking_reward_distribution_address: Addr::unchecked(UNLOCK_ADDR1)
        };
        let funds = vec![Coin { denom: "token".to_string(), amount: Uint128::new(300) }];
        let result = tranche.validate(env, funds);
        assert!(matches!(
            result,
            Err(ContractError::InvalidTranche(msg)) if msg.contains("insufficient deposit for the vesting plan")
        ));
    }

    #[test]
    fn test_validate_non_monotonic_vesting_timestamps() {
        let env = mock_env();
        let tranche = Tranche {
            vesting_amounts: vec![100, 100],
            unlocked_token_distribution_address: Addr::unchecked(UNLOCK_ADDR1),
            vesting_timestamps: vec![Timestamp::from_seconds(2).plus_nanos(env.block.time.nanos()), Timestamp::from_seconds(1).plus_nanos(env.block.time.nanos())],
            denom: "token".to_string(),
            staking_reward_distribution_address: Addr::unchecked(UNLOCK_ADDR1)
        };
        let funds = vec![Coin { denom: "token".to_string(), amount: Uint128::new(200) }];
        let result = tranche.validate(env, funds);
        assert!(matches!(
            result,
            Err(ContractError::InvalidTranche(msg)) if msg.contains("vesting schedule must be monotonic increasing")
        ));
    }

    #[test]
    fn test_validate_timestamps_too_early() {
        let env = mock_env();
        let tranche = Tranche {
            vesting_amounts: vec![100],
            unlocked_token_distribution_address: Addr::unchecked(UNLOCK_ADDR1),
            vesting_timestamps: vec![Timestamp::from_seconds(2).plus_nanos(env.block.time.nanos()).minus_seconds(3)],
            denom: "token".to_string(),
            staking_reward_distribution_address: Addr::unchecked(UNLOCK_ADDR1)
        };
        let funds = vec![Coin { denom: "token".to_string(), amount: Uint128::new(200) }];
        let result = tranche.validate(env, funds);
        assert!(matches!(
            result,
            Err(ContractError::InvalidTranche(msg)) if msg.contains("Timestamp nanoseconds are out of range")
        ));
   }

   #[test]
   fn test_validate_timestamps_too_late() {
       let env = mock_env();
       let tranche = Tranche {
           vesting_amounts: vec![100],
           unlocked_token_distribution_address: Addr::unchecked(UNLOCK_ADDR1),
           vesting_timestamps: vec![Timestamp::from_seconds(HUNDRED_YEARS_IN_SECONDS+1).plus_nanos(env.block.time.nanos())],
           denom: "token".to_string(),
           staking_reward_distribution_address: Addr::unchecked(UNLOCK_ADDR1)
       };
       let funds = vec![Coin { denom: "token".to_string(), amount: Uint128::new(200) }];
       let result = tranche.validate(env, funds);
       assert!(matches!(
           result,
           Err(ContractError::InvalidTimestamp(msg)) if msg.contains("Timestamp is too far in the future")
       ));
  }
}