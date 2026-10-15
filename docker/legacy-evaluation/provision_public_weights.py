"""Provision torchvision's public, hash-checked checkpoint before sandbox execution."""
import hashlib
import json
import os
from pathlib import Path

import torch
from torchvision.models import ResNet18_Weights, resnet18

weights = ResNet18_Weights.IMAGENET1K_V1
state = weights.get_state_dict(progress=False, check_hash=True)
model = resnet18(weights=None)
model.load_state_dict(state, strict=True)
checkpoint = Path(os.environ["TORCH_HOME"]) / "hub/checkpoints" / weights.url.rsplit("/", 1)[1]
digest = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
if not digest.startswith("f37072fd"):
    raise RuntimeError("Unexpected ResNet18 public checkpoint digest")
report = {"source": weights.url, "sha256": digest, "bytes": checkpoint.stat().st_size,
          "torchVersion": torch.__version__, "weights": "IMAGENET1K_V1"}
(Path("/opt/legacy-runtime") / "public-weights.json").write_text(json.dumps(report, indent=2))
print(json.dumps(report))

