"""Clone, pin, install, and verify the authoritative research branch."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import subprocess
import sys
from pathlib import Path


def _run(arguments: list[str], *, cwd: Path | None = None) -> None:
    subprocess.run(arguments, cwd=cwd, check=True)


def _output(arguments: list[str], *, cwd: Path) -> str:
    return subprocess.check_output(arguments, cwd=cwd, text=True).strip()


def bootstrap_repository(
    *,
    repository_url: str,
    branch: str,
    target: Path,
    commit: str | None,
    run_checks: bool = True,
) -> dict[str, object]:
    if not (target / ".git").exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        _run(
            [
                "git",
                "clone",
                "--single-branch",
                "--branch",
                branch,
                repository_url,
                str(target),
            ]
        )
    _run(["git", "fetch", "origin", branch], cwd=target)
    selected_commit = commit or _output(["git", "rev-parse", f"origin/{branch}"], cwd=target)
    _run(["git", "merge-base", "--is-ancestor", selected_commit, f"origin/{branch}"], cwd=target)
    _run(["git", "checkout", "-B", branch, selected_commit], cwd=target)
    actual_commit = _output(["git", "rev-parse", "HEAD"], cwd=target)
    actual_branch = _output(["git", "branch", "--show-current"], cwd=target)
    if actual_commit != selected_commit or actual_branch != branch:
        raise RuntimeError("Git provenance verification failed")

    research_root = target / "research"
    _run([sys.executable, "-m", "pip", "install", "-e", f"{research_root}[dev]"])
    versions: dict[str, str] = {"python": sys.version.split()[0]}
    for package in ("pydantic", "pyarrow", "PyYAML", "jsonschema", "ruff", "mypy", "pytest"):
        versions[package] = importlib.metadata.version(package)
    print(json.dumps({"branch": actual_branch, "commit": actual_commit, "versions": versions}, sort_keys=True))

    if run_checks:
        _run([sys.executable, "-m", "ruff", "check", "."], cwd=research_root)
        _run([sys.executable, "-m", "mypy", "quant_research"], cwd=research_root)
        _run([sys.executable, "-m", "pytest"], cwd=research_root)
    return {"branch": actual_branch, "commit": actual_commit, "versions": versions}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository-url", required=True)
    parser.add_argument("--branch", default="cursor/quant-agents")
    parser.add_argument("--commit")
    parser.add_argument("--target", type=Path, default=Path("/content/World-Cup-quant"))
    parser.add_argument("--skip-checks", action="store_true")
    arguments = parser.parse_args()
    bootstrap_repository(
        repository_url=arguments.repository_url,
        branch=arguments.branch,
        target=arguments.target,
        commit=arguments.commit,
        run_checks=not arguments.skip_checks,
    )


if __name__ == "__main__":
    main()
