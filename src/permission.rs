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

#[cfg(test)]
mod tests {
    use cosmwasm_std::{testing::mock_dependencies, Addr};

    use super::*;

    use crate::state::OPS;
    use crate::data_structure::EmptyStruct;

    const GOOD_OP: &str = "good_op";
    const BAD_OP: &str = "bad_op";
    const GOOD_ADMIN: &str = "good_admin";
    const BAD_ADMIN: &str = "bad_admin";

    #[test]
    fn test_autorize_op() {
        let mut deps = mock_dependencies();
        let deps_mut = deps.as_mut();
        OPS.save(deps_mut.storage, &Addr::unchecked(GOOD_OP), &EmptyStruct {}).unwrap();

        autorize_op(deps.as_ref().storage, Addr::unchecked(GOOD_OP)).unwrap();
        autorize_op(deps.as_ref().storage, Addr::unchecked(BAD_OP)).unwrap_err();
    }

    #[test]
    fn test_autorize_admin() {
        let mut deps = mock_dependencies();
        let deps_mut = deps.as_mut();
        ADMINS.save(deps_mut.storage, &Addr::unchecked(GOOD_ADMIN), &EmptyStruct {}).unwrap();

        autorize_admin(deps.as_ref().storage, Addr::unchecked(GOOD_ADMIN)).unwrap();
        autorize_admin(deps.as_ref().storage, Addr::unchecked(BAD_ADMIN)).unwrap_err();
    }
}
