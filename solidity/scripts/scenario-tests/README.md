# Gringotts Scenario Scripts

These scripts exercise the deployed `Gringotts` proxy against the scenario list in `/Users/xiaoyuchen/Downloads/EVM Gringotts Testing.txt`.

They are review-safe by default. Without `EXECUTE=true`, scripts only run read/static-call checks and skip state-changing scenarios.

## One-Time Setup

Compile contracts first so the scripts can load current ABIs, including `GringottsV2Dummy`:

```bash
cd /Users/xiaoyuchen/repos/gringotts/solidity
npm run compile
```

The scripts resolve the proxy address in this order:

1. `PROXY_ADDRESS`
2. `SCENARIO_CONFIG.proxyAddress`
3. latest `deployments/gringotts-*.json`

Create an ignored local config for signer keys and validator addresses:

```bash
cp scripts/scenario-tests/scenario.config.example.json scripts/scenario-tests/scenario.local.json
```

Then fill in signer private keys and validator addresses:

- `adminPrivateKeys`: enough current admin keys to pass proposals.
- `operatorPrivateKey`: a current operator key for staking/withdrawal flows.
- `implementationDeployerPrivateKey`: optional funded key for `upgrade-tests.js`; it does not need admin permission.

```bash
SCENARIO_CONFIG=scripts/scenario-tests/scenario.local.json \
  npx hardhat --config hardhat.harbor-shortunbond.config.js run scripts/scenario-tests/access-tests.js --network harbor-shortunbond-testnet
```

Do not commit `scenario.local.json`.

## Static Review Mode

Run scripts without `EXECUTE=true` first. This mode checks read-only state and `staticCall` reverts, then skips mutating scenarios.

```bash
SCENARIO_CONFIG=scripts/scenario-tests/scenario.local.json \
  npx hardhat --config hardhat.harbor-shortunbond.config.js run scripts/scenario-tests/access-tests.js --network harbor-shortunbond-testnet
```

Run all scenario groups in static/review mode:

```bash
for script in \
  access-tests.js \
  vesting-tests.js \
  staking-operation-tests.js \
  reward-tests.js \
  governance-admin-tests.js \
  upgrade-tests.js
do
  SCENARIO_CONFIG=scripts/scenario-tests/scenario.local.json \
    npx hardhat --config hardhat.harbor-shortunbond.config.js run "scripts/scenario-tests/$script" --network harbor-shortunbond-testnet
done
```

## Execution Guards

- `EXECUTE=true`: allow state-changing transactions.
- `ALLOW_DESTRUCTIVE=true`: allow irreversible/destructive checks such as emergency withdrawal.
- `WAIT_FOR_EXPIRY=true`: allow scripts to wait through proposal expiration windows.
- `RUN_STRESS=true`: allow repeated 7-entry unbonding/redelegation stress loops.

## Mutating Runs

Run one group at a time when sending transactions. Example:

```bash
EXECUTE=true \
SCENARIO_CONFIG=scripts/scenario-tests/scenario.local.json \
  npx hardhat --config hardhat.harbor-shortunbond.config.js run scripts/scenario-tests/access-tests.js --network harbor-shortunbond-testnet
```

Run the live upgrade/migration-style check. This deploys `GringottsV2Dummy`, proposes an upgrade, votes/processes it, then calls the new dummy functions through the existing proxy:

```bash
EXECUTE=true \
SCENARIO_CONFIG=scripts/scenario-tests/scenario.local.json \
  npx hardhat --config hardhat.harbor-shortunbond.config.js run scripts/scenario-tests/upgrade-tests.js --network harbor-shortunbond-testnet
```

Run expiration scenarios only when you are willing to wait through `maxVotingPeriod`:

```bash
EXECUTE=true WAIT_FOR_EXPIRY=true \
SCENARIO_CONFIG=scripts/scenario-tests/scenario.local.json \
  npx hardhat --config hardhat.harbor-shortunbond.config.js run scripts/scenario-tests/governance-admin-tests.js --network harbor-shortunbond-testnet
```

Run destructive/stress scenarios only on a disposable deployment:

```bash
EXECUTE=true ALLOW_DESTRUCTIVE=true RUN_STRESS=true \
SCENARIO_CONFIG=scripts/scenario-tests/scenario.local.json \
  npx hardhat --config hardhat.harbor-shortunbond.config.js run scripts/scenario-tests/vesting-tests.js --network harbor-shortunbond-testnet
```

## Unit Tests

The Hardhat unit suite includes a local upgrade test that upgrades through admin proposals to `GringottsV2Dummy` and calls the dummy functions through the proxy.

Run only the upgrade unit test:

```bash
npx hardhat test test/Gringotts.test.js --grep "GringottsV2Dummy"
```

Run the full Solidity test suite:

```bash
npm test
```

## Script Groups

- `access-tests.js`: operator/admin access, direct upgrade blocking, proposal lifecycle basics.
- `vesting-tests.js`: vesting reads and guarded unlocked/emergency withdrawal flows.
- `staking-operation-tests.js`: delegate, undelegate, redelegate, invalid validator, truncation, entry-limit scenarios.
- `reward-tests.js`: reward withdrawal and distribution address update flows.
- `governance-admin-tests.js`: admin/distribution/gov proposals, expiration, threshold, last-admin/last-operator invariants.
- `upgrade-tests.js`: deploys `GringottsV2Dummy`, upgrades by admin proposal, then calls the new dummy function through the proxy.

Some scenarios depend on live-chain timing or available rewards. The scripts explicitly skip those when prerequisites are missing rather than pretending the condition was tested.

## Validator Addresses

The Harbor short-unbond testnet currently has these bonded validators:

```text
seivaloper1z7dlhv79r45ulcnnumxle67ven8n65hcaxvwea
seivaloper1yp96dyhkjndszsyf7mv55tck34c5vgue5l2rxv
seivaloper1jjy6d7kpyphcgtkgjsgrp8624m2uq3cp2gauhz
seivaloper15c6rdhx97mc7uuhl94v3ramslcpt6xcjeqqrx9
```
