#!/bin/bash
# Export CosmWasm Gringotts contract state for migration to Solidity
#
# Usage: ./export-cosmwasm.sh <contract_address> [--node <rpc_url>] [--output <file>]
#
# Prerequisites:
# - seid CLI installed and configured
# - jq installed for JSON processing

set -e

# Default values
NODE_URL="https://rpc.sei-apis.com"
OUTPUT_FILE="gringotts-export.json"

# Parse arguments
CONTRACT_ADDRESS=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --node)
            NODE_URL="$2"
            shift 2
            ;;
        --output)
            OUTPUT_FILE="$2"
            shift 2
            ;;
        *)
            if [ -z "$CONTRACT_ADDRESS" ]; then
                CONTRACT_ADDRESS="$1"
            fi
            shift
            ;;
    esac
done

if [ -z "$CONTRACT_ADDRESS" ]; then
    echo "Usage: ./export-cosmwasm.sh <contract_address> [--node <rpc_url>] [--output <file>]"
    echo ""
    echo "Example:"
    echo "  ./export-cosmwasm.sh sei1abc...xyz --node https://rpc.sei-apis.com --output export.json"
    exit 1
fi

echo "Exporting Gringotts state from CosmWasm contract..."
echo "Contract: $CONTRACT_ADDRESS"
echo "Node: $NODE_URL"
echo ""

# Query functions
query_contract() {
    local query="$1"
    seid query wasm contract-state smart "$CONTRACT_ADDRESS" "$query" --node "$NODE_URL" --output json 2>/dev/null
}

echo "Querying contract info..."
INFO=$(query_contract '{"info":{}}')

echo "Querying contract config..."
CONFIG=$(query_contract '{"config":{}}')

echo "Querying admin list..."
ADMINS=$(query_contract '{"list_admins":{}}')

echo "Querying operator list..."
OPS=$(query_contract '{"list_ops":{}}')

echo "Querying total vested amount..."
VESTED=$(query_contract '{"total_vested":{}}')

# Extract and format data
echo ""
echo "Processing exported data..."

# Create the export JSON
cat > "$OUTPUT_FILE" << EOF
{
  "exportedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "sourceContract": "$CONTRACT_ADDRESS",
  "sourceChain": "sei",
  "nodeUrl": "$NODE_URL",
  "contractState": {
    "info": $(echo "$INFO" | jq '.data'),
    "config": $(echo "$CONFIG" | jq '.data'),
    "admins": $(echo "$ADMINS" | jq '.data.admins'),
    "operators": $(echo "$OPS" | jq '.data.ops'),
    "totalVested": $(echo "$VESTED" | jq '.data.vested_amount')
  }
}
EOF

echo ""
echo "Export complete! Data saved to: $OUTPUT_FILE"
echo ""
echo "Summary:"
echo "  - Admins: $(echo "$ADMINS" | jq '.data.admins | length')"
echo "  - Operators: $(echo "$OPS" | jq '.data.ops | length')"
echo "  - Vesting tranches: $(echo "$INFO" | jq '.data.vesting_timestamps | length')"
echo ""
echo "Next steps:"
echo "  1. Review the exported data in $OUTPUT_FILE"
echo "  2. Convert Sei addresses (sei1...) to EVM addresses (0x...)"
echo "  3. Run: npx hardhat run scripts/migration/deploy-from-export.js --network sei"
