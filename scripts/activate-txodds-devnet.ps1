Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ExpectedRpc = "https://api.devnet.solana.com"
$ExpectedApiOrigin = "https://txline-dev.txodds.com"
$ExpectedApiBase = "$ExpectedApiOrigin/api"
$ExpectedProgramId = "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"
$ExpectedTokenMint = "4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG"
$ServiceLevel = 1
$DurationWeeks = 4
$SelectedLeagues = "[]"
$RepoRoot = "E:\Hackathons\World-Cup\txodds-official"
$OfficialScript = "examples/devnet/scripts/subscription_free_tier.ts"

function Fail($Message) {
  Write-Error $Message
  exit 1
}

function Mask-Secret($Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
  if ($Value.Length -le 12) { return "<masked>" }
  return "$($Value.Substring(0, 6))...$($Value.Substring($Value.Length - 4))"
}

function Require-NoMainnet($Name, $Value) {
  if ($Value -match "mainnet|mainnet-beta|txline\.txodds\.com|9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA|Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL") {
    Fail "$Name contains a mainnet value; refusing to continue."
  }
}

$SolanaBin = Join-Path $env:USERPROFILE ".local\share\solana\install\active_release\bin"
if (Test-Path -LiteralPath (Join-Path $SolanaBin "solana.exe")) {
  $env:PATH = "$SolanaBin;$env:PATH"
}

$solanaCommand = Get-Command solana -ErrorAction SilentlyContinue
if (-not $solanaCommand) {
  Fail "solana CLI was not found. Install it or add it to PATH before activation."
}

if (-not (Test-Path -LiteralPath $RepoRoot -PathType Container)) {
  Fail "Official TxODDS repository not found at $RepoRoot"
}

$configText = solana config get | Out-String
$rpcLine = ($configText -split "`r?`n" | Where-Object { $_ -match "^RPC URL:" } | Select-Object -First 1)
$keypairLine = ($configText -split "`r?`n" | Where-Object { $_ -match "^Keypair Path:" } | Select-Object -First 1)
if (-not $rpcLine) { Fail "Could not detect Solana RPC URL from solana config get." }
if (-not $keypairLine) { Fail "Could not detect Solana keypair path from solana config get." }

$rpcUrl = ($rpcLine -replace "^RPC URL:\s*", "").Trim()
$walletPath = ($keypairLine -replace "^Keypair Path:\s*", "").Trim()

Require-NoMainnet "Solana RPC URL" $rpcUrl
Require-NoMainnet "TxLINE API origin" $ExpectedApiOrigin
Require-NoMainnet "TxLINE API base" $ExpectedApiBase
Require-NoMainnet "TxLINE program ID" $ExpectedProgramId
Require-NoMainnet "TxL token mint" $ExpectedTokenMint

if ($rpcUrl -ne $ExpectedRpc) {
  Fail "Configured Solana RPC is '$rpcUrl', expected '$ExpectedRpc'. Refusing to continue."
}

if (-not (Test-Path -LiteralPath $walletPath -PathType Leaf)) {
  Fail "Configured wallet file does not exist: $walletPath"
}

$publicAddress = (solana address | Out-String).Trim()
if ([string]::IsNullOrWhiteSpace($publicAddress)) {
  Fail "Could not determine public wallet address."
}

$balanceOutput = (solana balance --url devnet | Out-String).Trim()
if ($balanceOutput -notmatch "^([0-9]+(\.[0-9]+)?)\s+SOL$") {
  Fail "Could not parse devnet balance from output: $balanceOutput"
}
$balanceSol = [decimal]$Matches[1]

Write-Output "TxODDS TxLINE devnet activation preflight"
Write-Output "Public wallet address: $publicAddress"
Write-Output "Network: Solana devnet"
Write-Output "RPC: $rpcUrl"
Write-Output "TxLINE API origin: $ExpectedApiOrigin"
Write-Output "Program ID: $ExpectedProgramId"
Write-Output "Token mint: $ExpectedTokenMint"
Write-Output "Service level: $ServiceLevel"
Write-Output "Subscription duration: $DurationWeeks weeks"
Write-Output "Selected leagues: $SelectedLeagues"
Write-Output "Requires TxL: No"
Write-Output "Requires devnet SOL: Yes, for transaction fees and possible account rent"
Write-Output "Current devnet SOL balance: $balanceOutput"
Write-Output "Official script: $RepoRoot\$OfficialScript"

if ($balanceSol -le 0) {
  Fail "Wallet has zero devnet SOL. Activation cannot submit a transaction until this wallet is funded."
}

if ($env:APPROVE_TXODDS_DEVNET_SUBSCRIPTION -ne "YES") {
  Fail "Approval missing. Re-run only after explicit user approval with APPROVE_TXODDS_DEVNET_SUBSCRIPTION=YES for this process."
}

$env:ANCHOR_PROVIDER_URL = $ExpectedRpc
$env:ANCHOR_WALLET = $walletPath
$env:TOKEN_MINT_ADDRESS = $ExpectedTokenMint

Set-Location -LiteralPath $RepoRoot

$yarnCommand = Get-Command yarn.cmd -ErrorAction SilentlyContinue
if ($yarnCommand) {
  & yarn.cmd ts-node $OfficialScript
} else {
  $corepackCommand = Get-Command corepack -ErrorAction SilentlyContinue
  if (-not $corepackCommand) {
    Fail "Neither yarn.cmd nor corepack was found; cannot run the official TypeScript example."
  }
  & corepack yarn ts-node $OfficialScript
}

if ($LASTEXITCODE -ne 0) {
  Fail "Official TxODDS devnet activation example failed with exit code $LASTEXITCODE."
}
