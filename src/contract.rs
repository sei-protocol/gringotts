#[cfg(not(feature = "library"))]
use cosmwasm_std::entry_point;
use cosmwasm_std::{
    to_binary, Addr, Binary, BlockInfo, CosmosMsg, Decimal, Deps, DepsMut, Empty, Env, MessageInfo,
    Order, Response, StdResult, WasmMsg,
};
use cw2::set_contract_version;
use cw3::{
    Ballot, Proposal, ProposalListResponse, ProposalResponse, Status, Vote, VoteInfo,
    VoteListResponse, Votes,
};
use cw_utils::{Threshold, ThresholdError};

use crate::data_structure::EmptyStruct;
use crate::error::ContractError;
use crate::msg::{
    AdminListResponse, ExecuteMsg, InstantiateMsg, OpListResponse, QueryMsg, ShowConfigResponse,
    ShowInfoResponse,
};
use crate::permission::{authorize_admin, authorize_op, authorize_self_call};
use crate::staking::{
    delegate, get_all_delegated_validators, get_delegation_rewards, redelegate, undelegate,
    withdraw_delegation_rewards,
};
use crate::state::{
    get_number_of_admins, next_proposal_id, ADMINS, ADMIN_VOTING_THRESHOLD, BALLOTS, DENOM,
    MAX_VOTING_PERIOD, OPS, PROPOSALS, STAKING_REWARD_ADDRESS, UNLOCK_DISTRIBUTION_ADDRESS,
    VESTING_AMOUNTS, VESTING_TIMESTAMPS, WITHDRAWN_STAKING_REWARDS,
};
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
    if msg.admin_voting_threshold_percentage > 100 {
        return Err(ContractError::Threshold(
            ThresholdError::InvalidThreshold {},
        ));
    }
    msg.tranche.validate(info.funds)?;

    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;
    for admin in msg.admins.iter() {
        ADMINS.save(deps.storage, admin, &EmptyStruct {})?;
    }
    for op in msg.ops.iter() {
        OPS.save(deps.storage, op, &EmptyStruct {})?;
    }
    DENOM.save(deps.storage, &msg.tranche.denom)?;
    VESTING_TIMESTAMPS.save(deps.storage, &msg.tranche.vesting_timestamps)?;
    VESTING_AMOUNTS.save(deps.storage, &msg.tranche.vesting_amounts)?;
    UNLOCK_DISTRIBUTION_ADDRESS.save(
        deps.storage,
        &msg.tranche.unlocked_token_distribution_address,
    )?;
    STAKING_REWARD_ADDRESS.save(
        deps.storage,
        &msg.tranche.staking_reward_distribution_address,
    )?;
    MAX_VOTING_PERIOD.save(deps.storage, &msg.max_voting_period)?;
    ADMIN_VOTING_THRESHOLD.save(
        deps.storage,
        &Threshold::AbsolutePercentage {
            percentage: Decimal::percent(msg.admin_voting_threshold_percentage as u64),
        },
    )?;
    WITHDRAWN_STAKING_REWARDS.save(deps.storage, &0)?;
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
        ExecuteMsg::Delegate { validator, amount } => {
            execute_delegate(deps.as_ref(), info, validator, amount)
        }
        ExecuteMsg::Redelegate {
            src_validator,
            dst_validator,
            amount,
        } => execute_redelegate(deps.as_ref(), info, src_validator, dst_validator, amount),
        ExecuteMsg::Undelegate { validator, amount } => {
            execute_undelegate(deps.as_ref(), info, validator, amount)
        }
        ExecuteMsg::InitiateWithdrawUnlocked {} => {
            execute_initiate_withdraw_unlocked(deps, env, info)
        }
        ExecuteMsg::InitiateWithdrawReward {} => {
            execute_initiate_withdraw_reward(deps.as_ref(), env, info)
        }
        ExecuteMsg::ProposeUpdateAdmin { admin, remove } => {
            execute_propose_update_admin(deps, env, info, admin, remove)
        }
        ExecuteMsg::VoteProposal { proposal_id } => execute_vote(deps, env, info, proposal_id),
        ExecuteMsg::ProcessProposal { proposal_id } => {
            execute_process_proposal(deps, env, info, proposal_id)
        }
        ExecuteMsg::InternalUpdateAdmin { admin, remove } => {
            execute_internal_update_admin(deps, env, info, admin, remove)
        }
    }
}

