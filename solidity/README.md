# Gringotts - Solidity Version for Sei

A Solidity port of the CosmWasm Gringotts vesting contract for the Sei blockchain, using native SEI and Sei's staking/distribution precompiles.

## Overview

Gringotts is a token vesting contract that supports:

- **Token Vesting**: Time-based vesting schedules with configurable timestamps and amounts
- **Multi-sig Governance**: Admin proposals and voting system with configurable threshold
- **Operator Permissions**: Separate operator role for day-to-day operations
- **Native Staking**: Delegate, redelegate, and undelegate via Sei's staking precompile
- **Reward Management**: Withdraw staking rewards via Sei's distribution precompile
- **Emergency Controls**: Admin-approved emergency withdrawal mechanism
- **Upgradeable**: UUPS proxy pattern with multi-sig upgrade approval

## Sei Precompiles

This contract integrates with Sei's native precompiles:

| Precompile | Address | Purpose |
|------------|---------|---------|
| Staking | `0x0000000000000000000000000000000000001005` | Delegation operations |
| Distribution | `0x0000000000000000000000000000000000001007` | Reward withdrawals |

## Architecture

### Contracts

| Contract | Description |
|----------|-------------|
| `Gringotts.sol` | Upgradeable vesting contract with staking and governance (UUPS) |
| `GringottsFactory.sol` | Factory for deploying Gringotts proxy instances |

### Upgradeability

The contract uses OpenZeppelin's UUPS (Universal Upgradeable Proxy Standard) pattern:

- **Implementation**: The logic contract (`Gringotts.sol`)
- **Proxy**: ERC1967 proxy that delegates calls to implementation
- **Upgrades**: Require multi-sig admin approval via proposal system

```
┌─────────────────┐     ┌─────────────────┐
│   ERC1967Proxy  │────▶│   Gringotts     │
│   (holds state) │     │ (implementation)│
└─────────────────┘     └─────────────────┘
```

To upgrade:
1. Deploy new implementation contract
2. Admin calls `proposeUpgrade(newImplementation)`
3. Other admins vote via `voteProposal(proposalId)`
4. Once threshold reached, admin calls `processProposal(proposalId)`
5. Contract upgrades, state is preserved

### Interfaces

| Interface | Description |
|-----------|-------------|
| `IStaking.sol` | Sei staking precompile interface |
| `IDistribution.sol` | Sei distribution precompile interface |

### Mocks (Testing)

| Mock | Description |
|------|-------------|
| `MockStaking.sol` | Mock Sei staking precompile |
| `MockDistribution.sol` | Mock Sei distribution precompile |
| `MockERC20.sol` | Mock ERC20 token (for testing utilities) |

## Installation

```bash
cd solidity
npm install
```

## Usage

### Compile

```bash
npm run compile
```

### Test

```bash
npm test
```

### Deploy (Local)

Start a local node:
```bash
npm run node
```

In another terminal:
```bash
npm run deploy:local
```

## Deployment

### Deploy via Factory

```javascript
// Deploy implementation
const Gringotts = await ethers.getContractFactory("Gringotts");
const implementation = await Gringotts.deploy();

// Deploy factory with implementation
const GringottsFactory = await ethers.getContractFactory("GringottsFactory");
const factory = await GringottsFactory.deploy(implementation.address);

// Deploy Gringotts proxy with native SEI
const proxyAddress = await factory.createGringotts(
  [admin1, admin2],       // Initial admins
  [operator1],            // Initial operators
  vestingTimestamps,      // Array of timestamps
  vestingAmounts,         // Array of amounts (in wei)
  unlockAddress,          // Where unlocked tokens go
  rewardAddress,          // Where staking rewards go
  3600,                   // Voting period (1 hour)
  75,                     // Threshold percentage
  { value: totalAmount }  // Send native SEI
);

// Interact with proxy as Gringotts
const gringotts = Gringotts.attach(proxyAddress);
```

### Direct Deployment (without factory)

```javascript
// Deploy implementation
const Gringotts = await ethers.getContractFactory("Gringotts");
const implementation = await Gringotts.deploy();

// Encode initialization data
const initData = Gringotts.interface.encodeFunctionData("initialize", [
  [admin1, admin2],
  [operator1],
  vestingTimestamps,
  vestingAmounts,
  unlockAddress,
  rewardAddress,
  3600,
  75
]);

// Deploy proxy
const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
const proxy = await ERC1967Proxy.deploy(implementation.address, initData, { value: totalAmount });

// Interact with proxy as Gringotts
const gringotts = Gringotts.attach(proxy.address);
```

## Contract Functions

### Operator Functions

| Function | Description |
|----------|-------------|
| `delegate(string validator, uint256 amount)` | Delegate SEI to a validator; `amount` is wei and must be a whole uSEI |
| `redelegate(string src, string dst, uint256 amount)` | Move delegation between validators; `amount` is wei and converted to uSEI for the precompile |
| `undelegate(string validator, uint256 amount)` | Remove delegation from a validator; `amount` is wei and converted to uSEI for the precompile |
| `initiateWithdrawUnlocked(uint256 amount)` | Withdraw vested tokens |
| `initiateWithdrawReward(string[] validators)` | Withdraw staking rewards |
| `withdrawSingleValidatorReward(string validator)` | Withdraw from one validator |

