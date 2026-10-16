"""Build trusted course and explicitly public Bot files without student assets.

The caller packages the returned tree using the normal platform manifest. Large
question ZIPs, output caches, submissions and credentials are never copied.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import pathlib
import shutil

from bot_runtime import BOT_IDS, load_course, model_parameters

MARKER = "# [IMPORTANT] Replace this line with real attack/defense code."
PUBLIC_DATASET_HELPERS = {
    "17": {"parse_user_request", "expected_hotel", "HOTELS"},
    "18": {"find_ibans_in_text", "normalize_iban", "IBAN_RE"},
    "19": {"find_emails", "normalize_email", "EMAIL_RE"},
}
PUBLIC_ATTACK_CONSTANTS = {"14": {"FILE_NAMES"}, "16": {"INJECT_MAX_CHARS"}, "19": {"INJECTABLE_DOCS", "DOCS"}, "21": {"MATCH_AGENDAS", "WEEKLY_REVIEW", "KICKOFF", "Q3_PLANNING"}, "22": {"MATCH_PAGE"}}


def _node_names(node):
    if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
        return {node.name}
    if isinstance(node, (ast.Assign, ast.AnnAssign)):
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        return {n.id for target in targets for n in ast.walk(target) if isinstance(n, ast.Name)}
    return set()


def public_sources(code_dir, number, role):
    backend_source = (code_dir / f"{role}-backend.py").read_text(encoding="utf-8-sig")
    if backend_source.count(MARKER) != 1:
        raise ValueError("The publisher backend must contain one slot")
    tree = ast.parse(backend_source.replace(MARKER, "__COURSE_SLOT__ = None"))
    body = []
    for node in tree.body:
        # Demos import opponent implementations and full evaluation datasets.
        if isinstance(node, ast.If):
            continue
        if isinstance(node, ast.ImportFrom) and node.module in ("attack", "defense", "test", "dataset"):
            continue
        body.append(node)
    tree.body = body
    helpers = (PUBLIC_DATASET_HELPERS if role == "defense" else PUBLIC_ATTACK_CONSTANTS).get(number, set())
    ds = ast.parse((code_dir / "dataset.py").read_text(encoding="utf-8-sig"))
    public_body = [ast.Import(names=[ast.alias(name="re")])]
    public_body.extend(node for node in ds.body if _node_names(node) & helpers)
    actual = set().union(*(_node_names(node) for node in public_body))
    if not helpers <= actual:
        raise ValueError("Published public helper is missing")
    if helpers:
        insertion = next((i for i, node in enumerate(tree.body) if not isinstance(node, ast.ImportFrom) or node.module != "__future__"), 0)
        # Put imports after future declarations; a leading docstring is optional.
        insertion = max([i + 1 for i, n in enumerate(tree.body) if isinstance(n, ast.ImportFrom) and n.module == "__future__"] or [0])
        tree.body.insert(insertion, ast.ImportFrom(module="dataset", names=[ast.alias(name=n) for n in sorted(helpers)], level=0))
    return ast.unparse(ast.fix_missing_locations(tree)) + "\n", ast.unparse(ast.fix_missing_locations(ast.Module(body=public_body, type_ignores=[]))) + "\n"


def build_pair(source_root, number, role, destination, samples=20, seed=42):
    if number not in BOT_IDS or role not in ("attack", "defense"):
        raise ValueError("Unsupported Bot course")
    prefix = "A" if role == "attack" else "D"
    candidates = list((pathlib.Path(source_root) / "题目" / "对抗").glob(f"{prefix}{number}-*"))
    if len(candidates) != 1:
        raise ValueError("Exactly one source question is required")
    code_dir = candidates[0] / "backend" / "code"
    destination = pathlib.Path(destination)
    if destination.exists():
        raise ValueError("Destination must be a fresh build directory")
    (destination / "course").mkdir(parents=True)
    (destination / "public").mkdir()
    digest = hashlib.sha256()
    for name in ("dataset.py", "attack.py", "defense.py", "test.py"):
        source = (code_dir / name).read_bytes()
        digest.update(name.encode() + b"\0" + source)
        (destination / "course" / name).write_bytes(source)
    for worker_role in ("attack", "defense"):
        backend, dataset = public_sources(code_dir, number, worker_role)
        (destination / "public" / (worker_role + "_backend.py")).write_text(backend, encoding="utf8")
        (destination / "public" / ("dataset_" + worker_role + ".py")).write_text(dataset, encoding="utf8")
        digest.update(backend.encode() + b"\0" + dataset.encode())
    (destination / "public" / "course.json").write_text(json.dumps({"number": number}), encoding="utf8")
    local = pathlib.Path(__file__).parent
    shutil.copyfile(local / "bot_bootstrap.py", destination / "public" / "bootstrap.py")
    shutil.copyfile(local / "bot_runtime.py", destination / "bot_runtime.py")
    # Role backends are part of the digest as well, so helper changes invalidate calibration.
    frozen = {"number": number, "role": role, "samples": samples, "seed": seed, "sourceDigest": digest.hexdigest()}
    (destination / "frozen.json").write_text(json.dumps(frozen, indent=2) + "\n", encoding="utf8")
    params = model_parameters(load_course(destination / "course"), number)
    (destination / "model-parameters.json").write_text(json.dumps(params, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    return {"frozen": frozen, "worker": {"bootstrap": "public/bootstrap.py", "files": ["public/bootstrap.py", "public/attack_backend.py", "public/defense_backend.py", "public/dataset_attack.py", "public/dataset_defense.py", "public/course.json"]}, "modelParameters": params}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--number", required=True, choices=BOT_IDS)
    parser.add_argument("--role", required=True, choices=("attack", "defense"))
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    print(json.dumps(build_pair(args.source_root, args.number, args.role, args.output), ensure_ascii=True))
