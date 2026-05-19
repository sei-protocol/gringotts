const {
  ZERO_ADDRESS,
  connectGringotts,
  ethers,
  expectRevert,
  expectSuccess,
  loadActors,
  loadScenarioConfig,
  requireActor,
  requireValidator,
  ScenarioRunner,
  sendTx,
  staticCall,
  txOverrides,
} = require("./lib/common");

const {
  createProposal,
  expectDuplicateVoteFails,
  expectProcessBeforeThresholdFails,
  expectVoteAfterExpirationBehavior,
  processPassedProposal,
  voteUntilPassed,
} = require("./lib/proposals");

async function main() {
  const config = loadScenarioConfig();
  const runner = new ScenarioRunner("Access Tests", config);
  runner.header();

  const contract = await connectGringotts(config.proxyAddress);
  const actors = loadActors(config);
  const currentAdmins = await contract.listAdmins();
  const currentOperators = await contract.listOperators();
  const info = await contract.getInfo();

  runner.note(`current admins: ${currentAdmins.join(", ")}`);
  runner.note(`current operators: ${currentOperators.join(", ")}`);

  await runner.scenario("Non-op cannot call operator methods", async () => {
    const nonOp = actors.nonOperator;
    await expectRevert(runner, "non-op delegate", () =>
      staticCall(contract, nonOp, "delegate", [config.validators.invalid, config.amounts.delegateWei])
    );
    await expectRevert(runner, "non-op redelegate", () =>
      staticCall(contract, nonOp, "redelegate", [
        config.validators.invalid,
        config.validators.invalid,
        config.amounts.delegateWei,
      ])
    );
    await expectRevert(runner, "non-op undelegate", () =>
      staticCall(contract, nonOp, "undelegate", [config.validators.invalid, config.amounts.delegateWei])
    );
    await expectRevert(runner, "non-op initiateWithdrawUnlocked", () =>
      staticCall(contract, nonOp, "initiateWithdrawUnlocked", [config.amounts.withdrawWei])
    );
    await expectRevert(runner, "non-op initiateWithdrawReward", () =>
      staticCall(contract, nonOp, "initiateWithdrawReward", [[]])
    );
  });

  await runner.scenario("Current op can call safe/no-op operational methods", async () => {
    if (!requireActor(runner, actors.operator, "operator")) return;

    await expectSuccess(runner, "operator withdraw rewards with empty validator list static-call", () =>
      staticCall(contract, actors.operator, "initiateWithdrawReward", [[]])
    );
    await expectSuccess(runner, "operator withdraw unlocked 0 static-call", () =>
      staticCall(contract, actors.operator, "initiateWithdrawUnlocked", [0n])
    );

    if (!requireValidator(runner, config.validators.primary, "primary")) return;
    await expectRevert(runner, "operator delegate 0 fails", () =>
      staticCall(contract, actors.operator, "delegate", [config.validators.primary, 0n])
    );
  });

  await runner.scenario("Current op can call staking operations successfully when validator state exists", async () => {
    if (!requireActor(runner, actors.operator, "operator")) return;
    if (!requireValidator(runner, config.validators.primary, "primary")) return;
    if (!requireValidator(runner, config.validators.secondary, "secondary")) return;

    runner.note("delegate/redelegate/undelegate success paths are mutating; static-call may not reflect precompile side effects on every RPC");
    if (!config.execution.execute) {
      runner.skip("set EXECUTE=true to send the success-path staking transactions");
      return;
    }

    await sendTx(config, contract, actors.operator, "delegate", [
      config.validators.primary,
      config.amounts.delegateWei,
    ]);
    runner.pass("operator delegate sent");

    await sendTx(config, contract, actors.operator, "redelegate", [
      config.validators.primary,
      config.validators.secondary,
      config.amounts.smallWei,
    ]);
    runner.pass("operator redelegate sent");

    await sendTx(config, contract, actors.operator, "undelegate", [
      config.validators.secondary,
      config.amounts.smallWei,
    ]);
    runner.pass("operator undelegate sent");
  });

  await runner.scenario("Non-admin cannot add/remove ops or manage proposals", async () => {
    const nonAdmin = actors.nonAdmin;
    await expectRevert(runner, "non-admin updateOp", () =>
      staticCall(contract, nonAdmin, "updateOp", [actors.newOperator.address, false])
    );
    await expectRevert(runner, "non-admin proposeUpdateAdmin", () =>
      staticCall(contract, nonAdmin, "proposeUpdateAdmin", [actors.newAdmin.address, false])
    );
    await expectRevert(runner, "non-admin voteProposal", () =>
      staticCall(contract, nonAdmin, "voteProposal", [1n])
    );
    await expectRevert(runner, "non-admin processProposal", () =>
      staticCall(contract, nonAdmin, "processProposal", [1n])
    );
  });

  await runner.scenario("Admin can add/remove an op; new/removed op access changes immediately", async () => {
    if (!requireActor(runner, actors.admin, "admin")) return;
    const newOperator = actors.newOperator;

    if (!config.execution.execute) {
      runner.skip("set EXECUTE=true to add/remove operator on-chain");
      return;
    }

    await sendTx(config, contract, actors.admin, "updateOp", [newOperator.address, false]);
    runner.pass(`added operator ${newOperator.address}`);
    await expectSuccess(runner, "new operator can call operator no-op static-call", () =>
      staticCall(contract, newOperator, "initiateWithdrawReward", [[]])
    );

    await sendTx(config, contract, actors.admin, "updateOp", [newOperator.address, true]);
    runner.pass(`removed operator ${newOperator.address}`);
    await expectRevert(runner, "removed operator loses access", () =>
      staticCall(contract, newOperator, "initiateWithdrawReward", [[]])
    );
  });

  await runner.scenario("Proposal creator auto-votes yes; duplicate vote fails; threshold/process behavior", async () => {
    if (!requireActor(runner, actors.admin, "admin")) return;

    const proposalId = await createProposal(config, runner, contract, actors.admin, "proposeUpdateUnlockedDistributionAddress", [
      info._unlockDistributionAddress,
    ]);
    if (proposalId === null) return;

    const proposal = await contract.getProposal(proposalId);
    if (proposal.yesVotes === 1n && (await contract.hasVoted(proposalId, actors.admin.address))) {
      runner.pass("proposal creator auto-voted yes");
    } else {
      runner.fail("proposal creator auto-vote was not recorded as expected");
    }

    await expectDuplicateVoteFails(runner, contract, actors.admin, proposalId);

    if (Number(proposal.status) === 0) {
      await expectProcessBeforeThresholdFails(runner, contract, actors.admin, proposalId);
    } else {
      runner.skip("process-before-threshold: proposer auto-vote already reached threshold");
    }

    if (actors.admins.length < 2) {
      runner.skip("process-after-threshold requires at least two admin private keys");
      return;
    }

    await voteUntilPassed(config, runner, contract, proposalId, actors.admins);
    await processPassedProposal(config, runner, contract, actors.admin, proposalId);
    await expectRevert(runner, "processing the same proposal twice fails", () =>
      staticCall(contract, actors.admin, "processProposal", [proposalId])
    );
  });

  await runner.scenario("Vote after proposal expiration", async () => {
    if (!requireActor(runner, actors.admin, "admin")) return;
    if (!requireActor(runner, actors.secondAdmin, "secondAdmin")) return;

    runner.note("current contract returns cleanly when voteProposal sees an expired proposal; it does not revert");
    await expectVoteAfterExpirationBehavior(
      config,
      runner,
      contract,
      actors.admin,
      actors.secondAdmin,
      "proposeUpdateUnlockedDistributionAddress",
      [info._unlockDistributionAddress]
    );
  });

  await runner.scenario("Internal-only methods cannot be called directly; direct UUPS upgrade is blocked", async () => {
    const internalNames = [
      "_executeUpgrade",
      "_executeUpdateAdmin",
      "_executeUpdateUnlockDistributionAddress",
      "_executeUpdateStakingRewardAddress",
      "_executeEmergencyWithdraw",
    ];

    const exposed = internalNames.filter((name) => contract.interface.fragments.some((fragment) => fragment.name === name));
    if (exposed.length === 0) {
      runner.pass("internal helper methods are absent from ABI");
    } else {
      runner.fail(`internal helpers exposed in ABI: ${exposed.join(", ")}`);
    }

    await expectRevert(runner, "direct upgradeToAndCall is blocked", () =>
      staticCall(contract, actors.nonAdmin, "upgradeToAndCall", [ZERO_ADDRESS, "0x"])
    );
  });

  await runner.scenario("Internal-only methods succeed only through proposal execution path", async () => {
    if (!requireActor(runner, actors.admin, "admin")) return;
    if (actors.admins.length < 2) {
      runner.skip("requires enough admin private keys to pass a proposal");
      return;
    }

    const proposalId = await createProposal(config, runner, contract, actors.admin, "proposeUpdateUnlockedDistributionAddress", [
      info._unlockDistributionAddress,
    ]);
    if (proposalId === null) return;

    await voteUntilPassed(config, runner, contract, proposalId, actors.admins);
    await processPassedProposal(config, runner, contract, actors.admin, proposalId);
    const after = await contract.getInfo();
    if (after._unlockDistributionAddress === info._unlockDistributionAddress) {
      runner.pass("proposal execution path completed without exposing internal helper");
    } else {
      runner.fail("unexpected unlock distribution address after proposal execution");
    }
  });

  runner.summary();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
