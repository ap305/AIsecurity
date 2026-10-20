/** Runs only in the submission's constrained worker. Parses AST, never imports student code. */
export const SUBMISSION_PREFLIGHT_SOURCE = String.raw`
import ast, json, pathlib, sys

UNKNOWN = object()
def failure(reason, node=None):
    return {"ok": False, "reason": reason, "line": min(100000, max(1, getattr(node, "lineno", 1) or 1))}

def declarations(tree, prefix=""):
    found = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            found[prefix + node.name] = node
        elif isinstance(node, ast.ClassDef):
            found.update(declarations(node, prefix + node.name + "."))
    return found

def unimplemented(node):
    return isinstance(node, ast.Raise) and (
        isinstance(node.exc, ast.Name) and node.exc.id == "NotImplementedError" or
        isinstance(node.exc, ast.Call) and isinstance(node.exc.func, ast.Name) and node.exc.func.id == "NotImplementedError")

def abstract(node):
    return any((isinstance(d, ast.Name) and d.id == "abstractmethod") or
               (isinstance(d, ast.Attribute) and d.attr == "abstractmethod") for d in node.decorator_list)

def empty(body):
    return all(isinstance(n, ast.Pass) or isinstance(n, ast.Expr) and isinstance(n.value, ast.Constant)
               and (isinstance(n.value.value, str) or n.value.value is Ellipsis) for n in body)

def terminates(body):
    for node in body:
        if isinstance(node, (ast.Return, ast.Raise)): return True
        if isinstance(node, ast.If):
            if isinstance(node.test, ast.Constant):
                if terminates(node.body if node.test.value else node.orelse): return True
            elif node.orelse and terminates(node.body) and terminates(node.orelse): return True
        if isinstance(node, ast.Try):
            if terminates(node.finalbody): return True
            if terminates(node.body) and all(terminates(h.body) for h in node.handlers): return True
    return False

def literal(node, values):
    if node is None: return None
    if any(isinstance(n, (ast.Call, ast.Await, ast.Yield, ast.YieldFrom, ast.NamedExpr)) for n in ast.walk(node)):
        return UNKNOWN
    if isinstance(node, ast.Name): return values.get(node.id, UNKNOWN)
    if isinstance(node, ast.Constant): return node.value
    if isinstance(node, (ast.Tuple, ast.List)):
        parts = [literal(n, values) for n in node.elts]
        return tuple(parts) if isinstance(node, ast.Tuple) else parts
    if isinstance(node, ast.Dict):
        keys = [literal(n, values) if n else UNKNOWN for n in node.keys]
        if any(not isinstance(k, str) for k in keys): return UNKNOWN
        return dict(zip(keys, [literal(n, values) for n in node.values]))
    return UNKNOWN

def matches(value, annotation):
    if value is UNKNOWN or annotation is None: return True
    if isinstance(annotation, ast.Constant):
        return value is None if annotation.value is None else True
    if isinstance(annotation, ast.BinOp) and isinstance(annotation.op, ast.BitOr):
        return matches(value, annotation.left) or matches(value, annotation.right)
    name = annotation.id if isinstance(annotation, ast.Name) else ""
    if isinstance(annotation, ast.Subscript):
        name = annotation.value.id if isinstance(annotation.value, ast.Name) else ""
        if name in ("Optional", "Union"): return True
    types = {"list": list, "List": list, "tuple": tuple, "Tuple": tuple, "dict": dict, "Dict": dict,
             "str": str, "bool": bool, "int": int, "float": (int, float)}
    expected = types.get(name)
    if expected is None: return True
    if not isinstance(value, expected) or name in ("int", "float") and isinstance(value, bool): return False
    if name in ("tuple", "Tuple") and isinstance(annotation, ast.Subscript) and isinstance(annotation.slice, ast.Tuple):
        parts = annotation.slice.elts
        if any(isinstance(p, ast.Constant) and p.value is Ellipsis for p in parts): return True
        return len(parts) == len(value) and all(matches(v, a) for v, a in zip(value, parts))
    return True

def check(code, template):
    try:
        tree = ast.parse(code)
        compile(tree, "<submission>", "exec")  # Compile only; never execute.
    except (SyntaxError, ValueError, TypeError) as error:
        return failure("syntax", error)
    try: frame = ast.parse(template)
    except (SyntaxError, ValueError, TypeError): return {"ok": True}
    submitted = declarations(tree)
    classes = {n.name: n for n in tree.body if isinstance(n, ast.ClassDef)}
    assigned = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)}
    bindings = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)}
    bindings.update(n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute) and isinstance(n.ctx, ast.Store))
    definition_counts = {}
    for n in ast.walk(tree):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            definition_counts[n.name] = definition_counts.get(n.name, 0) + 1
    assigned.update(n.name for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)))
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            assigned.update(a.asname or a.name.split(".")[0] for a in node.names)
            bindings.update(a.asname or a.name.split(".")[0] for a in node.names)
    for name, required in declarations(frame).items():
        if abstract(required) or not any(unimplemented(n) for n in ast.walk(required)): continue
        # Any rebinding may replace the apparent declaration; runtime owns it.
        if name.split(".")[-1] in bindings or definition_counts.get(name.split(".")[-1], 0) > 1: continue
        actual = submitted.get(name)
        if actual is None:
            # Dynamic aliases/inheritance can supply entries; let runtime verify.
            owner = name.split(".")[0]
            if owner in assigned and owner not in classes or owner in classes and (classes[owner].bases or classes[owner].decorator_list): continue
            return failure("missing_entry", required)
        owner = classes.get(name.split(".")[0]) if "." in name else None
        if actual.decorator_list or owner is not None and (owner.decorator_list or owner.keywords): continue
        if empty(actual.body): return failure("incomplete", actual)
        if ast.dump(actual) == ast.dump(required): return failure("incomplete", actual)
        values = {}
        for node in actual.body:
            if unimplemented(node): return failure("incomplete", node)
            if isinstance(node, ast.Assign):
                value = literal(node.value, values)
                # Calls may mutate previous assignments; do not guess their effects.
                if any(isinstance(n, (ast.Call, ast.Await, ast.Yield, ast.YieldFrom, ast.NamedExpr)) for n in ast.walk(node.value)):
                    values.clear()
                for target in node.targets:
                    if isinstance(target, ast.Name): values[target.id] = value
                    else: values.clear()
            elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                value = literal(node.value, values) if node.value is not None else UNKNOWN
                if node.value is not None and any(isinstance(n, (ast.Call, ast.Await, ast.Yield, ast.YieldFrom, ast.NamedExpr)) for n in ast.walk(node.value)):
                    values.clear()
                values[node.target.id] = value
            elif isinstance(node, ast.Return):
                if not matches(literal(node.value, values), required.returns): return failure("return_format", node)
                break
            elif not (isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant)):
                values.clear()
                if terminates([node]): break
                # Do not speculate about loops, context managers, exception
                # paths, pattern matching, or nested control flow.
                simple_guard = isinstance(node, ast.If) and all(isinstance(n, (ast.Return, ast.Raise, ast.Pass))
                    for n in node.body + node.orelse)
                if isinstance(node, (ast.For, ast.AsyncFor, ast.While, ast.Try, ast.With, ast.AsyncWith, ast.Match)) or isinstance(node, ast.If) and not simple_guard:
                    break
    return {"ok": True}

if __name__ == "__main__":
    if len(sys.argv) == 3:
        code = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8-sig")
        template = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8-sig")
    else:
        request = json.load(sys.stdin)
        code, template = request["code"], request.get("template", "")
    try: result = check(code, template)
    except (RecursionError, MemoryError): result = failure("complexity")
    print(json.dumps(result), flush=True)
`

