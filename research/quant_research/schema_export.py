"""Export canonical JSON Schemas for Colab inputs and artifacts."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from pydantic import BaseModel

from .contracts import ArtifactMetadata, DatasetManifest, ExperimentSpec, FeatureManifest


SCHEMAS: dict[str, type[BaseModel]] = {
    "dataset.schema.json": DatasetManifest,
    "experiment.schema.json": ExperimentSpec,
    "feature-manifest.schema.json": FeatureManifest,
    "artifact-metadata.schema.json": ArtifactMetadata,
}


def export_schemas(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for filename, model in SCHEMAS.items():
        path = directory / filename
        path.write_text(
            json.dumps(model.model_json_schema(), indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path, nargs="?", default=Path("schemas"))
    arguments = parser.parse_args()
    export_schemas(arguments.directory)


if __name__ == "__main__":
    main()
