"""Verify Colab runtime provenance and optional context configuration."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from quant_research.colab_runtime import verify_git_provenance
from quant_research.secrets import configuration_status, load_perplexity_configuration


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--branch", default="cursor/quant-agents")
    parser.add_argument("--commit")
    arguments = parser.parse_args()
    provenance = verify_git_provenance(
        arguments.repo_root,
        expected_branch=arguments.branch,
        expected_commit=arguments.commit,
    )
    configuration = load_perplexity_configuration()
    print(
        json.dumps(
            {
                "branch": provenance.branch,
                "commit": provenance.commit,
                "commit_time": provenance.commit_time.isoformat(),
            },
            sort_keys=True,
        )
    )
    print(configuration_status(configuration))


if __name__ == "__main__":
    main()
