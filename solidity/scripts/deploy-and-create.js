/**
 * Deploy Gringotts implementation + factory, then create an initialized proxy.
 *
 * Usage:
 *   DEPLOY_CONFIG=scripts/deploy-and-create.example.json \
 *     npx hardhat run scripts/deploy-and-create.js --network sei-testnet
 *
 * Environment variables:
 *   DEPLOY_CONFIG   - Path to deployment JSON file. Required.
 *   DRY_RUN         - Set to "true" to validate and print params without deploying.
 *   GAS_LIMIT       - Optional gas limit applied to each deployment transaction.
 *   OUTPUT_DIR      - Optional directory for deployment output JSON. Defaults to deployments.
 */

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

function readJsonFile(filePath) {
  const fullPath = path.resolve(filePath);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Deployment config not found: ${fullPath}`);
  }

  return {
    fullPath,
    data: JSON.parse(fs.readFileSync(fullPath, "utf8")),
  };
}

function getConfigPath() {
  const configPath = process.env.DEPLOY_CONFIG || process.env.CONFIG_FILE;

  if (!configPath) {
    throw new Error(
      "Missing DEPLOY_CONFIG. Example: DEPLOY_CONFIG=scripts/deploy-and-create.example.json npx hardhat run scripts/deploy-and-create.js --network sei-testnet"
    );
  }

  return configPath;
}

function parseUint(value, fieldName) {
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error(`${fieldName} must be non-negative`);
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${fieldName} must be a non-negative safe integer or decimal string`);
    }
    return BigInt(value);
  }

  if (typeof value === "string") {
    if (!/^\d+$/.test(value)) {
      throw new Error(`${fieldName} must be a base-10 integer string`);
    }
    return BigInt(value);
  }

  throw new Error(`${fieldName} must be a number or base-10 integer string`);
}

function parseAddress(value, fieldName) {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be an EVM address string`);
  }

  try {
    return ethers.getAddress(value);
  } catch {
    throw new Error(`${fieldName} is not a valid EVM address: ${value}`);
  }
}

function parseAddressArray(value, fieldName) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty address array`);
  }

  return value.map((entry, index) => parseAddress(entry, `${fieldName}[${index}]`));
}

