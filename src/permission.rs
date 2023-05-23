use cosmwasm_std::{Addr, Env, MessageInfo, Storage};

use crate::{
    state::{ADMINS, OPS},
    ContractError,
};

pub fn authorize_op(store: &dyn Storage, caller: Addr) -> Result<(), ContractError> {
    match OPS.load(store, &caller) {
        Ok(_) => Ok(()),
        Err(_) => Err(ContractError::Unauthorized {}),
    }
}

pub fn authorize_admin(store: &dyn Storage, caller: Addr) -> Result<(), ContractError> {
    match ADMINS.load(store, &caller) {
        Ok(_) => Ok(()),
        Err(_) => Err(ContractError::Unauthorized {}),
    }
}

pub fn authorize_self_call(env: Env, info: MessageInfo) -> Result<(), ContractError> {
    if env.contract.address != info.sender {
        return Err(ContractError::Unauthorized {});
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use cosmwasm_std::{testing::mock_dependencies, Addr};

    use super::*;

    use crate::data_structure::EmptyStruct;
    use crate::state::OPS;

    const GOOD_OP: &str = "good_op";
    const BAD_OP: &str = "bad_op";
    const GOOD_ADMIN: &str = "good_admin";
    const BAD_ADMIN: &str = "bad_admin";

    #[test]
    fn test_authorize_op() {
        let mut deps = mock_dependencies();
        let deps_mut = deps.as_mut();
        OPS.save(deps_mut.storage, &Addr::unchecked(GOOD_OP), &EmptyStruct {})
            .unwrap();

        authorize_op(deps.as_ref().storage, Addr::unchecked(GOOD_OP)).unwrap();
        authorize_op(deps.as_ref().storage, Addr::unchecked(BAD_OP)).unwrap_err();
    }

    #[test]
    fn test_authorize_admin() {
        let mut deps = mock_dependencies();
        let deps_mut = deps.as_mut();
        ADMINS
            .save(
                deps_mut.storage,
                &Addr::unchecked(GOOD_ADMIN),
                &EmptyStruct {},
            )
            .unwrap();

        authorize_admin(deps.as_ref().storage, Addr::unchecked(GOOD_ADMIN)).unwrap();
        authorize_admin(deps.as_ref().storage, Addr::unchecked(BAD_ADMIN)).unwrap_err();
    }
}
