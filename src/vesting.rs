use cosmwasm_std::{coins, BankMsg, Response, StdResult, Storage, Timestamp};

use crate::{
    state::{DENOM, UNLOCK_DISTRIBUTION_ADDRESS, VESTING_AMOUNTS, VESTING_TIMESTAMPS},
    ContractError,
};

pub fn collect_vested(
    storage: &mut dyn Storage,
    now: Timestamp,
    requested_amount: u128,
) -> Result<u128, ContractError> {
    let vesting_ts = VESTING_TIMESTAMPS.load(storage)?;
    let vesting_amounts = VESTING_AMOUNTS.load(storage)?;
    let mut vested_amount = 0u128;
    let mut amount_to_subtract = 0u128;
    let mut remaining_first_idx: usize = 0;
    for (i, (ts, amount)) in vesting_ts.iter().zip(vesting_amounts.iter()).enumerate() {
        if *ts > now {
            break;
        }
        vested_amount += *amount;
        if vested_amount >= requested_amount {
            amount_to_subtract = *amount + requested_amount - vested_amount;
            if vested_amount == requested_amount {
                remaining_first_idx += 1;
                amount_to_subtract = 0;
            }
            vested_amount = requested_amount;
            break;
        }
        remaining_first_idx = i + 1;
    }
    if vested_amount < requested_amount {
        return Err(ContractError::NoSufficientUnlockedTokens {});
    }
    if remaining_first_idx >= vesting_amounts.len() {
        VESTING_AMOUNTS.save(storage, &vec![])?;
        VESTING_TIMESTAMPS.save(storage, &vec![])?;
    } else {
        let mut remaining_amounts = vesting_amounts[remaining_first_idx..].to_vec();
        if amount_to_subtract > 0 {
            remaining_amounts[0] -= amount_to_subtract;
        }
        VESTING_AMOUNTS.save(storage, &remaining_amounts)?;
        let remaining_ts = vesting_ts[remaining_first_idx..].to_vec();
        VESTING_TIMESTAMPS.save(storage, &remaining_ts)?;
    }

    Ok(vested_amount)
}

pub fn total_vested_amount(storage: &dyn Storage, now: Timestamp) -> StdResult<u128> {
    let vesting_timestamps = VESTING_TIMESTAMPS.load(storage)?;
    let vesting_amounts = VESTING_AMOUNTS.load(storage)?;
    let mut total_vested_amount = 0u128;
    for i in 0..vesting_timestamps.len() {
        if vesting_timestamps[i] <= now {
            total_vested_amount += vesting_amounts[i];
        } else {
            break;
        }
    }
    Ok(total_vested_amount)
}

pub fn distribute_vested(
    storage: &dyn Storage,
    amount: u128,
    response: Response,
) -> Result<Response, ContractError> {
    if amount == 0 {
        return Ok(response);
    }
    let addr = UNLOCK_DISTRIBUTION_ADDRESS.load(storage)?;
    let denom = DENOM.load(storage)?;
    let msg = BankMsg::Send {
        to_address: addr.to_string(),
        amount: coins(amount, denom),
    };
    Ok(response.add_message(msg))
}

#[cfg(test)]
mod tests {
    use cosmwasm_std::testing::{mock_dependencies, mock_env};
    use cosmwasm_std::{Addr, Response};

    use crate::state::{DENOM, UNLOCK_DISTRIBUTION_ADDRESS, VESTING_AMOUNTS, VESTING_TIMESTAMPS};
    use crate::ContractError;

    use super::{collect_vested, distribute_vested};

    #[test]
    fn test_nothing_to_vest() {
        let mut deps = mock_dependencies();
        let deps_mut = deps.as_mut();
        let now = mock_env().block.time;
        VESTING_TIMESTAMPS.save(deps_mut.storage, &vec![]).unwrap();
        VESTING_AMOUNTS.save(deps_mut.storage, &vec![]).unwrap();

        assert_eq!(0, collect_vested(deps_mut.storage, now, 0).unwrap());
        assert_eq!(
            ContractError::NoSufficientUnlockedTokens {},
            collect_vested(deps_mut.storage, now, 10).expect_err("should error")
        );
    }

    #[test]
    fn test_vest_single_full() {
        let mut deps = mock_dependencies();
        let deps_mut = deps.as_mut();
        let now = mock_env().block.time;
        VESTING_TIMESTAMPS
            .save(deps_mut.storage, &vec![now])
            .unwrap();
        VESTING_AMOUNTS.save(deps_mut.storage, &vec![10]).unwrap();

        assert_eq!(10, collect_vested(deps_mut.storage, now, 10).unwrap());
        assert_eq!(VESTING_TIMESTAMPS.load(deps_mut.storage).unwrap(), vec![]);
        assert_eq!(VESTING_AMOUNTS.load(deps_mut.storage).unwrap(), vec![]);
    }

    #[test]
    fn test_vest_single_more() {
        let mut deps = mock_dependencies();
        let deps_mut = deps.as_mut();
        let now = mock_env().block.time;
        VESTING_TIMESTAMPS
            .save(deps_mut.storage, &vec![now])
            .unwrap();
        VESTING_AMOUNTS.save(deps_mut.storage, &vec![10]).unwrap();

        assert_eq!(
            ContractError::NoSufficientUnlockedTokens {},
            collect_vested(deps_mut.storage, now, 15).expect_err("should error")
        );
        assert_eq!(
            VESTING_TIMESTAMPS.load(deps_mut.storage).unwrap(),
            vec![now]
        );
        assert_eq!(VESTING_AMOUNTS.load(deps_mut.storage).unwrap(), vec![10]);
    }

