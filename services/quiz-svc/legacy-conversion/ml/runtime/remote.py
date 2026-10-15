"""Small proxies only; student code and trained models stay inside their own worker."""
from platform_student import invoke, construct, call_method
from contracts import probability, MaterialContractError


class RemoteModel:
    def __init__(self, worker, name, **kwargs):
        self.worker = worker
        self.object = construct(worker, name, kwargs=kwargs)

    def train(self, *args, **kwargs):
        call_method(self.object, 'train', args=list(args), kwargs=kwargs)
        return self

    def fit(self, *args, **kwargs):
        answer = call_method(self.object, 'fit', args=list(args), kwargs=kwargs)
        # The RPC API returns a remote handle for both self and separately returned models.
        if answer is not None:
            self.object = answer
        return self

    def defend(self, request):
        result = call_method(self.object, 'defend', args=[request])
        if not isinstance(result, dict) or 'spoof_probability' not in result:
            raise MaterialContractError('defend must return spoof_probability')
        return {'spoof_probability': probability(result['spoof_probability'])}

    def predict(self, image):
        return probability(call_method(self.object, 'predict', args=[image]))

    def predict_many(self, images):
        import numpy as np
        values = call_method(self.object, 'predict_many', args=[images])
        if not isinstance(values, (list, tuple, np.ndarray)) or np.ndim(values) != 1 or len(values) != len(images):
            raise MaterialContractError('prediction count mismatch')
        return np.asarray([probability(v) for v in values])


class RemoteImageAttack:
    name = 'student'

    def __init__(self, worker):
        self.object = construct(worker, 'JPEGReencodeAttack', kwargs={'quality': 85, 'seed': 42})

    def apply(self, image):
        return call_method(self.object, 'apply', args=[image])


class RemoteAudioAttack:
    name = 'A_codec'

    def __init__(self, worker):
        self.object = construct(worker, 'CodecAttack')

    def attack(self, sample):
        return call_method(self.object, 'attack', args=[sample])


def function(worker, name):
    return lambda *args, **kwargs: invoke(worker, name, args=list(args), kwargs=kwargs)
