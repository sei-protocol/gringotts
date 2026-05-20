const {
  connectGringotts,
  ethers,
  expectRevert,
  expectSuccess,
  loadActors,
  loadScenarioConfig,
  requireActor,
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

function vestedAmountFromSchedule(timestamps, amounts, timestamp) {
  return amounts.reduce((sum, amount, index) => {
    if (Number(timestamps[index]) > timestamp) return sum;
    return sum + amount;
  }, 0n);
}

function vestedTrancheIndexes(timestamps, timestamp) {
  return timestamps
    .map((ts, index) => (Number(ts) <= timestamp ? index : -1))
    .filter((index) => index >= 0);
}

async function loadVestingState(contract) {
  const [timestamps, amounts] = await contract.getVestingSchedule();
  const info = await contract.getInfo();
  const latestBlock = await ethers.provider.getBlock("latest");
  const now = Number(latestBlock.timestamp);

  return { timestamps, amounts, info, now };
}

async function main() {
  const config = loadScenarioConfig();
  const runner = new ScenarioRunner("Vesting Tests", config);
  runner.header();

  const contract = await connectGringotts(config.proxyAddress);
  const actors = loadActors(config);

  await runner.scenario("Query totalVested before/exactly/just-before vest timestamps", async () => {
    const { timestamps, amounts, now } = await loadVestingState(contract);
    if (timestamps.length === 0) {
      runner.skip("vesting schedule is empty");
      return;
    }

    const totalVested = await contract.getTotalVested();
    runner.note(`now=${now}; firstVest=${timestamps[0]}; current totalVested=${weiToSei(totalVested)} SEI`);

    if (now < Number(timestamps[0])) {
      if (totalVested === 0n) runner.pass("before first vest timestamp returns zero");
      else runner.fail(`before first vest expected zero but got ${totalVested}`);
    } else {
      runner.skip("before-first-timestamp case no longer applies on this deployed schedule");
    }

    const exactIndex = timestamps.findIndex((ts) => Number(ts) === now);
    if (exactIndex >= 0) {
      const expected = amounts.slice(0, exactIndex + 1).reduce((sum, amount) => sum + amount, 0n);
      if (totalVested === expected) runner.pass("exact vest timestamp includes that tranche");
      else runner.fail(`exact vest timestamp expected ${expected} but got ${totalVested}`);
    } else {
      runner.skip("exact vest timestamp requires running at the exact scheduled second");
    }

    const justBeforeIndex = timestamps.findIndex((ts) => Number(ts) === now + 1);
    if (justBeforeIndex >= 0) {
      const expected = amounts.slice(0, justBeforeIndex).reduce((sum, amount) => sum + amount, 0n);
      if (totalVested === expected) runner.pass("just before vest timestamp excludes that tranche");
      else runner.fail(`just-before timestamp expected ${expected} but got ${totalVested}`);
    } else {
      runner.skip("just-before timestamp requires running one second before a vest");
    }
  });

  await runner.scenario("Withdraw unlocked amount 0", async () => {
    if (!requireActor(runner, actors.operator, "operator")) return;

    await expectSuccess(runner, "withdraw unlocked 0 static-call succeeds", () =>
      staticCall(contract, actors.operator, "initiateWithdrawUnlocked", [0n])
    );
    runner.note("current implementation emits UnlockedWithdrawn(..., 0) if sent as a transaction; it sends zero value");
  });

  await runner.scenario("Withdraw less/equal/greater than vested amount", async () => {
    if (!requireActor(runner, actors.operator, "operator")) return;

    const { timestamps, amounts, info, now } = await loadVestingState(contract);
    const totalVested = await contract.getTotalVested();
    const withdrawable = vestedAmountFromSchedule(timestamps, amounts, now);
    runner.note(`withdrawable in current vesting schedule now: ${weiToSei(withdrawable)} SEI`);
    runner.note(`getTotalVested=${weiToSei(totalVested)} SEI; withdrawnUnlocked=${weiToSei(info._withdrawnUnlocked)} SEI`);

    if (withdrawable === 0n) {
      await expectRevert(runner, "withdraw greater than vested fails", () =>
        staticCall(contract, actors.operator, "initiateWithdrawUnlocked", [1n])
      );
      runner.skip("less/equal vested withdrawal requires vested principal");
      return;
    }

    const lessThanVested = withdrawable > 1n ? withdrawable / 2n : 0n;
    if (lessThanVested > 0n) {
      await expectSuccess(runner, "withdraw less than vested static-call succeeds", () =>
        staticCall(contract, actors.operator, "initiateWithdrawUnlocked", [lessThanVested])
      );
    } else {
      runner.skip("less-than-vested case needs withdrawable amount > 1 wei");
    }

    await expectSuccess(runner, "withdraw exactly vested static-call succeeds", () =>
      staticCall(contract, actors.operator, "initiateWithdrawUnlocked", [withdrawable])
    );
    await expectRevert(runner, "withdraw greater than vested fails", () =>
      staticCall(contract, actors.operator, "initiateWithdrawUnlocked", [withdrawable + 1n])
    );

    if (!config.execution.execute) {
      runner.skip("set EXECUTE=true to actually test state changes for partial/exact withdrawals");
      return;
    }

    await sendTx(config, contract, actors.operator, "initiateWithdrawUnlocked", [lessThanVested || withdrawable]);
    runner.pass("sent one unlocked withdrawal transaction");
  });

  await runner.scenario("Withdraw across two vested tranches and fully withdraw all vested tranches", async () => {
    if (!requireActor(runner, actors.operator, "operator")) return;
    const { timestamps, amounts, now } = await loadVestingState(contract);
    if (timestamps.length < 2) {
      runner.skip("needs at least two tranches");
      return;
    }

    const vestedIndexes = vestedTrancheIndexes(timestamps, now);
    if (vestedIndexes.length < 2) {
      runner.skip("needs at least two currently vested remaining tranches");
      return;
    }

    const firstVestedIndex = vestedIndexes[0];
    const secondVestedIndex = vestedIndexes[1];
    const secondPartialAmount = amounts[secondVestedIndex] > 1n
      ? amounts[secondVestedIndex] / 2n
      : amounts[secondVestedIndex];
    const twoTrancheAmount = amounts[firstVestedIndex] + secondPartialAmount;
    const allVestedAmount = vestedAmountFromSchedule(timestamps, amounts, now);

    await expectSuccess(runner, "withdraw across two vested tranches static-call succeeds", () =>
      staticCall(contract, actors.operator, "initiateWithdrawUnlocked", [twoTrancheAmount])
    );
    await expectSuccess(runner, "withdraw all currently vested tranches static-call succeeds", () =>
      staticCall(contract, actors.operator, "initiateWithdrawUnlocked", [allVestedAmount])
    );

    if (!config.execution.execute) {
      runner.skip("set EXECUTE=true to inspect partial remainder after actual withdrawal");
      return;
    }
  });

  await runner.scenario("Repeated unlocked withdrawals cannot exceed cumulative vested amount", async () => {
    if (!requireActor(runner, actors.operator, "operator")) return;

    const totalVested = await contract.getTotalVested();
    await expectRevert(runner, "single call above cumulative vested fails", () =>
      staticCall(contract, actors.operator, "initiateWithdrawUnlocked", [totalVested + 1n])
    );

    runner.skip("true repeated-withdrawal check requires EXECUTE=true and changes deployed state");
  });

  await runner.scenario("Attempt unlocked withdrawal while principal is staked/unbonding", async () => {
    if (!requireActor(runner, actors.operator, "operator")) return;
    runner.skip("requires a prior full-principal delegate/undelegate sequence and live unbonding window");
  });

  await runner.scenario("Emergency locked withdrawal through proposal", async () => {
    if (!config.execution.allowDestructive) {
      runner.skip("emergency withdrawal is destructive; set ALLOW_DESTRUCTIVE=true and EXECUTE=true");
      return;
    }
    if (!requireActor(runner, actors.admin, "admin")) return;
    if (actors.admins.length < 2) {
      runner.skip("requires enough admin private keys to pass proposal");
      return;
    }

    const { info } = await loadVestingState(contract);
    const proposalId = await createProposal(config, runner, contract, actors.admin, "proposeEmergencyWithdraw", [
      info._unlockDistributionAddress,
    ]);
    if (proposalId === null) return;

    await voteUntilPassed(config, runner, contract, proposalId, actors.admins);
    await processPassedProposal(config, runner, contract, actors.admin, proposalId);

    const [afterTimestamps] = await contract.getVestingSchedule();
    if (afterTimestamps.length === 0) runner.pass("emergency withdrawal emptied vesting schedule");
    else runner.fail("vesting schedule is not empty after emergency withdrawal");
  });

  runner.summary();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
