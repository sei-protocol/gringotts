use cosmwasm_std::{Addr, Timestamp};
use cw_storage_plus::{Item, Map};

use crate::data_structure::{EmptyStruct};

pub const DENOM: Item<String> = Item::new("denom");
pub const VESTING_TIMESTAMPS: Item<Vec<Timestamp>> = Item::new("ts");
pub const VESTING_AMOUNTS: Item<Vec<u128>> = Item::new("amounts");
pub const UNLOCK_DISTRIBUTION_ADDRESS: Item<Addr> = Item::new("uda");
pub const STAKING_REWARD_ADDRESS: Item<Addr> = Item::new("sra");
pub const WITHDRAWN_STAKING_REWARDS: Item<u128> = Item::new("wsr");

pub const ADMINS: Map<&Addr, EmptyStruct> = Map::new("admins");
pub const OPS: Map<&Addr, EmptyStruct> = Map::new("ops");
