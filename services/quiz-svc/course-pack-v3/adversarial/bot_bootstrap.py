"""Public worker bootstrap. This file must never run in the trusted grader."""
from __future__ import annotations

import ast
import importlib.util
import json
import pathlib
import sys
import types


def _load_role(code_path, role, data=None, diagnostics=None):
    public = pathlib.Path(__file__).resolve().parent
    source = pathlib.Path(code_path).read_text(encoding="utf-8-sig")
    student = ast.parse(source, str(code_path))
    for node in ast.walk(student):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or ""]
            if any(name.split(".")[0] in ("attack", "defense", "test", "assemble") for name in names):
                raise ValueError("Importing reference or evaluation modules is not allowed")
        if isinstance(node, ast.Raise) and isinstance(node.exc, ast.Call) and isinstance(node.exc.func, ast.Name) and node.exc.func.id == "NotImplementedError":
            raise ValueError("Complete every submission slot before submitting")
    if role not in ("attack", "defense"):
        raise ValueError("Invalid role")
    spec = importlib.util.spec_from_file_location("dataset", public / ("dataset_" + role + ".py"))
    dataset = importlib.util.module_from_spec(spec)
    sys.modules["dataset"] = dataset
    spec.loader.exec_module(dataset)
    if callable(getattr(dataset, "configure", None)):
        dataset.configure(data or {}, diagnostics)
    backend = ast.parse((public / (role + "_backend.py")).read_text(encoding="utf8"))
    slot_indices = [i for i, node in enumerate(backend.body) if isinstance(node, ast.Assign)
                    and any(isinstance(t, ast.Name) and t.id == "__COURSE_SLOT__" for t in node.targets)]
    if len(slot_indices) != 1:
        raise ValueError("Invalid published course slot")
    futures, statements = [], []
    for node in student.body:
        (futures if isinstance(node, ast.ImportFrom) and node.module == "__future__" else statements).append(node)
    backend.body[slot_indices[0]:slot_indices[0] + 1] = statements
    backend_futures = [n for n in backend.body if isinstance(n, ast.ImportFrom) and n.module == "__future__"]
    backend.body = futures + backend_futures + [n for n in backend.body if n not in backend_futures]
    module = types.ModuleType("student_code")
    module.__file__ = str(code_path)
    sys.modules["student_code"] = module
    exec(compile(ast.unparse(ast.fix_missing_locations(backend)), str(code_path), "exec"), module.__dict__)
    config = json.loads((public / "course.json").read_text(encoding="utf8"))
    symbols = config.get("symbols", {}).get(role, ["attack" if role == "attack" else "defend"])
    for symbol in symbols:
        if not callable(getattr(module, symbol, None)):
            raise ValueError("Required course entry is missing")
    module.__course_dataset__ = dataset
    return module


class _DatabaseView:
    def __init__(self, proxy):
        self._proxy = proxy

    def list_documents(self):
        return [types.SimpleNamespace(**value) for value in self._proxy.list_documents()]

    def __len__(self):
        return self._proxy.length()

    @property
    def operation_count(self):
        return self._proxy.operation_count()

    def __getattr__(self, name):
        return getattr(self._proxy, name)


def load_student(code_path, _work_dir):
    # Both workers receive this same public tree. Role is supplied by the trusted
    # grader at invocation, never inferred from the current question's role.
    module = types.ModuleType("student_entry")
    cache = {}
    number = json.loads((pathlib.Path(__file__).resolve().parent / "course.json").read_text(encoding="utf8"))["number"]

    def course_invoke(role, env, *args):
        if role not in cache:
            cache[role] = _load_role(code_path, role)
        target = cache[role]
        if number == "13" and role == "defense":
            env = types.SimpleNamespace(question=env.question, db=_DatabaseView(env.db))
        return getattr(target, "attack" if role == "attack" else "defend")(env, *args)
    module.course_invoke = course_invoke

    def course_create(role, name, kwargs=None, data=None):
        if role not in cache:
            cache[role] = _load_role(code_path, role, data=data)
        target = cache[role]
        if callable(getattr(target.__course_dataset__, "configure", None)):
            target.__course_dataset__.configure(data or {}, None)
        return getattr(target, name)(**(kwargs or {}))

    def course_attack_run(name, kwargs, environment, data=None, diagnostics=None):
        if "attack" not in cache:
            cache["attack"] = _load_role(code_path, "attack", data=data, diagnostics=diagnostics)
        target = cache["attack"]
        if callable(getattr(target.__course_dataset__, "configure", None)):
            target.__course_dataset__.configure(data or {}, diagnostics)
        runner = getattr(target, name)(**kwargs)
        return runner.run(environment.query, verbose=False)
    module.course_create = course_create
    module.course_attack_run = course_attack_run
    return module
