"""Build class based API courses with public helpers and no secret corpus in workers."""
from __future__ import annotations
import ast
import hashlib
import io
import json
import pathlib
import secrets
import shutil
import sys

from bot_runtime import load_course
from build_bots import MARKER, _node_names

CLASS_IDS = ("03", "27", "28")
TRUSTED_BIGRAM_SHA256 = "c3e368cc510ffc00f85202abfd788974fb06a67c527cac7c8227f201d75b7d6d"
SYMBOLS = {"03": {"attack": ["attack"], "defense": ["WatermarkDefense", "WatermarkDetector"]},
           "27": {"attack": ["AdaptiveRolePlayExtraction"], "defense": ["GuardedPromptWithLeakFilter"]},
           "28": {"attack": ["EnumerativeCitationProbe"], "defense": ["SecretSpanRetrievalFilter"]}}


def public_dataset(source, number):
    tree = ast.parse(source)
    if number == "03":
        names = {"VOCAB_SIZE", "_PUNCT_TRANS", "tokenize", "word2id", "BigramLM"}
        prelude = "import hashlib, json, math\nfrom pathlib import Path\n"
        suffix = '''\ndef load_bigram():
    obj = object.__new__(BigramLM)
    obj.__dict__.update(json.loads((Path(__file__).parent / 'bigram.json').read_text(encoding='utf8')))
    return obj
'''
    elif number == "27":
        names = {"TOKEN_RE", "MIN_SPAN_COVERAGE", "MIN_LCS_TOKENS", "tokenize", "lcs_length", "span_coverage", "strip_space", "is_verbatim", "span_match", "leak_report"}
        prelude = "import re, copy\nfrom typing import Any\nfrom difflib import SequenceMatcher\n"
        suffix = '''
_local_leak_report = leak_report
_data = {}
_diagnostics = None
def configure(data, diagnostics=None):
    global _data, _diagnostics
    _data, _diagnostics = data, diagnostics
def secret_spans(*_args, **_kwargs):
    return copy.deepcopy(_data.get('spans', []))
def build_system_prompt(*_args, **_kwargs):
    return _data.get('systemPrompt', '')
def leak_report(text, spans=None):
    if _diagnostics is None:
        return _local_leak_report(text, spans)
    result = _diagnostics.report(text)
    for item in spans or []:
        item['text'] = result.get('observed', {}).get(item['id'], '')
    return result['report']
'''
    else:
        names = {"TOKEN_RE", "tokenize"}
        prelude = "import re, copy\n"
        suffix = '''
_data = {}
KBOT_SYSTEM_PROMPT = ''
def configure(data, diagnostics=None):
    global _data, KBOT_SYSTEM_PROMPT
    _data = data
    KBOT_SYSTEM_PROMPT = data.get('systemPrompt', '')
def secret_spans(*_args, **_kwargs):
    return copy.deepcopy(_data.get('spans', []))
def all_docs(include_secret=True):
    return copy.deepcopy(_data.get('publicDocs', []))
'''
    selected = [node for node in tree.body if _node_names(node) & names]
    present = set().union(*(_node_names(node) for node in selected))
    if not names <= present:
        raise ValueError("Missing public helpers: " + repr(names - present))
    return "from __future__ import annotations\n" + prelude + ast.unparse(ast.Module(body=selected, type_ignores=[])) + "\n" + suffix


def backend_source(code_dir, role, number):
    source = (code_dir / (role + "-backend.py")).read_text(encoding="utf-8-sig")
    if source.count(MARKER) != 1:
        raise ValueError("Expected one student slot")
    tree = ast.parse(source.replace(MARKER, "__COURSE_SLOT__ = None"))
    tree.body = [node for node in tree.body if not isinstance(node, ast.If)
                 and not (isinstance(node, ast.FunctionDef) and node.name.startswith(("_selftest", "_main")))
                 and not (isinstance(node, ast.ImportFrom) and node.module in ("attack", "defense", "test", "dataset"))]
    if number == "03":
        imports = ast.ImportFrom(module="dataset", names=[ast.alias(name=n) for n in ("VOCAB_SIZE", "load_bigram", "tokenize", "word2id")], level=0)
        i = max([idx + 1 for idx, node in enumerate(tree.body) if isinstance(node, ast.ImportFrom) and node.module == "__future__"] or [0])
        tree.body.insert(i, imports)
    return ast.unparse(ast.fix_missing_locations(tree)) + "\n"