fn execute_delegate(
    deps: Deps,
    info: MessageInfo,
    validator: String,
    amount: u128,
) -> Result<Response<Empty>, ContractError> {
    authorize_op(deps.storage, info.sender)?;
    let denom = DENOM.load(deps.storage)?;
    let mut response = Response::new();
    response = delegate(response, validator, amount, denom);
    Ok(response)
}

fn execute_redelegate(
    deps: Deps,
    info: MessageInfo,
    src_validator: String,
    dst_validator: String,
    amount: u128,
) -> Result<Response<Empty>, ContractError> {
    authorize_op(deps.storage, info.sender)?;
    let denom = DENOM.load(deps.storage)?;
    let mut response = Response::new();
    response = redelegate(response, src_validator, dst_validator, amount, denom);
    Ok(response)
}

fn execute_undelegate(
    deps: Deps,
    info: MessageInfo,
    validator: String,
    amount: u128,
) -> Result<Response<Empty>, ContractError> {
    authorize_op(deps.storage, info.sender)?;
    let denom = DENOM.load(deps.storage)?;
    let mut response = Response::new();
    response = undelegate(response, validator, amount, denom);
    Ok(response)
}

fn execute_initiate_withdraw_unlocked(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
) -> Result<Response<Empty>, ContractError> {
    authorize_op(deps.storage, info.sender)?;
    let vested_amount = collect_vested(deps.storage, env.block.time)?;
    distribute_vested(deps.storage, vested_amount, Response::new())
}

fn execute_initiate_withdraw_reward(
    deps: Deps,
    env: Env,
    info: MessageInfo,
) -> Result<Response<Empty>, ContractError> {
    authorize_op(deps.storage, info.sender)?;
    let mut response = Response::new();
    for validator in get_all_delegated_validators(deps, env.clone())? {
        let withdrawable_amount = get_delegation_rewards(deps, env.clone(), validator.clone())?;
        response = withdraw_delegation_rewards(deps, response, validator, withdrawable_amount)?;
    }
    Ok(response)
}

fn execute_propose_update_admin(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    admin: Addr,
    remove: bool,
) -> Result<Response<Empty>, ContractError> {
    let msg = ExecuteMsg::InternalUpdateAdmin {
        admin: admin.clone(),
        remove: remove,
    };
    let title: String;
    if remove {
        title = format!("remove {}", admin.to_string());
    } else {
        title = format!("add {}", admin.to_string());
    }
    execute_propose(
        deps,
        env.clone(),
        info.clone(),
        title.clone(),
        vec![CosmosMsg::Wasm(WasmMsg::Execute {
            contract_addr: env.contract.address.to_string(),
            msg: to_binary(&msg)?,
            funds: vec![],
        })],
    )
}

fn execute_propose(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    title: String,
    msgs: Vec<CosmosMsg>,
) -> Result<Response<Empty>, ContractError> {
    authorize_admin(deps.storage, info.sender.clone())?;

    let expires = MAX_VOTING_PERIOD.load(deps.storage)?.after(&env.block);
    let mut prop = Proposal {
        title: title,
        description: "".to_string(),
        start_height: env.block.height,
        expires,
        msgs: msgs,
        status: Status::Open,
        votes: Votes::yes(1), // every admin has equal voting power, and the proposer automatically votes
        threshold: ADMIN_VOTING_THRESHOLD.load(deps.storage)?,
        total_weight: get_number_of_admins(deps.storage) as u64,
        proposer: info.sender.clone(),
        deposit: None,
    };
    prop.update_status(&env.block);
    let id = next_proposal_id(deps.storage)?;
    PROPOSALS.save(deps.storage, id, &prop)?;

    let ballot = Ballot {
        weight: 1,
        vote: Vote::Yes,
    };
    BALLOTS.save(deps.storage, (id, &info.sender), &ballot)?;

    Ok(Response::new()
        .add_attribute("action", "propose")
        .add_attribute("sender", info.sender)
        .add_attribute("proposal_id", id.to_string())
        .add_attribute("status", format!("{:?}", prop.status)))
}

