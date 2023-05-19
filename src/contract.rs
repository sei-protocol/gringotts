

#[cfg(not(feature = "library"))]
use cosmwasm_std::entry_point;
use cosmwasm_std::{
    to_binary, Binary, Deps, DepsMut, Empty, Env, MessageInfo,
    Response, StdResult,
};
use cw2::set_contract_version;

use crate::data_structure::EmptyStruct;
use crate::error::ContractError;
use crate::msg::{ExecuteMsg, InstantiateMsg, QueryMsg};
use crate::permission::authorize_op;
use crate::staking::{delegate, redelegate, undelegate, withdraw_delegation_rewards};
use crate::state::{ADMINS, OPS, DENOM,
    VESTING_TIMESTAMPS, VESTING_AMOUNTS, UNLOCK_DISTRIBUTION_ADDRESS, STAKING_REWARD_ADDRESS};
use crate::vesting::{collect_vested, distribute_vested};

// version info for migration info
const CONTRACT_NAME: &str = "crates.io:sei-gringotts";
const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    if msg.admins.is_empty() {
        return Err(ContractError::NoAdmins {});
    }
    if msg.ops.is_empty() {
        return Err(ContractError::NoOps {});
    }
    msg.tranche.validate(info.funds)?;

    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;
    for admin in msg.admins.iter() {
        ADMINS.save(deps.storage, admin, &EmptyStruct{})?;
    }
    for op in msg.ops.iter() {
        OPS.save(deps.storage, op, &EmptyStruct{})?;
    }
    DENOM.save(deps.storage, &msg.tranche.denom)?;
    VESTING_TIMESTAMPS.save(deps.storage, &msg.tranche.vesting_timestamps)?;
    VESTING_AMOUNTS.save(deps.storage, &msg.tranche.vesting_amounts)?;
    UNLOCK_DISTRIBUTION_ADDRESS.save(deps.storage, &msg.tranche.unlocked_token_distribution_address)?;
    STAKING_REWARD_ADDRESS.save(deps.storage, &msg.tranche.staking_reward_distribution_address)?;
    Ok(Response::default())
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response<Empty>, ContractError> {
    match msg {
        ExecuteMsg::Delegate {
            validator, amount,
        } => execute_delegate(deps.as_ref(), info, validator, amount),
        ExecuteMsg::Redelegate {
            src_validator, dst_validator, amount
        } => execute_redelegate(deps.as_ref(), info, src_validator, dst_validator, amount),
        ExecuteMsg::Undelegate {
            validator, amount,
        } => execute_undelegate(deps.as_ref(), info, validator, amount),
        ExecuteMsg::InitiateWithdrawUnlocked {} => execute_initiate_withdraw_unlocked(deps, env, info),
        ExecuteMsg::InitiateWithdrawReward { validator } => execute_initiate_withdraw_reward(deps.as_ref(), info, validator),
    }
}

fn execute_delegate(deps: Deps, info: MessageInfo, validator: String, amount: u128) -> Result<Response<Empty>, ContractError> {
    authorize_op(deps.storage, info.sender)?;
    let denom = DENOM.load(deps.storage)?;
    let mut response = Response::new();
    response = delegate(response, validator, amount, denom);
    Ok(response)
}

fn execute_redelegate(deps: Deps, info: MessageInfo, src_validator: String, dst_validator: String, amount: u128) -> Result<Response<Empty>, ContractError> {
    authorize_op(deps.storage, info.sender)?;
    let denom = DENOM.load(deps.storage)?;
    let mut response = Response::new();
    response = redelegate(response, src_validator, dst_validator, amount, denom);
    Ok(response)
}

fn execute_undelegate(deps: Deps, info: MessageInfo, validator: String, amount: u128) -> Result<Response<Empty>, ContractError> {
    authorize_op(deps.storage, info.sender)?;
    let denom = DENOM.load(deps.storage)?;
    let mut response = Response::new();
    response = undelegate(response, validator, amount, denom);
    Ok(response)
}

fn execute_initiate_withdraw_unlocked(deps: DepsMut, env: Env, info: MessageInfo) -> Result<Response<Empty>, ContractError> {
    authorize_op(deps.storage, info.sender)?;
    let vested_amount = collect_vested(deps.storage, env.block.time)?;
    distribute_vested(deps.storage, vested_amount, Response::new())
}

