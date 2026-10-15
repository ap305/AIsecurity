"""Frozen CPU execution profile for the Patch course's trainable reference models."""

PATCH_EXECUTION_PROFILE = {
    'id': 'torch-cpu-single-thread-deterministic-v1',
    'intraOpThreads': 1,
    'interOpThreads': 1,
    'deterministicAlgorithms': True,
    'mkldnnDeterministic': True,
}


def configure_patch_runtime():
    import torch

    torch.set_num_threads(PATCH_EXECUTION_PROFILE['intraOpThreads'])
    # PyTorch permits changing this setting only before inter-op work starts.
    # Avoid trying to set it again when the same process already has this profile.
    if torch.get_num_interop_threads() != PATCH_EXECUTION_PROFILE['interOpThreads']:
        torch.set_num_interop_threads(PATCH_EXECUTION_PROFILE['interOpThreads'])
    torch.use_deterministic_algorithms(True)
    torch.backends.mkldnn.deterministic = True