    #[test]
    fn test_vest_single_partial() {
        let mut deps = mock_dependencies();
        let deps_mut = deps.as_mut();
        let now = mock_env().block.time;
        VESTING_TIMESTAMPS
            .save(deps_mut.storage, &vec![now])
            .unwrap();
        VESTING_AMOUNTS.save(deps_mut.storage, &vec![10]).unwrap();

        assert_eq!(5, collect_vested(deps_mut.storage, now, 5).unwrap());
        assert_eq!(
            VESTING_TIMESTAMPS.load(deps_mut.storage).unwrap(),
            vec![now]
        );
        assert_eq!(VESTING_AMOUNTS.load(deps_mut.storage).unwrap(), vec![5]);
    }

    #[test]
    fn test_not_vest_single() {
        let mut deps = mock_dependencies();
        let deps_mut = deps.as_mut();
        let now = mock_env().block.time;
        VESTING_TIMESTAMPS
            .save(deps_mut.storage, &vec![now.plus_seconds(1)])
            .unwrap();
        VESTING_AMOUNTS.save(deps_mut.storage, &vec![10]).unwrap();

        assert_eq!(
            ContractError::NoSufficientUnlockedTokens {},
            collect_vested(deps_mut.storage, now, 10).expect_err("should error")
        );
        assert_eq!(
            VESTING_TIMESTAMPS.load(deps_mut.storage).unwrap(),
            vec![now.plus_seconds(1)]
        );
        assert_eq!(VESTING_AMOUNTS.load(deps_mut.storage).unwrap(), vec![10]);
    }

    #[test]
    fn test_vest_multiple() {
        let mut deps = mock_dependencies();
        let deps_mut = deps.as_mut();
        let now = mock_env().block.time;
        VESTING_TIMESTAMPS
            .save(
                deps_mut.storage,
                &vec![now.minus_seconds(1), now, now.plus_seconds(1)],
            )
            .unwrap();
        VESTING_AMOUNTS
            .save(deps_mut.storage, &vec![10, 9, 11])
            .unwrap();

        assert_eq!(18, collect_vested(deps_mut.storage, now, 18).unwrap());
        assert_eq!(
            VESTING_TIMESTAMPS.load(deps_mut.storage).unwrap(),
            vec![now, now.plus_seconds(1)]
        );
        assert_eq!(
            VESTING_AMOUNTS.load(deps_mut.storage).unwrap(),
            vec![1u128, 11u128]
        );

        assert_eq!(
            2,
            collect_vested(deps_mut.storage, now.plus_seconds(1), 2).unwrap()
        );
        assert_eq!(
            VESTING_TIMESTAMPS.load(deps_mut.storage).unwrap(),
            vec![now.plus_seconds(1)]
        );
        assert_eq!(
            VESTING_AMOUNTS.load(deps_mut.storage).unwrap(),
            vec![10u128]
        );
    }

    #[test]
    fn test_vest_multiple_all() {
        let mut deps = mock_dependencies();
        let deps_mut = deps.as_mut();
        let now = mock_env().block.time;
        VESTING_TIMESTAMPS
            .save(
                deps_mut.storage,
                &vec![now.minus_seconds(2), now.minus_seconds(1), now],
            )
            .unwrap();
        VESTING_AMOUNTS
            .save(deps_mut.storage, &vec![10, 9, 11])
            .unwrap();

        assert_eq!(30, collect_vested(deps_mut.storage, now, 30).unwrap());
        assert_eq!(VESTING_TIMESTAMPS.load(deps_mut.storage).unwrap(), vec![]);
        assert_eq!(VESTING_AMOUNTS.load(deps_mut.storage).unwrap(), vec![]);
    }

    #[test]
    fn test_vest_multiple_none() {
        let mut deps = mock_dependencies();
        let deps_mut = deps.as_mut();
        let now = mock_env().block.time;
        VESTING_TIMESTAMPS
            .save(
                deps_mut.storage,
                &vec![
                    now.plus_seconds(1),
                    now.plus_seconds(2),
                    now.plus_seconds(3),
                ],
            )
            .unwrap();
        VESTING_AMOUNTS
            .save(deps_mut.storage, &vec![10, 9, 11])
            .unwrap();

        assert_eq!(
            ContractError::NoSufficientUnlockedTokens {},
            collect_vested(deps_mut.storage, now, 30).expect_err("should error")
        );
        assert_eq!(
            VESTING_TIMESTAMPS.load(deps_mut.storage).unwrap(),
            vec![
                now.plus_seconds(1),
                now.plus_seconds(2),
                now.plus_seconds(3)
            ]
        );
        assert_eq!(
            VESTING_AMOUNTS.load(deps_mut.storage).unwrap(),
            vec![10, 9, 11]
        );
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
        UNLOCK_DISTRIBUTION_ADDRESS
            .save(deps_mut.storage, &Addr::unchecked("unlock_address"))
            .unwrap();
        response = distribute_vested(deps_mut.storage, 20, response).unwrap();
        assert_eq!(response.messages.len(), 1);
    }
}
