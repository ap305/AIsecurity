"""Validate model-selected public tools before the original 17/19 dispatcher.

Invalid calls follow the publisher parser's existing None/end-of-episode path.
Execution, defense hooks and RPC failures remain outside this boundary.
"""
from __future__ import annotations

import inspect

VERSION = 'v3-api-text-tools-20261016-v6'
SUPPORTED_NUMBERS = ('17', '19')
POLICY = {
    'kind': 'public-text-tool-contract-boundary',
    'numbers': list(SUPPORTED_NUMBERS),
    'invalidCall': 'Return None from the original parser; end this episode and judge existing actions normally.',
    'retained': ['original teacher and parser bytes', 'original falsey arguments compatibility',
                 'valid tool names and arguments', 'existing environment actions and judge',
                 'environment/defense/RPC exception propagation', 'original model parameters and pools',
                 'fixed samples, seed, thresholds and scoring formulas', 'SupportBot 18 original protocol'],
    'requiresFreshCalibration': True,
}

# Names and types are the publisher's SYSTEM_PROMPT contract and Env signatures.
# Injection helpers such as set_review/set_file are not model-visible tools.
SCHEMAS = {
    '17': {
        'get_all_hotels_in_city': {'city': str},
        'get_hotels_prices': {'hotel_names': list},
        'get_rating_reviews_for_hotels': {'hotel_names': list},
        'get_hotels_address': {'hotel_name': str},
        'reserve_hotel': {'hotel': str, 'start_day': str, 'end_day': str},
        'get_user_information': {},
    },
    '19': {
        'read_file': {'file_path': str},
        'get_notes': {},
        'write_note': {'title': str, 'content': str},
        'get_project_info': {'project': str},
        'update_notification_target': {'project': str, 'target_email': str},
    },
}


def install(course, number):
    """Wrap only the selected trusted course parser; never wrap tool execution."""
    if number not in SUPPORTED_NUMBERS:
        raise ValueError('Text tool boundary is restricted to courses 17 and 19')
    schemas = SCHEMAS[number]
    signatures = {}
    for name, schema in schemas.items():
        signature = inspect.signature(getattr(course.Env, name))
        if tuple(signature.parameters) != ('self', *schema):
            raise ValueError('Trusted public tool signature changed')
        for key, parameter in signature.parameters.items():
            if (parameter.kind != inspect.Parameter.POSITIONAL_OR_KEYWORD or
                    parameter.default is not inspect.Parameter.empty):
                raise ValueError('Trusted public tool signature changed')
            if key != 'self' and parameter.annotation not in (schema[key], schema[key].__name__):
                raise ValueError('Trusted public tool type declaration changed')
        signatures[name] = signature
    original = course._parse_tool_call

    def parse(content):
        call = original(content)
        if call is None:
            return None
        name, arguments = call
        if name not in schemas:
            return None
        try:
            signatures[name].bind(None, **arguments)
        except TypeError:
            return None
        if any(not isinstance(arguments[key], expected) for key, expected in schemas[name].items()):
            return None
        # Preserve the original tuple and argument dictionary without coercion.
        return call

    course._parse_tool_call = parse


def entrypoint_source(number):
    if number not in SUPPORTED_NUMBERS:
        raise ValueError('Text tool entrypoint is restricted to courses 17 and 19')
    return ('import sys\nfrom text_tool_boundary import main\n'
            f'main(sys.argv[1], sys.argv[2], {number!r})\n')


def main(context_path, output_path, number):
    """Install at course loading, inside the runtime's normal error handling."""
    if number not in SUPPORTED_NUMBERS:
        raise ValueError('Text tool entrypoint is restricted to courses 17 and 19')
    import bot_runtime
    original_loader = bot_runtime.load_course

    def load_course(directory):
        course = original_loader(directory)
        install(course, number)
        return course

    bot_runtime.load_course = load_course
    try:
        return bot_runtime.main(context_path, output_path)
    finally:
        bot_runtime.load_course = original_loader
