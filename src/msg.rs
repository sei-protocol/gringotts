use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{Addr, CustomQuery, Timestamp, Uint128, VoteOption};
use cw_utils::{Duration, Threshold};

use crate::data_structure::Tranche;

#[cw_serde]
pub struct MigrateMsg {}

#[cw_serde]
pub struct InstantiateMsg {
    pub admins: Vec<Addr>,
    pub ops: Vec<Addr>,
    pub tranche: Tranche,
    pub max_voting_period: Duration,
    pub admin_voting_threshold_percentage: u8,

    // override cumulative state (for inheriting a contract or testing)
    pub withdrawn_staking_rewards: Option<u128>,
    pub withdrawn_unlocked: Option<u128>,
    pub withdrawn_locked: Option<u128>,
}

#[cw_serde]
pub enum ExecuteMsg {
    Delegate {
        validator: String,
        amount: u128,
    },
    Redelegate {
        src_validator: String,
        dst_validator: String,
        amount: u128,
    },
    Undelegate {
        validator: String,
        amount: u128,
    },
    InitiateWithdrawUnlocked {
        amount: u128,
    },
    InitiateWithdrawReward {},
    UpdateOp {
        op: Addr,
        remove: bool,
    },
    ProposeEmergencyWithdraw {
        dst: Addr,
    },
    ProposeUpdateAdmin {
        admin: Addr,
        remove: bool,
    },
    ProposeUpdateUnlockedDistributionAddress {
        unlocked_distribution_address: Addr,
    },
    ProposeUpdateStakingRewardDistributionAddress {
        staking_reward_distribution_address: Addr,
    },
    ProposeGovVote {
        gov_proposal_id: u64,
        gov_vote: VoteOption,
    },
    VoteProposal {
        proposal_id: u64,
    },
    ProcessProposal {
        proposal_id: u64,
    },
    InternalUpdateAdmin {
        admin: Addr,
        remove: bool,
    },
    InternalUpdateUnlockedDistributionAddress {
        unlocked_distribution_address: Addr,
    },
    InternalUpdateStakingRewardDistributionAddress {
        staking_reward_distribution_address: Addr,
    },
    InternalWithdrawLocked {
        dst: Addr,
    },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(cw3::ProposalListResponse)]
    ListProposals {},
    #[returns(cw3::VoteListResponse)]
    ListVotes { proposal_id: u64 },
    #[returns(AdminListResponse)]
    ListAdmins {},
    #[returns(OpListResponse)]
    ListOps {},
    #[returns(ShowInfoResponse)]
    Info {},
    #[returns(ShowConfigResponse)]
    Config {},
    #[returns(ShowTotalVestedResponse)]
    TotalVested {},
}

#[cw_serde]
pub struct AdminListResponse {
    pub admins: Vec<Addr>,
}

#[cw_serde]
pub struct OpListResponse {
    pub ops: Vec<Addr>,
}

#[cw_serde]
pub struct ShowInfoResponse {
    pub denom: String,
    pub vesting_timestamps: Vec<Timestamp>,
    pub vesting_amounts: Vec<u128>,
    pub unlock_distribution_address: Addr,
    pub staking_reward_address: Addr,
    pub withdrawn_staking_rewards: u128,
    pub withdrawn_unlocked: u128,
    pub withdrawn_locked: u128,
}

#[cw_serde]
pub struct ShowConfigResponse {
    pub max_voting_period: Duration,
    pub admin_voting_threshold: Threshold,
}

#[cw_serde]
pub struct ShowTotalVestedResponse {
    pub vested_amount: u128,
}

#[cw_serde]
pub struct SeiQueryWrapper {
    pub route: SeiRoute,
    pub query_data: SeiQuery,
}

impl CustomQuery for SeiQueryWrapper {}

#[cw_serde]
pub enum SeiRoute {
    Stakingext,
}

#[cw_serde]
pub enum SeiQuery {
    UnbondingDelegations { delegator: String },
}

#[cw_serde]
pub struct UnbondingDelegationEntry {
    pub creation_height: i64,
    pub completion_time: String,
    pub initial_balance: Uint128,
    pub balance: Uint128,
}

#[cw_serde]
pub struct UnbondingDelegationsResponse {
    pub entries: Vec<UnbondingDelegationEntry>,
}