export const preflightMessages = {
  syntax: '代码语法或缩进错误，请检查报错行及其上一行',
  incomplete: '题目要求的函数尚未完成，请补齐空实现或 NotImplementedError',
  missing_entry: '缺少题目要求的函数或类方法，请保留模板入口名称',
  return_format: '返回格式不符合题目模板，请检查 None、列表、元组及字段类型',
  complexity: '代码结构过于复杂，无法完成语法检查，请简化后重试',
}
export const preservationSuffix = '；本次不计分，原有效成绩保留'
export function decodePreflight(output: string): string | undefined {
  if (Buffer.byteLength(output) > 1024) throw new Error('preflight output too large')
  const value: unknown = JSON.parse(output)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid preflight')
  const row = value as Record<string, unknown>
  if (row.ok === true && Object.keys(row).length === 1) return undefined
  if (row.ok !== false || Object.keys(row).sort().join(',') !== 'line,ok,reason' ||
      typeof row.reason !== 'string' || !Object.hasOwn(preflightMessages, row.reason) ||
      !Number.isInteger(row.line) || Number(row.line) < 1 || Number(row.line) > 100000) throw new Error('invalid preflight')
  const where = row.reason === 'missing_entry' ? '题目模板' : '提交代码'
  return `${where}第 ${row.line} 行：${preflightMessages[row.reason as keyof typeof preflightMessages]}${preservationSuffix}`
}
