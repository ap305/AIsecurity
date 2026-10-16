"""Data-only access to ML student operations. No student executable enters grader."""
from __future__ import annotations

from course_codec import pack, unpack
from platform_student import invoke


class InvalidStudentValue(ValueError):
    pass


class Bridge:
    def __init__(self, worker, role):
        if role not in ('attack', 'defense'):
            raise ValueError('Invalid frozen role')
        self.worker, self.role = worker, role

    def call(self, operation, **data):
        response = invoke(self.worker, 'course_ml_call', [self.role, operation, pack(data)])
        try:
            return unpack(response)
        except (ValueError, TypeError) as error:
            raise InvalidStudentValue('Malformed numerical student result') from error

    def function(self, name, *args, **kwargs):
        return self.call('function', name=name, args=args, kwargs=kwargs)

    def predict(self, images):
        return self.call('predict', images=images)

    def noise_defend(self, probabilities, labels):
        return self.call('noise_defend', probabilities=probabilities, labels=labels)
