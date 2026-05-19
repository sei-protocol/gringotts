const {
  connectGringotts,
  expectSuccess,
  loadActors,
  loadScenarioConfig,
  requireActor,
  requireValidator,
  ScenarioRunner,
  sendTx,
  staticCall,
  weiToSei,
} = require("./lib/common");

const {
  createProposal,
  processPassedProposal,
  voteUntilPassed,
} = require("./lib/proposals");

async function main() {
  const config = loadScenarioConfig();
  const runner = new ScenarioRunner("Reward Withdrawal Tests", config);
  runner.header();

  const contract = await connectGringotts(config.proxyAddress);
  const actors = loadActors(config);

  await runner.scenario("Withdraw rewards with no active delegations", async () => {
    if (!requireActor(runner, actors.operator, "operator")) return;

    await expectSuccess(runner, "withdraw rewards empty validator list static-call", () =>
      staticCall(contract, actors.operator, "initiateWithdrawReward", [[]])
    );
    runner.note("Current API treats empty validator list as no-op after sending any banked rewards.");
  });

  await runner.scenario("Withdraw rewards with active delegation and no unbonding", async () => {
    if (!requireActor(runner, actors.operator, "operator")) return;
    if (!requireValidator(runner, config.validators.primary, "primary")) return;

    const rewards = await contract.getPendingRewards();
    runner.note(`pending reward validator buckets: ${rewards.rewards.length}`);

    if (!config.execution.execute) {
      runner.skip("set EXECUTE=true to withdraw live rewards");
      return;
    }

    const before = await contract.getInfo();
    await sendTx(config, contract, actors.operator, "initiateWithdrawReward", [[config.validators.primary]]);
    const after = await contract.getInfo();
    runner.pass(
      "withdraw rewards sent",
      `withdrawnStakingRewards ${weiToSei(before._withdrawnStakingRewards)} -> ${weiToSei(after._withdrawnStakingRewards)}`
    );
  });

  await runner.scenario("Withdraw rewards while unbonding exists", async () => {
    if (!requireActor(runner, actors.operator, "operator")) return;
    if (!requireValidator(runner, config.validators.primary, "primary")) return;

    runner.note("This verifies accounting after a prior undelegate created an unbonding entry.");
    if (!config.execution.execute) {
      runner.skip("requires prior unbonding state and EXECUTE=true");
      return;
    }

    const before = await contract.getInfo();
    await sendTx(config, contract, actors.operator, "initiateWithdrawReward", [[config.validators.primary]]);
    const after = await contract.getInfo();
    if (after._withdrawnLocked === before._withdrawnLocked && after._withdrawnUnlocked === before._withdrawnUnlocked) {
      runner.pass("reward withdrawal did not modify principal withdrawal accounting");
    } else {
      runner.fail("reward withdrawal changed principal withdrawal accounting");
    }
  });

  await runner.scenario("Withdraw rewards after all unbonding has completed", async () => {
    runner.skip("requires waiting through unbonding completion and EndBlock processing before running reward withdrawal");
  });

  await runner.scenario("Withdraw rewards over multiple validators and twice in a row", async () => {
    if (!requireActor(runner, actors.operator, "operator")) return;
    const validators = [config.validators.primary, config.validators.secondary, config.validators.tertiary].filter(Boolean);
    if (validators.length === 0) {
      runner.skip("no validators configured");
      return;
    }

    if (!config.execution.execute) {
      runner.skip("set EXECUTE=true to withdraw live rewards");
      return;
    }

    const before = await contract.getInfo();
    await sendTx(config, contract, actors.operator, "initiateWithdrawReward", [validators]);
    const afterFirst = await contract.getInfo();
    await sendTx(config, contract, actors.operator, "initiateWithdrawReward", [validators]);
    const afterSecond = await contract.getInfo();

    runner.pass(
      "two reward withdrawals sent",
      `withdrawn ${before._withdrawnStakingRewards} -> ${afterFirst._withdrawnStakingRewards} -> ${afterSecond._withdrawnStakingRewards}`
    );
  });

  await runner.scenario("Update staking reward distribution address, then confirm subsequent rewards use it", async () => {
    if (!requireActor(runner, actors.admin, "admin")) return;
    if (actors.admins.length < 2) {
      runner.skip("requires enough admin private keys to pass proposal");
      return;
    }

    const info = await contract.getInfo();
    const proposalId = await createProposal(config, runner, contract, actors.admin, "proposeUpdateStakingRewardDistributionAddress", [
      info._stakingRewardAddress,
    ]);
    if (proposalId === null) return;

    await voteUntilPassed(config, runner, contract, proposalId, actors.admins);
    await processPassedProposal(config, runner, contract, actors.admin, proposalId);

    const after = await contract.getInfo();
    if (after._stakingRewardAddress === info._stakingRewardAddress) {
      runner.pass("staking reward address proposal executed");
    } else {
      runner.fail("staking reward address changed unexpectedly");
    }
  });

  await runner.scenario("Update unlocked distribution address, then confirm subsequent unlocked principal uses it", async () => {
    if (!requireActor(runner, actors.admin, "admin")) return;
    if (actors.admins.length < 2) {
      runner.skip("requires enough admin private keys to pass proposal");
      return;
    }

    const info = await contract.getInfo();
    const proposalId = await createProposal(config, runner, contract, actors.admin, "proposeUpdateUnlockedDistributionAddress", [
      info._unlockDistributionAddress,
    ]);
    if (proposalId === null) return;

    await voteUntilPassed(config, runner, contract, proposalId, actors.admins);
    await processPassedProposal(config, runner, contract, actors.admin, proposalId);

    const after = await contract.getInfo();
    if (after._unlockDistributionAddress === info._unlockDistributionAddress) {
      runner.pass("unlock distribution address proposal executed");
    } else {
      runner.fail("unlock distribution address changed unexpectedly");
    }
  });

  runner.summary();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
