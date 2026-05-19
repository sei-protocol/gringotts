const {
  expectRevert,
  ethers,
  mineOrWait,
  proposalStatusName,
  sendTx,
  staticCall,
} = require("./common");

function proposalIdFromReceipt(contract, receipt) {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed && parsed.name === "ProposalCreated") {
        return parsed.args.proposalId;
      }
    } catch {
      // Ignore logs emitted by other contracts/precompiles.
    }
  }
  return null;
}

async function createProposal(config, runner, contract, admin, fn, args) {
  if (!config.execution.execute) {
    runner.skip(`${fn} would create a proposal; set EXECUTE=true to send it`);
    return null;
  }

  const receipt = await sendTx(config, contract, admin, fn, args);
  const proposalId = proposalIdFromReceipt(contract, receipt);
  if (proposalId === null) {
    runner.fail(`${fn}: ProposalCreated event not found`);
    return null;
  }

  const proposal = await contract.getProposal(proposalId);
  runner.pass(`${fn}: created proposal ${proposalId}`, `status=${proposalStatusName(proposal.status)}, yesVotes=${proposal.yesVotes}`);
  return proposalId;
}

async function voteUntilPassed(config, runner, contract, proposalId, adminWallets) {
  for (const admin of adminWallets.slice(1)) {
    const before = await contract.getProposal(proposalId);
    if (Number(before.status) === 1) {
      runner.pass(`proposal ${proposalId} already passed`);
      return;
    }

    await sendTx(config, contract, admin, "voteProposal", [proposalId]);
    const after = await contract.getProposal(proposalId);
    runner.pass(`admin ${admin.address} voted`, `status=${proposalStatusName(after.status)}, yesVotes=${after.yesVotes}`);

    if (Number(after.status) === 1) return;
  }

  const finalProposal = await contract.getProposal(proposalId);
  if (Number(finalProposal.status) !== 1) {
    runner.fail(`proposal ${proposalId} did not reach Passed with provided admin keys`);
  }
}

async function processPassedProposal(config, runner, contract, admin, proposalId) {
  await sendTx(config, contract, admin, "processProposal", [proposalId]);
  const proposal = await contract.getProposal(proposalId);
  if (Number(proposal.status) === 2) {
    runner.pass(`processed proposal ${proposalId}`);
  } else {
    runner.fail(`proposal ${proposalId} processed but status is ${proposalStatusName(proposal.status)}`);
  }
}

async function expectProcessBeforeThresholdFails(runner, contract, admin, proposalId) {
  await expectRevert(runner, "process before threshold fails", () =>
    staticCall(contract, admin, "processProposal", [proposalId])
  );
}

async function expectDuplicateVoteFails(runner, contract, admin, proposalId) {
  await expectRevert(runner, "duplicate admin vote fails", () =>
    staticCall(contract, admin, "voteProposal", [proposalId])
  );
}

async function expectVoteAfterExpirationBehavior(config, runner, contract, proposer, voter, fn, args) {
  if (!config.execution.execute || !config.execution.waitForExpiry) {
    runner.skip("vote-after-expiration requires EXECUTE=true and WAIT_FOR_EXPIRY=true");
    return;
  }

  const proposalId = await createProposal(config, runner, contract, proposer, fn, args);
  if (proposalId === null) return;

  const proposal = await contract.getProposal(proposalId);
  const latestBlock = await ethers.provider.getBlock("latest");
  const now = Number(latestBlock.timestamp);
  const waitSeconds = Math.max(Number(proposal.expiresAt) - now + 2, 1);
  runner.note(`waiting ${waitSeconds}s for proposal ${proposalId} to expire`);
  await mineOrWait(waitSeconds);

  const before = await contract.getProposal(proposalId);
  await sendTx(config, contract, voter, "voteProposal", [proposalId]);
  const after = await contract.getProposal(proposalId);
  if (Number(after.status) === 3) {
    runner.pass("expired vote transaction returned cleanly and marked proposal Expired");
  } else {
    runner.fail(`expected Expired after late vote, got ${proposalStatusName(after.status)}`);
  }
  runner.note(`status before late vote=${proposalStatusName(before.status)}, after=${proposalStatusName(after.status)}`);
}

module.exports = {
  proposalIdFromReceipt,
  createProposal,
  voteUntilPassed,
  processPassedProposal,
  expectProcessBeforeThresholdFails,
  expectDuplicateVoteFails,
  expectVoteAfterExpirationBehavior,
};
