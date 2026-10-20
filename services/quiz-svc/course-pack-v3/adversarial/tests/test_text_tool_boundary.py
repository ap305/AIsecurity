from __future__ import annotations

import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bot_runtime
import text_tool_boundary as subject


class TripEnv:
    def get_all_hotels_in_city(self, city: str): return []
    def get_hotels_prices(self, hotel_names: list): return {}
    def get_rating_reviews_for_hotels(self, hotel_names: list): return {}
    def get_hotels_address(self, hotel_name: str): return ''
    def reserve_hotel(self, hotel: str, start_day: str, end_day: str): return {}
    def get_user_information(self): return {}


class ProjectEnv:
    def read_file(self, file_path: str): return ''
    def get_notes(self): return []
    def write_note(self, title: str, content: str): return {}
    def get_project_info(self, project: str): return {}
    def update_notification_target(self, project: str, target_email: str): return {}


def publisher_parser(content):
    """Original parser shape, including its pre-existing falsey compatibility."""
    marker = content.find('[TOOL]')
    if marker < 0: return None
    start, end = content.find('{', marker), content.rfind('}')
    if start < 0 or end <= start: return None
    try:
        obj = json.loads(content[start:end + 1])
    except json.JSONDecodeError:
        return None
    name, arguments = obj.get('name'), obj.get('arguments') or {}
    if not isinstance(name, str) or not isinstance(arguments, dict): return None
    return name, arguments


def course(number, parser=publisher_parser):
    return types.SimpleNamespace(Env=TripEnv if number == '17' else ProjectEnv,
                                 _parse_tool_call=parser)


def content(name, arguments):
    return '[TOOL] ' + json.dumps({'name': name, 'arguments': arguments})


class TextToolBoundaryTests(unittest.TestCase):
    def test_valid_calls_keep_original_objects_and_parser_content(self):
        for number, calls in {
            '17': [('get_all_hotels_in_city', {'city': 'Zurich'}),
                   ('get_hotels_prices', {'hotel_names': ['A', 'B']}),
                   ('get_rating_reviews_for_hotels', {'hotel_names': []}),
                   ('get_hotels_address', {'hotel_name': 'A'}),
                   ('reserve_hotel', {'hotel': 'A', 'start_day': '2024-06-10', 'end_day': '2024-06-14'}),
                   ('get_user_information', {})],
            '19': [('read_file', {'file_path': 'meeting-minutes.txt'}), ('get_notes', {}),
                   ('write_note', {'title': 'T', 'content': 'C'}),
                   ('get_project_info', {'project': 'P'}),
                   ('update_notification_target', {'project': 'P', 'target_email': 'legitimate@example.invalid'})],
        }.items():
            for value in calls:
                with self.subTest(number=number, name=value[0]):
                    parser = Mock(return_value=value)
                    loaded = course(number, parser)
                    subject.install(loaded, number)
                    self.assertIs(loaded._parse_tool_call('exact original model text'), value)
                    parser.assert_called_once_with('exact original model text')

    def test_unknown_private_noncallable_and_wrong_signatures_end_episode(self):
        fixtures = {
            '17': [('unknown', {}), ('set_review', {}), ('history', {}), ('__init__', {}),
                   ('reserve_hotel', {'hotel': 'A'}), ('get_user_information', {'extra': 1}),
                   ('get_hotels_prices', {'hotel_names': None}), ('get_all_hotels_in_city', {'city': 42})],
            '19': [('unknown', {}), ('set_file', {}), ('history', {}), ('execute_tool', {}),
                   ('read_file', {}), ('get_notes', {'extra': 1}),
                   ('read_file', {'file_path': []}), ('get_project_info', {'project': 42})],
        }
        for number, calls in fixtures.items():
            loaded = course(number)
            subject.install(loaded, number)
            for name, args in calls:
                with self.subTest(number=number, name=name, args=args):
                    self.assertIsNone(loaded._parse_tool_call(content(name, args)))

    def test_existing_falsey_arguments_and_malformed_json_are_preserved(self):
        for number, name in [('17', 'get_user_information'), ('19', 'get_notes')]:
            loaded = course(number)
            subject.install(loaded, number)
            for args in (None, False, 0, '', [], {}):
                self.assertEqual(loaded._parse_tool_call(content(name, args)), (name, {}))
            for raw in ('Finished.', '[TOOL] {bad json}', content(42, {}), content(name, [1])):
                self.assertIsNone(loaded._parse_tool_call(raw))

    def test_parser_internal_failure_is_not_reclassified(self):
        for failure in (RuntimeError('internal'), bot_runtime.CourseFailure('system_error', 'rpc')):
            loaded = course('17', Mock(side_effect=failure))
            subject.install(loaded, '17')
            with self.assertRaises(type(failure)):
                loaded._parse_tool_call('anything')

    def test_does_not_wrap_env_or_defense_execution(self):
        loaded = course('19')
        before = loaded.Env.read_file
        subject.install(loaded, '19')
        self.assertIs(loaded.Env.read_file, before)
        name, args = loaded._parse_tool_call(content('read_file', {'file_path': 'legal.txt'}))
        for failure in (RuntimeError('internal env'), bot_runtime.CourseFailure('student_error', 'defense RPC')):
            with patch.object(loaded.Env, name, side_effect=failure):
                with self.assertRaises(type(failure)):
                    getattr(loaded.Env(), name)(**args)
        # A defense hook deleting an argument remains an execution failure.
        args.clear()
        with self.assertRaises(TypeError): getattr(loaded.Env(), name)(**args)

    def test_unsupported_courses_and_changed_trusted_schema_fail_closed(self):
        loaded = course('17')
        original = loaded._parse_tool_call
        for number in ('18', '14', '20', 17):
            with self.assertRaises(ValueError): subject.install(loaded, number)
            with self.assertRaises(ValueError): subject.entrypoint_source(number)
            self.assertIs(loaded._parse_tool_call, original)
        def wrong_name(self, place: str): return []
        def wrong_type(self, city: list): return []
        def wrong_default(self, city: str = 'x'): return []
        for replacement in (wrong_name, wrong_type, wrong_default):
            with patch.object(TripEnv, 'get_all_hotels_in_city', replacement):
                with self.assertRaises(ValueError): subject.install(loaded, '17')
                self.assertIs(loaded._parse_tool_call, original)

    def test_grade_entry_installs_during_runtime_load_and_restores_after_errors(self):
        for number in subject.SUPPORTED_NUMBERS:
            loaded = course(number)
            loader = Mock(return_value=loaded)
            def run(_context, _output):
                current = bot_runtime.load_course('/trusted/course')
                self.assertIsNone(current._parse_tool_call(content('history', {})))
                raise bot_runtime.CourseFailure('system_error', 'synthetic')
            with patch.object(bot_runtime, 'load_course', loader), patch.object(bot_runtime, 'main', run):
                with self.assertRaises(bot_runtime.CourseFailure): subject.main('context.json', 'result.json', number)
                self.assertIs(bot_runtime.load_course, loader)
                loader.assert_called_once_with('/trusted/course')
            with patch.object(subject, 'main') as main, patch.object(sys, 'argv', ['grade.py', 'context.json', 'result.json']):
                exec(compile(subject.entrypoint_source(number), 'grade.py', 'exec'), {})
                main.assert_called_once_with('context.json', 'result.json', number)


if __name__ == '__main__': unittest.main()
