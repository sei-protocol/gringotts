const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

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

    it("should fail with timestamp in the past", async function () {
      const currentTime = await time.latest();
      const Gringotts = await ethers.getContractFactory("Gringotts");
      
      const initData = Gringotts.interface.encodeFunctionData("initialize", [
        [admin1.address],
        [operator1.address],
        [currentTime - ONE_DAY], // In the past
        [ethers.parseEther("1")],
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

  // Note: Full Gringotts deployment tests require Sei precompiles
  // These would pass on Sei testnet/mainnet but fail on local Hardhat
  // because the distribution precompile at 0x1007 doesn't exist
  describe("Deployment on Sei (requires precompiles)", function () {
    it.skip("should deploy new upgradeable Gringotts proxy", async function () {
      // This test would work on Sei but fails locally due to missing precompiles
      const currentTime = await time.latest();
      const vestingTimestamps = [currentTime + 86400];
      const vestingAmounts = [ethers.parseEther("1")];
      const totalAmount = ethers.parseEther("1");

      const tx = await factory.createGringotts(
        [admin1.address],
        [operator1.address],
        vestingTimestamps,
        vestingAmounts,
        unlockAddr.address,
        rewardAddr.address,
        3600,
        75,
        { value: totalAmount }
      );

      const receipt = await tx.wait();
      expect(await factory.getDeployedContractsCount()).to.equal(1);
    });
  });
});

// Integration tests that would run on Sei network
describe("Gringotts Integration (Sei Network)", function () {
  it.skip("should deploy and configure correctly on Sei", async function () {
    // These tests require actual Sei network with precompiles
    // Run with: npx hardhat test --network sei-testnet
  });

  it.skip("should delegate to validators", async function () {
    // Requires Sei network
  });

  it.skip("should withdraw staking rewards", async function () {
    // Requires Sei network
  });

  it.skip("should upgrade contract through multi-sig proposal", async function () {
    // Requires Sei network and demonstrates upgrade flow:
    // 1. Deploy new implementation (GringottsV2)
    // 2. Admin calls proposeUpgrade(newImplementation)
    // 3. Other admins vote via voteProposal(proposalId)
    // 4. Once threshold reached, admin calls processProposal(proposalId)
    // 5. Contract is upgraded, state is preserved
  });
});
