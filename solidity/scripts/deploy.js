const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with the account:", deployer.address);
  console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "SEI");

  // Deploy Gringotts implementation
  console.log("\nDeploying Gringotts implementation...");
  const Gringotts = await ethers.getContractFactory("Gringotts");
  const implementation = await Gringotts.deploy();
  await implementation.waitForDeployment();
  const implementationAddress = await implementation.getAddress();
  console.log("Gringotts implementation deployed to:", implementationAddress);

  // Deploy GringottsFactory
  console.log("\nDeploying GringottsFactory...");
  const GringottsFactory = await ethers.getContractFactory("GringottsFactory");
  const factory = await GringottsFactory.deploy(implementationAddress);
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log("GringottsFactory deployed to:", factoryAddress);

  console.log("\n" + "=".repeat(60));
  console.log("Deployment Summary:");
  console.log("=".repeat(60));
  console.log("Implementation:", implementationAddress);
  console.log("Factory:", factoryAddress);
  console.log("");
  console.log("To create a Gringotts contract, call factory.createGringotts() with:");
  console.log("  - admins: [<admin addresses>]");
  console.log("  - operators: [<operator addresses>]");
  console.log("  - vestingTimestamps: [<unix timestamps>]");
  console.log("  - vestingAmounts: [<amounts in wei>]");
  console.log("  - unlockDistributionAddress: <address>");
  console.log("  - stakingRewardAddress: <address>");
  console.log("  - maxVotingPeriod: <seconds>");
  console.log("  - adminVotingThresholdPercentage: <0-100>");
  console.log("  - { value: <total vesting amount in wei> }");
  console.log("=".repeat(60));

  // Save deployment info
  const deploymentInfo = {
    deployedAt: new Date().toISOString(),
    network: (await ethers.provider.getNetwork()).name,
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    deployer: deployer.address,
    implementation: implementationAddress,
    factory: factoryAddress
  };

  console.log("\nDeployment info:", JSON.stringify(deploymentInfo, null, 2));

  return deploymentInfo;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
