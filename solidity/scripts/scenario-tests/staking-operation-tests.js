const {
  connectGringotts,
  connectStakingPrecompile,
  expectRevert,
  expectSuccess,
  loadActors,
  loadScenarioConfig,
  requireActor,
  requireValidator,
  ScenarioRunner,
  sendTx,
  staticCall,
} = require("./lib/common");

function delegationAmountUsei(delegation) {
  return BigInt(delegation.balance.amount);
}

async function main() {
  const config = loadScenarioConfig();
  const runner = new ScenarioRunner("Staking Operation Tests", config);
  runner.header();

  const contract = await connectGringotts(config.proxyAddress);
  const staking = connectStakingPrecompile();
  const actors = loadActors(config);

  await runner.scenario("Delegate 0 fails", async () => {
    if (!requireActor(runner, actors.operator, "operator")) return;
    if (!requireValidator(runner, config.validators.primary, "primary")) return;

    await expectRevert(runner, "delegate 0", () =>
      staticCall(contract, actors.operator, "delegate", [config.validators.primary, 0n])
    );
  });

  await runner.scenario("Delegate with nonzero amount succeeds and increases delegation", async () => {
    if (!requireActor(runner, actors.operator, "operator")) return;
    if (!requireValidator(runner, config.validators.primary, "primary")) return;

    if (!config.execution.execute) {
      runner.skip("set EXECUTE=true to delegate real stake");
      return;
    }

    const before = await contract.getDelegation(config.validators.primary);
    await sendTx(config, contract, actors.operator, "delegate", [
      config.validators.primary,
      config.amounts.delegateWei,
    ]);
    const after = await contract.getDelegation(config.validators.primary);

    if (delegationAmountUsei(after) > delegationAmountUsei(before)) {
      runner.pass("delegation amount increased");
    } else {
      runner.fail("delegation amount did not increase");
    }
  });

  await runner.scenario("Delegate without msg.value", async () => {
    runner.note("Gringotts.delegate(amount) sends value from the contract balance to the precompile; callers do not send msg.value to Gringotts.");
    runner.note("So the old 'without msg.value fails' scenario does not map directly to this EVM API.");
  });

  await runner.scenario("Delegate to invalid validator fails", async () => {
    if (!requireActor(runner, actors.operator, "operator")) return;

    await expectRevert(runner, "delegate invalid validator", () =>
      staticCall(contract, actors.operator, "delegate", [config.validators.invalid, config.amounts.delegateWei])
    );
  });

  await runner.scenario("Delegate to the same validator twice", async () => {
    if (!requireActor(runner, actors.operator, "operator")) return;
    if (!requireValidator(runner, config.validators.primary, "primary")) return;

    if (!config.execution.execute) {
      runner.skip("set EXECUTE=true to perform two real delegations");
      return;
    }

    await sendTx(config, contract, actors.operator, "delegate", [
      config.validators.primary,
      config.amounts.smallWei,
    ]);
    await sendTx(config, contract, actors.operator, "delegate", [
      config.validators.primary,
      config.amounts.smallWei,
    ]);
    runner.pass("two delegate transactions to same validator sent");
  });

  await runner.scenario("Undelegate less/exact/more than delegated amount", async () => {
    if (!requireActor(runner, actors.operator, "operator")) return;
    if (!requireValidator(runner, config.validators.primary, "primary")) return;

    const delegation = await contract.getDelegation(config.validators.primary);
    const delegatedUsei = delegationAmountUsei(delegation);
    if (delegatedUsei === 0n) {
      runner.skip("no active delegation for primary validator");
      return;
    }

    const delegatedWei = delegatedUsei * 1000000000000n;
    const lessWei = delegatedWei > 1000000000000n ? delegatedWei / 2n : delegatedWei;

    await expectSuccess(runner, "undelegate less/equal delegated static-call succeeds", () =>
      staticCall(contract, actors.operator, "undelegate", [config.validators.primary, lessWei])
    );
    await expectRevert(runner, "undelegate more than delegated fails", () =>
      staticCall(contract, actors.operator, "undelegate", [config.validators.primary, delegatedWei + 1000000000000n])
    );

    if (!config.execution.execute) {
      runner.skip("set EXECUTE=true to create real unbonding entries");
      return;
    }

    await sendTx(config, contract, actors.operator, "undelegate", [config.validators.primary, lessWei]);
    runner.pass("undelegate transaction sent; inspect unbonding entries separately");
  });

  await runner.scenario("Undelegate while rewards exist accounts for rewards separately", async () => {
    if (!requireActor(runner, actors.operator, "operator")) return;
    if (!requireValidator(runner, config.validators.primary, "primary")) return;

    const rewardsBefore = (await contract.getInfo())._withdrawnStakingRewards;
    runner.note(`withdrawnStakingRewards before: ${rewardsBefore}`);

    if (!config.execution.execute) {
      runner.skip("requires live rewards plus EXECUTE=true");
      return;
    }

    await sendTx(config, contract, actors.operator, "undelegate", [
      config.validators.primary,
      config.amounts.smallWei,
    ]);
    const rewardsAfter = (await contract.getInfo())._withdrawnStakingRewards;
    runner.pass(`undelegate sent; withdrawnStakingRewards after=${rewardsAfter}`);
  });

  await runner.scenario("Create 7 unbonding entries, verify 8th fails, then retry after maturity", async () => {
    if (!config.execution.runStress || !config.execution.execute) {
      runner.skip("requires RUN_STRESS=true and EXECUTE=true");
      return;
    }
    if (!requireActor(runner, actors.operator, "operator")) return;
    if (!requireValidator(runner, config.validators.primary, "primary")) return;

    for (let i = 0; i < 7; i++) {
      await sendTx(config, contract, actors.operator, "undelegate", [
        config.validators.primary,
        config.amounts.smallWei,
      ]);
      runner.pass(`created unbonding entry ${i + 1}`);
    }

    await expectRevert(runner, "8th undelegate fails with max entries", () =>
      staticCall(contract, actors.operator, "undelegate", [config.validators.primary, config.amounts.smallWei])
    );
    runner.skip("maturity + EndBlock retry requires waiting for chain unbonding time");
  });

  await runner.scenario("Redelegate less/exact/more and invalid destination cases", async () => {
    if (!requireActor(runner, actors.operator, "operator")) return;
    if (!requireValidator(runner, config.validators.primary, "primary")) return;
    if (!requireValidator(runner, config.validators.secondary, "secondary")) return;

    const delegation = await contract.getDelegation(config.validators.primary);
    const delegatedUsei = delegationAmountUsei(delegation);
    if (delegatedUsei === 0n) {
      runner.skip("no active delegation for primary validator");
      return;
    }

    const delegatedWei = delegatedUsei * 1000000000000n;
    const lessWei = delegatedWei > 1000000000000n ? delegatedWei / 2n : delegatedWei;

    await expectSuccess(runner, "redelegate less/equal delegated static-call succeeds", () =>
      staticCall(contract, actors.operator, "redelegate", [
        config.validators.primary,
        config.validators.secondary,
        lessWei,
      ])
    );
    await expectRevert(runner, "redelegate more than delegated fails", () =>
      staticCall(contract, actors.operator, "redelegate", [
        config.validators.primary,
        config.validators.secondary,
        delegatedWei + 1000000000000n,
      ])
    );
    await expectRevert(runner, "redelegate to invalid destination fails", () =>
      staticCall(contract, actors.operator, "redelegate", [
        config.validators.primary,
        config.validators.invalid,
        lessWei,
      ])
    );
    await expectRevert(runner, "redelegate amount that truncates to zero fails", () =>
      staticCall(contract, actors.operator, "redelegate", [
        config.validators.primary,
        config.validators.secondary,
        config.amounts.dustWei,
      ])
    );

    runner.note("same-validator redelegate is not explicitly rejected by Gringotts; expected behavior depends on Sei precompile.");
    await expectRevert(runner, "redelegate from validator to itself", () =>
      staticCall(contract, actors.operator, "redelegate", [
        config.validators.primary,
        config.validators.primary,
        lessWei,
      ])
    );
  });

  await runner.scenario("Redelegate reward side effects and transitive redelegation", async () => {
    if (!requireActor(runner, actors.operator, "operator")) return;
    if (!requireValidator(runner, config.validators.primary, "primary")) return;
    if (!requireValidator(runner, config.validators.secondary, "secondary")) return;
    if (!requireValidator(runner, config.validators.tertiary, "tertiary")) return;

    runner.skip("requires controlled live rewards and redelegation completion windows; keep as guarded manual flow");
  });

  await runner.scenario("Create 7 redelegations for same tuple, verify 8th fails", async () => {
    if (!config.execution.runStress || !config.execution.execute) {
      runner.skip("requires RUN_STRESS=true and EXECUTE=true");
      return;
    }
    if (!requireActor(runner, actors.operator, "operator")) return;
    if (!requireValidator(runner, config.validators.primary, "primary")) return;
    if (!requireValidator(runner, config.validators.secondary, "secondary")) return;

    for (let i = 0; i < 7; i++) {
      await sendTx(config, contract, actors.operator, "redelegate", [
        config.validators.primary,
        config.validators.secondary,
        config.amounts.smallWei,
      ]);
      runner.pass(`created redelegation entry ${i + 1}`);
    }

    await expectRevert(runner, "8th redelegation fails with max entries", () =>
      staticCall(contract, actors.operator, "redelegate", [
        config.validators.primary,
        config.validators.secondary,
        config.amounts.smallWei,
      ])
    );
    runner.skip("post-completion retry requires waiting for chain redelegation completion time");
  });

  await runner.scenario("Query unbonding delegations and redelegations", async () => {
    if (!requireValidator(runner, config.validators.primary, "primary")) return;

    const unbonding = await staking.delegatorUnbondingDelegations(config.proxyAddress, "0x");
    runner.pass(`queried delegatorUnbondingDelegations`, `${unbonding.unbondingDelegations.length} entries`);

    const redelegations = await staking.redelegations(config.proxyAddress, "", "", "0x");
    runner.pass(`queried redelegations`, `${redelegations.redelegations.length} entries`);
  });

  runner.summary();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
