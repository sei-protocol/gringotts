use cosmwasm_std::{Storage, Timestamp, Response, BankMsg, Coin};

use crate::{ContractError, state::{VESTING_TIMESTAMPS, VESTING_AMOUNTS, UNLOCK_DISTRIBUTION_ADDRESS, DENOM}};

pub fn collect_vested(storage: &mut dyn Storage, now: Timestamp) -> Result<u128, ContractError> {
    let vesting_ts = VESTING_TIMESTAMPS.load(storage)?;
    let mut earliest_unvested_ts_idx = 0;
    for ts in vesting_ts.iter() {
        if *ts <= now {
            earliest_unvested_ts_idx += 1;
        }
    }
    if earliest_unvested_ts_idx == 0 {
        return Ok(0);
    }
    let vesting_amounts = VESTING_AMOUNTS.load(storage)?;
    let vested_amounts = vesting_amounts[..earliest_unvested_ts_idx].to_vec();
    let remaining_vesting_amounts = vesting_amounts[earliest_unvested_ts_idx..].to_vec();
    let mut total_vested_amount = 0u128;
    for vested_amount in vested_amounts.iter() {
        total_vested_amount += *vested_amount;
    }
    let remaining_vesting_ts = vesting_ts[earliest_unvested_ts_idx..].to_vec();
    VESTING_AMOUNTS.save(storage, &remaining_vesting_amounts)?;
    VESTING_TIMESTAMPS.save(storage, &remaining_vesting_ts)?;

    Ok(total_vested_amount)
}

pub fn distribute_vested(storage: &dyn Storage, amount: u128, response: Response) -> Result<Response, ContractError> {
    if amount == 0 {
        return Ok(response);
    }
    let addr = UNLOCK_DISTRIBUTION_ADDRESS.load(storage)?;
    let denom = DENOM.load(storage)?;
    let msg = BankMsg::Send { to_address: addr.to_string(), amount: vec![Coin::new(amount, denom)] };
    Ok(response.add_message(msg))
}

#[cfg(test)]
mod tests {
    use cosmwasm_std::{Response, Addr};
    use cosmwasm_std::testing::{mock_dependencies, mock_env};

    use crate::state::{VESTING_TIMESTAMPS, VESTING_AMOUNTS, DENOM, UNLOCK_DISTRIBUTION_ADDRESS};

    use super::{collect_vested, distribute_vested};

    #[test]
    fn test_nothing_to_vest() {
        let mut deps = mock_dependencies();
        let deps_mut = deps.as_mut();
        let now = mock_env().block.time;
        VESTING_TIMESTAMPS.save(deps_mut.storage, &vec![]).unwrap();
        VESTING_AMOUNTS.save(deps_mut.storage, &vec![]).unwrap();

        assert_eq!(0, collect_vested(deps_mut.storage, now).unwrap());
    }

    #[test]
    fn test_vest_single() {
        let mut deps = mock_dependencies();
        let deps_mut = deps.as_mut();
        let now = mock_env().block.time;
        VESTING_TIMESTAMPS.save(deps_mut.storage, &vec![now]).unwrap();
        VESTING_AMOUNTS.save(deps_mut.storage, &vec![10]).unwrap();

        assert_eq!(10, collect_vested(deps_mut.storage, now).unwrap());
        assert_eq!(VESTING_TIMESTAMPS.load(deps_mut.storage).unwrap(), vec![]);
        assert_eq!(VESTING_AMOUNTS.load(deps_mut.storage).unwrap(), vec![]);
    }

    #[test]
    fn test_not_vest_single() {
        let mut deps = mock_dependencies();
        let deps_mut = deps.as_mut();
        let now = mock_env().block.time;
        VESTING_TIMESTAMPS.save(deps_mut.storage, &vec![now.plus_seconds(1)]).unwrap();
        VESTING_AMOUNTS.save(deps_mut.storage, &vec![10]).unwrap();

        assert_eq!(0, collect_vested(deps_mut.storage, now).unwrap());
        assert_eq!(VESTING_TIMESTAMPS.load(deps_mut.storage).unwrap(), vec![now.plus_seconds(1)]);
        assert_eq!(VESTING_AMOUNTS.load(deps_mut.storage).unwrap(), vec![10]);
    }

    #[test]
    fn test_vest_multiple() {
        let mut deps = mock_dependencies();
        let deps_mut = deps.as_mut();
        let now = mock_env().block.time;
        VESTING_TIMESTAMPS.save(deps_mut.storage, &vec![now.minus_seconds(1), now, now.plus_seconds(1)]).unwrap();
        VESTING_AMOUNTS.save(deps_mut.storage, &vec![10, 9, 11]).unwrap();

        assert_eq!(19, collect_vested(deps_mut.storage, now).unwrap());
        assert_eq!(VESTING_TIMESTAMPS.load(deps_mut.storage).unwrap(), vec![now.plus_seconds(1)]);
        assert_eq!(VESTING_AMOUNTS.load(deps_mut.storage).unwrap(), vec![11u128]);
    }

    #[test]
    fn test_vest_multiple_all() {
        let mut deps = mock_dependencies();
        let deps_mut = deps.as_mut();
        let now = mock_env().block.time;
        VESTING_TIMESTAMPS.save(deps_mut.storage, &vec![now.minus_seconds(2), now.minus_seconds(1), now]).unwrap();
        VESTING_AMOUNTS.save(deps_mut.storage, &vec![10, 9, 11]).unwrap();

        assert_eq!(30, collect_vested(deps_mut.storage, now).unwrap());
        assert_eq!(VESTING_TIMESTAMPS.load(deps_mut.storage).unwrap(), vec![]);
        assert_eq!(VESTING_AMOUNTS.load(deps_mut.storage).unwrap(), vec![]);
    }

    #[test]
    fn test_vest_multiple_none() {
        let mut deps = mock_dependencies();
        let deps_mut = deps.as_mut();
        let now = mock_env().block.time;
        VESTING_TIMESTAMPS.save(deps_mut.storage, &vec![now.plus_seconds(1), now.plus_seconds(2), now.plus_seconds(3)]).unwrap();
        VESTING_AMOUNTS.save(deps_mut.storage, &vec![10, 9, 11]).unwrap();

        assert_eq!(0, collect_vested(deps_mut.storage, now).unwrap());
        assert_eq!(VESTING_TIMESTAMPS.load(deps_mut.storage).unwrap(), vec![now.plus_seconds(1), now.plus_seconds(2), now.plus_seconds(3)]);
        assert_eq!(VESTING_AMOUNTS.load(deps_mut.storage).unwrap(), vec![10, 9, 11]);
    }

    #[test]
    fn test_distribute_vested_zero_amount() {
        let deps = mock_dependencies();
        let deps_ref = deps.as_ref();
        let mut response = Response::new();
        response = distribute_vested(deps_ref.storage, 0, response).unwrap();
        assert_eq!(response.messages.len(), 0);
    }

    #[test]
    fn test_distribute_vested() {
        let mut deps = mock_dependencies();
        let deps_mut = deps.as_mut();
        let mut response = Response::new();
        DENOM.save(deps_mut.storage, &"usei".to_string()).unwrap();
        UNLOCK_DISTRIBUTION_ADDRESS.save(deps_mut.storage, &Addr::unchecked("unlock_address")).unwrap();
        response = distribute_vested(deps_mut.storage, 20, response).unwrap();
        assert_eq!(response.messages.len(), 1);
    }
}
