const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");

const DEFAULT_IMAGE = process.env.SEI_DOCKER_IMAGE || "seid:latest";
const CHAIN_ID = "sei-chain";
const MNEMONIC = "test test test test test test test test test test test junk";
const BALANCE = "1000000000000000000000usei,1000000000000000000000uusdc,1000000000000000000000uatom";
const DOCKER_COMMAND_TIMEOUT_MS = Number(process.env.SEI_DOCKER_COMMAND_TIMEOUT_MS || 120000);
const LOG_ENABLED = process.env.SEI_TEST_LOGS === "1" || process.env.GITHUB_ACTIONS === "true";
const STARTED_AT = Date.now();

const ACCOUNT_SPECS = [
  ["funder", 0],
  ["admin1", 1],
  ["admin2", 2],
  ["admin3", 3],
  ["admin4", 4],
  ["operator1", 5],
  ["operator2", 6],
  ["unlock", 7],
  ["reward", 8],
  ["recipient", 9],
  ["validator", 99],
];

function deriveWallet(index) {
  return ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/118'/0'/0/${index}`);
}

function log(message) {
  if (!LOG_ENABLED) return;

  const elapsed = ((Date.now() - STARTED_AT) / 1000).toFixed(1).padStart(6, " ");
  console.log(`[sei-local +${elapsed}s] ${message}`);
}

function docker(args, options = {}) {
  const command = ["docker", ...args].join(" ");
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    input: options.input,
    stdio: options.stdio || ["pipe", "pipe", "pipe"],
    timeout: options.timeoutMs || DOCKER_COMMAND_TIMEOUT_MS,
  });

  if (result.status !== 0) {
    throw new Error(
      `Command failed: ${command}\nstatus: ${result.status}\nsignal: ${result.signal || ""}\nstdout:\n${result.stdout || ""}\nstderr:\n${result.stderr || ""}`
    );
  }

  return result.stdout;
}

function dockerIgnoreErrors(args, options = {}) {
  spawnSync("docker", args, {
    encoding: "utf8",
    input: options.input,
    stdio: options.stdio || ["ignore", "ignore", "ignore"],
    timeout: options.timeoutMs || DOCKER_COMMAND_TIMEOUT_MS,
  });
}

function runSeid(home, args, options = {}) {
  const interactive = options.input ? ["-i"] : [];
  return docker([
    "run",
    "--rm",
    ...interactive,
    "-v",
    `${home}:/root/.sei`,
    "--entrypoint",
    "seid",
    DEFAULT_IMAGE,
    ...args,
  ], options);
}

function makeHomeWritable(home) {
  docker([
    "run",
    "--rm",
    "-v",
    `${home}:/root/.sei`,
    "--entrypoint",
    "sh",
    DEFAULT_IMAGE,
    "-c",
    "chmod -R 777 /root/.sei",
  ], { stdio: "ignore" });
}

function makeHomeWritableIgnoreErrors(home) {
  dockerIgnoreErrors([
    "run",
    "--rm",
    "-v",
    `${home}:/root/.sei`,
    "--entrypoint",
    "sh",
    DEFAULT_IMAGE,
    "-c",
    "chmod -R 777 /root/.sei",
  ]);
}

function removeContainer(containerName) {
  dockerIgnoreErrors(["rm", "-f", containerName]);
}

function logContainer(containerName, lines = 200) {
  if (!LOG_ENABLED) return;

  const output = spawnSync("docker", ["logs", "--tail", String(lines), containerName], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
  });
  if (output.status === 0 && (output.stdout || output.stderr)) {
    log(`container logs for ${containerName}:\n${output.stdout || ""}${output.stderr || ""}`);
  }
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function updateGenesis(home) {
  const genesisPath = path.join(home, "config", "genesis.json");
  const genesis = JSON.parse(fs.readFileSync(genesisPath, "utf8"));
  const validatorKey = JSON.parse(
    fs.readFileSync(path.join(home, "config", "priv_validator_key.json"), "utf8")
  ).pub_key;

  genesis.validators = [{ power: "7000000000", pub_key: validatorKey }];
  genesis.app_state.crisis.constant_fee.denom = "usei";
  genesis.app_state.mint.params.mint_denom = "usei";
  genesis.app_state.staking.params.bond_denom = "usei";
  genesis.app_state.staking.params.max_validators = 50;
  genesis.app_state.staking.params.max_voting_power_ratio = "1.000000000000000000";
  genesis.app_state.staking.params.unbonding_time = "10s";
  genesis.app_state.distribution.params.community_tax = "0.000000000000000000";
  genesis.app_state.oracle.params.vote_period = "2";
  genesis.app_state.slashing.params.signed_blocks_window = "10000";
  genesis.app_state.slashing.params.min_signed_per_window = "0.050000000000000000";
  genesis.app_state.gov.deposit_params.min_deposit = [{ amount: "1000000", denom: "usei" }];
  genesis.app_state.gov.deposit_params.min_expedited_deposit = [{ amount: "2000000", denom: "usei" }];
  genesis.app_state.gov.deposit_params.max_deposit_period = "60s";
  genesis.app_state.gov.voting_params.voting_period = "30s";
  genesis.app_state.gov.voting_params.expedited_voting_period = "10s";
  genesis.app_state.gov.tally_params.quorum = "0.334000000000000000";
  genesis.app_state.gov.tally_params.threshold = "0.500000000000000000";
  genesis.consensus_params.block.max_gas = "35000000";
  genesis.consensus_params.block.max_gas_wanted = "70000000";
  genesis.app_state.bank.denom_metadata = [
    {
      denom_units: [{ denom: "usei", exponent: 0, aliases: ["USEI"] }],
      base: "usei",
      display: "usei",
      name: "USEI",
      symbol: "USEI",
    },
  ];

  fs.writeFileSync(genesisPath, `${JSON.stringify(genesis, null, 2)}\n`);
}

function updateConfig(home) {
  const configPath = path.join(home, "config", "config.toml");
  const appPath = path.join(home, "config", "app.toml");

  let config = fs.readFileSync(configPath, "utf8");
  config = config
    .replace('laddr = "tcp://127.0.0.1:26657"', 'laddr = "tcp://0.0.0.0:26657"')
    .replace('mode = "full"', 'mode = "validator"')
    .replace("pex = true", "pex = false")
    .replace('timeout_commit = "5s"', 'timeout_commit = "1s"');
  if (!config.includes("[blocksync]")) {
    config += "\n[blocksync]\nenable = false\n";
  }
  fs.writeFileSync(configPath, config);

  let app = fs.readFileSync(appPath, "utf8");
  app = app
    .replace(/minimum-gas-prices = ".*"/, 'minimum-gas-prices = "0usei"')
    .replace("slow = false", "slow = true")
    .replace("supply_enabled = true", "supply_enabled = false");
  fs.writeFileSync(appPath, app);
}

function parseProposalId(txJson) {
  const parsed = JSON.parse(txJson);
  if (parsed.code && parsed.code !== 0) {
    throw new Error(`Gov proposal failed: ${parsed.raw_log || txJson}`);
  }

  for (const log of parsed.logs || []) {
    for (const event of log.events || []) {
      if (event.type !== "submit_proposal") continue;
      const attr = event.attributes.find((item) => item.key === "proposal_id");
      if (attr) return BigInt(attr.value);
    }
  }

  throw new Error(`Could not find proposal_id in gov tx: ${txJson}`);
}

async function waitForEvm(evmRpcUrl, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastError;

  while (Date.now() < deadline) {
    attempts++;
    try {
      const [chainId, blockNumber] = await Promise.all([
        jsonRpc(evmRpcUrl, "eth_chainId"),
        jsonRpc(evmRpcUrl, "eth_blockNumber"),
      ]);
      if (BigInt(chainId) > 0n && BigInt(blockNumber) > 0n) {
        log(`EVM RPC ready at block ${BigInt(blockNumber).toString()} on chain ${BigInt(chainId).toString()}`);
        return;
      }
    } catch (error) {
      lastError = error;
    }

    if (attempts === 1 || attempts % 10 === 0) {
      log(`waiting for EVM RPC at ${evmRpcUrl}; attempt ${attempts}; last error: ${lastError?.message || "none"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out waiting for Sei EVM RPC. Last error: ${lastError?.message || "none"}`);
}

async function jsonRpc(url, method, params = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json();
  if (payload.error) {
    throw new Error(payload.error.message || JSON.stringify(payload.error));
  }
  return payload.result;
}

async function startSeiLocalNode() {
  log(`checking Docker image ${DEFAULT_IMAGE}`);
  execFileSync("docker", ["image", "inspect", DEFAULT_IMAGE], { stdio: "ignore" });

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gringotts-sei-"));
  const evmPort = await getFreePort();
  const tendermintPort = await getFreePort();
  const restPort = await getFreePort();
  const containerName = `gringotts-sei-${process.pid}-${Date.now()}`;
  log(`using Sei home ${home}`);
  log(`reserved ports evm=${evmPort} tendermint=${tendermintPort} rest=${restPort}`);

  try {
    log("initializing seid home");
    runSeid(home, ["init", "gringotts", "--chain-id", CHAIN_ID, "--overwrite"]);
    makeHomeWritable(home);

    const accounts = {};
    log(`recovering ${ACCOUNT_SPECS.length} deterministic keys`);
    for (const [name, index] of ACCOUNT_SPECS) {
      log(`recovering key ${name} at index ${index}`);
      runSeid(home, [
        "keys",
        "add",
        name,
        "--recover",
        "--index",
        String(index),
        "--keyring-backend",
        "test",
        "--output",
        "json",
      ], { input: `${MNEMONIC}\n` });

      const wallet = deriveWallet(index);
      accounts[name] = {
        address: wallet.address,
        privateKey: wallet.privateKey,
        index,
      };
    }

    log("adding genesis account balances");
    for (const [name] of ACCOUNT_SPECS) {
      runSeid(home, [
        "add-genesis-account",
        name,
        BALANCE,
        "--keyring-backend",
        "test",
      ]);
    }

    log("creating validator gentx");
    runSeid(home, [
      "gentx",
      "validator",
      "7000000000000000usei",
      "--chain-id",
      CHAIN_ID,
      "--keyring-backend",
      "test",
    ]);

    makeHomeWritable(home);
    log("patching genesis");
    updateGenesis(home);
    log("collecting gentxs");
    runSeid(home, ["collect-gentxs"]);
    makeHomeWritable(home);
    log("patching node config");
    updateConfig(home);

    log("resolving validator address");
    const validatorAddress = runSeid(home, [
      "keys",
      "show",
      "validator",
      "--bech=val",
      "-a",
      "--keyring-backend",
      "test",
    ]).trim();
    log(`validator address ${validatorAddress}`);

    log(`starting Sei container ${containerName}`);
    docker([
      "run",
      "-d",
      "--name",
      containerName,
      "-p",
      `127.0.0.1:${evmPort}:8545`,
      "-p",
      `127.0.0.1:${tendermintPort}:26657`,
      "-p",
      `127.0.0.1:${restPort}:1317`,
      "-v",
      `${home}:/root/.sei`,
      "--entrypoint",
      "seid",
      DEFAULT_IMAGE,
      "start",
      "--chain-id",
      CHAIN_ID,
      "--home",
      "/root/.sei",
    ]);

    const evmRpcUrl = `http://127.0.0.1:${evmPort}`;
    log(`waiting for EVM RPC ${evmRpcUrl}`);
    await waitForEvm(evmRpcUrl);
    log(`Sei container ${containerName} is ready`);

    return {
      image: DEFAULT_IMAGE,
      containerName,
      home,
      evmRpcUrl,
      tendermintRpcUrl: `http://127.0.0.1:${tendermintPort}`,
      restUrl: `http://127.0.0.1:${restPort}`,
      accounts,
      validatorAddress,
      cleanup() {
        log(`cleaning up Sei container ${containerName}`);
        removeContainer(containerName);
        makeHomeWritableIgnoreErrors(home);
        fs.rmSync(home, { recursive: true, force: true });
        log(`removed Sei home ${home}`);
      },
      submitGovProposal({ title = "Gringotts test proposal", description = "test" } = {}) {
        log(`submitting gov proposal: ${title}`);
        const output = docker([
          "exec",
          containerName,
          "seid",
          "tx",
          "gov",
          "submit-proposal",
          "--title",
          title,
          "--description",
          description,
          "--type",
          "Text",
          "--deposit",
          "1000000usei",
          "--from",
          "funder",
          "--keyring-backend",
          "test",
          "--chain-id",
          CHAIN_ID,
          "--node",
          "tcp://localhost:26657",
          "--fees",
          "20000usei",
          "-y",
          "-b",
          "block",
          "-o",
          "json",
        ]);
        return parseProposalId(output);
      },
    };
  } catch (error) {
    log(`local Sei startup failed: ${error.message}`);
    logContainer(containerName);
    removeContainer(containerName);
    makeHomeWritableIgnoreErrors(home);
    fs.rmSync(home, { recursive: true, force: true });
    log(`removed failed Sei home ${home}`);
    throw error;
  }
}

module.exports = {
  startSeiLocalNode,
};
