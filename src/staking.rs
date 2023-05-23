use cosmwasm_std::{StakingMsg, Response, Coin};

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
