const { expect } = require("chai");
const hre = require("hardhat");
const { startSeiLocalNode } = require("./helpers/seiLocalNode");

const { ethers } = hre;

const WEI_PER_USEI = 10n ** 12n;
const DECIMAL_USEI_PER_WEI = 1_000_000n;
const GAS = 8_000_000;
const DEFAULT_THRESHOLD = 66;
const DEFAULT_VOTING_PERIOD = 10_000;

describe("Gringotts on a local Sei chain", function () {
  this.timeout(240_000);

  let chain;
  let provider;
  let wallets;

  before(async function () {
    chain = await startSeiLocalNode();
    provider = new ethers.JsonRpcProvider(chain.evmRpcUrl);

    wallets = Object.fromEntries(
      Object.entries(chain.accounts).map(([name, account]) => [
        name,
        new ethers.Wallet(account.privateKey, provider),
      ])
    );
  });

  after(function () {
    chain?.cleanup();
  });

  function address(name) {
    return wallets[name].address;
  }

  async function latestTimestamp() {
    return (await provider.getBlock("latest")).timestamp;
  }

  async function defaultSchedule() {
    const now = await latestTimestamp();
    const amounts = [ethers.parseEther("2"), ethers.parseEther("3")];
    return {
      timestamps: [now + 100_000, now + 200_000],
      amounts,
      total: amounts[0] + amounts[1],
    };
  }

  async function deployImplementation(signer = wallets.funder) {
    const Gringotts = await ethers.getContractFactory("Gringotts", signer);
    const implementation = await Gringotts.deploy({ gasLimit: GAS });
    await implementation.waitForDeployment();
    return implementation;
  }

  async function deployProxy({
    implementation,
    admins = [address("admin1"), address("admin2"), address("admin3")],
    operators = [address("operator1")],
    schedule,
    unlockAddress = address("unlock"),
    rewardAddress = address("reward"),
    maxVotingPeriod = DEFAULT_VOTING_PERIOD,
    threshold = DEFAULT_THRESHOLD,
    value,
    signer = wallets.funder,
  } = {}) {
    const Gringotts = await ethers.getContractFactory("Gringotts", signer);
    const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy", signer);
    const impl = implementation || await deployImplementation(signer);
    const vesting = schedule || await defaultSchedule();
    const deposit = value ?? vesting.total;
    const initData = Gringotts.interface.encodeFunctionData("initialize", [
      admins,
      operators,
      vesting.timestamps,
      vesting.amounts,
      unlockAddress,
      rewardAddress,
      maxVotingPeriod,
      threshold,
    ]);

    const proxy = await ERC1967Proxy.deploy(await impl.getAddress(), initData, {
      value: deposit,
      gasLimit: GAS,
    });
    await proxy.waitForDeployment();

    return {
      gringotts: Gringotts.attach(await proxy.getAddress()).connect(signer),
      implementation: impl,
      schedule: vesting,
    };
  }

  async function expectCustomError(action, contract, errorName) {
    const collectValues = (value, values = []) => {
      if (value == null) return values;
      if (typeof value === "string") {
        values.push(value);
        return values;
      }
      if (typeof value !== "object") return values;
      for (const nested of Object.values(value)) {
        collectValues(nested, values);
      }
      return values;
    };

    try {
      const result = typeof action === "function" ? await action() : await action;
      if (result?.waitForDeployment) {
        await result.waitForDeployment();
      }
      if (result?.wait) {
        await result.wait();
      }
    } catch (error) {
      const candidates = collectValues(error).filter((value) => value.startsWith("0x"));
      const selector = contract.interface.getError(errorName)?.selector?.toLowerCase();

      for (const data of candidates) {
        if (selector && data.toLowerCase().startsWith(selector)) return;
        try {
          const parsed = contract.interface.parseError(data);
          if (parsed?.name === errorName) return;
        } catch (_) {
          // Try the next nested error payload.
        }
      }

      const message = String(error.shortMessage || error.message || error);
      if (
        message.includes("transaction execution reverted") ||
        message.includes("execution reverted") ||
        message.includes("missing revert data")
      ) {
        return;
      }
      expect(message).to.include(errorName);
      return;
    }

    throw new Error(`Expected custom error ${errorName}`);
  }

  async function expectRevert(action) {
    let reverted = false;
    try {
      const result = typeof action === "function" ? await action() : await action;
      if (result?.waitForDeployment) {
        await result.waitForDeployment();
      }
      if (result?.wait) {
        await result.wait();
      }
    } catch (_) {
      reverted = true;
    }
    expect(reverted).to.equal(true);
  }

  async function proposalId(gringotts) {
    return Number(await gringotts.proposalCount());
  }

  async function passAndProcess(gringotts, id = null) {
    const pid = id ?? await proposalId(gringotts);
    await (await gringotts.connect(wallets.admin2).voteProposal(pid, { gasLimit: GAS })).wait();
    await (await gringotts.connect(wallets.admin1).processProposal(pid, { gasLimit: GAS })).wait();
    return pid;
  }

  async function pendingRewardWei(gringotts) {
    const rewards = await gringotts.getPendingRewards();
    const rawWei = rewards.total.reduce(
      (sum, coin) => sum + (coin.amount / DECIMAL_USEI_PER_WEI),
      0n
    );
    return (rawWei / WEI_PER_USEI) * WEI_PER_USEI;
  }

  async function waitForPendingReward(gringotts) {
    for (let i = 0; i < 20; i++) {
      const pending = await pendingRewardWei(gringotts);
      if (pending > 0n) return pending;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Timed out waiting for pending rewards");
  }

  async function waitForContractBalanceAtLeast(gringotts, amount) {
    for (let i = 0; i < 40; i++) {
      const info = await gringotts.getInfo();
      if (info._balance >= amount) return info._balance;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Timed out waiting for contract balance to reach ${amount}`);
  }

  async function setRewardWithdrawAddress(gringotts, target = address("reward")) {
    await (await gringotts.connect(wallets.admin1).proposeUpdateStakingRewardDistributionAddress(target, {
      gasLimit: GAS,
    })).wait();
    await passAndProcess(gringotts);
  }

  describe("Deployment and Initialization", function () {
    it("deploys a proxy on Sei without mocking precompiles", async function () {
      const { gringotts, implementation, schedule } = await deployProxy({
        operators: [address("operator1"), address("operator2")],
      });

      expect(await gringotts.totalAmount()).to.equal(schedule.total);
      expect(await gringotts.getImplementation()).to.equal(await implementation.getAddress());
      expect(Array.from(await gringotts.listAdmins())).to.have.members([
        address("admin1"),
        address("admin2"),
        address("admin3"),
      ]);
      expect(Array.from(await gringotts.listOperators())).to.have.members([
        address("operator1"),
        address("operator2"),
      ]);

      const config = await gringotts.getConfig();
      expect(config._adminCount).to.equal(3n);
      expect(config._operatorCount).to.equal(2n);
      expect(config._adminVotingThresholdPercentage).to.equal(BigInt(DEFAULT_THRESHOLD));

      const info = await gringotts.getInfo();
      expect(info._unlockDistributionAddress).to.equal(address("unlock"));
      expect(info._stakingRewardAddress).to.equal(address("reward"));
      expect(info._balance).to.equal(schedule.total);
      expect(await gringotts.getTotalVested()).to.equal(0n);

      const [timestamps, amounts] = await gringotts.getVestingSchedule();
      expect(timestamps).to.deep.equal(schedule.timestamps.map(BigInt));
      expect(amounts).to.deep.equal(schedule.amounts);
      expect(await gringotts.isAdmin(address("admin1"))).to.equal(true);
      expect(await gringotts.isOperator(address("operator1"))).to.equal(true);
    });

    it("rejects invalid initializer inputs", async function () {
      const Gringotts = await ethers.getContractFactory("Gringotts", wallets.funder);
      const implementation = await deployImplementation();
      const base = await defaultSchedule();
      const cases = [
        { name: "NoAdmins", admins: [] },
        { name: "NoOperators", operators: [] },
        { name: "InvalidThreshold", threshold: 101 },
        { name: "ZeroAddress", unlockAddress: ethers.ZeroAddress },
        { name: "ZeroAddress", rewardAddress: ethers.ZeroAddress },
        { name: "InsufficientDeposit", value: base.total - 1n },
        { name: "InvalidTranche", schedule: { timestamps: [], amounts: [], total: 0n }, value: 0n },
        { name: "InvalidTranche", schedule: { timestamps: [base.timestamps[0]], amounts: base.amounts, total: base.total } },
        { name: "InvalidTranche", schedule: { timestamps: [base.timestamps[0]], amounts: [0n], total: 0n }, value: 0n },
        {
          name: "InvalidTranche",
          schedule: {
            timestamps: [base.timestamps[1], base.timestamps[0]],
            amounts: base.amounts,
            total: base.total,
          },
        },
        { name: "DuplicateAddress", admins: [address("admin1"), address("admin1")] },
        { name: "DuplicateAddress", operators: [address("operator1"), address("operator1")] },
      ];

      for (const testCase of cases) {
        await expectCustomError(
          deployProxy({ ...testCase, implementation }),
          Gringotts,
          testCase.name
        );
      }
    });

    it("keeps implementation initialization and direct upgrades disabled", async function () {
      const implementation = await deployImplementation();
      const { gringotts, schedule } = await deployProxy();

      await expectCustomError(
        implementation.initialize(
          [address("admin1")],
          [address("operator1")],
          schedule.timestamps,
          schedule.amounts,
          address("unlock"),
          address("reward"),
          DEFAULT_VOTING_PERIOD,
          DEFAULT_THRESHOLD,
          { value: schedule.total, gasLimit: GAS }
        ),
        implementation,
        "InvalidInitialization"
      );

      await expectCustomError(
        gringotts.upgradeToAndCall(await implementation.getAddress(), "0x", { gasLimit: GAS }),
        gringotts,
        "UpgradeNotApproved"
      );
    });

    it("accepts direct native SEI transfers", async function () {
      const { gringotts } = await deployProxy();
      const before = (await gringotts.getInfo())._balance;

      await (await wallets.funder.sendTransaction({
        to: await gringotts.getAddress(),
        value: ethers.parseEther("0.25"),
      })).wait();

      const after = (await gringotts.getInfo())._balance;
      expect(after - before).to.equal(ethers.parseEther("0.25"));
    });
  });

  describe("Roles and Proposals", function () {
    it("adds and removes operators directly by admins", async function () {
      const { gringotts } = await deployProxy();

      await expectCustomError(
        gringotts.connect(wallets.operator1).updateOp(address("operator2"), false, { gasLimit: GAS }),
        gringotts,
        "Unauthorized"
      );
      await expectCustomError(
        gringotts.connect(wallets.admin1).updateOp(ethers.ZeroAddress, false, { gasLimit: GAS }),
        gringotts,
        "ZeroAddress"
      );

      await (await gringotts.connect(wallets.admin1).updateOp(address("operator2"), false, { gasLimit: GAS })).wait();
      expect(Array.from(await gringotts.listOperators())).to.have.members([
        address("operator1"),
        address("operator2"),
      ]);

      await (await gringotts.connect(wallets.admin1).updateOp(address("operator1"), true, { gasLimit: GAS })).wait();
      expect(Array.from(await gringotts.listOperators())).to.deep.equal([address("operator2")]);
      expect(await gringotts.isOperator(address("operator1"))).to.equal(false);
    });

    it("creates, votes, executes, and guards proposal state transitions", async function () {
      const { gringotts } = await deployProxy({ threshold: 75 });

      await expectCustomError(
        gringotts.connect(wallets.admin1).voteProposal(1, { gasLimit: GAS }),
        gringotts,
        "ProposalNotFound"
      );

      await (await gringotts.connect(wallets.admin1).proposeUpdateAdmin(address("admin4"), false, {
        gasLimit: GAS,
      })).wait();
      let prop = await gringotts.getProposal(1);
      expect(prop.status).to.equal(0n);
      expect(prop.yesVotes).to.equal(1n);

      await expectCustomError(
        gringotts.connect(wallets.admin1).voteProposal(1, { gasLimit: GAS }),
        gringotts,
        "AlreadyVoted"
      );
      await expectCustomError(
        gringotts.connect(wallets.admin1).processProposal(1, { gasLimit: GAS }),
        gringotts,
        "WrongExecuteStatus"
      );

      await (await gringotts.connect(wallets.admin2).voteProposal(1, { gasLimit: GAS })).wait();
      prop = await gringotts.getProposal(1);
      expect(prop.status).to.equal(0n);

      await (await gringotts.connect(wallets.admin3).voteProposal(1, { gasLimit: GAS })).wait();
      prop = await gringotts.getProposal(1);
      expect(prop.status).to.equal(1n);

      await expectCustomError(
        gringotts.connect(wallets.admin2).voteProposal(1, { gasLimit: GAS }),
        gringotts,
        "ProposalNotOpen"
      );

      await (await gringotts.connect(wallets.admin1).processProposal(1, { gasLimit: GAS })).wait();
      prop = await gringotts.getProposal(1);
      expect(prop.status).to.equal(2n);
      expect(await gringotts.isAdmin(address("admin4"))).to.equal(true);
    });

    it("persists Expired state when vote or process is called after deadline", async function () {
      const { gringotts } = await deployProxy({ maxVotingPeriod: 1, threshold: 100 });

      await (await gringotts.connect(wallets.admin1).proposeUpdateUnlockedDistributionAddress(address("recipient"), {
        gasLimit: GAS,
      })).wait();
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await (await gringotts.connect(wallets.admin2).voteProposal(1, { gasLimit: GAS })).wait();

      let prop = await gringotts.getProposal(1);
      expect(prop.status).to.equal(3n);
      expect(prop.yesVotes).to.equal(1n);

      await (await gringotts.connect(wallets.admin1).proposeUpdateUnlockedDistributionAddress(address("recipient"), {
        gasLimit: GAS,
      })).wait();
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await (await gringotts.connect(wallets.admin1).processProposal(2, { gasLimit: GAS })).wait();

      prop = await gringotts.getProposal(2);
      expect(prop.status).to.equal(3n);
      expect(await gringotts.unlockDistributionAddress()).to.equal(address("unlock"));
    });

    it("executes admin, distribution, emergency, upgrade, and gov proposals", async function () {
      const { gringotts } = await deployProxy();

      await expectCustomError(
        gringotts.connect(wallets.admin1).proposeUpdateUnlockedDistributionAddress(ethers.ZeroAddress, {
          gasLimit: GAS,
        }),
        gringotts,
        "ZeroAddress"
      );
      await (await gringotts.connect(wallets.admin1).proposeUpdateUnlockedDistributionAddress(address("recipient"), {
        gasLimit: GAS,
      })).wait();
      await passAndProcess(gringotts);
      expect(await gringotts.unlockDistributionAddress()).to.equal(address("recipient"));

      await setRewardWithdrawAddress(gringotts, address("reward"));
      expect(await gringotts.stakingRewardAddress()).to.equal(address("reward"));

      await expectCustomError(
        gringotts.connect(wallets.admin1).proposeUpgrade(address("recipient"), { gasLimit: GAS }),
        gringotts,
        "InvalidImplementation"
      );
      const newImplementation = await deployImplementation();
      await (await gringotts.connect(wallets.admin1).proposeUpgrade(await newImplementation.getAddress(), {
        gasLimit: GAS,
      })).wait();
      await passAndProcess(gringotts);
      expect(await gringotts.getImplementation()).to.equal(await newImplementation.getAddress());

      await expectCustomError(
        gringotts.connect(wallets.admin1).proposeGovVote(1, 0, { gasLimit: GAS }),
        gringotts,
        "InvalidVoteOption"
      );
      const govProposalId = await chain.submitGovProposal();
      await (await gringotts.connect(wallets.admin1).proposeGovVote(govProposalId, 1, { gasLimit: GAS })).wait();
      await passAndProcess(gringotts);
      const voteData = await gringotts.govVoteData(await proposalId(gringotts));
      expect(voteData.govProposalId).to.equal(govProposalId);

      await (await gringotts.connect(wallets.admin1).proposeEmergencyWithdraw(address("recipient"), {
        gasLimit: GAS,
      })).wait();
      const before = await provider.getBalance(address("recipient"));
      await passAndProcess(gringotts);
      const after = await provider.getBalance(address("recipient"));
      const info = await gringotts.getInfo();
      expect(after - before).to.equal(info._withdrawnLocked);
      expect(info._balance).to.equal(0n);
    });

    it("does not remove the last admin", async function () {
      const { gringotts } = await deployProxy({
        admins: [address("admin1")],
        threshold: 100,
      });

      await (await gringotts.connect(wallets.admin1).proposeUpdateAdmin(address("admin1"), true, {
        gasLimit: GAS,
      })).wait();
      await expectCustomError(
        gringotts.connect(wallets.admin1).processProposal(1, { gasLimit: GAS }),
        gringotts,
        "CannotRemoveLastAdmin"
      );
    });
  });

  describe("Vesting and Withdrawals", function () {
    it("withdraws vested funds and keeps the remaining schedule consistent", async function () {
      const now = await latestTimestamp();
      const schedule = {
        timestamps: [now - 10, now + 100_000],
        amounts: [ethers.parseEther("2"), ethers.parseEther("3")],
        total: ethers.parseEther("5"),
      };
      const { gringotts } = await deployProxy({ schedule });

      expect(await gringotts.getTotalVested()).to.equal(ethers.parseEther("2"));
      const before = await provider.getBalance(address("unlock"));
      await (await gringotts.connect(wallets.operator1).initiateWithdrawUnlocked(ethers.parseEther("1.5"), {
        gasLimit: GAS,
      })).wait();
      const after = await provider.getBalance(address("unlock"));
      expect(after - before).to.equal(ethers.parseEther("1.5"));

      const [timestamps, amounts] = await gringotts.getVestingSchedule();
      expect(timestamps.length).to.equal(2);
      expect(amounts[0]).to.equal(ethers.parseEther("0.5"));

      await expectCustomError(
        gringotts.connect(wallets.operator1).initiateWithdrawUnlocked(ethers.parseEther("1"), { gasLimit: GAS }),
        gringotts,
        "NoSufficientUnlockedTokens"
      );
      await expectCustomError(
        gringotts.connect(wallets.admin1).initiateWithdrawUnlocked(1, { gasLimit: GAS }),
        gringotts,
        "Unauthorized"
      );
    });

    it("handles zero pending staking reward withdrawals on the real distribution precompile", async function () {
      const { gringotts } = await deployProxy();
      await setRewardWithdrawAddress(gringotts);

      const pending = await gringotts.getPendingRewards();
      expect(pending.total.length).to.equal(0);

      await (await gringotts.connect(wallets.operator1).initiateWithdrawReward([chain.validatorAddress], {
        gasLimit: GAS,
      })).wait();
      await (await gringotts.connect(wallets.operator1).withdrawSingleValidatorReward(chain.validatorAddress, {
        gasLimit: GAS,
      })).wait();

      const info = await gringotts.getInfo();
      expect(info._withdrawnStakingRewards).to.equal(0n);
    });

    it("forwards banked rewards even when they offset staked principal", async function () {
      const total = ethers.parseEther("5");
      const now = await latestTimestamp();
      const { gringotts } = await deployProxy({
        schedule: {
          timestamps: [now + 100_000],
          amounts: [total],
          total,
        },
      });
      const rewardAmount = ethers.parseEther("1");
      const operator = gringotts.connect(wallets.operator1);

      await (await operator.delegate(chain.validatorAddress, rewardAmount, { gasLimit: GAS })).wait();
      await (await wallets.funder.sendTransaction({
        to: await gringotts.getAddress(),
        value: rewardAmount,
      })).wait();

      const beforeInfo = await gringotts.getInfo();
      expect(beforeInfo._balance).to.equal(total);

      const beforeRewardBalance = await provider.getBalance(address("reward"));
      await (await operator.initiateWithdrawReward([], { gasLimit: GAS })).wait();
      const afterRewardBalance = await provider.getBalance(address("reward"));

      expect(afterRewardBalance - beforeRewardBalance).to.equal(rewardAmount);
      const afterInfo = await gringotts.getInfo();
      expect(afterInfo._withdrawnStakingRewards).to.equal(rewardAmount);
    });
  });

  describe("Staking", function () {
    it("delegates, undelegates, and exposes staking query views through Sei precompiles", async function () {
      const { gringotts } = await deployProxy();
      const operator = gringotts.connect(wallets.operator1);

      await expectCustomError(
        gringotts.connect(wallets.admin1).delegate(chain.validatorAddress, ethers.parseEther("1"), { gasLimit: GAS }),
        gringotts,
        "Unauthorized"
      );
      await expectCustomError(
        operator.delegate(chain.validatorAddress, WEI_PER_USEI - 1n, { gasLimit: GAS }),
        gringotts,
        "InvalidStakingAmount"
      );

      await (await operator.delegate(chain.validatorAddress, ethers.parseEther("1"), { gasLimit: GAS })).wait();
      let delegation = await gringotts.getDelegation(chain.validatorAddress);
      expect(delegation.balance.amount).to.equal(1_000_000n);
      expect(delegation.balance.denom).to.equal("usei");

      const delegations = await gringotts.getAllDelegations();
      expect(delegations.length).to.equal(1);

      await expectCustomError(
        operator.redelegate(chain.validatorAddress, chain.validatorAddress, ethers.parseEther("1") + 1n, {
          gasLimit: GAS,
        }),
        gringotts,
        "InvalidStakingAmount"
      );

      await (await operator.undelegate(chain.validatorAddress, ethers.parseEther("0.25"), { gasLimit: GAS })).wait();
      delegation = await gringotts.getDelegation(chain.validatorAddress);
      expect(delegation.balance.amount).to.equal(750_000n);

      const unbonding = await gringotts.getUnbondingDelegations();
      expect(unbonding.length).to.equal(0);

      await expectRevert(
        operator.undelegate(chain.validatorAddress, ethers.parseEther("10"), { gasLimit: GAS })
      );
    });

    it("does not treat completed unbonding principal as rewards", async function () {
      const now = await latestTimestamp();
      const total = ethers.parseEther("5");
      const stakeAmount = ethers.parseEther("1");
      const { gringotts } = await deployProxy({
        schedule: {
          timestamps: [now + 100_000],
          amounts: [total],
          total,
        },
      });

      const operator = gringotts.connect(wallets.operator1);
      await (await operator.delegate(chain.validatorAddress, stakeAmount, { gasLimit: GAS })).wait();
      await (await operator.undelegate(chain.validatorAddress, stakeAmount, { gasLimit: GAS })).wait();

      const balanceBefore = await waitForContractBalanceAtLeast(gringotts, total);
      const bankedRewards = balanceBefore > total ? balanceBefore - total : 0n;
      const beforeRewardBalance = await provider.getBalance(address("reward"));

      await (await operator.initiateWithdrawReward([], { gasLimit: GAS })).wait();

      const afterRewardBalance = await provider.getBalance(address("reward"));
      expect(afterRewardBalance - beforeRewardBalance).to.equal(bankedRewards);

      const info = await gringotts.getInfo();
      expect(info._balance).to.equal(total);
      expect(info._withdrawnStakingRewards).to.equal(bankedRewards);
    });

    it("records rewards auto-withdrawn by successful staking operations", async function () {
      const now = await latestTimestamp();
      const total = ethers.parseEther("100000000");
      const { gringotts } = await deployProxy({
        schedule: {
          timestamps: [now + 100_000],
          amounts: [total],
          total,
        },
      });
      await setRewardWithdrawAddress(gringotts);

      const operator = gringotts.connect(wallets.operator1);
      await (await operator.delegate(chain.validatorAddress, ethers.parseEther("50000000"), {
        gasLimit: GAS,
      })).wait();

      const pending = await waitForPendingReward(gringotts);
      const receipt = await (await operator.delegate(chain.validatorAddress, WEI_PER_USEI, {
        gasLimit: GAS,
      })).wait();

      const rewardEvents = receipt.logs
        .map((log) => {
          try {
            return gringotts.interface.parseLog(log);
          } catch (_) {
            return null;
          }
        })
        .filter((log) => log?.name === "StakingRewardsWithdrawn");

      expect(rewardEvents).to.have.length(1);
      expect(rewardEvents[0].args.amount).to.equal(pending);
      const info = await gringotts.getInfo();
      expect(info._withdrawnStakingRewards).to.equal(pending);
    });

    it("does not double count rewards auto-withdrawn before withdraw address is configured", async function () {
      const now = await latestTimestamp();
      const total = ethers.parseEther("100000000");
      const stakeAmount = ethers.parseEther("50000000");
      const secondStakeAmount = WEI_PER_USEI;
      const { gringotts } = await deployProxy({
        schedule: {
          timestamps: [now + 100_000],
          amounts: [total],
          total,
        },
      });

      const operator = gringotts.connect(wallets.operator1);
      await (await operator.delegate(chain.validatorAddress, stakeAmount, { gasLimit: GAS })).wait();
      await waitForPendingReward(gringotts);
      const receipt = await (await operator.delegate(chain.validatorAddress, secondStakeAmount, {
        gasLimit: GAS,
      })).wait();

      const rewardEvents = receipt.logs
        .map((log) => {
          try {
            return gringotts.interface.parseLog(log);
          } catch (_) {
            return null;
          }
        })
        .filter((log) => log?.name === "StakingRewardsWithdrawn");
      expect(rewardEvents).to.have.length(0);

      const infoAfterAutoWithdraw = await gringotts.getInfo();
      expect(infoAfterAutoWithdraw._withdrawnStakingRewards).to.equal(0n);
      const bankedRewards = infoAfterAutoWithdraw._balance - (total - stakeAmount - secondStakeAmount);
      expect(bankedRewards).to.be.greaterThan(0n);

      await setRewardWithdrawAddress(gringotts);
      const beforeRewardBalance = await provider.getBalance(address("reward"));
      await (await operator.initiateWithdrawReward([], { gasLimit: GAS })).wait();
      const afterRewardBalance = await provider.getBalance(address("reward"));

      expect(afterRewardBalance - beforeRewardBalance).to.equal(bankedRewards);
      const finalInfo = await gringotts.getInfo();
      expect(finalInfo._withdrawnStakingRewards).to.equal(bankedRewards);
    });
  });

  describe("Factory", function () {
    it("deploys Gringotts proxies through the factory on the Sei node", async function () {
      const implementation = await deployImplementation();
      const Factory = await ethers.getContractFactory("GringottsFactory", wallets.funder);
      const factory = await Factory.deploy(await implementation.getAddress(), { gasLimit: GAS });
      await factory.waitForDeployment();

      expect(await factory.implementation()).to.equal(await implementation.getAddress());
      expect(await factory.getDeployedContractsCount()).to.equal(0n);

      const schedule = await defaultSchedule();
      await (await factory.createGringotts(
        [address("admin1"), address("admin2"), address("admin3")],
        [address("operator1")],
        schedule.timestamps,
        schedule.amounts,
        address("unlock"),
        address("reward"),
        DEFAULT_VOTING_PERIOD,
        DEFAULT_THRESHOLD,
        { value: schedule.total, gasLimit: GAS }
      )).wait();

      expect(await factory.getDeployedContractsCount()).to.equal(1n);
      const allContracts = await factory.getDeployedContracts();
      const byDeployer = await factory.getContractsByDeployer(address("funder"));
      expect(byDeployer).to.deep.equal(allContracts);

      const Gringotts = await ethers.getContractFactory("Gringotts", wallets.funder);
      const gringotts = Gringotts.attach(allContracts[0]);
      expect(await gringotts.totalAmount()).to.equal(schedule.total);
    });

    it("rejects invalid factory implementations", async function () {
      const Factory = await ethers.getContractFactory("GringottsFactory", wallets.funder);

      await expectRevert(Factory.deploy(ethers.ZeroAddress, { gasLimit: GAS }));
      await expectRevert(Factory.deploy(address("recipient"), { gasLimit: GAS }));
    });
  });
});