**Note:** Validator addresses use Sei format: `seivaloper1...`. Public Gringotts amount parameters are wei-facing, but Sei staking redelegate/undelegate precompile calls and staking balance queries use uSEI. Gringotts converts at that boundary and rejects staking amounts that are not a whole uSEI.

### Admin Functions

| Function | Description |
|----------|-------------|
| `updateOp(address op, bool remove)` | Add or remove an operator |
| `proposeUpdateAdmin(address, bool)` | Propose to add/remove an admin |
| `proposeUpdateUnlockedDistributionAddress(address)` | Propose new unlock address |
| `proposeUpdateStakingRewardDistributionAddress(address)` | Propose new reward address |
| `proposeEmergencyWithdraw(address dst)` | Propose emergency withdrawal |
| `proposeUpgrade(address newImpl)` | Propose contract upgrade |
| `voteProposal(uint256 proposalId)` | Vote yes on a proposal |
| `processProposal(uint256 proposalId)` | Execute a passed proposal |

### View Functions

| Function | Description |
|----------|-------------|
| `getTotalVested()` | Get total vested amount at current time |
| `getVestingSchedule()` | Get vesting timestamps and amounts |
| `getInfo()` | Get contract info (addresses, withdrawal stats) |
| `getConfig()` | Get governance config |
| `getProposal(uint256)` | Get proposal details |
| `getDelegation(string)` | Get delegation for a validator |
| `getAllDelegations()` | Get all delegations |
| `getUnbondingDelegations()` | Get unbonding info |
| `getPendingRewards()` | Get pending staking rewards |
| `listAdmins()` / `listOperators()` | List current role members |
| `isAdmin(address)` / `isOperator(address)` | Check roles |
| `getImplementation()` | Get current implementation address |

## Sei Precompile Interfaces

### IStaking (0x1005)

```solidity
// Delegation operations
function delegate(string memory validator) external payable returns (bool);
function redelegate(string memory src, string memory dst, uint256 amountUsei) external returns (bool);
function undelegate(string memory validator, uint256 amountUsei) external returns (bool);

// Queries
function delegation(address delegator, string memory validator) external view returns (Delegation memory);
function delegations(address delegator) external view returns (Delegation[] memory);
function unbondingDelegations(address delegator) external view returns (UnbondingDelegation[] memory);
```

### IDistribution (0x1007)

```solidity
// Reward operations
function setWithdrawAddress(address withdrawAddr) external returns (bool);
function withdrawDelegationRewards(string memory validator) external returns (bool);
function withdrawMultipleDelegationRewards(string[] memory validators) external returns (bool);

// Queries
function rewards(address delegator) external view returns (Rewards memory);
```

## Security Considerations

1. **Reentrancy Protection**: All external calls use `nonReentrant` modifier
2. **Access Control**: Strict admin/operator separation
3. **Proposal Expiry**: Proposals have time limits
4. **Double Vote Prevention**: Each admin can only vote once per proposal
5. **Emergency Mechanism**: Requires multi-sig approval

## Bug Fixes from CosmWasm Version

All bug fixes from the [original gringotts repository](https://github.com/sei-protocol/gringotts) are included:

- ✅ Check withdrawable amount is zero before transferring (Dec 2025)
- ✅ Account for unbonding balances when calculating withdrawn rewards (Jan 2025)
- ✅ Fix calculation for withdrawn rewards (Nov 2024)
- ✅ Support partial withdraw for unlocked tokens (Jul 2024)
- ✅ Add msgs for updating distribution addresses (Mar 2024)
- ✅ Withdraw already-withdrawn rewards (Feb 2024)

## Migration from CosmWasm

To migrate an existing CosmWasm Gringotts contract to Solidity:

```bash
# 1. Export CosmWasm contract state
node scripts/migration/export-cosmwasm.js sei1contract... --output export.json

# 2. Convert Sei addresses to EVM addresses
seid q evm sei-addr sei1admin...

# 3. Create address mapping file (see scripts/migration/address-map.example.json)

# 4. Deploy (dry run first)
DRY_RUN=true EXPORT_FILE=export.json ADDRESS_MAP=address-map.json \
  npx hardhat run scripts/migration/deploy-from-export.js --network sei

# 5. Deploy for real
EXPORT_FILE=export.json ADDRESS_MAP=address-map.json \
  npx hardhat run scripts/migration/deploy-from-export.js --network sei
```

See [scripts/migration/README.md](scripts/migration/README.md) for detailed instructions.

## References

- [Sei Staking Precompile Docs](https://docs.sei.io/evm/precompiles/staking)
- [Sei Distribution Precompile Docs](https://docs.sei.io/evm/precompiles/distribution)
- [Original CosmWasm Gringotts](https://github.com/sei-protocol/gringotts)

## License

MIT