fn execute_vote(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    proposal_id: u64,
) -> Result<Response<Empty>, ContractError> {
    authorize_admin(deps.storage, info.sender.clone())?;

    let mut prop = PROPOSALS.load(deps.storage, proposal_id)?;
    if prop.status != Status::Open {
        return Err(ContractError::NotOpen {});
    }
    if prop.expires.is_expired(&env.block) {
        return Err(ContractError::Expired {});
    }

    // cast vote if no vote previously cast
    BALLOTS.update(deps.storage, (proposal_id, &info.sender), |bal| match bal {
        Some(_) => Err(ContractError::AlreadyVoted {}),
        None => Ok(Ballot {
            weight: 1,
            vote: Vote::Yes,
        }),
    })?;

    // update vote tally
    prop.votes.add_vote(Vote::Yes, 1);
    prop.update_status(&env.block);
    PROPOSALS.save(deps.storage, proposal_id, &prop)?;

    Ok(Response::new()
        .add_attribute("action", "vote")
        .add_attribute("sender", info.sender)
        .add_attribute("proposal_id", proposal_id.to_string())
        .add_attribute("status", format!("{:?}", prop.status)))
}

fn execute_process_proposal(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    proposal_id: u64,
) -> Result<Response<Empty>, ContractError> {
    authorize_admin(deps.storage, info.sender.clone())?;

    let mut prop = PROPOSALS.load(deps.storage, proposal_id)?;
    // we allow execution even after the proposal "expiration" as long as all vote come in before
    // that point. If it was approved on time, it can be executed any time.
    prop.update_status(&env.block);
    if prop.status != Status::Passed {
        return Err(ContractError::WrongExecuteStatus {});
    }

    // set it to executed
    prop.status = Status::Executed;
    PROPOSALS.save(deps.storage, proposal_id, &prop)?;

    // dispatch all proposed messages
    Ok(Response::new()
        .add_messages(prop.msgs)
        .add_attribute("action", "execute")
        .add_attribute("sender", info.sender)
        .add_attribute("proposal_id", proposal_id.to_string()))
}

fn execute_internal_update_admin(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    admin: Addr,
    remove: bool,
) -> Result<Response<Empty>, ContractError> {
    authorize_self_call(env, info)?;
    if remove {
        ADMINS.remove(deps.storage, &admin);
    } else {
        ADMINS.save(deps.storage, &admin, &EmptyStruct {})?;
    }
    Ok(Response::new())
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::ListProposals {} => to_binary(&query_proposals(deps, env)?),
        QueryMsg::ListVotes { proposal_id } => to_binary(&query_votes(deps, proposal_id)?),
        QueryMsg::ListAdmins {} => to_binary(&query_admins(deps)?),
        QueryMsg::ListOps {} => to_binary(&query_ops(deps)?),
        QueryMsg::Info {} => to_binary(&query_info(deps)?),
        QueryMsg::Config {} => to_binary(&query_config(deps)?),
    }
}

fn query_proposals(deps: Deps, env: Env) -> StdResult<ProposalListResponse> {
    let proposals: Vec<ProposalResponse> = PROPOSALS
        .range(deps.storage, None, None, Order::Descending)
        .map(|p| map_proposal(&env.block, p))
        .collect::<StdResult<_>>()?;
    Ok(ProposalListResponse { proposals })
}

fn map_proposal(
    block: &BlockInfo,
    item: StdResult<(u64, Proposal)>,
) -> StdResult<ProposalResponse> {
    item.map(|(id, prop)| {
        let status = prop.current_status(block);
        let threshold = prop.threshold.to_response(prop.total_weight);
        ProposalResponse {
            id,
            title: prop.title,
            description: prop.description,
            msgs: prop.msgs,
            status,
            deposit: prop.deposit,
            proposer: prop.proposer,
            expires: prop.expires,
            threshold,
        }
    })
}

fn query_votes(deps: Deps, proposal_id: u64) -> StdResult<VoteListResponse> {
    let votes = BALLOTS
        .prefix(proposal_id)
        .range(deps.storage, None, None, Order::Ascending)
        .map(|item| {
            item.map(|(addr, ballot)| VoteInfo {
                proposal_id,
                voter: addr.into(),
                vote: ballot.vote,
                weight: ballot.weight,
            })
        })
        .collect::<StdResult<_>>()?;

    Ok(VoteListResponse { votes })
}

fn query_admins(deps: Deps) -> StdResult<AdminListResponse> {
    let admins: Vec<Addr> = ADMINS
        .range(deps.storage, None, None, Order::Ascending)
        .map(|admin| admin.map(|(admin, _)| -> Addr { admin }))
        .collect::<StdResult<_>>()?;
    Ok(AdminListResponse { admins })
}

