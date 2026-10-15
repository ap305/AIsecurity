"""
Security sandbox for executing student attack/defense code.

Uses a restricted builtins + allowed modules whitelist approach.
Execution is run in-process with a threading-based timeout watchdog.
"""

import threading

# ── Execution timeout (seconds) ──────────────────────────────────────────────

EXECUTION_TIMEOUT = 30

# ── Builtins whitelist ───────────────────────────────────────────────────────

ALLOWED_BUILTINS = {
    # Basic types and operations
    "True", "False", "None",
    "abs", "all", "any", "ascii", "bin", "bool", "bytes", "bytearray",
    "callable", "chr", "complex", "dict", "dir", "divmod", "enumerate",
    "filter", "float", "format", "frozenset", "getattr", "hasattr",
    "hash", "hex", "id", "int", "isinstance", "issubclass", "iter",
    "len", "list", "map", "max", "memoryview", "min", "next",
    "object", "oct", "ord", "pow", "print", "property", "range",
    "repr", "reversed", "round", "set", "slice", "sorted",
    "staticmethod", "str", "sum", "super", "tuple", "type",
    "vars", "zip",
    # Exception handling
    "Exception", "ValueError", "TypeError", "KeyError", "IndexError",
    "AttributeError", "RuntimeError", "StopIteration",
    "ImportError", "ModuleNotFoundError", "OSError", "IOError",
    "ZeroDivisionError", "AssertionError",
    "BaseException",
}

# ── Module whitelist ─────────────────────────────────────────────────────────

ALLOWED_MODULES = {
    "str", "re", "json", "math", "random", "datetime",
    "collections", "itertools", "functools", "hashlib",
}


class SandboxError(Exception):
    """Raised when sandbox restrictions are violated."""
    pass


class SandboxTimeout(Exception):
    """Raised when code execution exceeds the time limit."""
    pass


def _restricted_import(name, globals=None, locals=None, fromlist=(), level=0):
    """Restricted __import__ that only allows whitelisted modules."""
    if name not in ALLOWED_MODULES:
        raise SandboxError(f"Module '{name}' is not allowed. Allowed: {sorted(ALLOWED_MODULES)}")
    return __import__(name, globals, locals, fromlist, level)


def _build_restricted_globals(extra: dict | None = None) -> dict:
    """Build the restricted globals dictionary for student code execution."""
    restricted = {
        "__builtins__": {k: __builtins__[k] for k in ALLOWED_BUILTINS if k in __builtins__},
        "__import__": _restricted_import,
        "__name__": "__sandbox__",
    }
    if extra:
        restricted.update(extra)
    return restricted


def safe_exec(code: str, fn_name: str, *args) -> dict:
    """
    Execute student code safely with timeout watchdog and restricted environment.

    Uses in-process execution with restricted builtins/modules. A watchdog
    thread monitors the timeout. The student code can only interact through
    the provided arguments (e.g., BotEnvironment).

    Args:
        code: Python source code to execute.
        fn_name: Name of the function to call after execution.
        *args: Arguments to pass to the function.

    Returns:
        dict: Either {"result": ...} on success or {"error": str} on failure.
    """
    result_container: dict = {}
    finished = threading.Event()
    error_occurred: Exception | None = None

    def _run():
        nonlocal error_occurred
        try:
            namespace = _build_restricted_globals()
            exec(compile(code, "<student_code>", "exec"), namespace)

            if fn_name not in namespace:
                result_container["error"] = f"Function '{fn_name}' not found in submitted code"
                return

            fn = namespace[fn_name]
            result = fn(*args)
            result_container["result"] = result
        except SandboxError as e:
            result_container["error"] = f"Sandbox violation: {e}"
        except Exception as e:
            error_occurred = e
            result_container["error"] = f"Runtime error: {type(e).__name__}: {e}"
        finally:
            finished.set()

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()

    # Wait for completion or timeout
    if not finished.wait(timeout=EXECUTION_TIMEOUT):
        # Timeout — the daemon thread will be cleaned up when the process exits
        result_container["error"] = f"Code execution timed out after {EXECUTION_TIMEOUT} seconds"

    return result_container
