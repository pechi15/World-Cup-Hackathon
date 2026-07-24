# TxODDS World Cup London Hackathon
[Won 3rd Place for Local Track]
Project root for the **Trading Tools and Agents** track setup.

## Layout

| Path | Purpose |
|------|---------|
| `txodds/` | TxODDS repositories (e.g. `tx-on-chain`) |
| `projects/` | Your hackathon project work |
| `starters/` | Starter projects (e.g. `full-stack-starter`) |
| `data/` | Datasets and Python analysis environments |
| `scripts/` | Setup logs and utility scripts |
| `docs/` | Notes and documentation |
| `temp/` | Scratch / temporary files |

## Quick start

```powershell
Set-Location "E:\Hackathons\World-Cup"

# TxODDS official repo
Set-Location ".\txodds\tx-on-chain"

# Full-stack starter
Set-Location "E:\Hackathons\World-Cup\starters\full-stack-starter"
npm run dev

# Python analytics env
Set-Location "E:\Hackathons\World-Cup"
.\data\python-env\.venv\Scripts\Activate.ps1
```

## Setup log

See `scripts/setup-log.md` for installation progress and verified tool versions.

**Do not store wallet keys, passwords, API keys, or seed phrases in this workspace.**
