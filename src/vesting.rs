use cosmwasm_std::{Storage, Timestamp, Response, BankMsg, Coin};

use crate::{ContractError, state::{VESTING_TIMESTAMPS, VESTING_AMOUNTS, UNLOCK_DISTRIBUTION_ADDRESS, DENOM}};

pub fn collect_vested(storage: &mut dyn Storage, now: Timestamp, amount: u128) -> Result<(), ContractError> {
    if amount == 0 {
        return Ok(())
    }
    let vesting_ts = VESTING_TIMESTAMPS.load(storage)?;
    let mut earliest_unvested_ts_idx = 0;
    for ts in vesting_ts.iter() {
        if *ts <= now {
            earliest_unvested_ts_idx += 1;
        }
    }
    let vesting_amounts = VESTING_AMOUNTS.load(storage)?;
    let vested_amounts = vesting_amounts[..earliest_unvested_ts_idx].to_vec();
    let mut remaining_vesting_amounts: Vec<u128> = vec![];
    let mut amount_to_collect = amount;
    for vested_amount in vested_amounts.iter() {
        if amount_to_collect > 0 {
            if amount_to_collect >= *vested_amount {
                amount_to_collect -= *vested_amount;
            } else {
                remaining_vesting_amounts.push(*vested_amount - amount_to_collect);
                amount_to_collect = 0;
            }
        } else {
            remaining_vesting_amounts.push(*vested_amount);
        }
    }
    if amount_to_collect > 0 {
        return Err(ContractError::NoSufficientUnlockedAmount {});
    }
    remaining_vesting_amounts.append(&mut vesting_amounts[earliest_unvested_ts_idx..].to_vec());
    let remaining_vesting_ts = vesting_ts[vesting_ts.len() - remaining_vesting_amounts.len()..].to_vec();
    VESTING_AMOUNTS.save(storage, &remaining_vesting_amounts)?;
    VESTING_TIMESTAMPS.save(storage, &remaining_vesting_ts)?;

    Ok(())
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

    use crate::ContractError;
    use crate::state::{VESTING_TIMESTAMPS, VESTING_AMOUNTS, DENOM, UNLOCK_DISTRIBUTION_ADDRESS};

    use super::{collect_vested, distribute_vested};

    #[test]
    fn test_zero_amount() {
        let mut deps = mock_dependencies();
        let deps_mut = deps.as_mut();
        let now = mock_env().block.time;

        collect_vested(deps_mut.storage, now, 0).unwrap();
    }

    #[test]
    fn test_nothing_to_vest() {
        let mut deps = mock_dependencies();
        let deps_mut = deps.as_mut();
        let now = mock_env().block.time;
        VESTING_TIMESTAMPS.save(deps_mut.storage, &vec![]).unwrap();
        VESTING_AMOUNTS.save(deps_mut.storage, &vec![]).unwrap();

        let err = collect_vested(deps_mut.storage, now, 10).unwrap_err();
        assert_eq!(err, ContractError::NoSufficientUnlockedAmount {});
    }

    #[test]
    fn test_vest_single_full() {
        let mut deps = mock_dependencies();
        let deps_mut = deps.as_mut();
        let now = mock_env().block.time;
        VESTING_TIMESTAMPS.save(deps_mut.storage, &vec![now]).unwrap();
        VESTING_AMOUNTS.save(deps_mut.storage, &vec![10]).unwrap();

        collect_vested(deps_mut.storage, now, 10).unwrap();
        assert_eq!(VESTING_TIMESTAMPS.load(deps_mut.storage).unwrap(), vec![]);
        assert_eq!(VESTING_AMOUNTS.load(deps_mut.storage).unwrap(), vec![]);
    }

    #[test]
    fn test_vest_single_partial() {
        let mut deps = mock_dependencies();
        let deps_mut = deps.as_mut();
        let now = mock_env().block.time;
        VESTING_TIMESTAMPS.save(deps_mut.storage, &vec![now]).unwrap();
        VESTING_AMOUNTS.save(deps_mut.storage, &vec![10]).unwrap();

        collect_vested(deps_mut.storage, now, 5).unwrap();
        assert_eq!(VESTING_TIMESTAMPS.load(deps_mut.storage).unwrap(), vec![now]);
        assert_eq!(VESTING_AMOUNTS.load(deps_mut.storage).unwrap(), vec![5u128]);
    }

    #[test]
    fn test_vest_multiple_full() {
        let mut deps = mock_dependencies();
        let deps_mut = deps.as_mut();
        let now = mock_env().block.time;
        VESTING_TIMESTAMPS.save(deps_mut.storage, &vec![now.minus_seconds(1), now, now.plus_seconds(1)]).unwrap();
        VESTING_AMOUNTS.save(deps_mut.storage, &vec![10, 9, 11]).unwrap();

        collect_vested(deps_mut.storage, now, 19).unwrap();
        assert_eq!(VESTING_TIMESTAMPS.load(deps_mut.storage).unwrap(), vec![now.plus_seconds(1)]);
        assert_eq!(VESTING_AMOUNTS.load(deps_mut.storage).unwrap(), vec![11u128]);
    }

    #[test]
    fn test_vest_multiple_partial() {
        let mut deps = mock_dependencies();
        let deps_mut = deps.as_mut();
        let now = mock_env().block.time;
        VESTING_TIMESTAMPS.save(deps_mut.storage, &vec![now.minus_seconds(1), now, now.plus_seconds(1)]).unwrap();
        VESTING_AMOUNTS.save(deps_mut.storage, &vec![10, 9, 11]).unwrap();

        collect_vested(deps_mut.storage, now, 15).unwrap();
        assert_eq!(VESTING_TIMESTAMPS.load(deps_mut.storage).unwrap(), vec![now, now.plus_seconds(1)]);
        assert_eq!(VESTING_AMOUNTS.load(deps_mut.storage).unwrap(), vec![4u128, 11u128]);
    }

    #[test]
    fn test_vest_multiple_insufficient() {
        let mut deps = mock_dependencies();
        let deps_mut = deps.as_mut();
        let now = mock_env().block.time;
        VESTING_TIMESTAMPS.save(deps_mut.storage, &vec![now.minus_seconds(1), now, now.plus_seconds(1)]).unwrap();
        VESTING_AMOUNTS.save(deps_mut.storage, &vec![10, 9, 11]).unwrap();

        let err = collect_vested(deps_mut.storage, now, 31).unwrap_err();
        assert_eq!(err, ContractError::NoSufficientUnlockedAmount {});
        assert_eq!(VESTING_TIMESTAMPS.load(deps_mut.storage).unwrap(), vec![now.minus_seconds(1), now, now.plus_seconds(1)]);
        assert_eq!(VESTING_AMOUNTS.load(deps_mut.storage).unwrap(), vec![10u128, 9u128, 11u128]);
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
