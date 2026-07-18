# Google Colab execution

`research/notebooks/colab_runner.ipynb` is the authoritative thin notebook. It
clones a branch/commit, installs `research/`, runs Ruff, MyPy, and Pytest, then
calls `quant_research.colab_runtime`. It contains no model, feature, backtest,
critic, or promotion implementation.

## Exact startup cells

Cell 1:

```python
REPOSITORY_URL = "https://github.com/pechi15/World-Cup-Hackathon.git"
BRANCH = "cursor/quant-agents"
COMMIT = ""  # Optional exact 40-character commit; blank uses branch HEAD.
REPO_DIR = "/content/World-Cup-quant"
OUTPUT_DIR = "/content/drive/MyDrive/world-cup-quant/COLAB-SYNTHETIC-REPRO-001"
```

Cell 2:

```python
import pathlib, subprocess, sys
repo = pathlib.Path(REPO_DIR)
if not (repo / ".git").exists():
    subprocess.run(
        ["git", "clone", "--single-branch", "--branch", BRANCH, REPOSITORY_URL, REPO_DIR],
        check=True,
    )
command = [
    sys.executable,
    str(repo / "research/colab/bootstrap.py"),
    "--repository-url", REPOSITORY_URL,
    "--branch", BRANCH,
    "--target", REPO_DIR,
]
if COMMIT:
    command.extend(["--commit", COMMIT])
subprocess.run(command, check=True)
```

Cell 3 mounts persistent storage and leaves Perplexity disabled:

```python
from google.colab import drive
drive.mount("/content/drive")
import os
os.environ.setdefault("ENABLE_PERPLEXITY_CONTEXT", "false")
```

Cells 4 and 5 run `verify_environment.py` and `run_experiment.py` exactly as
shown in the notebook. Output must be under mounted Drive; the CLI rejects
temporary `/content` output unless explicitly overridden for tests.

## Required repository inputs

- `research/configs/experiment-spec.example.yaml`
- `research/configs/feature-manifest.example.json`
- `research/configs/model-config.example.yaml`
- `research/configs/backtest-config.example.yaml`
- `research/schemas/*.schema.json`
- `research/quant_research/`
- sanitized samples listed by `research/colab/colab-manifest.json`

The default `SYNTHETIC_TEST` dataset is generated deterministically by repository
code. `SANITIZED_TXODDS` accepts the repository replay shape but fails closed
because the sample has no settled outcomes. `REAL_HISTORICAL` requires an
external JSON array of `PredictionObservation` records and an expected SHA-256.

## Optional Perplexity context

Perplexity remains disabled unless both conditions hold:

1. `ENABLE_PERPLEXITY_CONTEXT=true`
2. `PERPLEXITY_API_KEY` exists in Colab Secrets

The loader prints only `perplexity_configured=true|false`. It never prints the
key. Context is offline research metadata only and is never imported by the
TypeScript trading controller. Every accepted context claim must validate
`ContextClaim`: publication time, retrieval time, source, citation, and
valid-at-decision-time status are mandatory.

## Local equivalent

From the repository root:

```powershell
Set-Location research
uv sync --extra dev
uv run ruff check .
uv run mypy quant_research
uv run pytest
uv run python colab/run_experiment.py `
  --repo-root .. `
  --experiment-config configs/experiment-spec.example.yaml `
  --output-dir artifacts/local-example
```

Use an empty output directory. Never use Colab output as a production deployment
or wallet authorization artifact.
