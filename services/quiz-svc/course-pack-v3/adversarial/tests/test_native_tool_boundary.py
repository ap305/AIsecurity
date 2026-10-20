from __future__ import annotations
import copy
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bot_runtime
import native_tool_boundary as subject


def call(cid='call', name='query', arguments='{}'):
    return {'id': cid, 'type': 'function', 'function': {'name': name, 'arguments': arguments}}


class Agent:
    """Minimal trusted teacher interface for impossible-ledger boundary checks."""
    def __init__(self):
        self.requests = []
        self.reset()
    def reset(self):
        self._messages, self._pending = [], []
    def next_action(self): return self._pending.pop(0) if self._pending else None
    def observe(self, call_id, name, args, output):
        self._messages.append({'role': 'tool', 'tool_call_id': call_id, 'content': json.dumps(output)})
    def _chat(self, messages):
        self.requests.append(copy.deepcopy(messages))
        return {'content': 'Finished.', 'tool_calls': []}


class NativeBoundaryTests(unittest.TestCase):
    def fixture(self):
        agent = Agent()
        empty = Mock(return_value={})
        subject.install(agent, types.SimpleNamespace(_empty_output=empty))
        return agent, empty

    def select(self, agent, cid='call', name='query', fallback=False):
        agent._messages.append({'role': 'assistant', 'content': name + '()' if fallback else '',
                                'tool_calls': [] if fallback else [call(cid, name)]})
        agent._pending.append((cid, name, {}))
        return agent.next_action()

    def test_native_messages_are_deep_equal_and_transport_copy_is_independent(self):
        agent, empty = self.fixture()
        cid, name, args = self.select(agent)
        agent.observe(cid, name, args, {'actual': [1, 2]})
        previous = copy.deepcopy(agent._messages)
        agent._chat(agent._messages)
        self.assertEqual(agent.requests[-1], previous)
        self.assertEqual(agent._messages, previous)
        agent.requests[-1][0]['tool_calls'][0]['function']['name'] = 'mutation'
        self.assertEqual(agent._messages, previous)
        empty.assert_not_called()

    def test_fallback_repeated_text_id_stays_bound_to_its_own_turn(self):
        agent, empty = self.fixture()
        for name, output in [('first', {'first': 1}), ('second', {'second': 2})]:
            cid, name, args = self.select(agent, 'text_0', name, fallback=True)
            agent.observe(cid, name, args, output)
        before = copy.deepcopy(agent._messages)
        agent._chat(agent._messages)
        wire = agent.requests[-1]
        self.assertEqual([wire[index]['tool_calls'][0]['function']['name'] for index in (0, 2)], ['first', 'second'])
        self.assertEqual([json.loads(wire[index]['content']) for index in (1, 3)], [{'first': 1}, {'second': 2}])
        self.assertEqual(agent._messages, before)
        empty.assert_not_called()

    def test_reset_clears_old_actions_and_observations(self):
        agent, empty = self.fixture()
        self.select(agent, 'text_0', 'old', fallback=True)
        agent.reset()
        cid, name, args = self.select(agent, 'text_0', 'new', fallback=True)
        agent.observe(cid, name, args, {'new': 1})
        agent._chat(agent._messages)
        self.assertEqual(len(agent.requests[-1]), 2)
        self.assertEqual(agent.requests[-1][0]['tool_calls'][0]['function']['name'], 'new')
        empty.assert_not_called()

    def test_pending_and_unselected_calls_never_receive_fabricated_results(self):
        agent, empty = self.fixture()
        agent._messages = [{'role': 'assistant', 'content': '', 'tool_calls': [call('one'), call('two')]}]
        agent._pending = [('one', 'query', {}), ('two', 'query', {})]
        agent.next_action()
        with self.assertRaisesRegex(ValueError, 'pending'): agent._chat(agent._messages)
        agent._pending.clear()
        with self.assertRaisesRegex(ValueError, 'unselected'): agent._chat(agent._messages)
        self.assertEqual(agent.requests, [])
        empty.assert_not_called()

    def test_unknown_duplicate_and_missing_observation_positions_fail_closed(self):
        for mode in ('unknown_id', 'changed_id', 'duplicate_call', 'unknown_position', 'missing_position', 'duplicate_position'):
            with self.subTest(mode=mode):
                agent, empty = self.fixture()
                cid, name, args = self.select(agent)
                if mode == 'unknown_id':
                    with self.assertRaises(ValueError): agent.observe('foreign', name, args, {})
                elif mode == 'duplicate_call':
                    agent._messages[0]['tool_calls'].append(call())
                    agent._pending.append((cid, name, args))
                    agent.next_action()
                    with self.assertRaisesRegex(ValueError, 'Duplicate'): agent._chat(agent._messages)
                else:
                    agent.observe(cid, name, args, {})
                    if mode == 'changed_id': agent._messages[-1]['tool_call_id'] = 'foreign'
                    if mode == 'unknown_position': agent._messages.append({'role': 'tool', 'tool_call_id': 'foreign', 'content': '{}'})
                    if mode == 'missing_position': agent._messages.pop()
                    if mode == 'duplicate_position': agent._messages.append(copy.deepcopy(agent._messages[-1]))
                    with self.assertRaisesRegex(ValueError, 'observation'): agent._chat(agent._messages)
                self.assertEqual(agent.requests, [])
                empty.assert_not_called()

    def test_blocked_results_follow_selected_order_and_do_not_change_teacher(self):
        agent, empty = self.fixture()
        agent._messages = [{'role': 'assistant', 'content': '', 'tool_calls': [call('one', 'blocked'), call('two', 'allowed')]}]
        agent._pending = [('one', 'blocked', {}), ('two', 'allowed', {})]
        agent.next_action()
        cid, name, args = agent.next_action()
        # Legal defense rewrites must not be compared against initial arguments.
        agent.observe(cid, name, {'changed': True}, {'actual': 2})
        before = copy.deepcopy(agent._messages)
        agent._chat(agent._messages)
        wire = agent.requests[-1]
        self.assertEqual([m['tool_call_id'] for m in wire[1:]], ['one', 'two'])
        self.assertEqual(json.loads(wire[1]['content']), {})
        self.assertEqual(json.loads(wire[2]['content']), {'actual': 2})
        self.assertEqual(agent._messages, before)
        empty.assert_called_once_with('blocked')

    def test_original_action_and_observation_exceptions_escape(self):
        for source in ('next_action', 'observe'):
            for exception in (RuntimeError('internal'), bot_runtime.CourseFailure('student_error', 'RPC')):
                agent = Agent()
                setattr(agent, source, Mock(side_effect=exception))
                subject.install(agent, types.SimpleNamespace(_empty_output=Mock()))
                with self.assertRaises(type(exception)):
                    if source == 'next_action': agent.next_action()
                    else:
                        cid, name, args = self.select(agent)
                        agent.observe(cid, name, args, {})
                self.assertEqual(agent.requests, [])

    def test_entrypoint_scope_and_runtime_factory_restoration(self):
        for number in ('17', '18', '19', 20):
            with self.assertRaises(ValueError): subject.entrypoint_source(number)
        for number in subject.SUPPORTED_NUMBERS:
            factory = Mock(return_value=Agent())
            def main(_context, _result):
                bot_runtime.gateway_agent(types.SimpleNamespace(_empty_output=Mock()), number, object())
                raise bot_runtime.CourseFailure('system_error', 'fixture')
            with patch.object(bot_runtime, 'gateway_agent', factory), patch.object(bot_runtime, 'main', main):
                with self.assertRaises(bot_runtime.CourseFailure): subject.main('context.json', 'result.json', number)
                self.assertIs(bot_runtime.gateway_agent, factory)
            with patch.object(subject, 'main') as entry, patch.object(sys, 'argv', ['grade.py', 'context.json', 'result.json']):
                exec(compile(subject.entrypoint_source(number), 'grade.py', 'exec'), {})
                entry.assert_called_once_with('context.json', 'result.json', number)


if __name__ == '__main__': unittest.main()
