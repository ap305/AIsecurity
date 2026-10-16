"""Exception names used by the reviewed upstream course evaluator.

The original runtime dynamically imports student modules into the grader;
this compatibility module deliberately provides no such entry point.
"""


class ConfigurationError(RuntimeError):
    pass


class SubmissionError(RuntimeError):
    pass
