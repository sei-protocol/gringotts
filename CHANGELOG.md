# 0.1.5
- Add validations for timestamp in tranche: earliest must be later than current block time and latest must be within 100 years
- Fix validation that enforces equal timestamp and amount size
- Migrations to fix vesting timestamps/amounts due to bad input

# 0.1.4
Pacific-1 code ID: 375
- Add `total_vested` query endpoint that returns the amount of vested tokens ready for withdraw

# 0.1.3
Pacific-1 code ID: 317
- Add new proposal type to vote `gov` module proposals

# 0.1.2
Pacific-1 code ID: 62
- Add migration validation logic
- Add new proposal type to initiate emergency withdraw

# 0.1.0
Pacific-1 code ID: 59
- initial implementation