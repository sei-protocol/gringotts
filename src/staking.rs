use cosmwasm_std::{StakingMsg, Response, Coin};

pub fn delegate(response: Response, validator: String, amount: u64, denom: String) -> Response {
    let msg = StakingMsg::Delegate {
        validator: validator.clone(),
        amount: Coin::new(amount.into(), denom.clone()),
    };
    response.add_message(msg)
}