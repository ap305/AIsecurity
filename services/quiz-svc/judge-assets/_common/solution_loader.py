#!/usr/bin/env python3
"""统一作品加载器（Solution Loader）

依据《攻防对抗平台功能扩展开发需求》需求二：参赛作品文件夹上传 + 标准接口。

作品目录规范：
    submission/
    ├── solution.py           # 必须存在，标准入口
    ├── model/                # 可选（模型权重等）
    ├── config/               # 可选
    ├── requirements.txt      # 可选
    └── other_files/          # 可选

solution.py 推荐实现标准类：
    class Solution:
        def __init__(self, work_dir: str):
            ...
        def attack(self, ...): ...      # 攻击赛题
        def defend(self, ...): ...      # 防御赛题
        def predict(self, ...): ...     # 模型类赛题

各赛题的方法签名与内联代码契约保持一致（env / sample / request 等参数原样透传）。
为兼容历史用法，solution.py 也可仅定义顶层 attack/defend 函数，加载器会自动包装。

本模块提供两个入口：
  - validate_solution(work_dir, required_methods) -> 结构化校验清单（不抛异常）
  - load_solution(work_dir, required_methods)     -> Solution 实例（失败抛 SolutionValidationError）

引擎侧典型用法：
    from solution_loader import load_user_fn
    fn = load_user_fn(code, "attack", work_dir)   # work_dir 非空走 Solution，否则 exec(code)
"""

from __future__ import annotations

import importlib.util
import os
import sys
import traceback
import uuid
from types import ModuleType
from typing import Any, Callable

# ── 进程内实例缓存：同一次 run 中多次取方法（如水印 embed+detect）复用同一实例 ──
_INSTANCE_CACHE: dict[str, Any] = {}


class SolutionValidationError(Exception):
    """携带结构化校验清单的异常，供引擎捕获后回写 details。"""

    def __init__(self, checks: list[dict], message: str = "Submission validation failed"):
        self.checks = checks
        super().__init__(message)


# ── 校验步骤 ──────────────────────────────────────────────────────────────────

def _check_dir(work_dir: str) -> dict:
    ok = os.path.isdir(work_dir)
    return {
        "name": "work_dir",
        "label": "作品目录存在",
        "passed": ok,
        "detail": work_dir if ok else f"目录不存在: {work_dir}",
    }


def _check_solution_py(work_dir: str) -> tuple[dict, str | None]:
    path = os.path.join(work_dir, "solution.py")
    ok = os.path.isfile(path)
    return (
        {
            "name": "solution_py",
            "label": "solution.py 存在",
            "passed": ok,
            "detail": path if ok else "根目录缺少 solution.py（标准入口）",
        },
        path if ok else None,
    )


def _import_solution(work_dir: str, path: str) -> tuple[dict, ModuleType | None, str | None]:
    """以唯一模块名导入，避免不同作品间 sys.modules 缓存冲突。"""
    mod_name = f"_user_solution_{uuid.uuid4().hex}"
    try:
        spec = importlib.util.spec_from_file_location(mod_name, path)
        if spec is None or spec.loader is None:
            return (
                {"name": "import", "label": "solution.py 可导入",
                 "passed": False, "detail": "无法构建模块 spec"},
                None, None,
            )
        module = importlib.util.module_from_spec(spec)
        sys.modules[mod_name] = module
        # 将作品目录加入 Python Path，使 solution.py 能 import 同目录子模块
        if work_dir not in sys.path:
            sys.path.insert(0, work_dir)
        spec.loader.exec_module(module)
        return (
            {"name": "import", "label": "solution.py 可导入",
             "passed": True, "detail": "导入成功"},
            module, mod_name,
        )
    except Exception as e:
        tb = traceback.format_exc().splitlines()
        # 取关键的一行异常描述，避免过长
        detail = f"{type(e).__name__}: {e}"
        return (
            {"name": "import", "label": "solution.py 可导入",
             "passed": False, "detail": f"{detail}\n" + "\n".join(tb[-4:])},
            None, None,
        )


def _find_solution_class(module: ModuleType) -> tuple[dict, type | None]:
    cls = getattr(module, "Solution", None)
    if isinstance(cls, type):
        return (
            {"name": "solution_class", "label": "Solution 类存在",
             "passed": True, "detail": cls.__name__},
            cls,
        )
    return (
        {"name": "solution_class", "label": "Solution 类存在",
         "passed": False, "detail": "未找到 Solution 类（将尝试顶层函数兼容模式）"},
        None,
    )


def _wrap_functions(module: ModuleType, work_dir: str) -> tuple[dict, Any | None]:
    """兼容模式：solution.py 仅定义顶层 attack/defend/predict/embed/detect 函数。"""
    fns = {
        k: v for k, v in vars(module).items()
        if callable(v) and not k.startswith("_") and getattr(v, "__module__", None) == module.__name__
    }
    if not fns:
        return (
            {"name": "fallback_functions", "label": "顶层函数兼容",
             "passed": False, "detail": "既无 Solution 类，也无顶层 attack/defend 函数"},
            None,
        )
    shim = _FnShim(work_dir)
    for k, v in fns.items():
        setattr(shim, k, v)
    return (
        {"name": "fallback_functions", "label": "顶层函数兼容",
         "passed": True, "detail": f"包装顶层函数: {sorted(fns)}"},
        shim,
    )


