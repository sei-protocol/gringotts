const {
  connectGringotts,
  ethers,
  expectRevert,
  loadActors,
  loadScenarioConfig,
  mineOrWait,
  requireActor,
  ScenarioRunner,
  sendTx,
  staticCall,
} = require("./lib/common");

const {
  createProposal,
  expectProcessBeforeThresholdFails,
  expectVoteAfterExpirationBehavior,
  processPassedProposal,
  voteUntilPassed,
} = require("./lib/proposals");

async function main() {
  const config = loadScenarioConfig();
  const runner = new ScenarioRunner("Governance/Admin Proposal Tests", config);
  runner.header();

  const contract = await connectGringotts(config.proxyAddress);
  const actors = loadActors(config);

  await runner.scenario("Propose admin add/remove, collect enough votes, process, and verify admin set changes", async () => {
    if (!requireActor(runner, actors.admin, "admin")) return;
    if (actors.admins.length < 2) {
      runner.skip("requires enough admin private keys to pass proposals");
      return;
    }

    const newAdmin = actors.newAdmin;
    const addProposalId = await createProposal(config, runner, contract, actors.admin, "proposeUpdateAdmin", [
      newAdmin.address,
      false,
    ]);
    if (addProposalId === null) return;

    await voteUntilPassed(config, runner, contract, addProposalId, actors.admins);
    await processPassedProposal(config, runner, contract, actors.admin, addProposalId);

    if (await contract.isAdmin(newAdmin.address)) runner.pass("new admin added");
    else runner.fail("new admin was not added");

    const removeProposalId = await createProposal(config, runner, contract, actors.admin, "proposeUpdateAdmin", [
      newAdmin.address,
      true,
    ]);
    if (removeProposalId === null) return;

    await voteUntilPassed(config, runner, contract, removeProposalId, actors.admins);
    await processPassedProposal(config, runner, contract, actors.admin, removeProposalId);

    if (!(await contract.isAdmin(newAdmin.address))) runner.pass("new admin removed");
    else runner.fail("new admin still present after removal");
  });

  await runner.scenario("Propose unlocked distribution address update, process, then withdraw unlocked", async () => {
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
    runner.skip("actual unlocked withdrawal after address update is covered by vesting-tests.js with an operator key");
  });

  await runner.scenario("Propose staking reward address update, process, then withdraw rewards", async () => {
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
    runner.skip("actual reward withdrawal after address update is covered by reward-tests.js with an operator key");
  });

  await runner.scenario("Propose gov vote and process it", async () => {
    if (!requireActor(runner, actors.admin, "admin")) return;
    if (actors.admins.length < 2) {
      runner.skip("requires enough admin private keys to pass proposal");
      return;
    }
    if (!config.governance.govProposalId) {
      runner.skip("set governance.govProposalId or GOV_PROPOSAL_ID");
      return;
    }

    const proposalId = await createProposal(config, runner, contract, actors.admin, "proposeGovVote", [
      config.governance.govProposalId,
      config.governance.voteOption,
    ]);
    if (proposalId === null) return;

    await voteUntilPassed(config, runner, contract, proposalId, actors.admins);
    await processPassedProposal(config, runner, contract, actors.admin, proposalId);
    runner.pass("gov vote proposal processed; verify vote through Sei gov query tooling");
  });

  await runner.scenario("Proposal that expires before threshold cannot be processed", async () => {
    if (!requireActor(runner, actors.admin, "admin")) return;

    runner.note("current processProposal returns cleanly when it sees Expired; it does not revert");
    await expectVoteAfterExpirationBehavior(
      config,
      runner,
      contract,
      actors.admin,
      actors.secondAdmin || actors.nonAdmin,
      "proposeUpdateUnlockedDistributionAddress",
      [(await contract.getInfo())._unlockDistributionAddress]
    );
  });

  await runner.scenario("Proposal that reached threshold before expiration can still be processed after expiration", async () => {
    if (!requireActor(runner, actors.admin, "admin")) return;
    if (actors.admins.length < 2) {
      runner.skip("requires enough admin private keys to pass proposal");
      return;
    }
    if (!config.execution.execute || !config.execution.waitForExpiry) {
      runner.skip("requires EXECUTE=true and WAIT_FOR_EXPIRY=true");
      return;
    }

    const proposalId = await createProposal(config, runner, contract, actors.admin, "proposeUpdateUnlockedDistributionAddress", [
      (await contract.getInfo())._unlockDistributionAddress,
    ]);
    if (proposalId === null) return;

    await voteUntilPassed(config, runner, contract, proposalId, actors.admins);
    const proposal = await contract.getProposal(proposalId);
    const latestBlock = await ethers.provider.getBlock("latest");
    const waitSeconds = Math.max(Number(proposal.expiresAt) - Number(latestBlock.timestamp) + 2, 1);
    runner.note(`proposal is Passed; waiting ${waitSeconds}s before processing after expiration`);
    await mineOrWait(waitSeconds);
    await processPassedProposal(config, runner, contract, actors.admin, proposalId);
  });

  await runner.scenario("Admin removal changes threshold behavior for later proposals", async () => {
    if (!requireActor(runner, actors.admin, "admin")) return;
    if (actors.admins.length < 2) {
      runner.skip("requires enough admin private keys to change admin set");
      return;
    }

    runner.skip("destructive to admin topology; use the add/remove admin scenario with a disposable newAdmin key first");
  });

  await runner.scenario("Removing the last admin should fail or be prevented", async () => {
    if (!requireActor(runner, actors.admin, "admin")) return;

    const admins = await contract.listAdmins();
    if (admins.length !== 1) {
      runner.skip("contract currently has more than one admin; last-admin condition not present");
      return;
    }
    if (!config.execution.execute) {
      runner.skip("requires EXECUTE=true to create the last-admin removal proposal, then process it via static-call");
      return;
    }

    const proposalId = await createProposal(config, runner, contract, actors.admin, "proposeUpdateAdmin", [
      admins[0],
      true,
    ]);
    if (proposalId === null) return;

    await expectRevert(runner, "processing last admin removal fails", () =>
      staticCall(contract, actors.admin, "processProposal", [proposalId])
    );
  });

  await runner.scenario("Removing the last op should fail or be prevented if invariant is kept", async () => {
    if (!requireActor(runner, actors.admin, "admin")) return;

    const operators = await contract.listOperators();
    if (operators.length !== 1) {
      runner.skip("contract currently has more than one operator; last-op condition not present");
      return;
    }

    runner.note("current Gringotts has no CannotRemoveLastOperator invariant; this scenario is expected to reveal that mismatch if executed.");
    await expectRevert(runner, "last operator removal should fail under CW invariant", () =>
      staticCall(contract, actors.admin, "updateOp", [operators[0], true])
    );
  });

  await runner.scenario("Process before threshold is reached fails", async () => {
    if (!requireActor(runner, actors.admin, "admin")) return;

    const proposalId = await createProposal(config, runner, contract, actors.admin, "proposeUpdateUnlockedDistributionAddress", [
      (await contract.getInfo())._unlockDistributionAddress,
    ]);
    if (proposalId === null) return;

    const proposal = await contract.getProposal(proposalId);
    if (Number(proposal.status) !== 0) {
      runner.skip("auto-vote already reached threshold");
      return;
    }

    await expectProcessBeforeThresholdFails(runner, contract, actors.admin, proposalId);
  });

  runner.summary();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
