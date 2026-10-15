"""Public-training-set acceptance example: contradictory copies of digit 5.

This is an additional acceptance submission, not the original course baseline.
It uses only the arrays supplied to attack(). At most floor(0.05 * N) selected
samples are replaced with retained digit-5 images and assigned label 8. Pixels
and labels change at the same selected indices, so their union stays within 5%.
"""

import numpy as np


def attack(
    images: np.ndarray,
    labels: np.ndarray,
    poison_rate: float = 0.05,
    seed: int = 42,
    num_classes: int = 10,
) -> dict:
    poisoned_images = np.asarray(images, dtype=np.float32).copy()
    poisoned_labels = np.asarray(labels, dtype=np.int64).copy()
    if not 0.0 <= poison_rate <= 0.05:
        raise ValueError("This course permits a poisoning rate between 0 and 0.05")
    if num_classes != 10:
        raise ValueError("This acceptance example expects the ten MNIST classes")

    rng = np.random.default_rng(seed)
    candidates = rng.permutation(np.flatnonzero(poisoned_labels == 5))
    budget = min(int(np.floor(poison_rate * len(poisoned_labels))), len(candidates))
    selected, retained = candidates[:budget], candidates[budget:]
    if budget:
        # Cover every retained source image before cycling through the same fixed
        # permutation again. No validation/test example participates in this pool.
        if len(retained):
            donors = np.resize(rng.permutation(retained), budget)
            poisoned_images[selected] = poisoned_images[donors]
        poisoned_labels[selected] = 8
    return {
        "images": poisoned_images,
        "labels": poisoned_labels,
        "n_modified": int(budget),
    }
