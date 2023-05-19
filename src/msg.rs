use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{Addr};

use crate::data_structure::Tranche;

#[cw_serde]
pub struct InstantiateMsg {
    pub admins: Vec<Addr>,
    pub ops: Vec<Addr>,
    pub tranche: Tranche,
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
    InitiateWithdrawReward {
        validator: String,
    },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
}
