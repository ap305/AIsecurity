"""Bound the original 28 reference completion queue without changing students."""
from __future__ import annotations
import ast
import copy
import hashlib
from pathlib import Path

VERSION = 'v3-api-citation-queue-20261016-v8'
ORIGINAL_ATTACK_SHA256 = 'd40bd1db07dc9d865db44276c80037e928f08785e2697fc91dc23c0c69bb8209'
ORIGINAL_CLASS_AST_SHA256 = '3a199fd16066a168101fc26b57b4c91724c273d55aea3c80b351875da1cacc9f'
POLICY = {
    'kind': 'official-citation-reference-finite-completion-queue',
    'number': '28',
    'change': 'Only citation enqueues missing[:2]; completion never requeues itself.',
    'originalAttackSha256': ORIGINAL_ATTACK_SHA256,
    'originalClassAstSha256': ORIGINAL_CLASS_AST_SHA256,
    'astCanonicalization': 'ast.dump without attributes, excluding only empty Python 3.12 type_params fields',
    'retained': ['20-query budget and seed 42', 'original queries, title parsing and order, batch adaptation',
                 'no reserved bulk budget or additional queries', 'original 40% attack qualification gate',
                 'original data, teacher, public backend, defense and model parameters',
                 'student submissions are never rewritten'],
    'requiresFreshCalibration': True,
}


def _class_ast_sha256(node):
    # Python 3.12 added empty type_params fields. They carry no semantics in
    # this pre-PEP-695 teacher; exclude only empty fields, on a private copy.
    normalized = copy.deepcopy(node)
    for child in ast.walk(normalized):
        if 'type_params' in child._fields and getattr(child, 'type_params', None) == []:
            child._fields = tuple(field for field in child._fields if field != 'type_params')
    return hashlib.sha256(ast.dump(normalized, include_attributes=False).encode('utf8')).hexdigest()


def _checked_class(source):
    tree = ast.parse(source)
    if len(tree.body) != 1 or not isinstance(tree.body[0], ast.ClassDef) or tree.body[0].name != 'EnumerativeCitationProbe':
        raise ValueError('Expected exactly the original official citation reference class')
    original = tree.body[0]
    digest = _class_ast_sha256(original)
    if digest != ORIGINAL_CLASS_AST_SHA256:
        raise ValueError('Official citation reference AST differs from the audited original')
    return tree, original


def repair_reference(source: str) -> str:
    """Transform only the audited standalone official class, never student code."""
    tree, original = _checked_class(source)
    run = next(node for node in original.body if isinstance(node, ast.FunctionDef) and node.name == 'run')
    target = ast.dump(ast.parse('pending.extend(missing[:2])').body[0], include_attributes=False)
    changed = 0

    class Repair(ast.NodeTransformer):
        def visit_Expr(self, node):
            nonlocal changed
            if ast.dump(node, include_attributes=False) == target:
                changed += 1
                condition = ast.Compare(left=ast.Name(id='technique', ctx=ast.Load()), ops=[ast.Eq()],
                                        comparators=[ast.Constant(value='citation')])
                return ast.copy_location(ast.If(test=condition, body=[node], orelse=[]), node)
            return node

    Repair().visit(run)
    if changed != 1:
        raise ValueError('Expected one audited pending-queue statement')
    return ast.unparse(ast.fix_missing_locations(tree)) + '\n'


def install_trusted_reference(course):
    """Patch the trusted original method, including D28's worker=None baseline."""
    module = course.reference_modules['attack']
    raw = Path(module.__file__).read_bytes()
    if hashlib.sha256(raw).hexdigest() != ORIGINAL_ATTACK_SHA256:
        raise ValueError('Trusted citation teacher bytes differ from the audited original')
    source = ast.parse(raw.decode('utf-8-sig'))
    original = next(node for node in source.body if isinstance(node, ast.ClassDef) and node.name == 'EnumerativeCitationProbe')
    repaired = repair_reference(ast.unparse(ast.Module(body=[original], type_ignores=[])))
    cls = module.EnumerativeCitationProbe
    if getattr(cls.run, '__citation_queue_repair__', False):
        raise ValueError('Trusted citation reference is already repaired')
    namespace = dict(module.__dict__)
    exec(compile(repaired, '<trusted-citation-reference>', 'exec'), namespace)
    method = namespace['EnumerativeCitationProbe'].run
    method.__citation_queue_repair__ = True
    cls.run = method


def entrypoint_source(number='28'):
    if number != '28':
        raise ValueError('Citation reference entrypoint is restricted to course 28')
    return 'import sys\nfrom citation_reference import main\nmain(sys.argv[1], sys.argv[2])\n'


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
