"""Local-test guard: empty model caches and loopback-only Python sockets.

This is an additional regression check, not a replacement for container
network isolation. It is never copied into production grading packages.
"""
from pathlib import Path


def configure(environment, output):
    cache = Path(output) / 'empty-model-cache'
    cache.mkdir()
    environment.update(TORCH_HOME=str(cache / 'torch'), HF_HOME=str(cache / 'hf'),
                       HF_HUB_CACHE=str(cache / 'hf-hub'),
                       TRANSFORMERS_CACHE=str(cache / 'transformers'),
                       XDG_CACHE_HOME=str(cache / 'xdg'),
                       HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')


def entrypoint(target, destination):
    target, destination = Path(target).resolve(), Path(destination).resolve()
    destination.write_text(
        "import ipaddress, runpy, sys\n"
        "def deny_external_connect(event, args):\n"
        "    if event != 'socket.connect': return\n"
        "    address = args[1]\n"
        "    host = address[0] if isinstance(address, tuple) else None\n"
        "    try: allowed = host == 'localhost' or ipaddress.ip_address(host).is_loopback\n"
        "    except ValueError: allowed = False\n"
        "    if not allowed: raise RuntimeError('offline cache regression: external socket attempted')\n"
        "sys.addaudithook(deny_external_connect)\n"
        f"sys.path.insert(0, {str(target.parent)!r})\n"
        f"sys.argv[0] = {str(target)!r}\n"
        f"runpy.run_path({str(target)!r}, run_name='__main__')\n", encoding='utf8')
    return destination
