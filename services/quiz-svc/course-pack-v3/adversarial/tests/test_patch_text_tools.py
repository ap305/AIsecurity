from __future__ import annotations
import copy
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build
import patch_text_tools as subject

TEST_ROOT = Path(__file__).resolve().parents[5] / '.test-artifacts'


class TextToolPatchTests(unittest.TestCase):
    def setUp(self):
        TEST_ROOT.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=TEST_ROOT)
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.old, self.new = self.base / 'old', self.base / 'new'
        self.old.mkdir()
        def put(name, body):
            path = self.old / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
            return subject.digest(body)
        self.put = put
        reference = put('shared/reference.py', b'def answer(env):\n    return "original"\n')
        resource = put('shared/student.zip', b'unchanged public zip bytes\x00\x01')
        api = sorted(role + n for n in build.NUMBERS for role in ('A', 'D'))
        packages, questions, group_q, group_p, metadata = [], [], [], [], []
        for i in range(69):
            source = api[i] if i < len(api) else 'other' + str(i)
            directory = 'adversarial/packages/' + source
            files = []
            for name, body in [('grade.py', subject.ORIGINAL_ENTRYPOINT.replace('\n', '\r\n').encode('utf8')),
                               ('bot_runtime.py', b'original runtime'), ('frozen.json', b'{"seed":42}'),
                               ('course/test.py', b'original teacher'), ('public/dataset.py', b'original public helper')]:
                files.append({'path': name, 'sha256': put(directory + '/' + name, body)})
            package = {'key': 'adversarial-' + source, 'directory': directory, 'files': sorted(files, key=lambda row: row['path'])}
            packages.append(package)
            if i < len(api):
                group_package = copy.deepcopy(package)
                group_package.update(key=source, directory='packages/' + source)
                group_p.append(group_package)
        for i in range(77):
            source = api[i] if i < len(api) else 'nonapi' + str(i)
            q = {'id': 'V3-261012-' + source, 'packageKey': packages[i % 69]['key'],
                 'requiresCalibration': True, 'deploymentReady': False,
                 'definition': {'llm': {'enabled': i < 32, 'poolId': '$llm'}, 'evaluation': {
                     'version': subject.PREVIOUS_VERSION, 'baselineThreshold': 0, 'successThreshold': 1,
                     'samples': 20, 'seed': 42, 'sourceDigest': 'unchanged', 'maxModelCalls': 1000}},
                 'selfTest': {'codePath': 'shared/reference.py', 'codeSha256': reference},
                 'resources': [{'sourcePath': 'shared/student.zip', 'sha256': resource}],
                 'content': '中文原题\r\n literal [x] {x} ' + str(i)}
            questions.append(q)
            metadata.append({'sourceId': source, 'original': [i, 'raw 保留']})
            if i < 32:
                g = copy.deepcopy(q)
                g['packageKey'] = source
                g['definition']['evaluation']['baselineThreshold'] = None
                g['definition']['evaluation']['successThreshold'] = None
                group_q.append(g)
        self.root = {'requiresCalibration': True, 'deploymentReady': False, 'questions': questions, 'packages': packages}
        self.group = {'questions': group_q, 'packages': group_p}
        for name, value in [('manifest.json', self.root), ('adversarial/manifest.json', self.group),
                            ('build-evidence.json', {'questions': metadata, 'apiPools': [{'temperature': 0, 'seed': 42}]})]:
            put(name, (json.dumps(value, ensure_ascii=False, indent=2).replace('\n', '\r\n') + '\r\n').encode('utf8'))
        self.evidence = {'kind': 'synthetic offline test; not a model measurement'}

    def write_json(self, name, value):
        self.put(name, json.dumps(value, ensure_ascii=False, indent=2).encode('utf8'))

    def test_default_plan_is_read_only_and_exact_scope(self):
        before = subject.snapshot(self.old)
        report = subject.patch_build(self.old, self.new, self.evidence)
        self.assertEqual(before, subject.snapshot(self.old))
        self.assertFalse(self.new.exists())
        self.assertFalse(report['applied'])
        self.assertEqual(len(report['changedFiles']), 11)
        self.assertEqual(len(report['addedFiles']), 4)
        self.assertEqual(report['modelCalls'], 0)
        self.assertEqual(report['requiredNewPhasesForChangedQuestions'], 8)

    def test_apply_preserves_73_raw_records_65_packages_and_original_bytes(self):
        before = subject.snapshot(self.old)
        report = subject.patch_build(self.old, self.new, self.evidence, apply=True)
        after = subject.snapshot(self.new)
        self.assertEqual(before, subject.snapshot(self.old))
        changed = {name for name in before.keys() | after.keys() if before.get(name) != after.get(name)}
        self.assertEqual(changed, set(report['changedFiles']))
        self.assertEqual(report['retainedRecords'], {'questions': 73, 'packages': 65, 'groupQuestions': 28,
                                                     'groupPackages': 28, 'evidenceQuestions': 73})
        root = json.loads((self.new / 'manifest.json').read_bytes())
        for old, new in zip(self.root['questions'], root['questions']):
            expected = copy.deepcopy(old)
            if old['id'] in subject.IDS:
                expected['definition']['evaluation']['version'] = subject.VERSION
            self.assertEqual(new, expected)
        group = json.loads((self.new / 'adversarial/manifest.json').read_bytes())
        group_questions = {q['id']: q for q in group['questions']}
        for question in root['questions']:
            if question['id'] in subject.IDS:
                self.assertNotIn('textToolProtocolBoundary', question)
                self.assertEqual(group_questions[question['id']]['textToolProtocolBoundary'], subject.POLICY)
        for source in subject.SOURCES:
            folder = 'adversarial/packages/' + source
            self.assertEqual((self.new / folder / 'grade.py').read_text('utf8'), subject.entrypoint_source(source[1:]))
            self.assertEqual((self.new / folder / 'grade.py').read_bytes(), subject.entrypoint_source(source[1:]).encode('utf8'))
            self.assertEqual((self.new / folder / 'text_tool_boundary.py').read_bytes(),
                             (Path(subject.__file__).parent / 'text_tool_boundary.py').read_bytes())
            for suffix in ('bot_runtime.py', 'frozen.json', 'course/test.py', 'public/dataset.py'):
                self.assertEqual(before[folder + '/' + suffix], after[folder + '/' + suffix])
        self.assertTrue(report['originalBuildPreserved'])

    def test_no_public_zip_or_reference_rebuild_and_18_all_files_unchanged(self):
        subject.patch_build(self.old, self.new, self.evidence, apply=True)
        before, after = subject.snapshot(self.old), subject.snapshot(self.new)
        retained = [name for name in before if name.startswith('shared/') or '/A18/' in name or '/D18/' in name]
        self.assertTrue(retained)
        self.assertTrue(all(before[name] == after[name] for name in retained))

    def test_rejects_asset_tampering_before_output(self):
        self.put('adversarial/packages/A17/course/test.py', b'tampered teacher')
        with self.assertRaisesRegex(ValueError, 'package file'):
            subject.patch_build(self.old, self.new, self.evidence, apply=True)
        self.assertFalse(self.new.exists())

    def test_rejects_root_group_disagreement(self):
        row = next(p for p in self.group['packages'] if p['key'] == 'D19')
        row['files'][0]['sha256'] = '0' * 64
        self.write_json('adversarial/manifest.json', self.group)
        with self.assertRaisesRegex(ValueError, 'Root/group package'):
            subject.patch_build(self.old, self.new, self.evidence)

    def test_rejects_different_original_entrypoint_even_with_matching_hash(self):
        path = 'adversarial/packages/A17/grade.py'
        sha = self.put(path, b'import changed_runtime\n')
        for packages in (self.root['packages'], self.group['packages']):
            p = next(p for p in packages if p['key'] in ('adversarial-A17', 'A17'))
            next(f for f in p['files'] if f['path'] == 'grade.py')['sha256'] = sha
        self.write_json('manifest.json', self.root)
        self.write_json('adversarial/manifest.json', self.group)
        with self.assertRaisesRegex(ValueError, 'Original grade entrypoint'):
            subject.patch_build(self.old, self.new, self.evidence)

    def test_rejects_duplicate_metadata_records(self):
        self.group['questions'].append(copy.deepcopy(self.group['questions'][0]))
        self.write_json('adversarial/manifest.json', self.group)
        with self.assertRaisesRegex(ValueError, 'Duplicate metadata'):
            subject.patch_build(self.old, self.new, self.evidence)

    def test_rejects_output_reuse_nested_path_and_missing_evidence(self):
        for output in (self.old, self.old / 'nested', self.base):
            with self.assertRaisesRegex(ValueError, 'fresh'):
                subject.patch_build(self.old, output, self.evidence)
        with self.assertRaisesRegex(ValueError, 'evidence'):
            subject.patch_build(self.old, self.new, {})
        self.assertFalse(self.new.exists())

    def test_rejects_repatch_or_ready_manifest(self):
        subject.patch_build(self.old, self.new, self.evidence, apply=True)
        with self.assertRaisesRegex(ValueError, 'already applied'):
            subject.patch_build(self.new, self.base / 'again', self.evidence)
        self.root['deploymentReady'] = True
        self.write_json('manifest.json', self.root)
        with self.assertRaisesRegex(ValueError, 'uncalibrated'):
            subject.patch_build(self.old, self.base / 'ready', self.evidence)

    def test_rejects_existing_unlisted_helper(self):
        self.put('adversarial/packages/D17/text_tool_boundary.py', b'already present')
        with self.assertRaisesRegex(ValueError, 'already exists'):
            subject.patch_build(self.old, self.new, self.evidence)

    def make_link(self, link, target):
        try:
            os.symlink(target, link, target_is_directory=True)
        except OSError as exc:
            if getattr(exc, 'winerror', None) == 1314 or isinstance(exc, PermissionError):
                self.skipTest('Host does not permit creating directory symlinks')
            raise

    def test_rejects_dangling_output_link_before_resolve(self):
        target = self.base / 'missing-target'
        self.make_link(self.new, target)
        with self.assertRaisesRegex(ValueError, 'links or junctions'):
            subject.patch_build(self.old, self.new, self.evidence, apply=True)
        self.assertFalse(target.exists())

    def test_rejects_linked_ancestor_of_missing_output_and_report(self):
        link = self.base / 'linked-parent'
        self.make_link(link, self.old)
        with self.assertRaisesRegex(ValueError, 'links or junctions'):
            subject.patch_build(self.old, link / 'fresh', self.evidence, apply=True)
        with self.assertRaisesRegex(ValueError, 'links or junctions'):
            subject.no_links(link / 'missing' / 'report.json')
        with self.assertRaisesRegex(ValueError, 'links or junctions'):
            subject.patch_build(link, self.new, self.evidence)
        self.assertFalse((self.old / 'fresh').exists())

    def test_reparse_point_rejection_does_not_depend_on_link_creation_privilege(self):
        original = Path.lstat
        fake = self.base / 'junction'
        def lstat(path):
            if path == fake:
                return SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_file_attributes=0x400)
            return original(path)
        with patch.object(Path, 'lstat', lstat):
            with self.assertRaisesRegex(ValueError, 'links or junctions'):
                subject.no_links(fake / 'missing' / 'report.json')

    def test_missing_plain_ancestors_are_allowed(self):
        target = self.base / 'missing' / 'child' / 'output'
        self.assertEqual(subject.no_links(target), target)


if __name__ == '__main__':
    unittest.main()