fn query_ops(deps: Deps) -> StdResult<OpListResponse> {
    let ops: Vec<Addr> = OPS
        .range(deps.storage, None, None, Order::Ascending)
        .map(|op| op.map(|(op, _)| -> Addr { op }))
        .collect::<StdResult<_>>()?;
    Ok(OpListResponse { ops })
}

fn query_info(deps: Deps) -> StdResult<ShowInfoResponse> {
    Ok(ShowInfoResponse {
        denom: DENOM.load(deps.storage)?,
        vesting_timestamps: VESTING_TIMESTAMPS.load(deps.storage)?,
        vesting_amounts: VESTING_AMOUNTS.load(deps.storage)?,
        unlock_distribution_address: UNLOCK_DISTRIBUTION_ADDRESS.load(deps.storage)?,
        staking_reward_address: STAKING_REWARD_ADDRESS.load(deps.storage)?,
        withdrawn_staking_rewards: WITHDRAWN_STAKING_REWARDS.load(deps.storage)?,
    })
}

fn query_config(deps: Deps) -> StdResult<ShowConfigResponse> {
    Ok(ShowConfigResponse {
        max_voting_period: MAX_VOTING_PERIOD.load(deps.storage)?,
        admin_voting_threshold: ADMIN_VOTING_THRESHOLD.load(deps.storage)?,
    })
}

#[cfg(test)]
mod tests {
    use cosmwasm_std::testing::{mock_dependencies, mock_env, mock_info};
    use cosmwasm_std::{from_binary, Addr, Coin, Decimal, FullDelegation, Validator};

    use cw2::{get_contract_version, ContractVersion};
    use cw_utils::{Duration, Expiration, ThresholdResponse};

    use crate::data_structure::Tranche;

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
    fn setup_test_case(deps: DepsMut, info: MessageInfo) -> Result<Response<Empty>, ContractError> {
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
            ops: vec![Addr::unchecked(VOTER5), Addr::unchecked(VOTER6)],
            tranche: Tranche {
                denom: "usei".to_string(),
                vesting_amounts,
                vesting_timestamps,
                unlocked_token_distribution_address: Addr::unchecked(UNLOCK_ADDR1),
                staking_reward_distribution_address: Addr::unchecked(REWARD_ADDR1),
            },
            max_voting_period: Duration::Time(3600),
            admin_voting_threshold_percentage: 75,
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
            ops: vec![Addr::unchecked(VOTER5)],
            tranche: Tranche {
                denom: "usei".to_string(),
                vesting_amounts: vec![1],
                vesting_timestamps: vec![mock_env().block.time],
                unlocked_token_distribution_address: Addr::unchecked(UNLOCK_ADDR1),
                staking_reward_distribution_address: Addr::unchecked(REWARD_ADDR1),
            },
            max_voting_period: Duration::Time(3600),
            admin_voting_threshold_percentage: 75,
        };
        let err =
            instantiate(deps.as_mut(), mock_env(), info.clone(), instantiate_msg).unwrap_err();
        assert_eq!(err, ContractError::NoAdmins {});

        // Zero ops fails
        let instantiate_msg = InstantiateMsg {
            admins: vec![Addr::unchecked(VOTER1)],
            ops: vec![],
            tranche: Tranche {
                denom: "usei".to_string(),
                vesting_amounts: vec![1],
                vesting_timestamps: vec![mock_env().block.time],
                unlocked_token_distribution_address: Addr::unchecked(UNLOCK_ADDR1),
                staking_reward_distribution_address: Addr::unchecked(REWARD_ADDR1),
            },
            max_voting_period: Duration::Time(3600),
            admin_voting_threshold_percentage: 75,
        };
        let err =
            instantiate(deps.as_mut(), mock_env(), info.clone(), instantiate_msg).unwrap_err();
        assert_eq!(err, ContractError::NoOps {},);

        // Invalid vesting schedule
        let instantiate_msg = InstantiateMsg {
            admins: vec![Addr::unchecked(VOTER1)],
            ops: vec![Addr::unchecked(VOTER5)],
            tranche: Tranche {
                denom: "usei".to_string(),
                vesting_amounts: vec![],
                vesting_timestamps: vec![mock_env().block.time],
                unlocked_token_distribution_address: Addr::unchecked(UNLOCK_ADDR1),
                staking_reward_distribution_address: Addr::unchecked(REWARD_ADDR1),
            },
            max_voting_period: Duration::Time(3600),
            admin_voting_threshold_percentage: 75,
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

        let msg = ExecuteMsg::Delegate {
            validator: "val".to_string(),
            amount: 100,
        };
        let res = execute(deps.as_mut(), mock_env(), info, msg).unwrap();
        assert_eq!(1, res.messages.len());
    }

