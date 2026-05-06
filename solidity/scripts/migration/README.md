# Gringotts Migration: CosmWasm to Solidity

Scripts for migrating a CosmWasm Gringotts contract to the Solidity version on Sei EVM.

## Overview

The migration process:
1. **Export** - Query the CosmWasm contract and export its state
2. **Convert** - Convert Sei addresses (`sei1...`) to EVM addresses (`0x...`)
3. **Deploy** - Deploy the Solidity contract with the exported configuration

## Prerequisites

- Node.js 18+
- `seid` CLI (for address conversion)
- Access to Sei RPC endpoint
- Sufficient SEI balance for deployment

## Step 1: Export CosmWasm State

### Using Node.js (recommended)

```bash
cd solidity
node scripts/migration/export-cosmwasm.js <contract_address> \
  --rpc https://rpc.sei-apis.com \
  --output gringotts-export.json
```

### Using Shell Script (requires seid CLI)

```bash
cd solidity/scripts/migration
chmod +x export-cosmwasm.sh
./export-cosmwasm.sh <contract_address> \
  --node https://rpc.sei-apis.com \
  --output gringotts-export.json
```

### Example Output

```json
{
  "exportedAt": "2026-02-02T12:00:00Z",
  "sourceContract": "sei1abc...xyz",
  "solidity": {
    "admins": ["sei1admin1...", "sei1admin2..."],
    "operators": ["sei1op1..."],
    "vestingTimestamps": [1735689600, 1738368000, ...],
    "vestingAmounts": ["12000000000000000000000000", ...],
    "unlockDistributionAddress": "sei1unlock...",
    "stakingRewardAddress": "sei1reward...",
    "maxVotingPeriod": 86400,
    "adminVotingThresholdPercentage": 75,
    "totalAmount": "48000000000000000000000000"
  }
}
```

## Step 2: Convert Addresses

Convert all Sei addresses to EVM addresses using `seid`:

```bash
# Convert a single address
seid q evm sei-addr sei1abc...xyz

# Example output:
# 0x1234567890abcdef...
```

Create an address mapping file `address-map.json`:

```json
{
  "sei1admin1...": "0xAdmin1EvmAddress...",
  "sei1admin2...": "0xAdmin2EvmAddress...",
  "sei1op1...": "0xOperator1EvmAddress...",
  "sei1unlock...": "0xUnlockAddress...",
  "sei1reward...": "0xRewardAddress..."
}
```

Alternatively, manually edit the export file to replace Sei addresses with EVM addresses.

## Step 3: Deploy Solidity Contract

### Dry Run (Recommended First)

```bash
DRY_RUN=true EXPORT_FILE=gringotts-export.json ADDRESS_MAP=address-map.json \
  npx hardhat run scripts/migration/deploy-from-export.js --network sei
```

### Actual Deployment

```bash
EXPORT_FILE=gringotts-export.json ADDRESS_MAP=address-map.json \
  npx hardhat run scripts/migration/deploy-from-export.js --network sei
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `EXPORT_FILE` | Path to export JSON | `gringotts-export.json` |
| `ADDRESS_MAP` | Path to address mapping JSON | (none) |
| `DRY_RUN` | Set to "true" to simulate | `false` |

### Hardhat Network Configuration

Add Sei network to `hardhat.config.js`:

```javascript
networks: {
  sei: {
    url: "https://evm-rpc.sei-apis.com",
    accounts: [process.env.PRIVATE_KEY],
    chainId: 1329
  },
  "sei-testnet": {
    url: "https://evm-rpc-testnet.sei-apis.com",
    accounts: [process.env.PRIVATE_KEY],
    chainId: 1328
  }
}
```

## Important Considerations

### Address Conversion

Sei uses two address formats:
- **Sei native**: `sei1...` (Bech32, used in CosmWasm)
- **EVM**: `0x...` (Hex, used in Solidity)

Both formats map to the same underlying account. Use `seid q evm sei-addr` to convert.

### Vesting Schedule

The export converts:
- Timestamps from nanoseconds to seconds
- Amounts from usei (10^-6) to wei (10^-18)

The exported vesting schedule is the current remaining CosmWasm schedule. It can include tranches whose timestamps have already passed but whose funds have not been withdrawn yet; the Solidity initializer accepts those tranches so they remain immediately withdrawable after deployment.

### Already Withdrawn Amounts

If the CosmWasm contract has already had withdrawals:
- `withdrawnUnlocked`: Tokens withdrawn via `InitiateWithdrawUnlocked`
- `withdrawnLocked`: Tokens withdrawn via emergency withdrawal
- `withdrawnStakingRewards`: Staking rewards withdrawn

The vesting schedule in the export reflects the remaining schedule stored by the CosmWasm contract. Review the withdrawn fields when deciding how much liquid SEI must be available for migration funding.

### Funding the Contract

The Solidity contract requires the exported remaining vesting amount to be sent during deployment:

```
fundingAmount = totalAmount
```

### Staking State

The migration does **not** transfer staked tokens. Before migration:
1. Undelegate all staked tokens from validators
2. Wait for unbonding period to complete
3. Ensure all tokens are liquid in the contract

## Verification

After deployment, verify the contract:

```bash
npx hardhat verify --network sei <contract_address> \
  '[admin1, admin2]' \
  '[operator1]' \
  '[timestamp1, timestamp2, ...]' \
  '[amount1, amount2, ...]' \
  '<unlockAddress>' \
  '<rewardAddress>' \
  <maxVotingPeriod> \
  <thresholdPercentage>
```

## Troubleshooting

### "Address not found in mapping"

Convert the Sei address using:
```bash
seid q evm sei-addr <sei_address>
```

### "Insufficient balance"

Ensure the deployer has enough SEI:
- Total vesting amount
- Plus gas for deployment (~0.1 SEI)

### "Transaction reverted"

Check that:
- All addresses are valid EVM addresses
- Vesting timestamps are in the future
- Amounts are non-zero
- At least one admin and operator
