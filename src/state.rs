use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Addr, StdResult, Storage, Timestamp};

use cw3::{Ballot, Proposal};
use cw_storage_plus::{Item, Map};
use cw_utils::{Duration, Threshold};

use crate::data_structure::{EmptyStruct};

#[cw_serde]
pub struct Config {
    pub threshold: Threshold,
    pub total_weight: u64,
    pub max_voting_period: Duration,
}

// unique items
pub const CONFIG: Item<Config> = Item::new("config");
pub const PROPOSAL_COUNT: Item<u64> = Item::new("proposal_count");

// multiple-item map
pub const BALLOTS: Map<(u64, &Addr), Ballot> = Map::new("votes");
pub const PROPOSALS: Map<u64, Proposal> = Map::new("proposals");

// multiple-item maps
pub const VOTERS: Map<&Addr, u64> = Map::new("voters");

pub fn next_id(store: &mut dyn Storage) -> StdResult<u64> {
    let id: u64 = PROPOSAL_COUNT.may_load(store)?.unwrap_or_default() + 1;
    PROPOSAL_COUNT.save(store, &id)?;
    Ok(id)
}

pub const DENOM: Item<String> = Item::new("denom");
pub const VESTING_TIMESTAMPS: Item<Vec<Timestamp>> = Item::new("ts");
pub const VESTING_AMOUNTS: Item<Vec<u64>> = Item::new("amounts");
pub const UNLOCK_DISTRIBUTION_ADDRESS: Item<Addr> = Item::new("uda");
pub const STAKING_REWARD_ADDRESS: Item<Addr> = Item::new("sra");
pub const WITHDRAWN_STAKING_REWARDS: Item<u64> = Item::new("wsr");

pub const ADMINS: Map<&Addr, EmptyStruct> = Map::new("admins");
pub const OPS: Map<&Addr, EmptyStruct> = Map::new("ops");
