"""Repair only the audited 27 official defense's cumulative visible-output filter."""
from __future__ import annotations
import ast
import copy
import hashlib
from pathlib import Path

VERSION = 'v3-api-cumulative-reference-20261016-v9'
ORIGINAL_DEFENSE_SHA256 = 'c0c5d107653315885d011fbd2dae4d9b35066ea14eeb02617b5e5daf717ef848'
ORIGINAL_CLASS_AST_SHA256 = '6a6d81708312c0b81f18550f69176b9223fc52dd8bb90e056b4ff5159fb68717'
POLICY = {
    'kind': 'official-defense-cumulative-visible-output-filter', 'number': '27',
    'change': 'Run the original guard first; check delivered history plus its visible result, then original refusal, then empty output.',
    'reset': 'Clear delivered history only after the original system_prompt succeeds for a new environment.',
    'originalDefenseSha256': ORIGINAL_DEFENSE_SHA256,
    'originalClassAstSha256': ORIGINAL_CLASS_AST_SHA256,
    'astCanonicalization': 'ast.dump without attributes, excluding only empty Python 3.12 type_params fields',
    'retained': ['original raw leak report, single-turn redaction, disabled-filter behavior and other fields',
                 'at most one n_filtered increment per response; exceptions propagate',
                 'six spans, eight attack queries, original leakage and utility gates',
                 'one environment for all forty utility tasks; no message-driven resets',
                 'teacher, public backend, runtime, data, model parameters and student code'],
    'requiresFreshCalibration': True,
}


def _class_ast_sha256(node):
    normalized = copy.deepcopy(node)
    for child in ast.walk(normalized):
        if 'type_params' in child._fields and getattr(child, 'type_params', None) == []:
            child._fields = tuple(field for field in child._fields if field != 'type_params')
    return hashlib.sha256(ast.dump(normalized, include_attributes=False).encode('utf8')).hexdigest()


def repair_reference(source: str) -> str:
    """Transform the exact official class; submitted student code never enters here."""
    tree = ast.parse(source)
    if len(tree.body) != 1 or not isinstance(tree.body[0], ast.ClassDef) or tree.body[0].name != 'GuardedPromptWithLeakFilter':
        raise ValueError('Expected exactly the original official cumulative defense class')
    original = tree.body[0]
    if _class_ast_sha256(original) != ORIGINAL_CLASS_AST_SHA256:
        raise ValueError('Official cumulative defense AST differs from the audited original')
    methods = {node.name: node for node in original.body if isinstance(node, ast.FunctionDef)}
    methods['__init__'].body.extend(ast.parse('self._delivered = []').body)

    class ResetAfterSuccess(ast.NodeTransformer):
        def visit_Return(self, node):
            return [ast.Assign(targets=[ast.Name(id='_original_prompt', ctx=ast.Store())], value=node.value),
                    *ast.parse('self._delivered = []\nreturn _original_prompt').body]
    ResetAfterSuccess().visit(methods['system_prompt'])

    guard = methods['guard_response']
    body = guard.body
    nested = ast.parse('def _original_single_turn():\n    pass').body[0]
    nested.body = body
    guard.body = [nested, *ast.parse('''result = _original_single_turn()
if self.use_output_filter:
    candidate = '\\n'.join([*self._delivered, result['response']])
    if ds.leak_report(candidate, self.spans)['n_leaked'] > 0:
        replacement = REFUSAL_TEXT
        if ds.leak_report('\\n'.join([*self._delivered, replacement]), self.spans)['n_leaked'] > 0:
            replacement = ''
        if not result['filtered']:
            self.n_filtered += 1
        result = dict(result, response=replacement, filtered=True, mode='refuse')
self._delivered.append(result['response'])
return result
''').body]
    return ast.unparse(ast.fix_missing_locations(tree)) + '\n'


def install_trusted_reference(course):
    module = course.reference_modules['defense']
    raw = Path(module.__file__).read_bytes()
    if hashlib.sha256(raw).hexdigest() != ORIGINAL_DEFENSE_SHA256:
        raise ValueError('Trusted cumulative defense teacher bytes differ from the audited original')
    original = next(node for node in ast.parse(raw.decode('utf-8-sig')).body
                    if isinstance(node, ast.ClassDef) and node.name == 'GuardedPromptWithLeakFilter')
    repaired = repair_reference(ast.unparse(ast.Module(body=[original], type_ignores=[])))
    cls = module.GuardedPromptWithLeakFilter
    if getattr(cls.guard_response, '__cumulative_reference_repair__', False):
        raise ValueError('Trusted cumulative defense is already repaired')
    namespace = dict(module.__dict__)
    exec(compile(repaired, '<trusted-cumulative-reference>', 'exec'), namespace)
    replacement = namespace['GuardedPromptWithLeakFilter']
    replacement.guard_response.__cumulative_reference_repair__ = True
    for name in ('__init__', 'system_prompt', 'guard_response'):
        setattr(cls, name, getattr(replacement, name))


def entrypoint_source(number='27'):
    if number != '27':
        raise ValueError('Cumulative reference entrypoint is restricted to course 27')
    return 'import sys\nfrom cumulative_reference import main\nmain(sys.argv[1], sys.argv[2])\n'


def main(context_path, output_path):
    import class_runtime
    original_loader = class_runtime.load_course
    def load_course(directory):
        course = original_loader(directory)
        install_trusted_reference(course)
        return course
    class_runtime.load_course = load_course
    try:
        return class_runtime.main(context_path, output_path)
    finally:
        class_runtime.load_course = original_loader
