"""Download every Timestral size to the Hugging Face cache so the UI can compare them offline.

Run with: uv run python scripts/download_models.py
"""

from huggingface_hub import snapshot_download

MODELS = ["mistralai/Timestral-5M", "mistralai/Timestral-28M", "mistralai/Timestral-123M", "mistralai/Timestral-209M"]

for repo in MODELS:
    path = snapshot_download(repo, allow_patterns=["config.json", "model.safetensors", "LICENSE*"])
    print(f"{repo}: {path}")
