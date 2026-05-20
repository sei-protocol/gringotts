const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const { ethers } = hre;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ADDR_PRECOMPILE = "0x0000000000000000000000000000000000001004";
const STAKING_PRECOMPILE = "0x0000000000000000000000000000000000001005";
const DEFAULT_CONFIG_PATH = "scripts/scenario-tests/scenario.config.example.json";

const ADDR_ABI = [
  "function getSeiAddr(address addr) view returns (string response)",
];

const STAKING_ABI = [
  "function delegation(address delegator, string valAddress) view returns (tuple(tuple(uint256 amount,string denom) balance, tuple(string delegator_address,uint256 shares,uint256 decimals,string validator_address) delegation))",
  "function unbondingDelegation(address delegator, string validatorAddress) view returns (tuple(string delegatorAddress,string validatorAddress,tuple(int64 creationHeight,int64 completionTime,string initialBalance,string balance)[] entries))",
  "function delegatorUnbondingDelegations(address delegator, bytes nextKey) view returns (tuple(tuple(string delegatorAddress,string validatorAddress,tuple(int64 creationHeight,int64 completionTime,string initialBalance,string balance)[] entries)[] unbondingDelegations, bytes nextKey))",
  "function redelegations(string delegator, string srcValidator, string dstValidator, bytes nextKey) view returns (tuple(tuple(string delegatorAddress,string validatorSrcAddress,string validatorDstAddress,tuple(int64 creationHeight,int64 completionTime,string initialBalance,string sharesDst)[] entries)[] redelegations, bytes nextKey))",
];

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "y"].includes(String(value).toLowerCase());
}

