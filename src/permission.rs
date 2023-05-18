use cosmwasm_std::{Storage, Addr};

use crate::{ContractError, state::{OPS, ADMINS}};

pub fn autorize_op(store: &dyn Storage, caller: Addr) -> Result<(), ContractError> {
    match OPS.load(store, &caller) {
        Ok(_) => Ok(()),
        Err(_) => Err(ContractError::Unauthorized {})
    }
}

pub fn autorize_admin(store: &dyn Storage, caller: Addr) -> Result<(), ContractError> {
    match ADMINS.load(store, &caller) {
        Ok(_) => Ok(()),
        Err(_) => Err(ContractError::Unauthorized {})
    }
}
