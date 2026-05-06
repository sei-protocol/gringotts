const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const STAKING_PRECOMPILE = "0x0000000000000000000000000000000000001005";
const GOV_PRECOMPILE = "0x0000000000000000000000000000000000001006";
const DISTRIBUTION_PRECOMPILE = "0x0000000000000000000000000000000000001007";
const WEI_PER_USEI = 10n ** 12n;

async function installPrecompileMocks() {
  const MockStaking = await ethers.getContractFactory("MockStaking");
  const stakingImpl = await MockStaking.deploy();
  await stakingImpl.waitForDeployment();
  await ethers.provider.send("hardhat_setCode", [
    STAKING_PRECOMPILE,
    await ethers.provider.getCode(await stakingImpl.getAddress())
  ]);

  const MockGov = await ethers.getContractFactory("MockGov");
  const govImpl = await MockGov.deploy();
  await govImpl.waitForDeployment();
  await ethers.provider.send("hardhat_setCode", [
    GOV_PRECOMPILE,
    await ethers.provider.getCode(await govImpl.getAddress())
  ]);

  const MockDistribution = await ethers.getContractFactory("MockDistribution");
  const distributionImpl = await MockDistribution.deploy();
  await distributionImpl.waitForDeployment();
  await ethers.provider.send("hardhat_setCode", [
    DISTRIBUTION_PRECOMPILE,
    await ethers.provider.getCode(await distributionImpl.getAddress())
  ]);

  const distribution = MockDistribution.attach(DISTRIBUTION_PRECOMPILE);
  await distribution.fundRewards({ value: ethers.parseEther("10") });

  return {
    staking: MockStaking.attach(STAKING_PRECOMPILE),
    gov: MockGov.attach(GOV_PRECOMPILE),
    distribution
  };
}

beforeEach(async function () {
  await ethers.provider.send("hardhat_reset", []);
});

