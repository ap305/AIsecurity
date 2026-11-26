"""Create a private hash file for the standalone demo service."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sys


def private_json(path, value):
    with open(path, "x", encoding="utf-8", opener=lambda name, flags: os.open(name, flags, 0o600)) as f:
        json.dump(value, f)
        f.write("\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("hash_file", type=Path)
    parser.add_argument("username", nargs="?", default="demo")
    parser.add_argument("--generate", type=Path, metavar="PRIVATE_HANDOFF_FILE")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-zA-Z0-9_-]{3,32}", args.username):
        parser.error("username must be 3 to 32 letters, digits, underscores or hyphens")
    if args.generate and args.generate.resolve() == args.hash_file.resolve():
        parser.error("handoff and hash destinations must be different")
    if not args.generate and sys.stdin.isatty():
        parser.error("provide the password through stdin or use --generate")
    password = secrets.token_urlsafe(24) if args.generate else sys.stdin.read(256).removesuffix("\n").removesuffix("\r")
    if not 15 <= len(password) <= 128 or re.search(r"[\r\n\x00]", password):
        parser.error("the password must contain 15 to 128 characters on one line")
    salt = secrets.token_hex(16)
    key = hashlib.scrypt(password.encode(), salt=salt.encode("ascii"), n=16384, r=8, p=1, dklen=64)
    if args.generate:
        private_json(args.generate, {"username": args.username, "password": password})
    try:
        private_json(args.hash_file, {"username": args.username, "salt": salt, "scryptHash": key.hex()})
    except OSError:
        if args.generate:
            args.generate.unlink()
        raise


if __name__ == "__main__":
    main()
