class JPEGReencodeAttack:
    """Acceptance example: preserve fidelity by blending the original JPEG85 result.

    Fixed from public training data only; it is separate from the unchanged
    original reference used to calibrate matchup metrics.
    """
    def __init__(self, quality=85, seed=42):
        self.codec = BaselineJPEGAttack(quality=85, seed=seed)

    def apply(self, image):
        original = np.asarray(image, dtype=np.uint8)
        compressed = self.codec.apply(original)
        return np.rint(.5 * original.astype(np.float32) + .5 * compressed.astype(np.float32)).astype(np.uint8)
