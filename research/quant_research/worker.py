"""Minimal Colab entry point that emits a research-only execution receipt.

Projects plug a concrete ``TrainingTool`` into the notebook before using this
entry point. This module deliberately cannot publish or deploy an artifact.
"""

from __future__ import annotations

import argparse
import json
import os


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--experiment-id", required=True)
    parser.add_argument("--seed", required=True, type=int)
    arguments = parser.parse_args()
    if os.getenv("RESEARCH_ONLY") != "1" or os.getenv("DISABLE_PRODUCTION_DEPLOYMENT") != "1":
        raise RuntimeError("Colab worker requires research-only safety environment")
    print(
        json.dumps(
            {
                "experiment_id": arguments.experiment_id,
                "seed": arguments.seed,
                "status": "READY_FOR_CONFIGURED_TRAINING_TOOL",
                "production_deployment": False,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
