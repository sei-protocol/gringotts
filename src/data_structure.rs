use cosmwasm_schema::{cw_serde};
use cosmwasm_std::{Addr, Timestamp};

use crate::ContractError;

#[cw_serde]
pub struct EmptyStruct{}

#[cw_serde]
pub struct Tranche {
    pub vesting_timestamps: Vec<Timestamp>,
    pub vesting_amounts: Vec<u64>,
    pub unlocked_token_distribution_address: Addr,
    pub staking_reward_distribution_address: Addr,
}

impl Tranche {
    pub fn validate(&self) -> Result<(), ContractError> {
        if self.vesting_amounts.len() != self.vesting_amounts.len() {
            return Err(ContractError::InvalidTranche("mismatched vesting amounts and schedule".to_string()));
        }
        if self.vesting_amounts.len() == 0 {
            return Err(ContractError::InvalidTranche("nothing to vest".to_string()));
        }
        let mut last_ts = Timestamp::from_seconds(0);
        for ts in self.vesting_timestamps.iter() {
            if *ts <= last_ts {
                return Err(ContractError::InvalidTranche("vesting schedule must be monotonic increasing".to_string()));
            }
            last_ts = ts.clone();
        }
        Ok(())
    }
}
