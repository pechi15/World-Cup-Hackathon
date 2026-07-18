"""Copy verified artifacts to persistent Colab storage."""

from __future__ import annotations

import argparse
from pathlib import Path

from quant_research.colab_runtime import copy_artifacts


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    arguments = parser.parse_args()
    copy_artifacts(arguments.source, arguments.destination)
    print(f"artifacts_saved={arguments.destination}")


if __name__ == "__main__":
    main()