function parseUintArray(value, fieldName) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty integer array`);
  }

  return value.map((entry, index) => parseUint(entry, `${fieldName}[${index}]`));
}

function normalizeDeploymentConfig(rawConfig) {
  const admins = parseAddressArray(rawConfig.admins, "admins");
  const operators = parseAddressArray(rawConfig.operators, "operators");
  const vestingTimestamps = parseUintArray(rawConfig.vestingTimestamps, "vestingTimestamps");
  const vestingAmounts = parseUintArray(rawConfig.vestingAmounts, "vestingAmounts");

  if (vestingTimestamps.length !== vestingAmounts.length) {
    throw new Error("vestingTimestamps and vestingAmounts must have the same length");
  }

  for (let i = 0; i < vestingAmounts.length; i++) {
    if (vestingAmounts[i] === 0n) {
      throw new Error(`vestingAmounts[${i}] must be greater than zero`);
    }
    if (i > 0 && vestingTimestamps[i] <= vestingTimestamps[i - 1]) {
      throw new Error("vestingTimestamps must be strictly increasing");
    }
  }

  const maxVotingPeriod = parseUint(rawConfig.maxVotingPeriod, "maxVotingPeriod");
  const adminVotingThresholdPercentage = parseUint(
    rawConfig.adminVotingThresholdPercentage,
    "adminVotingThresholdPercentage"
  );

  if (adminVotingThresholdPercentage > 100n) {
    throw new Error("adminVotingThresholdPercentage must be between 0 and 100");
  }

  const vestingTotal = vestingAmounts.reduce((sum, amount) => sum + amount, 0n);
  const totalAmount = rawConfig.totalAmount === undefined
    ? vestingTotal
    : parseUint(rawConfig.totalAmount, "totalAmount");

  if (totalAmount !== vestingTotal) {
    throw new Error("totalAmount must equal the sum of vestingAmounts");
  }

  return {
    admins,
    operators,
    vestingTimestamps,
    vestingAmounts,
    unlockDistributionAddress: parseAddress(
      rawConfig.unlockDistributionAddress,
      "unlockDistributionAddress"
    ),
    stakingRewardAddress: parseAddress(rawConfig.stakingRewardAddress, "stakingRewardAddress"),
    maxVotingPeriod,
    adminVotingThresholdPercentage,
    totalAmount,
    vestingTotal,
  };
}

function stringifyBigInts(value) {
  return JSON.stringify(
    value,
    (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry),
    2
  );
}

function getOverrides(extra = {}) {
  const overrides = { ...extra };

  if (process.env.GAS_LIMIT) {
    overrides.gasLimit = parseUint(process.env.GAS_LIMIT, "GAS_LIMIT");
  }

  return overrides;
}

function getProxyAddressFromReceipt(factory, receipt) {
  for (const log of receipt.logs) {
    try {
      const parsed = factory.interface.parseLog(log);
      if (parsed && parsed.name === "GringottsCreated") {
        return parsed.args.proxy;
      }
    } catch {
      // Ignore logs emitted by other contracts during proxy initialization.
    }
  }

  return null;
}

async function main() {
  const isDryRun = process.env.DRY_RUN === "true";
  const { fullPath, data: rawConfig } = readJsonFile(getConfigPath());
  const config = normalizeDeploymentConfig(rawConfig);
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("=".repeat(60));
  console.log("Gringotts Deploy + Create");
  console.log("=".repeat(60));
  console.log("Config:", fullPath);
  console.log("Network:", network.name, `(chainId ${network.chainId})`);
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "SEI");
  console.log("");
  console.log("Deployment parameters:");
  console.log("  Admins:", config.admins.length);
  console.log("  Operators:", config.operators.length);
  console.log("  Vesting tranches:", config.vestingTimestamps.length);
  console.log("  Vesting total:", ethers.formatEther(config.vestingTotal), "SEI");
  console.log("  Deposit total:", ethers.formatEther(config.totalAmount), "SEI");
  console.log("  Unlock distribution:", config.unlockDistributionAddress);
  console.log("  Staking reward:", config.stakingRewardAddress);
  console.log("  Max voting period:", config.maxVotingPeriod.toString(), "seconds");
  console.log("  Admin voting threshold:", `${config.adminVotingThresholdPercentage}%`);
  console.log("");

  if (balance < config.totalAmount) {
    throw new Error(
      `Insufficient deployer balance. Required deposit ${ethers.formatEther(config.totalAmount)} SEI, available ${ethers.formatEther(balance)} SEI`
    );
  }

  if (isDryRun) {
    console.log("DRY RUN COMPLETE - no transactions sent");
    return;
  }

  console.log("Deploying Gringotts implementation...");
  const Gringotts = await ethers.getContractFactory("Gringotts");
  const implementation = await Gringotts.deploy(getOverrides());
  await implementation.waitForDeployment();
  const implementationAddress = await implementation.getAddress();
  console.log("  Implementation:", implementationAddress);
  console.log("");

  console.log("Deploying GringottsFactory...");
  const GringottsFactory = await ethers.getContractFactory("GringottsFactory");
  const factory = await GringottsFactory.deploy(implementationAddress, getOverrides());
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log("  Factory:", factoryAddress);
  console.log("");

  console.log("Creating initialized Gringotts proxy through factory...");
  const tx = await factory.createGringotts(
    config.admins,
    config.operators,
    config.vestingTimestamps,
    config.vestingAmounts,
    config.unlockDistributionAddress,
    config.stakingRewardAddress,
    config.maxVotingPeriod,
    config.adminVotingThresholdPercentage,
    getOverrides({ value: config.totalAmount })
  );
  const receipt = await tx.wait();

  let proxyAddress = getProxyAddressFromReceipt(factory, receipt);
  if (!proxyAddress) {
    const deployedContracts = await factory.getDeployedContracts();
    proxyAddress = deployedContracts[deployedContracts.length - 1];
  }

  const gringotts = Gringotts.attach(proxyAddress);
  const proxyImplementation = await gringotts.getImplementation();

  console.log("  Proxy:", proxyAddress);
  console.log("  Create tx:", receipt.hash);
  console.log("");
  console.log("Verification:");
  console.log("  Proxy implementation:", proxyImplementation);
  console.log("  Factory count:", (await factory.getDeployedContractsCount()).toString());
  console.log("");

  const deploymentInfo = {
    deployedAt: new Date().toISOString(),
    network: network.name,
    chainId: network.chainId,
    deployer: deployer.address,
    configFile: fullPath,
    implementation: implementationAddress,
    factory: factoryAddress,
    proxy: proxyAddress,
    createTransaction: receipt.hash,
    params: config,
  };

  const outputDir = path.resolve(process.env.OUTPUT_DIR || "deployments");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputFile = path.join(outputDir, `gringotts-${network.chainId}-${Date.now()}.json`);
  fs.writeFileSync(outputFile, stringifyBigInts(deploymentInfo));

  console.log("=".repeat(60));
  console.log("DEPLOYMENT SUCCESSFUL");
  console.log("=".repeat(60));
  console.log("Implementation:", implementationAddress);
  console.log("Factory:", factoryAddress);
  console.log("Proxy:", proxyAddress);
  console.log("Deployment info saved to:", outputFile);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