function splitCsv(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readJsonIfExists(filePath) {
  if (!filePath) return {};
  const fullPath = path.resolve(filePath);
  if (!fs.existsSync(fullPath)) return {};
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function latestDeployment() {
  const dir = path.resolve("deployments");
  if (!fs.existsSync(dir)) return {};

  const files = fs
    .readdirSync(dir)
    .filter((file) => /^gringotts-\d+-\d+\.json$/.test(file))
    .map((file) => path.join(dir, file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  if (files.length === 0) return {};
  return JSON.parse(fs.readFileSync(files[0], "utf8"));
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function toWei(value, fieldName) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string" && value.trim() !== "") return BigInt(value);
  throw new Error(`${fieldName} must be a base-10 wei string`);
}

function optionalAddress(value) {
  if (!value) return undefined;
  return ethers.getAddress(value);
}

function loadScenarioConfig() {
  const scenarioConfigPath = process.env.SCENARIO_CONFIG || DEFAULT_CONFIG_PATH;
  const fileConfig = readJsonIfExists(scenarioConfigPath);
  const deployment = latestDeployment();
  const deployParams = deployment.params || {};
  const actorConfig = fileConfig.actors || {};
  const validatorConfig = fileConfig.validators || {};
  const amountConfig = fileConfig.amounts || {};
  const distributionConfig = fileConfig.distribution || {};
  const executionConfig = fileConfig.execution || {};
  const govConfig = fileConfig.governance || {};

  const proxyAddress = optionalAddress(
    process.env.PROXY_ADDRESS || fileConfig.proxyAddress || deployment.proxy
  );
  if (!proxyAddress) {
    throw new Error("Missing proxy address. Set PROXY_ADDRESS or keep a deployment JSON in deployments/.");
  }

  const adminPrivateKeys = splitCsv(process.env.ADMIN_PRIVATE_KEYS).concat(
    asArray(actorConfig.adminPrivateKeys)
  );

  return {
    scenarioConfigPath: path.resolve(scenarioConfigPath),
    deployment,
    proxyAddress,
    implementationAddress: optionalAddress(
      process.env.IMPLEMENTATION_ADDRESS || fileConfig.implementationAddress || deployment.implementation
    ),
    expectedAdmins: asArray(fileConfig.admins || deployParams.admins).map((a) => ethers.getAddress(a)),
    expectedOperators: asArray(fileConfig.operators || deployParams.operators).map((a) => ethers.getAddress(a)),
    actors: {
      adminPrivateKeys,
      operatorPrivateKey: process.env.OPERATOR_PRIVATE_KEY || actorConfig.operatorPrivateKey || "",
      nonAdminPrivateKey: process.env.NON_ADMIN_PRIVATE_KEY || actorConfig.nonAdminPrivateKey || "",
      nonOperatorPrivateKey: process.env.NON_OPERATOR_PRIVATE_KEY || actorConfig.nonOperatorPrivateKey || "",
      newAdminPrivateKey: process.env.NEW_ADMIN_PRIVATE_KEY || actorConfig.newAdminPrivateKey || "",
      newOperatorPrivateKey: process.env.NEW_OPERATOR_PRIVATE_KEY || actorConfig.newOperatorPrivateKey || "",
      implementationDeployerPrivateKey:
        process.env.IMPLEMENTATION_DEPLOYER_PRIVATE_KEY ||
        actorConfig.implementationDeployerPrivateKey ||
        "",
    },
    validators: {
      primary: process.env.PRIMARY_VALIDATOR || validatorConfig.primary || "",
      secondary: process.env.SECONDARY_VALIDATOR || validatorConfig.secondary || "",
      tertiary: process.env.TERTIARY_VALIDATOR || validatorConfig.tertiary || "",
      invalid: process.env.INVALID_VALIDATOR || validatorConfig.invalid || "seivaloper1invalidvalidatoraddress",
    },
    amounts: {
      delegateWei: toWei(process.env.DELEGATE_WEI || amountConfig.delegateWei || ethers.parseEther("1").toString(), "delegateWei"),
      smallWei: toWei(process.env.SMALL_WEI || amountConfig.smallWei || ethers.parseEther("0.25").toString(), "smallWei"),
      dustWei: toWei(process.env.DUST_WEI || amountConfig.dustWei || "1", "dustWei"),
      withdrawWei: toWei(process.env.WITHDRAW_WEI || amountConfig.withdrawWei || ethers.parseEther("0.5").toString(), "withdrawWei"),
    },
    distribution: {
      stakingRewardPrivateKey:
        process.env.STAKING_REWARD_PRIVATE_KEY ||
        distributionConfig.stakingRewardPrivateKey ||
        "",
      associationFunderPrivateKey:
        process.env.ASSOCIATION_FUNDER_PRIVATE_KEY ||
        distributionConfig.associationFunderPrivateKey ||
        "",
      associationFundWei: toWei(
        process.env.ASSOCIATION_FUND_WEI ||
          distributionConfig.associationFundWei ||
          ethers.parseEther("0.01").toString(),
        "associationFundWei"
      ),
      associationReturnWei: toWei(
        process.env.ASSOCIATION_RETURN_WEI || distributionConfig.associationReturnWei || "1",
        "associationReturnWei"
      ),
    },
    execution: {
      execute: parseBool(process.env.EXECUTE, parseBool(executionConfig.execute, false)),
      waitForExpiry: parseBool(process.env.WAIT_FOR_EXPIRY, parseBool(executionConfig.waitForExpiry, false)),
      allowDestructive: parseBool(process.env.ALLOW_DESTRUCTIVE, parseBool(executionConfig.allowDestructive, false)),
      runStress: parseBool(process.env.RUN_STRESS, parseBool(executionConfig.runStress, false)),
      gasLimit: process.env.GAS_LIMIT || executionConfig.gasLimit || "",
    },
    governance: {
      govProposalId: Number(process.env.GOV_PROPOSAL_ID || govConfig.govProposalId || 0),
      voteOption: Number(process.env.GOV_VOTE_OPTION || govConfig.voteOption || 1),
    },
  };
}

async function connectGringotts(proxyAddress) {
  const artifact = await hre.artifacts.readArtifact("Gringotts");
  return new ethers.Contract(proxyAddress, artifact.abi, ethers.provider);
}

function connectStakingPrecompile() {
  return new ethers.Contract(STAKING_PRECOMPILE, STAKING_ABI, ethers.provider);
}

function connectAddressPrecompile() {
  return new ethers.Contract(ADDR_PRECOMPILE, ADDR_ABI, ethers.provider);
}

async function getAssociatedSeiAddress(evmAddress) {
  return connectAddressPrecompile().getSeiAddr(evmAddress);
}

async function addressAssociation(address) {
  try {
    const seiAddress = await getAssociatedSeiAddress(address);
    return { associated: true, seiAddress };
  } catch {
    return { associated: false, seiAddress: "" };
  }
}

function walletFromPrivateKey(privateKey, label) {
  if (!privateKey) return null;
  try {
    return new ethers.Wallet(privateKey, ethers.provider);
  } catch (error) {
    throw new Error(`Invalid private key for ${label}: ${error.message}`);
  }
}

async function signerAddress(signer) {
  if (signer.address) return signer.address;
  return signer.getAddress();
}

async function defaultFunderSigner() {
  const [funder] = await ethers.getSigners();
  if (!funder) throw new Error("No default signer available to fund association bootstrap");
  return funder;
}

async function ensureStakingRewardAddressAssociated(config, runner, rewardAddress) {
  const address = ethers.getAddress(rewardAddress);
  const current = await addressAssociation(address);
  if (current.associated) {
    runner.note(`staking reward address already associated as ${current.seiAddress}`);
    return true;
  }

  if (!config.execution.execute) {
    runner.skip("staking reward address is unassociated; set EXECUTE=true with STAKING_REWARD_PRIVATE_KEY to bootstrap it");
    return false;
  }

  if (!config.distribution.stakingRewardPrivateKey) {
    runner.skip("staking reward address is unassociated; provide distribution.stakingRewardPrivateKey or STAKING_REWARD_PRIVATE_KEY");
    return false;
  }

  const rewardWallet = walletFromPrivateKey(
    config.distribution.stakingRewardPrivateKey,
    "stakingRewardPrivateKey"
  );
  if (ethers.getAddress(rewardWallet.address) !== address) {
    runner.fail(`stakingRewardPrivateKey resolves to ${rewardWallet.address}, not ${address}`);
    return false;
  }

  const funder = config.distribution.associationFunderPrivateKey
    ? walletFromPrivateKey(config.distribution.associationFunderPrivateKey, "associationFunderPrivateKey")
    : await defaultFunderSigner();
  const funderAddress = await signerAddress(funder);

  if (config.distribution.associationFundWei > 0n) {
    const fundTx = await funder.sendTransaction(
      txOverrides(config, {
        to: address,
        value: config.distribution.associationFundWei,
      })
    );
    await fundTx.wait();
    runner.pass(
      "funded staking reward address for association",
      `${weiToSei(config.distribution.associationFundWei)} SEI from ${funderAddress}`
    );
  }

  const associationTx = await rewardWallet.sendTransaction(
    txOverrides(config, {
      to: funderAddress,
      value: config.distribution.associationReturnWei,
    })
  );
  await associationTx.wait();
  runner.pass(
    "staking reward address sent association transaction",
    `${weiToSei(config.distribution.associationReturnWei)} SEI to ${funderAddress}`
  );

  const updated = await addressAssociation(address);
  if (!updated.associated) {
    runner.fail("staking reward address is still unassociated after bootstrap transaction");
    return false;
  }

  runner.pass("staking reward address associated", updated.seiAddress);
  return true;
}

function randomReadOnlyWallet(label) {
  const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
  wallet.__scenarioLabel = `${label} (random eth_call-only wallet)`;
  return wallet;
}

function loadActors(config) {
  const adminWallets = config.actors.adminPrivateKeys.map((key, index) =>
    walletFromPrivateKey(key, `adminPrivateKeys[${index}]`)
  );

  return {
    admins: adminWallets,
    admin: adminWallets[0] || null,
    secondAdmin: adminWallets[1] || null,
    thirdAdmin: adminWallets[2] || null,
    operator: walletFromPrivateKey(config.actors.operatorPrivateKey, "operatorPrivateKey"),
    nonAdmin:
      walletFromPrivateKey(config.actors.nonAdminPrivateKey, "nonAdminPrivateKey") ||
      randomReadOnlyWallet("nonAdmin"),
    nonOperator:
      walletFromPrivateKey(config.actors.nonOperatorPrivateKey, "nonOperatorPrivateKey") ||
      randomReadOnlyWallet("nonOperator"),
    newAdmin:
      walletFromPrivateKey(config.actors.newAdminPrivateKey, "newAdminPrivateKey") ||
      randomReadOnlyWallet("newAdmin"),
    newOperator:
      walletFromPrivateKey(config.actors.newOperatorPrivateKey, "newOperatorPrivateKey") ||
      randomReadOnlyWallet("newOperator"),
    implementationDeployer:
      walletFromPrivateKey(config.actors.implementationDeployerPrivateKey, "implementationDeployerPrivateKey"),
  };
}

function txOverrides(config, extra = {}) {
  const overrides = { ...extra };
  if (config.execution.gasLimit) {
    overrides.gasLimit = BigInt(config.execution.gasLimit);
  }
  return overrides;
}

async function staticCall(contract, signer, fn, args = [], overrides = {}) {
  return contract.connect(signer)[fn].staticCall(...args, overrides);
}

async function sendTx(config, contract, signer, fn, args = [], overrides = {}) {
  if (!config.execution.execute) {
    throw new Error(`Refusing to send ${fn}; set EXECUTE=true after reviewing the script.`);
  }
  const tx = await contract.connect(signer)[fn](...args, txOverrides(config, overrides));
  return tx.wait();
}

function requireActor(runner, actor, label) {
  if (!actor) {
    runner.skip(`missing ${label}; provide it in SCENARIO_CONFIG or ${label.toUpperCase()}_PRIVATE_KEY env`);
    return false;
  }
  return true;
}

function requireValidator(runner, value, label) {
  if (!value) {
    runner.skip(`missing ${label}; set it in SCENARIO_CONFIG or ${label.toUpperCase()}_VALIDATOR env`);
    return false;
  }
  return true;
}

async function expectRevert(runner, label, thunk) {
  try {
    await thunk();
    runner.fail(`${label}: expected revert but call succeeded`);
  } catch (error) {
    runner.pass(label, shortError(error));
  }
}

async function expectSuccess(runner, label, thunk) {
  try {
    const value = await thunk();
    runner.pass(label);
    return value;
  } catch (error) {
    runner.fail(`${label}: ${shortError(error)}`);
    return undefined;
  }
}

function shortError(error) {
  const text = error && (error.shortMessage || error.reason || error.message || String(error));
  return String(text).split("\n")[0];
}

function proposalStatusName(status) {
  return ["Open", "Passed", "Executed", "Expired"][Number(status)] || String(status);
}

function weiToSei(value) {
  return ethers.formatEther(value);
}

async function mineOrWait(seconds) {
  try {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }
}

class ScenarioRunner {
  constructor(title, config) {
    this.title = title;
    this.config = config;
    this.passed = 0;
    this.failed = 0;
    this.skipped = 0;
  }

  header() {
    console.log("");
    console.log("=".repeat(72));
    console.log(this.title);
    console.log("=".repeat(72));
    console.log("Proxy:", this.config.proxyAddress);
    console.log("Config:", this.config.scenarioConfigPath);
    console.log("Mode:", this.config.execution.execute ? "EXECUTE transactions" : "review/static only");
    console.log("");
  }

  async scenario(name, fn) {
    console.log(`\n- ${name}`);
    try {
      await fn();
    } catch (error) {
      this.fail(shortError(error));
    }
  }

  pass(label, detail) {
    this.passed++;
    console.log(`  PASS ${label}${detail ? ` (${detail})` : ""}`);
  }

  fail(label) {
    this.failed++;
    console.log(`  FAIL ${label}`);
  }

  skip(label) {
    this.skipped++;
    console.log(`  SKIP ${label}`);
  }

  note(label) {
    console.log(`  NOTE ${label}`);
  }

  summary() {
    console.log("");
    console.log("Summary:", `${this.passed} passed, ${this.failed} failed, ${this.skipped} skipped`);
    if (this.failed > 0) process.exitCode = 1;
  }
}

module.exports = {
  ZERO_ADDRESS,
  ethers,
  loadScenarioConfig,
  connectGringotts,
  connectStakingPrecompile,
  connectAddressPrecompile,
  getAssociatedSeiAddress,
  addressAssociation,
  ensureStakingRewardAddressAssociated,
  loadActors,
  txOverrides,
  staticCall,
  sendTx,
  requireActor,
  requireValidator,
  expectRevert,
  expectSuccess,
  shortError,
  proposalStatusName,
  weiToSei,
  mineOrWait,
  ScenarioRunner,
};