    #[test]
    fn delegate_unauthorized() {
        let mut deps = mock_dependencies();

        let info = mock_info(OWNER, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();

        let msg = ExecuteMsg::Delegate {
            validator: "val".to_string(),
            amount: 100,
        };
        execute(deps.as_mut(), mock_env(), info, msg).unwrap_err();
    }

    #[test]
    fn redelegate_work() {
        let mut deps = mock_dependencies();

        let info = mock_info(VOTER5, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();

        let msg = ExecuteMsg::Redelegate {
            src_validator: "val1".to_string(),
            dst_validator: "val2".to_string(),
            amount: 100,
        };
        let res = execute(deps.as_mut(), mock_env(), info, msg).unwrap();
        assert_eq!(1, res.messages.len());
    }

    #[test]
    fn redelegate_unauthorized() {
        let mut deps = mock_dependencies();

        let info = mock_info(OWNER, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();

        let msg = ExecuteMsg::Redelegate {
            src_validator: "val1".to_string(),
            dst_validator: "val2".to_string(),
            amount: 100,
        };
        execute(deps.as_mut(), mock_env(), info, msg).unwrap_err();
    }

    #[test]
    fn undelegate_work() {
        let mut deps = mock_dependencies();

        let info = mock_info(VOTER5, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();

        let msg = ExecuteMsg::Undelegate {
            validator: "val".to_string(),
            amount: 100,
        };
        let res = execute(deps.as_mut(), mock_env(), info, msg).unwrap();
        assert_eq!(1, res.messages.len());
    }

    #[test]
    fn undelegate_unauthorized() {
        let mut deps = mock_dependencies();

        let info = mock_info(OWNER, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();

        let msg = ExecuteMsg::Undelegate {
            validator: "val".to_string(),
            amount: 100,
        };
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
        let validator1 = "val1";
        let validator2 = "val2";
        let mut deps = mock_dependencies();
        deps.querier.update_staking(
            "usei",
            &[
                Validator {
                    address: validator1.to_string(),
                    commission: Decimal::zero(),
                    max_commission: Decimal::zero(),
                    max_change_rate: Decimal::zero(),
                },
                Validator {
                    address: validator2.to_string(),
                    commission: Decimal::zero(),
                    max_commission: Decimal::zero(),
                    max_change_rate: Decimal::zero(),
                },
            ],
            &[
                FullDelegation {
                    delegator: Addr::unchecked(mock_env().contract.address),
                    validator: validator1.to_string(),
                    amount: Coin::new(1000000, "usei"),
                    can_redelegate: Coin::new(0, "usei"),
                    accumulated_rewards: vec![Coin::new(10, "usei"), Coin::new(20, "usei")],
                },
                FullDelegation {
                    delegator: Addr::unchecked(mock_env().contract.address),
                    validator: validator2.to_string(),
                    amount: Coin::new(500000, "usei"),
                    can_redelegate: Coin::new(0, "usei"),
                    accumulated_rewards: vec![Coin::new(5, "usei")],
                },
            ],
        );

        let info = mock_info(VOTER5, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();

        let msg = ExecuteMsg::InitiateWithdrawReward {};
        let res = execute(deps.as_mut(), mock_env(), info, msg).unwrap();
        assert_eq!(4, res.messages.len());
    }

    #[test]
    fn initiate_withdraw_reward_unauthorized() {
        let mut deps = mock_dependencies();

        let info = mock_info(OWNER, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();

        let msg = ExecuteMsg::InitiateWithdrawReward {};
        execute(deps.as_mut(), mock_env(), info, msg).unwrap_err();
    }

    #[test]
    fn test_propose_update_admin_works() {
        let mut deps = mock_dependencies();

        let info = mock_info(OWNER, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();

        let info = mock_info(VOTER1, &[]);
        let proposal = ExecuteMsg::ProposeUpdateAdmin {
            admin: Addr::unchecked("new_admin1"),
            remove: false,
        };
        let res = execute(deps.as_mut(), mock_env(), info, proposal.clone()).unwrap();

        // Verify
        assert_eq!(
            res,
            Response::new()
                .add_attribute("action", "propose")
                .add_attribute("sender", VOTER1)
                .add_attribute("proposal_id", 1.to_string())
                .add_attribute("status", "Open")
        );
    }

    #[test]
    fn test_propose_update_admin_unauthorized() {
        let mut deps = mock_dependencies();

        let info = mock_info(OWNER, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();

        let info = mock_info(OWNER, &[]);
        let proposal = ExecuteMsg::ProposeUpdateAdmin {
            admin: Addr::unchecked("new_admin1"),
            remove: false,
        };
        let err = execute(deps.as_mut(), mock_env(), info, proposal.clone()).unwrap_err();
        assert_eq!(err, ContractError::Unauthorized {});
    }

    #[test]
    fn test_vote_works() {
        let mut deps = mock_dependencies();

        let info = mock_info(OWNER, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();

        let info = mock_info(VOTER1, &[]);
        let proposal = ExecuteMsg::ProposeUpdateAdmin {
            admin: Addr::unchecked("new_admin1"),
            remove: false,
        };
        execute(deps.as_mut(), mock_env(), info, proposal.clone()).unwrap();

        let info = mock_info(VOTER2, &[]);
        let vote2 = ExecuteMsg::VoteProposal { proposal_id: 1 };
        execute(deps.as_mut(), mock_env(), info, vote2.clone()).unwrap();

        let info = mock_info(VOTER3, &[]);
        let vote3 = ExecuteMsg::VoteProposal { proposal_id: 1 };
        execute(deps.as_mut(), mock_env(), info, vote3.clone()).unwrap();
    }

    #[test]
    fn test_vote_expired() {
        let mut deps = mock_dependencies();

        let info = mock_info(OWNER, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();

        let info = mock_info(VOTER1, &[]);
        let proposal = ExecuteMsg::ProposeUpdateAdmin {
            admin: Addr::unchecked("new_admin1"),
            remove: false,
        };
        execute(deps.as_mut(), mock_env(), info, proposal.clone()).unwrap();

        let info = mock_info(VOTER2, &[]);
        let vote2 = ExecuteMsg::VoteProposal { proposal_id: 1 };
        execute(deps.as_mut(), mock_env(), info, vote2.clone()).unwrap();

        let info = mock_info(VOTER3, &[]);
        let vote3 = ExecuteMsg::VoteProposal { proposal_id: 1 };
        let mut env = mock_env();
        env.block.time = env.block.time.plus_seconds(3601);
        let err = execute(deps.as_mut(), env, info, vote3.clone()).unwrap_err();
        assert_eq!(err, ContractError::Expired {});
    }

    #[test]
    fn test_process_update_admin_works() {
        let mut deps = mock_dependencies();

        let info = mock_info(OWNER, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();

        let info = mock_info(VOTER1, &[]);
        let proposal = ExecuteMsg::ProposeUpdateAdmin {
            admin: Addr::unchecked("new_admin1"),
            remove: false,
        };
        execute(deps.as_mut(), mock_env(), info, proposal.clone()).unwrap();

        let info = mock_info(VOTER2, &[]);
        let vote2 = ExecuteMsg::VoteProposal { proposal_id: 1 };
        execute(deps.as_mut(), mock_env(), info, vote2.clone()).unwrap();

        let info = mock_info(VOTER3, &[]);
        let vote3 = ExecuteMsg::VoteProposal { proposal_id: 1 };
        execute(deps.as_mut(), mock_env(), info, vote3.clone()).unwrap();

        let info = mock_info(VOTER3, &[]);
        let process = ExecuteMsg::ProcessProposal { proposal_id: 1 };
        let res = execute(deps.as_mut(), mock_env(), info, process.clone()).unwrap();

        assert_eq!(1, res.messages.len());
    }

    #[test]
    fn test_process_proposal_premature() {
        let mut deps = mock_dependencies();

        let info = mock_info(OWNER, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();

        let info = mock_info(VOTER1, &[]);
        let proposal = ExecuteMsg::ProposeUpdateAdmin {
            admin: Addr::unchecked("new_admin1"),
            remove: false,
        };
        execute(deps.as_mut(), mock_env(), info, proposal.clone()).unwrap();

        let info = mock_info(VOTER2, &[]);
        let vote2 = ExecuteMsg::VoteProposal { proposal_id: 1 };
        execute(deps.as_mut(), mock_env(), info, vote2.clone()).unwrap();

        let info = mock_info(VOTER3, &[]);
        let process = ExecuteMsg::ProcessProposal { proposal_id: 1 };
        let err = execute(deps.as_mut(), mock_env(), info, process.clone()).unwrap_err();

        assert_eq!(err, ContractError::WrongExecuteStatus {});
    }

    #[test]
    fn test_process_update_admin_double_process() {
        let mut deps = mock_dependencies();

        let info = mock_info(OWNER, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();

        let info = mock_info(VOTER1, &[]);
        let proposal = ExecuteMsg::ProposeUpdateAdmin {
            admin: Addr::unchecked("new_admin1"),
            remove: false,
        };
        execute(deps.as_mut(), mock_env(), info, proposal.clone()).unwrap();

        let info = mock_info(VOTER2, &[]);
        let vote2 = ExecuteMsg::VoteProposal { proposal_id: 1 };
        execute(deps.as_mut(), mock_env(), info, vote2.clone()).unwrap();

        let info = mock_info(VOTER3, &[]);
        let vote3 = ExecuteMsg::VoteProposal { proposal_id: 1 };
        execute(deps.as_mut(), mock_env(), info, vote3.clone()).unwrap();

        let info = mock_info(VOTER3, &[]);
        let process = ExecuteMsg::ProcessProposal { proposal_id: 1 };
        execute(deps.as_mut(), mock_env(), info, process.clone()).unwrap();
        let info = mock_info(VOTER3, &[]);
        let err = execute(deps.as_mut(), mock_env(), info, process.clone()).unwrap_err();

        assert_eq!(err, ContractError::WrongExecuteStatus {});
    }

    #[test]
    fn test_execute_internal_update_admin_works() {
        let mut deps = mock_dependencies();

        let info = mock_info(OWNER, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();

        let info = mock_info(mock_env().contract.address.as_str(), &[]);
        let proposal = ExecuteMsg::InternalUpdateAdmin {
            admin: Addr::unchecked("new_admin1"),
            remove: false,
        };
        execute(deps.as_mut(), mock_env(), info, proposal.clone()).unwrap();
        ADMINS
            .load(deps.as_ref().storage, &Addr::unchecked("new_admin1"))
            .unwrap();
        assert_eq!(5, get_number_of_admins(deps.as_ref().storage));
    }

    #[test]
    fn test_execute_internal_update_admin_remove_works() {
        let mut deps = mock_dependencies();

        let info = mock_info(OWNER, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();

        let info = mock_info(mock_env().contract.address.as_str(), &[]);
        let proposal = ExecuteMsg::InternalUpdateAdmin {
            admin: Addr::unchecked(VOTER1),
            remove: true,
        };
        execute(deps.as_mut(), mock_env(), info, proposal.clone()).unwrap();
        ADMINS
            .load(deps.as_ref().storage, &Addr::unchecked(VOTER1))
            .unwrap_err();
        assert_eq!(3, get_number_of_admins(deps.as_ref().storage));
    }

    #[test]
    fn test_execute_internal_update_admin_unauthorized() {
        let mut deps = mock_dependencies();

        let info = mock_info(OWNER, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();

        let info = mock_info(VOTER1, &[]);
        let proposal = ExecuteMsg::InternalUpdateAdmin {
            admin: Addr::unchecked("new_admin1"),
            remove: false,
        };
        let err = execute(deps.as_mut(), mock_env(), info, proposal.clone()).unwrap_err();
        assert_eq!(err, ContractError::Unauthorized {});
        ADMINS
            .load(deps.as_ref().storage, &Addr::unchecked("new_admin1"))
            .unwrap_err();
        ADMINS
            .load(deps.as_ref().storage, &Addr::unchecked("new_admin2"))
            .unwrap_err();
        assert_eq!(4, get_number_of_admins(deps.as_ref().storage));
    }

    #[test]
    fn test_query_proposals() {
        let mut deps = mock_dependencies();
        PROPOSALS
            .save(
                deps.as_mut().storage,
                1,
                &Proposal {
                    title: "title".to_string(),
                    description: "description".to_string(),
                    start_height: 1,
                    expires: Expiration::Never {},
                    msgs: vec![],
                    status: Status::Open,
                    votes: Votes::yes(1),
                    threshold: Threshold::AbsolutePercentage {
                        percentage: Decimal::percent(75),
                    },
                    total_weight: 4,
                    proposer: Addr::unchecked("proposer"),
                    deposit: None,
                },
            )
            .unwrap();
        let msg = QueryMsg::ListProposals {};
        let bin = query(deps.as_ref(), mock_env(), msg).unwrap();
        let res: ProposalListResponse = from_binary(&bin).unwrap();
        assert_eq!(
            res.proposals,
            vec![ProposalResponse {
                id: 1,
                title: "title".to_string(),
                description: "description".to_string(),
                expires: Expiration::Never {},
                msgs: vec![],
                status: Status::Open,
                threshold: ThresholdResponse::AbsolutePercentage {
                    percentage: Decimal::percent(75),
                    total_weight: 4,
                },
                proposer: Addr::unchecked("proposer"),
                deposit: None,
            }]
        );
    }

    #[test]
    fn test_query_votes() {
        let mut deps = mock_dependencies();
        BALLOTS
            .save(
                deps.as_mut().storage,
                (1, &Addr::unchecked("admin")),
                &Ballot {
                    weight: 1,
                    vote: Vote::Yes,
                },
            )
            .unwrap();
        BALLOTS
            .save(
                deps.as_mut().storage,
                (2, &Addr::unchecked("admin")),
                &Ballot {
                    weight: 1,
                    vote: Vote::No,
                },
            )
            .unwrap();
        let msg = QueryMsg::ListVotes { proposal_id: 1 };
        let bin = query(deps.as_ref(), mock_env(), msg).unwrap();
        let res: VoteListResponse = from_binary(&bin).unwrap();
        assert_eq!(
            res.votes,
            vec![VoteInfo {
                proposal_id: 1,
                voter: "admin".to_string(),
                vote: Vote::Yes,
                weight: 1,
            }]
        );
    }

    #[test]
    fn test_query_admins() {
        let mut deps = mock_dependencies();

        let info = mock_info(OWNER, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();
        let msg = QueryMsg::ListAdmins {};
        let bin = query(deps.as_ref(), mock_env(), msg).unwrap();
        let res: AdminListResponse = from_binary(&bin).unwrap();
        assert_eq!(
            res.admins,
            vec![
                Addr::unchecked(VOTER1),
                Addr::unchecked(VOTER2),
                Addr::unchecked(VOTER3),
                Addr::unchecked(VOTER4),
            ]
        );
    }

    #[test]
    fn test_query_ops() {
        let mut deps = mock_dependencies();

        let info = mock_info(OWNER, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();
        let msg = QueryMsg::ListOps {};
        let bin = query(deps.as_ref(), mock_env(), msg).unwrap();
        let res: OpListResponse = from_binary(&bin).unwrap();
        assert_eq!(
            res.ops,
            vec![Addr::unchecked(VOTER5), Addr::unchecked(VOTER6),]
        );
    }

    #[test]
    fn test_query_info() {
        let mut deps = mock_dependencies();

        let info = mock_info(OWNER, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();
        let msg = QueryMsg::Info {};
        let bin = query(deps.as_ref(), mock_env(), msg).unwrap();
        let res: ShowInfoResponse = from_binary(&bin).unwrap();
        assert_eq!(
            res,
            ShowInfoResponse {
                denom: "usei".to_string(),
                vesting_timestamps: VESTING_TIMESTAMPS.load(deps.as_ref().storage).unwrap(),
                vesting_amounts: VESTING_AMOUNTS.load(deps.as_ref().storage).unwrap(),
                unlock_distribution_address: Addr::unchecked(UNLOCK_ADDR1),
                staking_reward_address: Addr::unchecked(REWARD_ADDR1),
                withdrawn_staking_rewards: 0,
            }
        );
    }

    #[test]
    fn test_query_config() {
        let mut deps = mock_dependencies();

        let info = mock_info(OWNER, &[Coin::new(48000000, "usei".to_string())]);
        setup_test_case(deps.as_mut(), info.clone()).unwrap();
        let msg = QueryMsg::Config {};
        let bin = query(deps.as_ref(), mock_env(), msg).unwrap();
        let res: ShowConfigResponse = from_binary(&bin).unwrap();
        assert_eq!(
            res,
            ShowConfigResponse {
                max_voting_period: Duration::Time(3600),
                admin_voting_threshold: Threshold::AbsolutePercentage {
                    percentage: Decimal::percent(75)
                },
            }
        );
    }
}