describe("Gringotts (Upgradeable)", function () {
  let admin1, admin2, admin3, admin4;
  let operator1, operator2;
  let unlockAddr, rewardAddr;
  let implementation;

  const ONE_HOUR = 3600;
  const ONE_DAY = 86400;
  const ONE_YEAR = 365 * ONE_DAY;
  const THRESHOLD_PERCENTAGE = 75;

  beforeEach(async function () {
    [, admin1, admin2, admin3, admin4, operator1, operator2, unlockAddr, rewardAddr] =
      await ethers.getSigners();

    // Deploy implementation
    const Gringotts = await ethers.getContractFactory("Gringotts");
    implementation = await Gringotts.deploy();
    await implementation.waitForDeployment();
  });

  // Helper to create small vesting schedule for tests
  async function getSmallVestingSchedule() {
    const currentTime = await time.latest();
    return {
      timestamps: [currentTime + ONE_DAY, currentTime + ONE_DAY * 2],
      amounts: [ethers.parseEther("1"), ethers.parseEther("1")],
      total: ethers.parseEther("2")
    };
  }

  async function deployProxy(options = {}) {
    const mocks = await installPrecompileMocks();
    const schedule = options.schedule || await getSmallVestingSchedule();
    const admins = options.admins || [admin1.address];
    const operators = options.operators || [operator1.address];
    const threshold = options.threshold ?? THRESHOLD_PERCENTAGE;

    const Gringotts = await ethers.getContractFactory("Gringotts");
    const initData = Gringotts.interface.encodeFunctionData("initialize", [
      admins,
      operators,
      schedule.timestamps,
      schedule.amounts,
      unlockAddr.address,
      rewardAddr.address,
      ONE_HOUR,
      threshold
    ]);

    const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const proxy = await ERC1967Proxy.deploy(await implementation.getAddress(), initData, { value: schedule.total });
    await proxy.waitForDeployment();

    return {
      gringotts: Gringotts.attach(await proxy.getAddress()),
      mocks,
      schedule
    };
  }

  describe("Implementation Deployment", function () {
    it("should deploy implementation with initializers disabled", async function () {
      // Implementation should not be initializable directly
      const { timestamps, amounts, total } = await getSmallVestingSchedule();
      
      await expect(
        implementation.initialize(
          [admin1.address],
          [operator1.address],
          timestamps,
          amounts,
          unlockAddr.address,
          rewardAddr.address,
          ONE_HOUR,
          THRESHOLD_PERCENTAGE,
          { value: total }
        )
      ).to.be.revertedWithCustomError(implementation, "InvalidInitialization");
    });
  });

  describe("Initialization Validation", function () {
    it("should initialize successfully against fixed precompile mocks", async function () {
      const { gringotts, mocks, schedule } = await deployProxy({
        admins: [admin1.address, admin2.address],
        operators: [operator1.address, operator2.address]
      });

      expect(await gringotts.totalAmount()).to.equal(schedule.total);
      expect(Array.from(await gringotts.listAdmins())).to.have.members([admin1.address, admin2.address]);
      expect(Array.from(await gringotts.listOperators())).to.have.members([operator1.address, operator2.address]);
      expect(await mocks.distribution.withdrawAddresses(await gringotts.getAddress())).to.equal(rewardAddr.address);
    });

    it("should fail with no admins", async function () {
      const { timestamps, amounts, total } = await getSmallVestingSchedule();
      const Gringotts = await ethers.getContractFactory("Gringotts");
      
      // Encode init data with no admins
      const initData = Gringotts.interface.encodeFunctionData("initialize", [
        [], // No admins
        [operator1.address],
        timestamps,
        amounts,
        unlockAddr.address,
        rewardAddr.address,
        ONE_HOUR,
        THRESHOLD_PERCENTAGE
      ]);

      const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
      await expect(
        ERC1967Proxy.deploy(await implementation.getAddress(), initData, { value: total })
      ).to.be.revertedWithCustomError(Gringotts, "NoAdmins");
    });

    it("should fail with no operators", async function () {
      const { timestamps, amounts, total } = await getSmallVestingSchedule();
      const Gringotts = await ethers.getContractFactory("Gringotts");
      
      const initData = Gringotts.interface.encodeFunctionData("initialize", [
        [admin1.address],
        [], // No operators
        timestamps,
        amounts,
        unlockAddr.address,
        rewardAddr.address,
        ONE_HOUR,
        THRESHOLD_PERCENTAGE
      ]);

      const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
      await expect(
        ERC1967Proxy.deploy(await implementation.getAddress(), initData, { value: total })
      ).to.be.revertedWithCustomError(Gringotts, "NoOperators");
    });

    it("should fail with invalid threshold", async function () {
      const { timestamps, amounts, total } = await getSmallVestingSchedule();
      const Gringotts = await ethers.getContractFactory("Gringotts");
      
      const initData = Gringotts.interface.encodeFunctionData("initialize", [
        [admin1.address],
        [operator1.address],
        timestamps,
        amounts,
        unlockAddr.address,
        rewardAddr.address,
        ONE_HOUR,
        101 // Invalid threshold > 100
      ]);

      const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
      await expect(
        ERC1967Proxy.deploy(await implementation.getAddress(), initData, { value: total })
      ).to.be.revertedWithCustomError(Gringotts, "InvalidThreshold");
    });

    it("should fail with insufficient deposit", async function () {
      const { timestamps, amounts } = await getSmallVestingSchedule();
      const Gringotts = await ethers.getContractFactory("Gringotts");
      
      const initData = Gringotts.interface.encodeFunctionData("initialize", [
        [admin1.address],
        [operator1.address],
        timestamps,
        amounts,
        unlockAddr.address,
        rewardAddr.address,
        ONE_HOUR,
        THRESHOLD_PERCENTAGE
      ]);

      const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
      await expect(
        ERC1967Proxy.deploy(await implementation.getAddress(), initData, { value: ethers.parseEther("0.5") })
      ).to.be.revertedWithCustomError(Gringotts, "InsufficientDeposit");
    });

    it("should fail with mismatched vesting arrays", async function () {
      const currentTime = await time.latest();
      const Gringotts = await ethers.getContractFactory("Gringotts");
      
      const initData = Gringotts.interface.encodeFunctionData("initialize", [
        [admin1.address],
        [operator1.address],
        [currentTime + ONE_DAY], // Only 1 timestamp
        [ethers.parseEther("1"), ethers.parseEther("1")], // 2 amounts
        unlockAddr.address,
        rewardAddr.address,
        ONE_HOUR,
        THRESHOLD_PERCENTAGE
      ]);

      const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
      await expect(
        ERC1967Proxy.deploy(await implementation.getAddress(), initData, { value: ethers.parseEther("2") })
      ).to.be.revertedWithCustomError(Gringotts, "InvalidTranche");
    });

    it("should fail with zero address for unlock distribution", async function () {
      const { timestamps, amounts, total } = await getSmallVestingSchedule();
      const Gringotts = await ethers.getContractFactory("Gringotts");
      
      const initData = Gringotts.interface.encodeFunctionData("initialize", [
        [admin1.address],
        [operator1.address],
        timestamps,
        amounts,
        ethers.ZeroAddress,
        rewardAddr.address,
        ONE_HOUR,
        THRESHOLD_PERCENTAGE
      ]);

      const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
      await expect(
        ERC1967Proxy.deploy(await implementation.getAddress(), initData, { value: total })
      ).to.be.revertedWithCustomError(Gringotts, "ZeroAddress");
    });

    it("should fail with zero address for staking reward", async function () {
      const { timestamps, amounts, total } = await getSmallVestingSchedule();
      const Gringotts = await ethers.getContractFactory("Gringotts");
      
      const initData = Gringotts.interface.encodeFunctionData("initialize", [
        [admin1.address],
        [operator1.address],
        timestamps,
        amounts,
        unlockAddr.address,
        ethers.ZeroAddress,
        ONE_HOUR,
        THRESHOLD_PERCENTAGE
      ]);

      const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
      await expect(
        ERC1967Proxy.deploy(await implementation.getAddress(), initData, { value: total })
      ).to.be.revertedWithCustomError(Gringotts, "ZeroAddress");
    });
  });

  describe("Vesting Schedule Validation", function () {
    it("should fail with empty vesting schedule", async function () {
      const Gringotts = await ethers.getContractFactory("Gringotts");
      
      const initData = Gringotts.interface.encodeFunctionData("initialize", [
        [admin1.address],
        [operator1.address],
        [],
        [],
        unlockAddr.address,
        rewardAddr.address,
        ONE_HOUR,
        THRESHOLD_PERCENTAGE
      ]);

      const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
      await expect(
        ERC1967Proxy.deploy(await implementation.getAddress(), initData, { value: 0 })
      ).to.be.revertedWithCustomError(Gringotts, "InvalidTranche");
    });

    it("should fail with zero vesting amount", async function () {
      const currentTime = await time.latest();
      const Gringotts = await ethers.getContractFactory("Gringotts");
      
      const initData = Gringotts.interface.encodeFunctionData("initialize", [
        [admin1.address],
        [operator1.address],
        [currentTime + ONE_DAY],
        [0], // Zero amount
        unlockAddr.address,
        rewardAddr.address,
        ONE_HOUR,
        THRESHOLD_PERCENTAGE
      ]);

      const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
      await expect(
        ERC1967Proxy.deploy(await implementation.getAddress(), initData, { value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(Gringotts, "InvalidTranche");
    });

    it("should fail with non-monotonic timestamps", async function () {
      const currentTime = await time.latest();
      const Gringotts = await ethers.getContractFactory("Gringotts");
      
      const initData = Gringotts.interface.encodeFunctionData("initialize", [
        [admin1.address],
        [operator1.address],
        [currentTime + ONE_DAY * 2, currentTime + ONE_DAY], // Not increasing
        [ethers.parseEther("1"), ethers.parseEther("1")],
        unlockAddr.address,
        rewardAddr.address,
        ONE_HOUR,
        THRESHOLD_PERCENTAGE
      ]);

      const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
      await expect(
        ERC1967Proxy.deploy(await implementation.getAddress(), initData, { value: ethers.parseEther("2") })
      ).to.be.revertedWithCustomError(Gringotts, "InvalidTranche");
    });

    it("should allow already-vested remaining migration tranches", async function () {
      const currentTime = await time.latest();
      const schedule = {
        timestamps: [currentTime - ONE_DAY],
        amounts: [ethers.parseEther("1")],
        total: ethers.parseEther("1")
      };

      const { gringotts } = await deployProxy({ schedule });
      expect(await gringotts.getTotalVested()).to.equal(ethers.parseEther("1"));
    });
  });

  describe("Role Enumeration", function () {
    it("should keep admin and operator lists in sync with role changes", async function () {
      const { gringotts } = await deployProxy({
        admins: [admin1.address, admin2.address],
        operators: [operator1.address],
        threshold: 50
      });

      await gringotts.connect(admin1).updateOp(operator2.address, false);
      expect(Array.from(await gringotts.listOperators())).to.have.members([operator1.address, operator2.address]);

      await gringotts.connect(admin1).updateOp(operator1.address, true);
      expect(Array.from(await gringotts.listOperators())).to.deep.equal([operator2.address]);

      await gringotts.connect(admin1).proposeUpdateAdmin(admin3.address, false);
      await gringotts.connect(admin1).processProposal(1);
      expect(Array.from(await gringotts.listAdmins())).to.have.members([admin1.address, admin2.address, admin3.address]);

      await gringotts.connect(admin1).proposeUpdateAdmin(admin2.address, true);
      await gringotts.connect(admin2).voteProposal(2);
      await gringotts.connect(admin1).processProposal(2);
      expect(Array.from(await gringotts.listAdmins())).to.have.members([admin1.address, admin3.address]);
      expect(await gringotts.isAdmin(admin2.address)).to.equal(false);
    });
  });

  describe("Staking Unit Conversion", function () {
    it("should expose a wei API and pass uSEI to redelegate and undelegate", async function () {
      const { gringotts } = await deployProxy();

      await gringotts.connect(operator1).delegate("val1", ethers.parseEther("1"));
      let delegation = await gringotts.getDelegation("val1");
      expect(delegation.balance.amount).to.equal(1_000_000n);

      await expect(gringotts.connect(operator1).redelegate("val1", "val2", ethers.parseEther("0.4")))
        .to.emit(gringotts, "Redelegated")
        .withArgs("val1", "val2", ethers.parseEther("0.4"));

      delegation = await gringotts.getDelegation("val1");
      expect(delegation.balance.amount).to.equal(600_000n);
      delegation = await gringotts.getDelegation("val2");
      expect(delegation.balance.amount).to.equal(400_000n);

      await expect(gringotts.connect(operator1).undelegate("val2", ethers.parseEther("0.25")))
        .to.emit(gringotts, "Undelegated")
        .withArgs("val2", ethers.parseEther("0.25"));

      delegation = await gringotts.getDelegation("val2");
      expect(delegation.balance.amount).to.equal(150_000n);
    });

    it("should reject staking operations below one uSEI or with fractional uSEI", async function () {
      const { gringotts } = await deployProxy();

      await expect(
        gringotts.connect(operator1).delegate("val1", WEI_PER_USEI - 1n)
      ).to.be.revertedWithCustomError(gringotts, "InvalidStakingAmount");

      await expect(
        gringotts.connect(operator1).redelegate("val1", "val2", ethers.parseEther("1") + 1n)
      ).to.be.revertedWithCustomError(gringotts, "InvalidStakingAmount");
    });

    it("should reconcile auto-withdrawn rewards while staked principal is reported in uSEI", async function () {
      const { gringotts } = await deployProxy();

      await gringotts.connect(operator1).delegate("val1", ethers.parseEther("1"));
      await admin1.sendTransaction({ to: await gringotts.getAddress(), value: ethers.parseEther("0.5") });

      await expect(gringotts.connect(operator1).initiateWithdrawReward([]))
        .to.changeEtherBalances(
          [gringotts, rewardAddr],
          [-ethers.parseEther("0.5"), ethers.parseEther("0.5")]
        );

      const info = await gringotts.getInfo();
      expect(info._withdrawnStakingRewards).to.equal(ethers.parseEther("0.5"));
    });
  });

  describe("Reward Withdrawals", function () {
    it("should skip zero and sub-uSEI rewards before calling the multi-withdraw precompile", async function () {
      const { gringotts, mocks } = await deployProxy();
      const contractAddress = await gringotts.getAddress();

      await mocks.distribution.setRewards(contractAddress, "dust", WEI_PER_USEI - 1n);
      await mocks.distribution.setRewards(contractAddress, "whole", 2n * WEI_PER_USEI + 123n);

      await expect(gringotts.connect(operator1).initiateWithdrawReward(["dust", "whole", "whole"]))
        .to.changeEtherBalance(rewardAddr, 2n * WEI_PER_USEI);

      expect(await mocks.distribution.multipleWithdrawCallCount()).to.equal(1n);
      expect(await mocks.distribution.pendingRewards(contractAddress, "dust")).to.equal(WEI_PER_USEI - 1n);
      expect(await mocks.distribution.pendingRewards(contractAddress, "whole")).to.equal(123n);

      const info = await gringotts.getInfo();
      expect(info._withdrawnStakingRewards).to.equal(2n * WEI_PER_USEI);
    });

    it("should skip single-validator withdrawals below one uSEI", async function () {
      const { gringotts, mocks } = await deployProxy();
      const contractAddress = await gringotts.getAddress();

      await mocks.distribution.setRewards(contractAddress, "dust", WEI_PER_USEI - 1n);
      await gringotts.connect(operator1).withdrawSingleValidatorReward("dust");
      expect(await mocks.distribution.singleWithdrawCallCount()).to.equal(0n);

      await mocks.distribution.setRewards(contractAddress, "whole", WEI_PER_USEI);
      await expect(gringotts.connect(operator1).withdrawSingleValidatorReward("whole"))
        .to.changeEtherBalance(rewardAddr, WEI_PER_USEI);
      expect(await mocks.distribution.singleWithdrawCallCount()).to.equal(1n);
    });

    it("should revert instead of accounting rewards when distribution returns false", async function () {
      const { gringotts, mocks } = await deployProxy();
      const contractAddress = await gringotts.getAddress();

      await mocks.distribution.setRewards(contractAddress, "val1", WEI_PER_USEI);
      await mocks.distribution.setWithdrawSuccess(false);

      await expect(
        gringotts.connect(operator1).initiateWithdrawReward(["val1"])
      ).to.be.revertedWithCustomError(gringotts, "DistributionFailed");

      await expect(
        gringotts.connect(operator1).withdrawSingleValidatorReward("val1")
      ).to.be.revertedWithCustomError(gringotts, "DistributionFailed");
    });
  });

  describe("Duplicate Address Protection", function () {
    it("should fail with duplicate admin addresses", async function () {
      const { timestamps, amounts, total } = await getSmallVestingSchedule();
      const Gringotts = await ethers.getContractFactory("Gringotts");
      
      const initData = Gringotts.interface.encodeFunctionData("initialize", [
        [admin1.address, admin1.address], // Duplicate admin
        [operator1.address],
        timestamps,
        amounts,
        unlockAddr.address,
        rewardAddr.address,
        ONE_HOUR,
        THRESHOLD_PERCENTAGE
      ]);

      const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
      await expect(
        ERC1967Proxy.deploy(await implementation.getAddress(), initData, { value: total })
      ).to.be.revertedWithCustomError(Gringotts, "DuplicateAddress");
    });

    it("should fail with duplicate operator addresses", async function () {
      const { timestamps, amounts, total } = await getSmallVestingSchedule();
      const Gringotts = await ethers.getContractFactory("Gringotts");
      
      const initData = Gringotts.interface.encodeFunctionData("initialize", [
        [admin1.address],
        [operator1.address, operator1.address], // Duplicate operator
        timestamps,
        amounts,
        unlockAddr.address,
        rewardAddr.address,
        ONE_HOUR,
        THRESHOLD_PERCENTAGE
      ]);

      const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
      await expect(
        ERC1967Proxy.deploy(await implementation.getAddress(), initData, { value: total })
      ).to.be.revertedWithCustomError(Gringotts, "DuplicateAddress");
    });
  });
});

describe("GringottsFactory (Upgradeable)", function () {
  let factory;
  let implementation;
  let admin1, operator1, unlockAddr, rewardAddr;

  beforeEach(async function () {
    [, admin1, operator1, unlockAddr, rewardAddr] = await ethers.getSigners();

    // Deploy implementation first
    const Gringotts = await ethers.getContractFactory("Gringotts");
    implementation = await Gringotts.deploy();
    await implementation.waitForDeployment();

    // Deploy factory with implementation
    const GringottsFactory = await ethers.getContractFactory("GringottsFactory");
    factory = await GringottsFactory.deploy(await implementation.getAddress());
    await factory.waitForDeployment();
  });

  it("should deploy factory with implementation address", async function () {
    expect(await factory.implementation()).to.equal(await implementation.getAddress());
    expect(await factory.getDeployedContractsCount()).to.equal(0);
  });

  it("should return empty array for deployed contracts initially", async function () {
    const contracts = await factory.getDeployedContracts();
    expect(contracts.length).to.equal(0);
  });

  it("should return empty array for contracts by deployer initially", async function () {
    const contracts = await factory.getContractsByDeployer(admin1.address);
    expect(contracts.length).to.equal(0);
  });
});

describe("Gringotts Governance Vote (Mock)", function () {
  async function deployGovernanceSubject() {
    await installPrecompileMocks();
    const [, admin1, operator1, unlockAddr, rewardAddr] = await ethers.getSigners();
    const currentTime = await time.latest();

    const Gringotts = await ethers.getContractFactory("Gringotts");
    const impl = await Gringotts.deploy();
    await impl.waitForDeployment();

    const initData = Gringotts.interface.encodeFunctionData("initialize", [
      [admin1.address],
      [operator1.address],
      [currentTime + 86400],
      [ethers.parseEther("1")],
      unlockAddr.address,
      rewardAddr.address,
      3600,
      75
    ]);

    const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const proxy = await ERC1967Proxy.deploy(await impl.getAddress(), initData, { value: ethers.parseEther("1") });
    await proxy.waitForDeployment();

    return {
      gringotts: Gringotts.attach(await proxy.getAddress()),
      admin1
    };
  }

  it("should create a GovVote proposal with valid vote option", async function () {
    const { gringotts, admin1 } = await deployGovernanceSubject();

    await expect(gringotts.connect(admin1).proposeGovVote(1, 1))
      .to.emit(gringotts, "GovVoteProposed")
      .withArgs(1, 1, 1);

    const voteData = await gringotts.govVoteData(1);
    expect(voteData.govProposalId).to.equal(1n);
    expect(voteData.voteOption).to.equal(1);
  });

  it("should reject invalid vote options (< 1)", async function () {
    const { gringotts, admin1 } = await deployGovernanceSubject();

    await expect(
      gringotts.connect(admin1).proposeGovVote(1, 0)
    ).to.be.revertedWithCustomError(gringotts, "InvalidVoteOption");
  });

  it("should reject invalid vote options (> 4)", async function () {
    const { gringotts, admin1 } = await deployGovernanceSubject();

    await expect(
      gringotts.connect(admin1).proposeGovVote(1, 5)
    ).to.be.revertedWithCustomError(gringotts, "InvalidVoteOption");
  });
});
