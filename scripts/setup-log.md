# TxODDS Hackathon Setup Log
Started: 2026-07-18
Completed safe setup: 2026-07-18

## Root workspace
`E:\Hackathons\World-Cup`  
(Note: `E:\Hackathons\World Cup Hackathon` does not exist; used existing dedicated root.)

## Phase 1 — System Check
| Step | Status | Notes |
|------|--------|-------|
| Windows AMD64 64-bit | COMPLETED | Build 26200 / NT 10.0.26200 |
| PowerShell | COMPLETED | |
| E: drive / World-Cup root | COMPLETED | Agent moved to this root |
| winget | COMPLETED | v1.29.280 |

## Directory structure
| Path | Status |
|------|--------|
| `txodds/` | EXISTS |
| `projects/` | CREATED |
| `starters/` | EXISTS |
| `data/` | EXISTS |
| `scripts/` | EXISTS |
| `docs/` | CREATED |
| `temp/` | CREATED |
| `txodds/tx-on-chain` | CLONED from https://github.com/txodds/tx-on-chain |
| `starters/full-stack-starter` | CREATED (Next.js + TS + Tailwind + ESLint + Prettier) |
| `data/python-env` | CREATED (uv venv 3.12 + DuckDB/pandas/etc.) |

## Tool verification
| Tool | Version | Source |
|------|---------|--------|
| Git | 2.54.0.windows.1 | pre-installed |
| Git LFS | 3.7.1 | pre-installed |
| GitHub CLI | 2.96.0 | already installed (winget) |
| Node.js | v24.18.0 | pre-installed |
| npm | 11.16.0 | pre-installed |
| pnpm | 11.13.0 | winget `pnpm.pnpm` |
| Yarn Classic | 1.22.22 | winget `Yarn.Yarn` |
| Python | 3.12.10 | pre-installed (+ 3.11 available) |
| uv | 0.11.29 | winget `astral-sh.uv` |
| VS Code | 1.129.1 | pre-installed |
| Cursor | 3.8.24 | pre-installed |
| Bruno | 3.5.2 | winget `Bruno.Bruno` → `C:\Program Files\Bruno\Bruno.exe` |
| DBeaver Community | 26.1.2 | winget → `%LOCALAPPDATA%\DBeaver\dbeaver.exe` |
| SQLite | 3.53.3 | winget `SQLite.SQLite` |
| Solana/Agave CLI | 4.1.1 | official `agave-install-init` stable |
| TypeScript | 5.9.3 | starter project |
| Next.js | 16.2.10 | starter project |
| React | 19.2.4 | starter project |
| Tailwind CSS | 4.x | starter project |
| DuckDB (Python) | 1.5.4 | `data/python-env` |

## Explicitly NOT done (per instructions)
- No Solana wallet / keypair created (`~\.config\solana\id.json` absent)
- No airdrop / transactions
- No GitHub login (`gh auth`)
- No Git identity changes
- No Rust / Anchor / Surfpool / Kubernetes / Docker (not required for TxLINE TypeScript client + API work)
- No secrets or API keys stored in workspace

## How to activate Python env
```powershell
Set-Location "E:\Hackathons\World-Cup"
.\data\python-env\.venv\Scripts\Activate.ps1
```

## How to run full-stack starter
```powershell
Set-Location "E:\Hackathons\World-Cup\starters\full-stack-starter"
npm run dev
```

## Optional next steps (ask before doing)
1. `gh auth login` for GitHub CLI
2. Create a Solana keypair (devnet only recommended)
3. Add TxLINE API token via env vars (never commit)
4. Install Rust/Anchor only if building on-chain programs
