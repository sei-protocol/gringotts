use cosmwasm_std::{StakingMsg, Response, Coin, Deps, Env, DistributionMsg, BankMsg};

use crate::{ContractError, state::{DENOM, STAKING_REWARD_ADDRESS}};

pub fn delegate(response: Response, validator: String, amount: u128, denom: String) -> Response {
    let msg = StakingMsg::Delegate {
        validator,
        amount: Coin::new(amount.into(), denom),
    };
    response.add_message(msg)
}

pub fn redelegate(response: Response, src_validator: String, dst_validator: String, amount: u128, denom: String) -> Response {
    let msg = StakingMsg::Redelegate {
        src_validator,
        dst_validator,
        amount: Coin::new(amount.into(), denom),
    };
    response.add_message(msg)
}

pub fn undelegate(response: Response, validator: String, amount: u128, denom: String) -> Response {
    let msg = StakingMsg::Undelegate {
        validator,
        amount: Coin::new(amount.into(), denom),
    };
    response.add_message(msg)
}

pub fn withdraw_delegation_rewards(deps: Deps, response: Response, validator: String, amount: u128) -> Result<Response, ContractError> {
    let msg = DistributionMsg::WithdrawDelegatorReward { validator: validator };
    let denom = DENOM.load(deps.storage)?;
    let to_address = STAKING_REWARD_ADDRESS.load(deps.storage)?;
    let send_msg = BankMsg::Send { to_address: to_address.to_string(), amount: vec![Coin::new(amount, denom)] };
    let mut new_response = response.add_message(msg);
    new_response = new_response.add_message(send_msg);
    Ok(new_response)
}

pub fn get_delegation_rewards(deps: Deps, env: Env, validator: String) -> Result<u128, ContractError> {
    let delegation = deps.querier.query_delegation(env.contract.address.to_string(), validator)?;
    if delegation.is_none() {
        return Ok(0);
    }
    let denom = DENOM.load(deps.storage)?;
    let mut reward_amount = 0u128;
    for reward in delegation.unwrap().accumulated_rewards.iter() {
        if reward.denom == denom {
            reward_amount += reward.amount.u128();
        }
    }
    Ok(reward_amount)
}

#[cfg(test)]
mod tests {
    use cosmwasm_std::{testing::{mock_dependencies, mock_env}, Validator, Decimal, FullDelegation, Coin, Addr};

    use crate::state::DENOM;

    use super::get_delegation_rewards;

    const VALIDATOR: &str = "val";
    const DELEGATOR: &str = "del";

    #[test]
    fn test_get_delegation_rewards_empty() {
        let mut deps = mock_dependencies();
        let mut env = mock_env();
        env.contract.address = Addr::unchecked(DELEGATOR);
        DENOM.save(deps.as_mut().storage, &"usei".to_string()).unwrap();

        let result = get_delegation_rewards(deps.as_ref(), env, VALIDATOR.to_string()).unwrap();
        assert_eq!(0u128, result);
    }

    #[test]
    fn test_get_delegation_rewards() {
        let mut deps = mock_dependencies();
        deps.querier.update_staking("usei", &[Validator{
            address: VALIDATOR.to_string(),
            commission: Decimal::zero(),
            max_commission: Decimal::zero(),
            max_change_rate: Decimal::zero(),
        }], &[FullDelegation{
            delegator: Addr::unchecked(DELEGATOR),
            validator: VALIDATOR.to_string(),
            amount: Coin::new(1000000, "usei"),
            can_redelegate: Coin::new(0, "usei"),
            accumulated_rewards: vec![Coin::new(10, "usei"), Coin::new(20, "usei")],
        }]);
        let mut env = mock_env();
        env.contract.address = Addr::unchecked(DELEGATOR);
        DENOM.save(deps.as_mut().storage, &"usei".to_string()).unwrap();

        let result = get_delegation_rewards(deps.as_ref(), env, VALIDATOR.to_string()).unwrap();
        assert_eq!(30u128, result);
    }
}