param(
  [switch]$Approved
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Workspace = "E:\Hackathons\World-Cup"
$OfficialRepo = Join-Path $Workspace "txodds-official"
$StatePath = Join-Path $Workspace ".local\txodds-subscription-state.json"
$Rpc = "https://api.devnet.solana.com"
$ApiOrigin = "https://txline-dev.txodds.com"
$ProgramId = "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"
$TokenMint = "4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG"
$ExpectedWallet = "2kQfybpNCcnwzomeovJiAFCtFA77LK74JR58st6TSTxs"

function Fail($Message) {
  Write-Error $Message
  exit 1
}

function Refuse-Mainnet($Name, $Value) {
  if ($Value -match "mainnet|mainnet-beta|txline\.txodds\.com|9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA|Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL") {
    Fail "$Name contains a mainnet value; refusing to continue."
  }
}

Set-Location $Workspace
$SolanaBin = Join-Path $env:USERPROFILE ".local\share\solana\install\active_release\bin"
if (Test-Path -LiteralPath (Join-Path $SolanaBin "solana.exe")) {
  $env:PATH = "$SolanaBin;$env:PATH"
}

$solana = Get-Command solana -ErrorAction SilentlyContinue
if (-not $solana) { Fail "solana CLI was not found." }
if (-not (Test-Path -LiteralPath $OfficialRepo -PathType Container)) { Fail "Official TxODDS repo missing: $OfficialRepo" }

$config = solana config get | Out-String
$rpcLine = ($config -split "`r?`n" | Where-Object { $_ -match "^RPC URL:" } | Select-Object -First 1)
$walletLine = ($config -split "`r?`n" | Where-Object { $_ -match "^Keypair Path:" } | Select-Object -First 1)
if (-not $rpcLine) { Fail "Could not read Solana RPC from config." }
if (-not $walletLine) { Fail "Could not read Solana keypair path from config." }
$configuredRpc = ($rpcLine -replace "^RPC URL:\s*", "").Trim()
$walletPath = ($walletLine -replace "^Keypair Path:\s*", "").Trim()

Refuse-Mainnet "RPC" $configuredRpc
Refuse-Mainnet "API origin" $ApiOrigin
Refuse-Mainnet "Program ID" $ProgramId
Refuse-Mainnet "Token mint" $TokenMint
if ($configuredRpc -ne $Rpc) { Fail "Configured Solana RPC is '$configuredRpc', expected '$Rpc'." }
if (-not (Test-Path -LiteralPath $walletPath -PathType Leaf)) { Fail "Configured wallet file does not exist." }

$publicAddress = (solana address | Out-String).Trim()
if ($publicAddress -ne $ExpectedWallet) { Fail "Configured public wallet '$publicAddress' does not match expected '$ExpectedWallet'." }
$balanceOutput = (solana balance --url devnet | Out-String).Trim()
if ($balanceOutput -notmatch "^([0-9]+(\.[0-9]+)?)\s+SOL$") { Fail "Could not parse devnet balance: $balanceOutput" }
$balanceSol = [decimal]$Matches[1]
if ($balanceSol -le 0) { Fail "Wallet has zero devnet SOL." }

Write-Output "TxODDS devnet subscription transaction summary"
Write-Output "Public wallet address: $publicAddress"
Write-Output "Devnet balance: $balanceOutput"
Write-Output "Network: devnet"
Write-Output "RPC: $Rpc"
Write-Output "API origin: $ApiOrigin"
Write-Output "Program ID: $ProgramId"
Write-Output "TxL mint: $TokenMint"
Write-Output "Service level: 1"
Write-Output "Duration: 4 weeks"
Write-Output "Selected leagues: []"
Write-Output "Requires TxL payment: No"
Write-Output "Expected transaction purpose: register free service-level-1 TxLINE subscription on Solana devnet."
Write-Output "State output: $StatePath"

if (-not $Approved) {
  Fail "Approval flag missing. Re-run with -Approved only after explicit approval."
}

$env:ANCHOR_PROVIDER_URL = $Rpc
$env:ANCHOR_WALLET = $walletPath
$env:TOKEN_MINT_ADDRESS = $TokenMint
$env:APPROVE_TXODDS_DEVNET_SUBSCRIPTION = "YES"
$env:TXODDS_OFFICIAL_REPO = $OfficialRepo
$env:TXODDS_SUBSCRIPTION_STATE_PATH = $StatePath
$env:NODE_PATH = Join-Path $OfficialRepo "node_modules"

node.exe (Join-Path $Workspace "scripts\txodds\src\subscribe-devnet.cjs")
if ($LASTEXITCODE -ne 0) { Fail "Subscription helper failed with exit code $LASTEXITCODE." }