fn execute_initiate_withdraw_reward(deps: Deps, info: MessageInfo, validator: String) -> Result<Response<Empty>, ContractError> {
    authorize_op(deps.storage, info.sender)?;
    Ok(withdraw_delegation_rewards(Response::new(), validator))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(_deps: Deps, _env: Env, _msg: QueryMsg) -> StdResult<Binary> {
    Ok(to_binary("").unwrap())
}

#[cfg(test)]
mod tests {
    use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};
    use cosmwasm_std::{Addr, Coin};

    use cw2::{get_contract_version, ContractVersion};
    use cw_utils::{Duration};

    use crate::data_structure::{Tranche};

    use super::*;

    const OWNER: &str = "admin0001";
    const VOTER1: &str = "voter0001";
    const VOTER2: &str = "voter0002";
    const VOTER3: &str = "voter0003";
    const VOTER4: &str = "voter0004";
    const VOTER5: &str = "voter0005";
    const VOTER6: &str = "voter0006";

    const UNLOCK_ADDR1: &str = "unlock0001";
    const REWARD_ADDR1: &str = "reward0001";

    // this will set up the instantiation for other tests
    #[track_caller]
    fn setup_test_case(
        deps: DepsMut,
        info: MessageInfo,
    ) -> Result<Response<Empty>, ContractError> {
        let env = mock_env();
        let mut vesting_amounts = vec![12000000u128];
        let mut vesting_timestamps = vec![env.block.time.plus_seconds(31536000)];
        for _ in 1..37 {
            vesting_amounts.push(1000000u128);
            vesting_timestamps.push(vesting_timestamps.last().unwrap().plus_seconds(2592000));
        }
        let instantiate_msg = InstantiateMsg {
            admins: vec![
                Addr::unchecked(VOTER1),
                Addr::unchecked(VOTER2),
                Addr::unchecked(VOTER3),
                Addr::unchecked(VOTER4),
            ],
            ops: vec![
                Addr::unchecked(VOTER5),
                Addr::unchecked(VOTER6),
            ],
            tranche: Tranche {
                denom: "usei".to_string(),
                vesting_amounts,
                vesting_timestamps,
                unlocked_token_distribution_address: Addr::unchecked(UNLOCK_ADDR1),
                staking_reward_distribution_address: Addr::unchecked(REWARD_ADDR1),
            },
        };
        instantiate(deps, mock_env(), info, instantiate_msg)
    }

    #[test]
    fn test_instantiate_works() {
        let mut deps = mock_dependencies();
        let info = mock_info(OWNER, &[]);

        let _max_voting_period = Duration::Time(1234567);

        // No admins fails
        let instantiate_msg = InstantiateMsg {
            admins: vec![],
            ops: vec![
                Addr::unchecked(VOTER5),
            ],
            tranche: Tranche {
                denom: "usei".to_string(),
                vesting_amounts: vec![1],
                vesting_timestamps: vec![mock_env().block.time],
                unlocked_token_distribution_address: Addr::unchecked(UNLOCK_ADDR1),
                staking_reward_distribution_address: Addr::unchecked(REWARD_ADDR1),
            },
        };
        let err = instantiate(
            deps.as_mut(),
            mock_env(),
            info.clone(),
            instantiate_msg,
        )
        .unwrap_err();
        assert_eq!(err, ContractError::NoAdmins {});

        // Zero ops fails
        let instantiate_msg = InstantiateMsg {
            admins: vec![
                Addr::unchecked(VOTER1),
            ],
            ops: vec![],
            tranche: Tranche {
                denom: "usei".to_string(),
                vesting_amounts: vec![1],
                vesting_timestamps: vec![mock_env().block.time],
                unlocked_token_distribution_address: Addr::unchecked(UNLOCK_ADDR1),
                staking_reward_distribution_address: Addr::unchecked(REWARD_ADDR1),
            },
        };
        let err =
            instantiate(deps.as_mut(), mock_env(), info.clone(), instantiate_msg).unwrap_err();
        assert_eq!(
            err,
            ContractError::NoOps {},
        );

        // Invalid vesting schedule
        let instantiate_msg = InstantiateMsg {
            admins: vec![
                Addr::unchecked(VOTER1),
            ],
            ops: vec![
                Addr::unchecked(VOTER5),
            ],
            tranche: Tranche {
                denom: "usei".to_string(),
                vesting_amounts: vec![],
                vesting_timestamps: vec![mock_env().block.time],
                unlocked_token_distribution_address: Addr::unchecked(UNLOCK_ADDR1),
                staking_reward_distribution_address: Addr::unchecked(REWARD_ADDR1),
            },
        };
        let err =
            instantiate(deps.as_mut(), mock_env(), info.clone(), instantiate_msg).unwrap_err();
        assert_eq!(
            err,
            ContractError::InvalidTranche("nothing to vest".to_string()),
        );

        // insufficient funds
        let err = setup_test_case(deps.as_mut(), info).unwrap_err();
        assert_eq!(
            err,
            ContractError::InvalidTranche("insufficient deposit for the vesting plan".to_string()),
        );

        // happy path
        let info = mock_info(OWNER, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info).unwrap();

        // Verify
        assert_eq!(
            ContractVersion {
                contract: CONTRACT_NAME.to_string(),
                version: CONTRACT_VERSION.to_string(),
            },
            get_contract_version(&deps.storage).unwrap()
        )
    }

    #[test]
    fn delegate_work() {
        let mut deps = mock_dependencies();

        let info = mock_info(VOTER5, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();

        let msg = ExecuteMsg::Delegate { validator: "val".to_string(), amount: 100 };
        let res = execute(deps.as_mut(), mock_env(), info, msg).unwrap();
        assert_eq!(1, res.messages.len());
    }

    #[test]
    fn delegate_unauthorized() {
        let mut deps = mock_dependencies();

        let info = mock_info(OWNER, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();

        let msg = ExecuteMsg::Delegate { validator: "val".to_string(), amount: 100 };
        execute(deps.as_mut(), mock_env(), info, msg).unwrap_err();
    }

    #[test]
    fn redelegate_work() {
        let mut deps = mock_dependencies();

        let info = mock_info(VOTER5, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();

        let msg = ExecuteMsg::Redelegate { src_validator: "val1".to_string(), dst_validator: "val2".to_string(), amount: 100 };
        let res = execute(deps.as_mut(), mock_env(), info, msg).unwrap();
        assert_eq!(1, res.messages.len());
    }

    #[test]
    fn redelegate_unauthorized() {
        let mut deps = mock_dependencies();

        let info = mock_info(OWNER, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();

        let msg = ExecuteMsg::Redelegate { src_validator: "val1".to_string(), dst_validator: "val2".to_string(), amount: 100 };
        execute(deps.as_mut(), mock_env(), info, msg).unwrap_err();
    }

    #[test]
    fn undelegate_work() {
        let mut deps = mock_dependencies();

        let info = mock_info(VOTER5, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();

        let msg = ExecuteMsg::Undelegate { validator: "val".to_string(), amount: 100 };
        let res = execute(deps.as_mut(), mock_env(), info, msg).unwrap();
        assert_eq!(1, res.messages.len());
    }

    #[test]
    fn undelegate_unauthorized() {
        let mut deps = mock_dependencies();

        let info = mock_info(OWNER, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();

        let msg = ExecuteMsg::Undelegate { validator: "val".to_string(), amount: 100 };
        execute(deps.as_mut(), mock_env(), info, msg).unwrap_err();
    }

    #[test]
    fn initiate_withdraw_unlocked_work() {
        let mut deps = mock_dependencies();

        let info = mock_info(VOTER5, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();

        let msg = ExecuteMsg::InitiateWithdrawUnlocked {};
        let mut env = mock_env();
        let mut block = env.block;
        block.time = block.time.plus_seconds(31536000);
        env.block = block;
        let res = execute(deps.as_mut(), env, info, msg).unwrap();
        assert_eq!(1, res.messages.len());
    }

    #[test]
    fn initiate_withdraw_unlocked_unauthorized() {
        let mut deps = mock_dependencies();

        let info = mock_info(OWNER, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();

        let msg = ExecuteMsg::InitiateWithdrawUnlocked {};
        let mut env = mock_env();
        let mut block = env.block;
        block.time = block.time.plus_seconds(31536000);
        env.block = block;
        let err = execute(deps.as_mut(), mock_env(), info, msg).unwrap_err();
        assert_eq!(err, ContractError::Unauthorized {});
    }

    #[test]
    fn initiate_withdraw_reward_work() {
        let mut deps = mock_dependencies();

        let info = mock_info(VOTER5, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();

        let msg = ExecuteMsg::InitiateWithdrawReward { validator: "val".to_string() };
        let res = execute(deps.as_mut(), mock_env(), info, msg).unwrap();
        assert_eq!(1, res.messages.len());
    }

    #[test]
    fn initiate_withdraw_reward_unauthorized() {
        let mut deps = mock_dependencies();

        let info = mock_info(OWNER, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();

        let msg = ExecuteMsg::InitiateWithdrawReward { validator: "val".to_string() };
        execute(deps.as_mut(), mock_env(), info, msg).unwrap_err();
    }
}