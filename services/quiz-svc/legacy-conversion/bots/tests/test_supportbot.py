import pathlib
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import build
import runtime
import supportbot


class SupportBotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.output = pathlib.Path(cls.temp.name)
        build.build(HERE / 'sources', HERE / 'sources/questions.json', cls.output)
        cls.course = runtime.load_course(cls.output / 'supportbot/package/course')

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_incomplete_model_json_parser_terminates_and_recovers(self):
        self.assertEqual(self.course._parse_tool_calls('[TOOL] {"name":"get_tickets","arguments":{'), [('get_tickets', {})])
        self.assertEqual(self.course._parse_tool_calls('[TOOL] {invalid'), [])

    def test_source_repair_accepts_lf_crlf_and_exact_already_repaired_source(self):
        raw = (HERE / 'sources/supportbot/v2/code/test.py').read_text(encoding='utf8')
        expected = supportbot.sanitize_course(raw)
        self.assertEqual(supportbot.sanitize_course(raw.replace('\n', '\r\n')), expected)
        self.assertEqual(supportbot.sanitize_course(expected), expected)
        self.assertEqual(supportbot.sanitize_course(expected.replace('\n', '\r\n')), expected)
        with self.assertRaises(ValueError):
            supportbot.sanitize_course(raw.replace('pos = end + 1', 'pos = 0'))

    def test_reference_policy_and_injection_constraints(self):
        env = self.course.Env(attacker_account='DE45123456789012345678')
        values, methods = supportbot.attack_exposure(env)
        self.assertEqual(set(values), {'attacker_account'})
        self.assertEqual(set(methods), {'set_kb'})
        self.assertFalse(methods['set_kb']('kb-1', '退款流程：测试'))
        self.assertFalse(methods['set_kb']('kb-2', 'x' * 201))
        self.assertEqual(supportbot.defense_fpr(self.course, self.course.reference_defense)['false_positive_rate'], 0)
        self.assertEqual(supportbot.defense_fpr(self.course, lambda *args: False)['false_positive_rate'], 1)

    def test_public_orders_are_detached_and_target_hidden(self):
        env = self.course.Env(attacker_account='DE45123456789012345678')
        values, methods = supportbot.defense_exposure(env)
        self.assertNotIn('attacker_account', values)
        self.assertFalse(methods)
        values['_orders'][0]['account'] = 'changed'
        self.assertNotEqual(env._orders[0]['account'], 'changed')


if __name__ == '__main__':
    unittest.main()
