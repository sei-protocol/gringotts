const {
  connectGringotts,
  ethers,
  expectRevert,
  loadActors,
  loadScenarioConfig,
  requireActor,
  ScenarioRunner,
  staticCall,
} = require("./lib/common");

const {
  createProposal,
  processPassedProposal,
  voteUntilPassed,
} = require("./lib/proposals");

async function main() {
  const config = loadScenarioConfig();
  const runner = new ScenarioRunner("Upgrade Tests", config);
  runner.header();

  const contract = await connectGringotts(config.proxyAddress);
  const actors = loadActors(config);

  await runner.scenario("Direct UUPS upgrade remains blocked", async () => {
    const currentImplementation = await contract.getImplementation();
    await expectRevert(runner, "direct upgradeToAndCall reverts", () =>
      staticCall(contract, actors.nonAdmin, "upgradeToAndCall", [currentImplementation, "0x"])
    );
  });

  await runner.scenario("Upgrade through admin proposal to GringottsV2Dummy and call dummy function", async () => {
    if (!requireActor(runner, actors.admin, "admin")) return;
    if (actors.admins.length < 2) {
      runner.skip("requires enough admin private keys to pass the upgrade proposal");
      return;
    }

    const beforeImplementation = await contract.getImplementation();
    const beforeAdmins = await contract.listAdmins();
    const beforeOperators = await contract.listOperators();
    const beforeTotalAmount = await contract.totalAmount();
    runner.note(`current implementation: ${beforeImplementation}`);

    if (!config.execution.execute) {
      runner.skip("set EXECUTE=true to deploy V2 implementation and upgrade the live proxy");
      return;
    }

    const implementationDeployer = actors.implementationDeployer || actors.admin;
    runner.note(`implementation deployer: ${implementationDeployer.address}`);

    const GringottsV2Dummy = await ethers.getContractFactory("GringottsV2Dummy", implementationDeployer);
    const newImplementation = await GringottsV2Dummy.deploy();
    await newImplementation.waitForDeployment();
    const newImplementationAddress = await newImplementation.getAddress();
    runner.pass(`deployed GringottsV2Dummy implementation`, newImplementationAddress);

    const proposalId = await createProposal(config, runner, contract, actors.admin, "proposeUpgrade", [
      newImplementationAddress,
    ]);
    if (proposalId === null) return;

    await voteUntilPassed(config, runner, contract, proposalId, actors.admins);
    await processPassedProposal(config, runner, contract, actors.admin, proposalId);

    const afterImplementation = await contract.getImplementation();
    if (afterImplementation === newImplementationAddress) {
      runner.pass("proxy implementation updated to GringottsV2Dummy");
    } else {
      runner.fail(`expected implementation ${newImplementationAddress}, got ${afterImplementation}`);
    }

    const upgraded = GringottsV2Dummy.attach(config.proxyAddress);
    const dummyVersion = await upgraded.dummyVersion();
    const dummyNumber = await upgraded.dummyNumber();

    if (dummyVersion === "gringotts-v2-dummy" && dummyNumber === 2n) {
      runner.pass("dummy V2 functions are callable through proxy");
    } else {
      runner.fail(`unexpected dummy function result: ${dummyVersion}, ${dummyNumber}`);
    }

    const afterAdmins = await contract.listAdmins();
    const afterOperators = await contract.listOperators();
    const afterTotalAmount = await contract.totalAmount();

    if (
      JSON.stringify(afterAdmins) === JSON.stringify(beforeAdmins) &&
      JSON.stringify(afterOperators) === JSON.stringify(beforeOperators) &&
      afterTotalAmount === beforeTotalAmount
    ) {
      runner.pass("core storage survived upgrade");
    } else {
      runner.fail("core storage changed unexpectedly after upgrade");
    }
  });

  runner.summary();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
