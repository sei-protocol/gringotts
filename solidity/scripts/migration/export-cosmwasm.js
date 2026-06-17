/**
 * Export CosmWasm Gringotts contract state for migration to Solidity
 * 
 * Usage:
 *   node export-cosmwasm.js <contract_address> [options]
 * 
 * Options:
 *   --rpc <url>     RPC endpoint (default: https://rpc.sei-apis.com)
 *   --output <file> Output file (default: gringotts-export.json)
 * 
 * Example:
 *   node export-cosmwasm.js sei1abc...xyz --rpc https://rpc.sei-apis.com
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    contractAddress: null,
    rpcUrl: 'https://rpc.sei-apis.com',
    outputFile: 'gringotts-export.json'
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--rpc' && args[i + 1]) {
      config.rpcUrl = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      config.outputFile = args[++i];
    } else if (!args[i].startsWith('--')) {
      config.contractAddress = args[i];
    }
  }

  return config;
}

// Make HTTP request
function httpRequest(url, options, body = null) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https');
    const lib = isHttps ? https : http;
    
    const req = lib.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Query CosmWasm contract
async function queryContract(rpcUrl, contractAddress, queryMsg) {
  const queryBase64 = Buffer.from(JSON.stringify(queryMsg)).toString('base64');
  const url = `${rpcUrl}/cosmwasm/wasm/v1/contract/${contractAddress}/smart/${queryBase64}`;
  
  const response = await httpRequest(url, { method: 'GET' });
  
  if (response.data) {
    return response.data;
  }
  throw new Error(`Query failed: ${JSON.stringify(response)}`);
}

// Convert nanoseconds timestamp to seconds
function nanoToSeconds(nanoTimestamp) {
  // CosmWasm timestamps are in nanoseconds, Solidity uses seconds
  return Math.floor(parseInt(nanoTimestamp) / 1_000_000_000);
}

// Convert usei (micro) to wei (10^18)
// usei = 10^-6 SEI, wei = 10^-18 SEI
// So 1 usei = 10^12 wei
function useiToWei(useiAmount) {
  const amount = BigInt(useiAmount);
  return (amount * BigInt(10 ** 12)).toString();
}

async function main() {
  const config = parseArgs();

  if (!config.contractAddress) {
    console.log(`
Export CosmWasm Gringotts contract state for migration to Solidity

Usage:
  node export-cosmwasm.js <contract_address> [options]

Options:
  --rpc <url>     RPC endpoint (default: https://rpc.sei-apis.com)
  --output <file> Output file (default: gringotts-export.json)

Example:
  node export-cosmwasm.js sei1abc...xyz --rpc https://rpc.sei-apis.com
`);
    process.exit(1);
  }

  console.log('Exporting Gringotts state from CosmWasm contract...');
  console.log(`Contract: ${config.contractAddress}`);
  console.log(`RPC: ${config.rpcUrl}`);
  console.log('');

  try {
    // Query all contract state
    console.log('Querying contract info...');
    const info = await queryContract(config.rpcUrl, config.contractAddress, { info: {} });

    console.log('Querying contract config...');
    const configData = await queryContract(config.rpcUrl, config.contractAddress, { config: {} });

    console.log('Querying admin list...');
    const admins = await queryContract(config.rpcUrl, config.contractAddress, { list_admins: {} });

    console.log('Querying operator list...');
    const ops = await queryContract(config.rpcUrl, config.contractAddress, { list_ops: {} });

    console.log('Querying total vested...');
    const vested = await queryContract(config.rpcUrl, config.contractAddress, { total_vested: {} });

    // Process and convert data for Solidity deployment
    console.log('\nProcessing exported data...');

    // Convert timestamps from nanoseconds to seconds
    const vestingTimestamps = info.vesting_timestamps.map(ts => nanoToSeconds(ts));
    
    // Convert amounts from usei to wei
    const vestingAmounts = info.vesting_amounts.map(amt => useiToWei(amt));

    // Parse voting threshold from cw_utils::Threshold
    // Threshold can be: AbsoluteCount, AbsolutePercentage, or ThresholdQuorum
    let thresholdPercentage = 75; // Default
    if (configData.admin_voting_threshold) {
      const threshold = configData.admin_voting_threshold;
      if (threshold.absolute_percentage) {
        // Format: { absolute_percentage: { percentage: "0.75" } }
        thresholdPercentage = Math.round(parseFloat(threshold.absolute_percentage.percentage) * 100);
      } else if (threshold.threshold_quorum) {
        // Format: { threshold_quorum: { threshold: "0.75", quorum: "0.5" } }
        thresholdPercentage = Math.round(parseFloat(threshold.threshold_quorum.threshold) * 100);
      }
    }

    // Parse voting period from cw_utils::Duration
    // Duration can be: Height(u64) or Time(u64) in seconds
    let maxVotingPeriodSeconds = 86400; // Default 1 day
    if (configData.max_voting_period) {
      const period = configData.max_voting_period;
      if (period.time) {
        maxVotingPeriodSeconds = parseInt(period.time);
      } else if (period.height) {
        // Approximate: ~6 seconds per block on Sei
        maxVotingPeriodSeconds = parseInt(period.height) * 6;
      }
    }

    // Create export object
    const exportData = {
      exportedAt: new Date().toISOString(),
      sourceContract: config.contractAddress,
      sourceChain: 'sei-cosmwasm',
      rpcUrl: config.rpcUrl,
      
      // Raw data from CosmWasm (for reference)
      raw: {
        info,
        config: configData,
        admins: admins.admins,
        operators: ops.ops,
        totalVested: vested.vested_amount
      },

      // Converted data for Solidity deployment
      // NOTE: Sei addresses (sei1...) need to be converted to EVM addresses (0x...)
      // Use seid CLI: seid q evm sei-addr <sei_address>
      solidity: {
        // These need manual conversion from sei1... to 0x...
        admins: admins.admins,
        operators: ops.ops,
        unlockDistributionAddress: info.unlock_distribution_address,
        stakingRewardAddress: info.staking_reward_address,
        
        // Already converted to Solidity-compatible format
        vestingTimestamps,
        vestingAmounts,
        maxVotingPeriod: maxVotingPeriodSeconds,
        adminVotingThresholdPercentage: thresholdPercentage,
        
        // Withdrawal state (for reference during migration)
        withdrawnStakingRewards: useiToWei(info.withdrawn_staking_rewards || '0'),
        withdrawnUnlocked: useiToWei(info.withdrawn_unlocked || '0'),
        withdrawnLocked: useiToWei(info.withdrawn_locked || '0'),
        
        // Total amount in wei
        totalAmount: vestingAmounts.reduce((a, b) => (BigInt(a) + BigInt(b)).toString(), '0')
      },

      // Migration notes
      migrationNotes: [
        'IMPORTANT: Convert all sei1... addresses to 0x... EVM addresses before deployment',
        'Use: seid q evm sei-addr <sei_address> to convert addresses',
        'Verify the vesting schedule matches the current remaining contract state',
        'Already-vested remaining tranches are preserved and should be immediately withdrawable after deployment',
        'The new contract must be funded with totalAmount, the exported remaining principal'
      ]
    };

    // Write to file
    const outputPath = path.resolve(config.outputFile);
    fs.writeFileSync(outputPath, JSON.stringify(exportData, null, 2));

    console.log('');
    console.log(`Export complete! Data saved to: ${outputPath}`);
    console.log('');
    console.log('Summary:');
    console.log(`  - Admins: ${admins.admins.length}`);
    console.log(`  - Operators: ${ops.ops.length}`);
    console.log(`  - Vesting tranches: ${vestingTimestamps.length}`);
    console.log(`  - Total amount: ${exportData.solidity.totalAmount} wei`);
    console.log(`  - Voting period: ${maxVotingPeriodSeconds} seconds`);
    console.log(`  - Threshold: ${thresholdPercentage}%`);
    console.log('');
    console.log('Next steps:');
    console.log('  1. Review the exported data');
    console.log('  2. Convert Sei addresses to EVM addresses:');
    console.log('     seid q evm sei-addr <sei_address>');
    console.log('  3. Update the addresses in the export file or migration config');
    console.log('  4. Run: npx hardhat run scripts/migration/deploy-from-export.js --network sei');

  } catch (error) {
    console.error('Error exporting contract state:', error.message);
    process.exit(1);
  }
}

main();
