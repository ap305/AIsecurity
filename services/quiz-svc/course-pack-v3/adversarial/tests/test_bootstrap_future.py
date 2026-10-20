"""No models or private course data: exercise the real public role assembler."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

BOOTSTRAP = Path(os.environ.get('AUDIT_BOOTSTRAP_PATH',Path(__file__).resolve().parents[1] / 'bot_bootstrap.py'))


class ApiFutureAssemblyTests(unittest.TestCase):
    def test_both_roles_accept_valid_postponed_annotations_after_a_docstring(self):
        for role in ('attack', 'defense'):
            with self.subTest(role=role), tempfile.TemporaryDirectory(dir=os.environ.get('TEST_TMPDIR')) as directory:
                root=Path(directory)
                (root/'bootstrap.py').write_bytes(BOOTSTRAP.read_bytes())
                (root/'course.json').write_text(json.dumps({'number':'13','symbols':{role:['entry']}}),encoding='utf8')
                (root/('dataset_'+role+'.py')).write_text('def configure(*args): pass\n',encoding='utf8')
                (root/(role+'_backend.py')).write_text('from __future__ import annotations\nHELPER=7\n__COURSE_SLOT__=True\n',encoding='utf8')
                source='"""Public student description."""\n\n\n\n\n\n\nfrom __future__ import annotations\ndef entry(x: UnresolvedType):\n    return x+HELPER\n'
                code=root/'student.py';code.write_text(source,encoding='utf8');compile(source,str(code),'exec')
                spec=importlib.util.spec_from_file_location('synthetic_api_bootstrap',root/'bootstrap.py')
                module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
                with patch.dict(sys.modules):
                    student=module._load_role(code,role)
                    self.assertEqual(student.entry(3),10)
                    self.assertEqual(student.entry.__annotations__['x'],'UnresolvedType')

    def test_course_create_preserves_class_construction_and_public_helpers(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get('TEST_TMPDIR'))as directory:
            root=Path(directory)
            (root/'bootstrap.py').write_bytes(BOOTSTRAP.read_bytes())
            (root/'course.json').write_text(json.dumps({'number':'27','symbols':{'defense':['Guard']}}),encoding='utf8')
            (root/'dataset_defense.py').write_text('def configure(*args): pass\n',encoding='utf8')
            (root/'defense_backend.py').write_text('from __future__ import annotations\nHELPER=7\n__COURSE_SLOT__=True\n',encoding='utf8')
            code=root/'student.py';code.write_text('"""Student class."""\n'+'\n'*1024+'from __future__ import annotations\nclass Guard:\n    def __init__(self,value:UnresolvedType): self.value=value+HELPER\n',encoding='utf8')
            spec=importlib.util.spec_from_file_location('synthetic_api_class_bootstrap',root/'bootstrap.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
            with patch.dict(sys.modules):
                worker=module.load_student(code,root)
                guard=worker.course_create('defense','Guard',{'value':3},{})
                self.assertEqual(guard.value,10)
                self.assertEqual(guard.__init__.__annotations__['value'],'UnresolvedType')


if __name__=='__main__': unittest.main()
