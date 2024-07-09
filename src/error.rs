use cosmwasm_std::StdError;
use cw_utils::ThresholdError;

use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("{0}")]
    Threshold(#[from] ThresholdError),

    #[error("Required weight cannot be zero")]
    ZeroWeight {},

    #[error("Not possible to reach required (passing) weight")]
    UnreachableWeight {},

    #[error("No voters")]
    NoVoters {},

    #[error("Unauthorized")]
    Unauthorized {},

    #[error("Proposal is not open")]
    NotOpen {},

    #[error("Proposal voting period has expired")]
    Expired {},

    #[error("Proposal must expire before you can close it")]
    NotExpired {},

    #[error("Wrong expiration option")]
    WrongExpiration {},

    #[error("Already voted on this proposal")]
    AlreadyVoted {},

    #[error("Proposal must have passed and not yet been executed")]
    WrongExecuteStatus {},

    #[error("Cannot close completed or passed proposals")]
    WrongCloseStatus {},

    #[error("No admins")]
    NoAdmins {},

    #[error("No operators")]
    NoOps {},

    #[error("Invalid tranche: {0}")]
    InvalidTranche(String),

    #[error("No sufficient delegation rewards")]
    NoSufficientDelegationReward {},

    #[error("Semver parsing error: {0}")]
    SemVer(String),

    #[error("No sufficient vested amount")]
    NoSufficientUnlockedTokens {},
}

impl From<semver::Error> for ContractError {
    fn from(err: semver::Error) -> Self {
        Self::SemVer(err.to_string())
    }
}
