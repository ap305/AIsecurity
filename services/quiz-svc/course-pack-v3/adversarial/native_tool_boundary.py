"""Native tool transport repair for 20/21/22; publisher execution is untouched."""
from __future__ import annotations

import copy
import json

VERSION = 'v3-api-native-tools-20261016-v7'
SUPPORTED_NUMBERS = ('20', '21', '22')
POLICY = {
    'kind': 'selected-native-tool-transport-copy',
    'numbers': list(SUPPORTED_NUMBERS),
    'transport': ['Normalize flat calls to native function envelopes',
                  'Register only text fallback actions actually returned by next_action',
                  'Reply with original empty output only for selected unobserved blocked actions after pending is exhausted'],
    'retained': ['publisher source bytes and internal messages', 'environment, history and original judge',
                 'tool and defense execution order and counts', 'original model request loop without retries',
                 'native arguments parsing and execution exception propagation',
                 'model pools, parameters, samples, seed, thresholds and score formulas'],
    'requiresFreshCalibration': True,
}


def install(agent, course):
    """Observe real actions; normalize only the copy passed to the gateway."""
    actions = []
    original_reset, original_next = agent.reset, agent.next_action
    original_observe, original_chat = agent.observe, agent._chat

    def reset():
        actions.clear()
        return original_reset()

    def next_action(*args, **kwargs):
        action = original_next(*args, **kwargs)
        if action is not None:
            assistant = next((i for i in range(len(agent._messages) - 1, -1, -1)
                              if agent._messages[i]['role'] == 'assistant'), None)
            if assistant is None:
                raise ValueError('Selected tool action has no originating assistant message')
            actions.append({'assistant': assistant, 'id': action[0], 'name': action[1],
                            'arguments': copy.deepcopy(action[2]), 'observed': None})
        return action

    def observe(call_id, tool_name, tool_input, output):
        if (not actions or actions[-1]['id'] != call_id or actions[-1]['name'] != tool_name or
                actions[-1]['observed'] is not None):
            raise ValueError('Tool observation does not match the selected action')
        position = len(agent._messages)
        result = original_observe(call_id, tool_name, tool_input, output)
        if (len(agent._messages) != position + 1 or agent._messages[position].get('role') != 'tool' or
                agent._messages[position].get('tool_call_id') != call_id):
            raise ValueError('Publisher tool observation contract changed')
        actions[-1]['observed'] = position
        return result

    def chat(messages):
        if agent._pending:
            raise ValueError('Cannot send a request while selected tools remain pending')
        outgoing = copy.deepcopy(messages)
        revised, index = [], 0
        while index < len(outgoing):
            message = outgoing[index]
            if message['role'] != 'assistant':
                if message['role'] == 'tool':
                    raise ValueError('Tool result has no originating assistant message')
                revised.append(message)
                index += 1
                continue
            selected = [action for action in actions if action['assistant'] == index]
            calls = message.get('tool_calls') or []
            if calls:
                normalized = []
                for call in calls:
                    if 'function' in call:
                        normalized.append(call)
                    else:
                        normalized.append({'id': call['id'], 'type': 'function',
                                           'function': {'name': call['name'], 'arguments': call['arguments']}})
                if (len(normalized) != len(selected) or
                        any(call['id'] != action['id'] or call['function']['name'] != action['name']
                            for call, action in zip(normalized, selected))):
                    raise ValueError('Cannot fabricate results for unselected tool calls')
                message['tool_calls'] = normalized
            elif selected:
                message['tool_calls'] = [
                    {'id': action['id'], 'type': 'function',
                     'function': {'name': action['name'], 'arguments': json.dumps(action['arguments'], ensure_ascii=False)}}
                    for action in selected]
            revised.append(message)
            end = index + 1
            while end < len(outgoing) and outgoing[end]['role'] == 'tool':
                end += 1
            observed = {action['observed'] for action in selected if action['observed'] is not None}
            if observed != set(range(index + 1, end)):
                raise ValueError('Unknown or missing publisher tool observation')
            if len({action['id'] for action in selected}) != len(selected):
                raise ValueError('Duplicate tool call IDs within one assistant turn')
            for action in selected:
                if action['observed'] is not None:
                    observation = outgoing[action['observed']]
                    if observation.get('tool_call_id') != action['id']:
                        raise ValueError('Publisher tool observation ID changed')
                    revised.append(observation)
                else:
                    # In the unchanged run_episode, only pre=False skips observe
                    # and reaches the next chat. All execution exceptions escape.
                    revised.append({'role': 'tool', 'tool_call_id': action['id'],
                                    'content': json.dumps(course._empty_output(action['name']), ensure_ascii=False)})
            index = end
        return original_chat(revised)

    agent.reset, agent.next_action = reset, next_action
    agent.observe, agent._chat = observe, chat


def entrypoint_source(number):
    if number not in SUPPORTED_NUMBERS:
        raise ValueError('Native tool entrypoint is restricted to courses 20, 21 and 22')
    return ('import sys\nfrom native_tool_boundary import main\n'
            f'main(sys.argv[1], sys.argv[2], {number!r})\n')


def main(context_path, output_path, number):
    if number not in SUPPORTED_NUMBERS:
        raise ValueError('Native tool entrypoint is restricted to courses 20, 21 and 22')
    import bot_runtime
    original = bot_runtime.gateway_agent

    def gateway_agent(course, current_number, gateway, env=None):
        if current_number != number:
            raise ValueError('Native tool package number differs from its entrypoint')
        agent = original(course, current_number, gateway, env)
        install(agent, course)
        return agent

    bot_runtime.gateway_agent = gateway_agent
    try:
        return bot_runtime.main(context_path, output_path)
    finally:
        bot_runtime.gateway_agent = original
