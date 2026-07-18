param(
  [switch]$ApprovedToSign
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Workspace = "E:\Hackathons\World-Cup"
$OfficialRepo = Join-Path $Workspace "txodds-official"
$StatePath = Join-Path $Workspace ".local\txodds-subscription-state.json"
$EnvLocalPath = Join-Path $Workspace ".env.local"
$Rpc = "https://api.devnet.solana.com"
$ApiOrigin = "https://txline-dev.txodds.com"
$ProgramId = "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"
$TokenMint = "4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG"

function Fail($Message) {
  Write-Error $Message
  exit 1
}

Set-Location $Workspace
$SolanaBin = Join-Path $env:USERPROFILE ".local\share\solana\install\active_release\bin"
if (Test-Path -LiteralPath (Join-Path $SolanaBin "solana.exe")) {
  $env:PATH = "$SolanaBin;$env:PATH"
}

if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { Fail "Subscription state missing: $StatePath" }
$state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
if ($state.network -ne "devnet") { Fail "Subscription state is not devnet." }

$config = solana config get | Out-String
$walletLine = ($config -split "`r?`n" | Where-Object { $_ -match "^Keypair Path:" } | Select-Object -First 1)
if (-not $walletLine) { Fail "Could not read Solana keypair path from config." }
$walletPath = ($walletLine -replace "^Keypair Path:\s*", "").Trim()
if (-not (Test-Path -LiteralPath $walletPath -PathType Leaf)) { Fail "Configured wallet file does not exist." }

$publicAddress = (solana address | Out-String).Trim()
if ($publicAddress -ne $state.publicWalletAddress) { Fail "Configured wallet does not match subscription state." }

Write-Output "TxODDS API activation summary"
Write-Output "Public wallet address: $publicAddress"
Write-Output "Network: devnet"
Write-Output "Subscription transaction: $($state.transactionSignature)"
Write-Output "Selected leagues: []"
Write-Output "API origin: $ApiOrigin"
Write-Output "Program ID: $ProgramId"
Write-Output "Mainnet values present: No"
Write-Output "This step will request a guest JWT and prepare the activation message."
Write-Output "It will not sign unless -ApprovedToSign is supplied."

$env:ANCHOR_PROVIDER_URL = $Rpc
$env:ANCHOR_WALLET = $walletPath
$env:TOKEN_MINT_ADDRESS = $TokenMint
$env:TXODDS_SUBSCRIPTION_STATE_PATH = $StatePath
$env:TXODDS_ENV_LOCAL_PATH = $EnvLocalPath
$env:NODE_PATH = Join-Path $OfficialRepo "node_modules"

if ($ApprovedToSign) {
  $env:APPROVE_TXODDS_API_ACTIVATION_SIGNATURE = "YES"
} else {
  Remove-Item Env:\APPROVE_TXODDS_API_ACTIVATION_SIGNATURE -ErrorAction SilentlyContinue
}

node.exe (Join-Path $Workspace "scripts\txodds\src\activate-api-devnet.cjs")
if ($LASTEXITCODE -eq 10) { exit 10 }
if ($LASTEXITCODE -ne 0) { Fail "Activation helper failed with exit code $LASTEXITCODE." }
