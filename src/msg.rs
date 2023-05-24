use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::Addr;
use cw_utils::Duration;

use crate::data_structure::Tranche;

#[cw_serde]
pub struct InstantiateMsg {
    pub admins: Vec<Addr>,
    pub ops: Vec<Addr>,
    pub tranche: Tranche,
    pub max_voting_period: Duration,
    pub admin_voting_threshold_percentage: u8,
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
    InitiateWithdrawUnlocked {},
    InitiateWithdrawReward {},
    ProposeUpdateAdmin {
        admin: Addr,
        remove: bool,
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
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {}
