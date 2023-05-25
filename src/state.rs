use cosmwasm_std::{Addr, StdResult, Storage, Timestamp};
use cw3::{Ballot, Proposal};
use cw_storage_plus::{Item, Map};
use cw_utils::{Duration, Threshold};

use crate::data_structure::EmptyStruct;

pub const DENOM: Item<String> = Item::new("denom");
pub const VESTING_TIMESTAMPS: Item<Vec<Timestamp>> = Item::new("ts");
pub const VESTING_AMOUNTS: Item<Vec<u128>> = Item::new("amounts");
pub const UNLOCK_DISTRIBUTION_ADDRESS: Item<Addr> = Item::new("uda");
pub const STAKING_REWARD_ADDRESS: Item<Addr> = Item::new("sra");
pub const WITHDRAWN_STAKING_REWARDS: Item<u128> = Item::new("wsr");

pub const ADMINS: Map<&Addr, EmptyStruct> = Map::new("admins");
pub const OPS: Map<&Addr, EmptyStruct> = Map::new("ops");

pub fn get_number_of_admins(store: &dyn Storage) -> usize {
    ADMINS
        .keys(
            store,
            Option::None,
            Option::None,
            cosmwasm_std::Order::Ascending,
        )
        .count()
}

pub fn get_number_of_ops(store: &dyn Storage) -> usize {
    OPS.keys(
        store,
        Option::None,
        Option::None,
        cosmwasm_std::Order::Ascending,
    )
    .count()
}

// ADMIN STATES
pub const MAX_VOTING_PERIOD: Item<Duration> = Item::new("max_voting_period");
pub const ADMIN_VOTING_THRESHOLD: Item<Threshold> = Item::new("threshold");

pub const PROPOSAL_COUNT: Item<u64> = Item::new("proposal_count");
pub const BALLOTS: Map<(u64, &Addr), Ballot> = Map::new("votes");
pub const PROPOSALS: Map<u64, Proposal> = Map::new("proposals");

pub fn next_proposal_id(store: &mut dyn Storage) -> StdResult<u64> {
    let id: u64 = PROPOSAL_COUNT.may_load(store)?.unwrap_or_default() + 1;
    PROPOSAL_COUNT.save(store, &id)?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use cosmwasm_std::{testing::mock_dependencies, Addr};

    use crate::{
        data_structure::EmptyStruct,
        state::{get_number_of_admins, get_number_of_ops, ADMINS, OPS},
    };

    #[test]
    fn test_get_number_of_admins() {
        let mut deps = mock_dependencies();
        assert_eq!(0, get_number_of_admins(deps.as_ref().storage));

        ADMINS
            .save(
                deps.as_mut().storage,
                &Addr::unchecked("admin"),
                &EmptyStruct {},
            )
            .unwrap();
        assert_eq!(1, get_number_of_admins(deps.as_ref().storage));
        ADMINS
            .save(
                deps.as_mut().storage,
                &Addr::unchecked("admin2"),
                &EmptyStruct {},
            )
            .unwrap();
        assert_eq!(2, get_number_of_admins(deps.as_ref().storage));
    }

    #[test]
    fn test_get_number_of_ops() {
        let mut deps = mock_dependencies();
        assert_eq!(0, get_number_of_ops(deps.as_ref().storage));

        OPS.save(
            deps.as_mut().storage,
            &Addr::unchecked("op"),
            &EmptyStruct {},
        )
        .unwrap();
        assert_eq!(1, get_number_of_ops(deps.as_ref().storage));
        OPS.save(
            deps.as_mut().storage,
            &Addr::unchecked("op2"),
            &EmptyStruct {},
        )
        .unwrap();
        assert_eq!(2, get_number_of_ops(deps.as_ref().storage));
    }
}
