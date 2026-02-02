/**
 * Deploy Solidity Gringotts from exported CosmWasm state
 * 
 * Usage:
 *   npx hardhat run scripts/migration/deploy-from-export.js --network sei
 * 
 * Environment variables:
 *   EXPORT_FILE     - Path to export JSON file (default: gringotts-export.json)
 *   ADDRESS_MAP     - Path to address mapping JSON file (optional)
 *   DRY_RUN         - Set to "true" to simulate without deploying
 */

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// Load export file
function loadExportFile() {
  const exportPath = process.env.EXPORT_FILE || 'gringotts-export.json';
  const fullPath = path.resolve(exportPath);
  
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Export file not found: ${fullPath}\nRun export-cosmwasm.js first.`);
  }
  
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

// Load address mapping (sei1... -> 0x...)
function loadAddressMapping() {
  const mapPath = process.env.ADDRESS_MAP;
  if (!mapPath) return null;
  
  const fullPath = path.resolve(mapPath);
  if (!fs.existsSync(fullPath)) {
    console.warn(`Address mapping file not found: ${fullPath}`);
    return null;
  }
  
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

// Convert Sei address to EVM address using mapping
function convertAddress(seiAddress, addressMap) {
  if (!seiAddress) return null;
  
  // If already an EVM address, return as-is
  if (seiAddress.startsWith('0x')) {
    return seiAddress;
  }
  
  // Look up in address map
  if (addressMap && addressMap[seiAddress]) {
    return addressMap[seiAddress];
  }
  
  return null;
}

// Validate all addresses are converted
function validateAddresses(data, addressMap) {
  const unconverted = [];
  
  const checkAddress = (addr, name) => {
    if (!addr) return;
    if (addr.startsWith('sei1')) {
      const converted = convertAddress(addr, addressMap);
      if (!converted) {
        unconverted.push({ name, address: addr });
      }
    }
  };
  
  // Check all addresses
  data.admins.forEach((addr, i) => checkAddress(addr, `admin[${i}]`));
  data.operators.forEach((addr, i) => checkAddress(addr, `operator[${i}]`));
  checkAddress(data.unlockDistributionAddress, 'unlockDistributionAddress');
  checkAddress(data.stakingRewardAddress, 'stakingRewardAddress');
  
  return unconverted;
}

async function main() {
  const isDryRun = process.env.DRY_RUN === 'true';
  
  console.log('='.repeat(60));
  console.log('Gringotts Migration: CosmWasm -> Solidity');
  console.log('='.repeat(60));
  console.log('');
  
  if (isDryRun) {
    console.log('*** DRY RUN MODE - No actual deployment ***\n');
  }
  
  // Load export data
  console.log('Loading export file...');
  const exportData = loadExportFile();
  console.log(`  Source contract: ${exportData.sourceContract}`);
  console.log(`  Exported at: ${exportData.exportedAt}`);
  console.log('');
  
  // Load address mapping
  console.log('Loading address mapping...');
  const addressMap = loadAddressMapping();
  if (addressMap) {
    console.log(`  Loaded ${Object.keys(addressMap).length} address mappings`);
  } else {
    console.log('  No address mapping file provided');
    console.log('  Expecting addresses to already be in EVM format (0x...)');
  }
  console.log('');
  
  // Get Solidity deployment params
  const solData = exportData.solidity;
  
  // Validate addresses
  console.log('Validating addresses...');
  const unconverted = validateAddresses(solData, addressMap);
  if (unconverted.length > 0) {
    console.error('\nERROR: The following addresses need to be converted to EVM format:');
    unconverted.forEach(({ name, address }) => {
      console.error(`  ${name}: ${address}`);
    });
    console.error('\nTo convert addresses, use:');
    console.error('  seid q evm sei-addr <sei_address>');
    console.error('\nThen create an address mapping file (JSON) with format:');
    console.error('  { "sei1...": "0x...", ... }');
    console.error('\nAnd set ADDRESS_MAP environment variable to the file path.');
    process.exit(1);
  }
  console.log('  All addresses validated');
  console.log('');
  
  // Convert addresses if needed
  const admins = solData.admins.map(addr => convertAddress(addr, addressMap) || addr);
  const operators = solData.operators.map(addr => convertAddress(addr, addressMap) || addr);
  const unlockDistributionAddress = convertAddress(solData.unlockDistributionAddress, addressMap) || solData.unlockDistributionAddress;
  const stakingRewardAddress = convertAddress(solData.stakingRewardAddress, addressMap) || solData.stakingRewardAddress;
  
  // Display deployment parameters
  console.log('Deployment Parameters:');
  console.log('-'.repeat(40));
  console.log(`Admins (${admins.length}):`);
  admins.forEach((addr, i) => console.log(`  [${i}] ${addr}`));
  console.log(`Operators (${operators.length}):`);
  operators.forEach((addr, i) => console.log(`  [${i}] ${addr}`));
  console.log(`Unlock Distribution Address: ${unlockDistributionAddress}`);
  console.log(`Staking Reward Address: ${stakingRewardAddress}`);
  console.log(`Vesting Tranches: ${solData.vestingTimestamps.length}`);
  console.log(`Max Voting Period: ${solData.maxVotingPeriod} seconds`);
  console.log(`Voting Threshold: ${solData.adminVotingThresholdPercentage}%`);
  console.log(`Total Amount: ${ethers.formatEther(solData.totalAmount)} SEI`);
  console.log('');
  
  // Show vesting schedule summary
  console.log('Vesting Schedule:');
  console.log('-'.repeat(40));
  const now = Math.floor(Date.now() / 1000);
  let totalVested = BigInt(0);
  let totalUnvested = BigInt(0);
  
  solData.vestingTimestamps.forEach((ts, i) => {
    const amount = BigInt(solData.vestingAmounts[i]);
    const date = new Date(ts * 1000).toISOString().split('T')[0];
    const status = ts <= now ? '✓ vested' : '○ pending';
    
    if (ts <= now) {
      totalVested += amount;
    } else {
      totalUnvested += amount;
    }
    
    if (i < 5 || i >= solData.vestingTimestamps.length - 2) {
      console.log(`  [${i}] ${date}: ${ethers.formatEther(amount)} SEI ${status}`);
    } else if (i === 5) {
      console.log(`  ... (${solData.vestingTimestamps.length - 7} more tranches) ...`);
    }
  });
  console.log('');
  console.log(`  Total vested: ${ethers.formatEther(totalVested)} SEI`);
  console.log(`  Total unvested: ${ethers.formatEther(totalUnvested)} SEI`);
  console.log('');
  
  // Migration notes
  if (solData.withdrawnUnlocked !== '0' || solData.withdrawnLocked !== '0') {
    console.log('IMPORTANT - Previous Withdrawals:');
    console.log('-'.repeat(40));
    console.log(`  Withdrawn Unlocked: ${ethers.formatEther(solData.withdrawnUnlocked)} SEI`);
    console.log(`  Withdrawn Locked: ${ethers.formatEther(solData.withdrawnLocked)} SEI`);
    console.log(`  Withdrawn Rewards: ${ethers.formatEther(solData.withdrawnStakingRewards)} SEI`);
    console.log('');
    console.log('  The vesting schedule in the export reflects remaining amounts.');
    console.log('  Fund the new contract with the remaining principal only.');
    console.log('');
  }
  
  if (isDryRun) {
    console.log('DRY RUN COMPLETE - No deployment performed');
    console.log('');
    console.log('To deploy, run without DRY_RUN:');
    console.log('  npx hardhat run scripts/migration/deploy-from-export.js --network sei');
    return;
  }
  
  // Get deployer
  const [deployer] = await ethers.getSigners();
  console.log('Deployer:', deployer.address);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log('Balance:', ethers.formatEther(balance), 'SEI');
  console.log('');
  
  // Check balance
  const totalRequired = BigInt(solData.totalAmount);
  if (balance < totalRequired) {
    console.error(`ERROR: Insufficient balance`);
    console.error(`  Required: ${ethers.formatEther(totalRequired)} SEI`);
    console.error(`  Available: ${ethers.formatEther(balance)} SEI`);
    process.exit(1);
  }
  
  // Deploy implementation
  console.log('Deploying Gringotts implementation...');
  const Gringotts = await ethers.getContractFactory("Gringotts");
  const implementation = await Gringotts.deploy();
  await implementation.waitForDeployment();
  const implementationAddress = await implementation.getAddress();
  console.log(`Implementation deployed to: ${implementationAddress}`);
  console.log('');

  // Deploy proxy
  console.log('Deploying Gringotts proxy...');
  
  // Encode initialization data
  const initData = Gringotts.interface.encodeFunctionData("initialize", [
    admins,
    operators,
    solData.vestingTimestamps,
    solData.vestingAmounts,
    unlockDistributionAddress,
    stakingRewardAddress,
    solData.maxVotingPeriod,
    solData.adminVotingThresholdPercentage
  ]);

  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const proxy = await ERC1967Proxy.deploy(implementationAddress, initData, { value: totalRequired });
  await proxy.waitForDeployment();
  const contractAddress = await proxy.getAddress();
  
  console.log('='.repeat(60));
  console.log('DEPLOYMENT SUCCESSFUL');
  console.log('='.repeat(60));
  console.log('');
  console.log(`Contract Address: ${contractAddress}`);
  console.log('');
  console.log('Verification:');
  console.log(`  npx hardhat verify --network sei ${contractAddress} \\`);
  console.log(`    '${JSON.stringify(admins)}' \\`);
  console.log(`    '${JSON.stringify(operators)}' \\`);
  console.log(`    '${JSON.stringify(solData.vestingTimestamps)}' \\`);
  console.log(`    '${JSON.stringify(solData.vestingAmounts)}' \\`);
  console.log(`    '${unlockDistributionAddress}' \\`);
  console.log(`    '${stakingRewardAddress}' \\`);
  console.log(`    ${solData.maxVotingPeriod} \\`);
  console.log(`    ${solData.adminVotingThresholdPercentage}`);
  console.log('');
  
  // Save deployment info
  const deploymentInfo = {
    deployedAt: new Date().toISOString(),
    network: (await ethers.provider.getNetwork()).name,
    proxyAddress: contractAddress,
    implementationAddress,
    deployer: deployer.address,
    sourceContract: exportData.sourceContract,
    upgradeable: true,
    params: {
      admins,
      operators,
      vestingTimestamps: solData.vestingTimestamps,
      vestingAmounts: solData.vestingAmounts,
      unlockDistributionAddress,
      stakingRewardAddress,
      maxVotingPeriod: solData.maxVotingPeriod,
      adminVotingThresholdPercentage: solData.adminVotingThresholdPercentage,
      totalAmount: solData.totalAmount
    }
  };
  
  const deploymentFile = `deployment-${Date.now()}.json`;
  fs.writeFileSync(deploymentFile, JSON.stringify(deploymentInfo, null, 2));
  console.log(`Deployment info saved to: ${deploymentFile}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
