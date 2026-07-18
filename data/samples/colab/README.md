# Sanitized Colab export sample

`sanitized-mini-input.json` contains one synthetic-name fixture, four sanitized odds observations, and one final score. It contains no API credential, wallet, address, signature, private key, or activation data.

The generated `txodds-*` directory is a complete small example bundle with every normalized table, schema, manifest, hash, data dictionary, and the JSONL-to-Parquet helper. It is for contract/integration testing only and makes no live-data or alpha claim.

Regenerate it from the repository root with a fixed provenance timestamp:

```powershell
$env:COLAB_EXPORT_INPUT = "data/samples/colab/sanitized-mini-input.json"
$env:COLAB_EXPORT_OUTPUT_ROOT = "data/samples/colab"
$env:EXPORT_TIMESTAMP = "2026-01-01T03:00:00.000Z"
npm run export:colab-data
```
