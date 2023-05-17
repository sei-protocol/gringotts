use std::collections::HashMap;

use cosmwasm_schema::{cw_serde};
use cosmwasm_std::{Addr, Env};

pub type TrancheID = u64;

#[cw_serde]
pub struct EmptyStruct{}

#[cw_serde]
pub struct Tranche {
    pub amount: u64,
    pub unlocked_token_distribution_address: Addr,
    pub staking_reward_distribution_address: Addr,
    pub vesting_schedule: HashMap<u64, u64>, // timestamp in seconds to amount vested
}

impl Tranche {
    pub fn validate(&self, env: &Env) -> bool {
        if self.amount == 0 {
            return false;
        }
        let mut total_vested: u64 = 0;
        for (vesting_time, vested) in self.vesting_schedule.iter() {
            if vesting_time.clone() < env.block.time.seconds() {
                return false
            }
            total_vested += vested.clone();
        }
        self.amount == total_vested
    }
}
