use cosmwasm_schema::{cw_serde};
use cosmwasm_std::{Addr, Timestamp, Coin};

use crate::ContractError;

#[cw_serde]
pub struct EmptyStruct{}

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
        if self.vesting_amounts.len() != self.vesting_amounts.len() {
            return Err(ContractError::InvalidTranche("mismatched vesting amounts and schedule".to_string()));
        }
        if self.vesting_amounts.len() == 0 {
            return Err(ContractError::InvalidTranche("nothing to vest".to_string()));
        }
        let mut total_vesting_amount = 0u128;
        for amount in self.vesting_amounts.iter() {
            if *amount == 0 {
                return Err(ContractError::InvalidTranche("zero vesting amount is not allowed".to_string()));
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
            return Err(ContractError::InvalidTranche("insufficient deposit for the vesting plan".to_string()));
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