def build_pair(source_root, number, role, destination, samples=None, seed=42, bigram_checkpoint=None, private_order_key=None):
    if number not in CLASS_IDS or role not in ("attack", "defense"):
        raise ValueError("Unsupported class course")
    prefix = "A" if role == "attack" else "D"
    candidates = list((pathlib.Path(source_root) / "题目" / "对抗").glob(prefix + number + "-*"))
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
    course = load_course(destination / "course")
    if number == "03":
        private_order_key = private_order_key or secrets.token_hex(32)
        if len(private_order_key) != 64 or any(c not in '0123456789abcdef' for c in private_order_key):
            raise ValueError('A private 256-bit detection ordering key is required')
        order_bytes = private_order_key.encode('ascii')
        (destination / 'detection-order.key').write_bytes(order_bytes)
        digest.update(b'detection-order.key\0' + order_bytes)
        if bigram_checkpoint is None or not pathlib.Path(bigram_checkpoint).is_file():
            raise ValueError("Prepared trusted bigram checkpoint is required")
        if hashlib.sha256(pathlib.Path(bigram_checkpoint).read_bytes()).hexdigest() != TRUSTED_BIGRAM_SHA256:
            raise ValueError("Bigram checkpoint does not match the reviewed prepared asset")
        import torch
        import joblib
        previous = sys.modules.get("dataset")
        sys.modules["dataset"] = course.dataset
        try:
            checkpoint = torch.load(bigram_checkpoint, map_location="cpu", weights_only=True)
            if checkpoint.get("format") != "joblib-v1":
                raise ValueError("Expected trusted joblib-v1 bigram asset")
            model = joblib.load(io.BytesIO(bytes(checkpoint["payload"].tolist())))
            state = {key: getattr(model, key) for key in ("_trans", "_global", "_total", "_vocab")}
        finally:
            if previous is None:
                sys.modules.pop("dataset", None)
            else:
                sys.modules["dataset"] = previous
        data = json.dumps(state, ensure_ascii=False, separators=(",", ":")).encode()
        (destination / "public" / "bigram.json").write_bytes(data)
        digest.update(b"bigram.json\0" + data)
        natural = (code_dir / "data" / "natural_texts.jsonl").read_bytes()
        (destination / "course" / "data").mkdir()
        (destination / "course" / "data" / "natural_texts.jsonl").write_bytes(natural)
        digest.update(b"natural_texts.jsonl\0" + natural)
    dataset = public_dataset((code_dir / "dataset.py").read_text(encoding="utf-8-sig"), number)
    for worker_role in ("attack", "defense"):
        backend = backend_source(code_dir, worker_role, number)
        (destination / "public" / (worker_role + "_backend.py")).write_text(backend, encoding="utf8")
        (destination / "public" / ("dataset_" + worker_role + ".py")).write_text(dataset, encoding="utf8")
        digest.update(backend.encode() + b"\0" + dataset.encode())
    (destination / "public" / "course.json").write_text(json.dumps({"number": number, "symbols": SYMBOLS[number]}), encoding="utf8")
    local = pathlib.Path(__file__).parent
    shutil.copyfile(local / "bot_bootstrap.py", destination / "public" / "bootstrap.py")
    for name in ("bot_runtime.py", "class_runtime.py"):
        shutil.copyfile(local / name, destination / name)
    samples = samples if samples is not None else {"03": 40, "27": 6, "28": 30}[number]
    frozen = {"number": number, "role": role, "samples": samples, "seed": seed,
              "budget": {"03": 0, "27": 8, "28": 20}[number], "sourceDigest": digest.hexdigest()}
    (destination / "frozen.json").write_text(json.dumps(frozen, indent=2) + "\n", encoding="utf8")
    params = {"temperature": 0, "seed": seed, "max_tokens": 128 if number == "03" else 1024}
    (destination / "model-parameters.json").write_text(json.dumps(params, indent=2) + "\n", encoding="utf8")
    public_files = ["public/" + path.name for path in sorted((destination / "public").iterdir()) if path.is_file()]
    return {"frozen": frozen, "worker": {"bootstrap": "public/bootstrap.py", "files": public_files}, "modelParameters": params}
