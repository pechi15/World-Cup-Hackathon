"""Convert a sanitized research bundle's JSONL tables to Parquet in Colab."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def convert(bundle: Path) -> list[Path]:
    import pyarrow as pa
    import pyarrow.parquet as pq

    manifest = json.loads((bundle / "dataset-manifest.json").read_text(encoding="utf-8"))
    outputs: list[Path] = []
    for entry in manifest["files"]:
        source = bundle / entry["path"]
        if source.suffix != ".jsonl":
            continue
        rows = [json.loads(line) for line in source.read_text(encoding="utf-8").splitlines() if line]
        target = source.with_suffix(".parquet")
        pq.write_table(pa.Table.from_pylist(rows), target, compression="zstd")
        outputs.append(target)
    return outputs


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("bundle", type=Path)
    args = parser.parse_args()
    for output in convert(args.bundle):
        print(output)


if __name__ == "__main__":
    main()
