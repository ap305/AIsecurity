"""Freeze prompt-course data and construct both public worker roles."""
from __future__ import annotations
import hashlib
import json
import pathlib
import shutil

import build_bots
from bot_runtime import load_course
from prompt_runtime import PROMPT_IDS, model_parameters


def build_pair(source_root, number, role, destination, samples=20, seed=42):
    if number not in PROMPT_IDS or role not in ("attack", "defense"):
        raise ValueError("Unsupported prompt course")
    prefix = "A" if role == "attack" else "D"
    candidates = list((pathlib.Path(source_root) / "题目" / "对抗").glob(f"{prefix}{number}-*"))
    if len(candidates) != 1:
        raise ValueError("Exactly one source question is required")
    code_dir = candidates[0] / "backend" / "code"
    destination = pathlib.Path(destination)
    if destination.exists():
        raise ValueError("Destination must be fresh")
    (destination / "course").mkdir(parents=True)
    (destination / "public").mkdir()
    digest = hashlib.sha256()
    for name in ("dataset.py", "attack.py", "defense.py", "test.py"):
        data = (code_dir / name).read_bytes()
        digest.update(name.encode() + b"\0" + data)
        (destination / "course" / name).write_bytes(data)
    data_dir = code_dir / "data"
    files = (("samples/public.jsonl", "samples/hidden.jsonl", "corpus/clean_corpus.jsonl") if number == "13"
             else ("harmful.jsonl", "benign.jsonl") if number == "08" else ("public.jsonl", "hidden.jsonl"))
    for name in files:
        data = (data_dir / name).read_bytes()
        target = destination / "course" / "data" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        digest.update(name.encode() + b"\0" + data)
    build_bots.PUBLIC_ATTACK_CONSTANTS.update({"09": {"MAX_PAYLOAD_BYTES", "MAX_QUERIES"}, "13": {"MAX_BYTES_PER_DOC", "MAX_POISON_DOCS"}})
    build_bots.PUBLIC_DATASET_HELPERS["02"] = {"RUBRIC_INSTRUCTION"}
    for worker_role in ("attack", "defense"):
        backend, dataset = build_bots.public_sources(code_dir, number, worker_role)
        (destination / "public" / (worker_role + "_backend.py")).write_text(backend, encoding="utf8")
        (destination / "public" / ("dataset_" + worker_role + ".py")).write_text(dataset, encoding="utf8")
        digest.update(backend.encode() + b"\0" + dataset.encode())
    (destination / "public" / "course.json").write_text(json.dumps({"number": number}), encoding="utf8")
    local = pathlib.Path(__file__).parent
    shutil.copyfile(local / "bot_bootstrap.py", destination / "public" / "bootstrap.py")
    for name in ("bot_runtime.py", "prompt_runtime.py"):
        shutil.copyfile(local / name, destination / name)
    frozen = {"number": number, "role": role, "samples": samples, "seed": seed, "sourceDigest": digest.hexdigest()}
    (destination / "frozen.json").write_text(json.dumps(frozen, indent=2) + "\n", encoding="utf8")
    params = model_parameters(load_course(destination / "course"), number)
    (destination / "model-parameters.json").write_text(json.dumps(params, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    return {"frozen": frozen, "worker": {"bootstrap": "public/bootstrap.py", "files": ["public/bootstrap.py", "public/attack_backend.py", "public/defense_backend.py", "public/dataset_attack.py", "public/dataset_defense.py", "public/course.json"]}, "modelParameters": params}