class _FnShim:
    """顶层函数包装为类实例，使 getattr(shim, 'attack') 返回函数。"""

    def __init__(self, work_dir: str):
        self.work_dir = work_dir


def _instantiate(cls: type, work_dir: str) -> tuple[dict, Any | None]:
    try:
        inst = cls(work_dir)
        return (
            {"name": "instantiate", "label": "Solution(work_dir) 初始化成功",
             "passed": True, "detail": "实例化成功"},
            inst,
        )
    except Exception as e:
        return (
            {"name": "instantiate", "label": "Solution(work_dir) 初始化成功",
             "passed": False, "detail": f"{type(e).__name__}: {e}"},
            None,
        )


def _check_methods(inst: Any, required_methods: list[str]) -> list[dict]:
    checks: list[dict] = []
    for m in required_methods:
        has = callable(getattr(inst, m, None))
        checks.append({
            "name": f"method:{m}",
            "label": f"{m}() 方法存在",
            "passed": has,
            "detail": f"Solution.{m}(input_data)" if has else f"缺少方法: Solution.{m}(...)",
        })
    return checks


# ── 主入口 ────────────────────────────────────────────────────────────────────

def validate_solution(work_dir: str, required_methods: list[str]) -> dict:
    """结构化校验，不抛异常。返回 {valid, checks, error}。"""
    work_dir = os.path.abspath(work_dir)
    checks: list[dict] = []

    checks.append(_check_dir(work_dir))
    if not checks[-1]["passed"]:
        return {"valid": False, "checks": checks, "error": "作品目录不存在"}

    c_sol, sol_path = _check_solution_py(work_dir)
    checks.append(c_sol)
    if not c_sol["passed"]:
        return {"valid": False, "checks": checks, "error": "缺少 solution.py"}

    c_imp, module, _ = _import_solution(work_dir, sol_path)  # type: ignore[arg-type]
    checks.append(c_imp)
    if module is None:
        return {"valid": False, "checks": checks, "error": "solution.py 导入失败"}

    inst: Any | None = None
    c_cls, cls = _find_solution_class(module)
    checks.append(c_cls)
    if cls is not None:
        c_inst, inst = _instantiate(cls, work_dir)
        checks.append(c_inst)
        if inst is None:
            return {"valid": False, "checks": checks, "error": "Solution 初始化失败"}
    else:
        c_fn, inst = _wrap_functions(module, work_dir)
        checks.append(c_fn)
        if inst is None:
            return {"valid": False, "checks": checks, "error": "未找到 Solution 类或顶层函数"}

    method_checks = _check_methods(inst, required_methods)
    checks.extend(method_checks)
    if not all(c["passed"] for c in method_checks):
        missing = [c["name"].split(":", 1)[1] for c in method_checks if not c["passed"]]
        return {"valid": False, "checks": checks, "error": f"缺少必需方法: {missing}"}

    # 缓存实例，供 load_user_fn 复用
    _INSTANCE_CACHE[work_dir] = inst
    return {"valid": True, "checks": checks, "error": None}


def load_solution(work_dir: str, required_methods: list[str]) -> Any:
    """加载并返回 Solution 实例。失败抛 SolutionValidationError。"""
    work_dir = os.path.abspath(work_dir)
    if work_dir in _INSTANCE_CACHE:
        return _INSTANCE_CACHE[work_dir]
    result = validate_solution(work_dir, required_methods)
    if not result["valid"]:
        raise SolutionValidationError(result["checks"])
    return _INSTANCE_CACHE[work_dir]


def format_checks(checks: list[dict]) -> str:
    """把校验清单格式化为多行文本，供引擎写入错误详情。"""
    lines = ["Submission validation failed:"]
    for c in checks:
        mark = "OK" if c.get("passed") else "FAIL"
        lines.append(f"  [{mark}] {c.get('label', c.get('name', '?'))}: {c.get('detail', '')}")
    return "\n".join(lines)


def load_user_fn(code: str, fn_name: str, work_dir: str | None = None) -> Callable | None:
    """引擎统一入口：work_dir 非空 -> 加载 Solution.{fn_name}；否则 exec(code) 取顶层函数。

    返回的 callable 与内联函数签名一致，引擎无需区分调用方式。
    """
    if work_dir:
        inst = load_solution(work_dir, [fn_name])
        fn = getattr(inst, fn_name, None)
        return fn if callable(fn) else None
    ns: dict[str, Any] = {}
    exec(code, ns)
    return ns.get(fn_name)


# ── CLI：供 /matches/validate 端点调用 ────────────────────────────────────────
# 用法: python solution_loader.py <work_dir> <method1,method2,...>
# 输出 JSON: {"valid": bool, "checks": [...], "error": str|null}
if __name__ == "__main__":
    import json
    if len(sys.argv) < 3:
        print(json.dumps({"valid": False, "checks": [], "error": "用法: solution_loader.py <work_dir> <methods>"}))
        sys.exit(0)
    wd = sys.argv[1]
    methods = [m.strip() for m in sys.argv[2].split(",") if m.strip()]
    try:
        result = validate_solution(wd, methods)
    except Exception as e:
        result = {"valid": False, "checks": [], "error": f"校验器异常: {type(e).__name__}: {e}"}
    print(json.dumps(result, ensure_ascii=False))
