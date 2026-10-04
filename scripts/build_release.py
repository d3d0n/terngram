#!/usr/bin/env python3
"""Package existing macOS arm64 runtimes using stdlib Python; do not build/sign them.

Example (from the checkout):
  mise run build --tdlib /path/to/libtdjson.dylib
Additional builder flags are forwarded unchanged by mise.

Mach-O artifacts are copied byte-for-byte, including existing signatures and
load commands. The launcher scopes dyld library/framework lookup to the package.
Actual versions, hashes, architecture and deployment targets are recorded.
Available installed license/notice texts are retained without a completeness
claim or an external licensing/provenance input requirement.
"""

from __future__ import annotations

import argparse
import base64
import csv
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import tomllib
import zipfile


REPO = Path(__file__).resolve().parents[1]
MACHO_MAGICS = {b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca", b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca"}
SKIP_NAMES = {".git", ".venv", "__pycache__", ".DS_Store", ".cache", ".pytest_cache", ".mypy_cache", ".ruff_cache"}
SYSTEM_PREFIXES = ("/usr/lib/", "/System/Library/", "/Library/Apple/System/Library/")
PROJECT_FILES = (
    'terngram/__init__.py', 'terngram/__main__.py', 'terngram/formatting.py',
    'terngram/tdlib.py', 'terngram/telegram.py', 'terngram/worker.py',
    'terngram/ui/app.ts', 'terngram/ui/chat-dock.ts', 'terngram/ui/chat-navigation.ts',
    'terngram/ui/chat-state.ts', 'terngram/ui/command-palette.ts',
    'terngram/ui/debug-log.ts', 'terngram/ui/forward-picker.ts', 'terngram/ui/image-loader.ts',
    'terngram/ui/main.ts', 'terngram/ui/message-view.ts', 'terngram/ui/nodes.ts',
    'terngram/ui/photo-viewer.ts', 'terngram/ui/read-receipts.ts',
    'terngram/ui/reader-counts.ts', 'terngram/ui/request-cooldowns.ts',
    'terngram/ui/shortcut-help.ts', 'terngram/ui/telegram.ts',
    'pyproject.toml', 'package.json', 'bun.lock',
    'patches/@oh-my-pi%2Fpi-tui@18.4.9.patch',
)


def fail(message: str) -> None:
    raise RuntimeError(message)


def run(*args: str | Path, env: dict[str, str] | None = None) -> str:
    result = subprocess.run([str(arg) for arg in args], cwd=REPO, env=env, text=True, capture_output=True)
    if result.returncode:
        fail(f"Command failed ({result.returncode}): {' '.join(map(str, args))}\n{result.stderr.strip()}")
    return result.stdout.strip()


def digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def version_tuple(value: str) -> tuple[int, ...]:
    if not re.fullmatch(r"\d+(?:\.\d+){1,3}", value):
        fail(f"Expected a numeric release version, got {value!r}")
    parts = tuple(map(int, value.split(".")))
    return parts + (0,) * (4 - len(parts))


def require_version(name: str, actual: str, minimum: str, expected: str | None) -> None:
    if version_tuple(actual) < version_tuple(minimum):
        fail(f"{name} {actual} is below required {minimum}")
    if expected is not None and actual != expected:
        fail(f"{name} version is {actual}, not requested {expected}")


def owned_directory(path: Path, kind: str) -> Path:
    path = path.expanduser().resolve()
    if path in {Path('/'), Path.home().resolve(), REPO} or path in REPO.parents:
        fail(f"Refusing unsafe {kind} directory: {path}")
    safe_roots = (REPO / "build", REPO / "dist", Path(tempfile.gettempdir()).resolve())
    standard = any(path == root or path.is_relative_to(root) for root in safe_roots)
    marker = path / ".terngram-release-owned"
    if path.exists() and not path.is_dir():
        fail(f"{kind} is not a directory: {path}")
    if path.exists() and not standard:
        if not marker.is_file() or marker.read_text() != "terngram-release-builder\n":
            fail(f"Existing custom {kind} directory is not builder-owned: {path}; choose a new directory")
    path.mkdir(parents=True, exist_ok=True)
    if not marker.exists():
        marker.write_text("terngram-release-builder\n")
    return path


def package_paths(root: Path):
    """Yield files and symlinks without following directory symlinks."""
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs.sort()
        files.sort()
        for name in dirs[:]:
            path = Path(directory) / name
            if path.is_symlink():
                dirs.remove(name)
                yield path
        for name in files:
            yield Path(directory) / name


def copy_tree(source: Path, target: Path, origins: dict[Path, Path], *, skip: set[str] | None = None, include_roots: set[Path] | None = None) -> None:
    source = source.resolve()
    excluded = SKIP_NAMES | (skip or set())
    target.mkdir(parents=True, exist_ok=True)
    for directory, dirs, files in os.walk(source, followlinks=False):
        relative = Path(directory).relative_to(source)
        destination = target / relative
        destination.mkdir(parents=True, exist_ok=True)
        for name in dirs[:] + files:
            original = Path(directory) / name
            if include_roots is not None:
                entry = original.relative_to(source)
                if not any(entry.is_relative_to(root) or root.is_relative_to(entry) for root in include_roots):
                    if name in dirs:
                        dirs.remove(name)
                    continue
            if name in excluded or name.endswith((".pyc", ".pyo")):
                if name in dirs:
                    dirs.remove(name)
                continue
            copied = destination / name
            if original.is_symlink():
                link = os.readlink(original)
                resolved = original.resolve(strict=True)
                if os.path.isabs(link) or not resolved.is_relative_to(source):
                    fail(f"Non-relative or escaping input symlink: {original} -> {link}")
                copied.symlink_to(link, target_is_directory=resolved.is_dir())
                if name in dirs:
                    dirs.remove(name)
            elif original.is_file():
                shutil.copy2(original, copied)
                origins[copied] = original.resolve()
            elif not original.is_dir():
                fail(f"Unsupported input file: {original}")

def node_runtime_roots(node_modules: Path, project: dict) -> set[Path]:
    """Copy the installed runtime dependency graph, retaining its relative layout."""
    node_modules = node_modules.resolve()
    roots = set()
    visited = set()
    queue = [(REPO, project)]
    for requester, metadata in queue:
        required = dict(metadata.get('dependencies', {}))
        optional = metadata.get('optionalDependencies', {})
        required.update(optional)
        for name in metadata.get('peerDependencies', {}):
            if not metadata.get('peerDependenciesMeta', {}).get(name, {}).get('optional'):
                required.setdefault(name, metadata['peerDependencies'][name])
        for name in required:
            if not re.fullmatch(r'(?:@[A-Za-z0-9_.-]+/)?[A-Za-z0-9_.-]+', name):
                fail(f'Invalid installed Node dependency name: {name}')
            candidates = [parent / 'node_modules' / name for parent in (requester, *requester.parents) if parent == REPO or parent.is_relative_to(REPO)]
            directory = next((candidate for candidate in candidates if (candidate / 'package.json').is_file()), None)
            if directory is None:
                if name in optional:
                    continue
                fail(f'Missing required installed Node dependency: {name} from {requester}')
            resolved = directory.resolve(strict=True)
            if not resolved.is_relative_to(node_modules):
                fail(f'Node dependency escapes installed node_modules: {directory}')
            installed = json.loads((directory / 'package.json').read_text())
            if name in optional:
                if installed.get('os') and 'darwin' not in installed['os']:
                    continue
                if installed.get('cpu') and 'arm64' not in installed['cpu']:
                    continue
            if installed.get('name') != name:
                fail(f'Installed Node dependency identity mismatch: {directory}')
            roots.add(directory.relative_to(node_modules))
            roots.add(resolved.relative_to(node_modules))
            if resolved not in visited:
                visited.add(resolved)
                queue.append((resolved, installed))
    return roots



def copy_file(source: Path, target: Path, origins: dict[Path, Path]) -> None:
    source = source.resolve(strict=True)
    if not source.is_file():
        fail(f"Expected an input file: {source}")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    origins[target] = source


def is_macho(path: Path) -> bool:
    if path.is_symlink() or not path.is_file():
        return False
    with path.open("rb") as source:
        return source.read(4) in MACHO_MAGICS


def macho_info(path: Path) -> dict:
    arches = run("/usr/bin/lipo", "-archs", path).split()
    if arches != ["arm64"]:
        fail(f"Release is arm64-only; {path} has architecture(s) {arches}")
    loads = run("/usr/bin/otool", "-l", path)
    commands = re.split(r"\nLoad command \d+\n", "\n" + loads)[1:]
    dependencies, rpaths, minimums = [], [], []
    identifier = None
    current_version = compatibility_version = None
    for command in commands:
        match = re.search(r"^\s*cmd (\S+)", command, re.MULTILINE)
        if not match:
            continue
        kind = match.group(1)
        if kind in {"LC_LOAD_DYLIB", "LC_LOAD_WEAK_DYLIB", "LC_REEXPORT_DYLIB", "LC_LOAD_UPWARD_DYLIB", "LC_ID_DYLIB"}:
            name = re.search(r"^\s*name (.*?) \(offset \d+\)", command, re.MULTILINE)
            if not name:
                fail(f"Unparsed {kind} in {path}")
            if kind == "LC_ID_DYLIB":
                identifier = name.group(1)
                current = re.search(r"^\s*current version (\S+)", command, re.MULTILINE)
                compatible = re.search(r"^\s*compatibility version (\S+)", command, re.MULTILINE)
                current_version = current.group(1) if current else None
                compatibility_version = compatible.group(1) if compatible else None
            else:
                dependencies.append(name.group(1))
        elif kind == "LC_RPATH":
            name = re.search(r"^\s*path (.*?) \(offset \d+\)", command, re.MULTILINE)
            if not name:
                fail(f"Unparsed LC_RPATH in {path}")
            rpaths.append(name.group(1))
        elif kind in {"LC_BUILD_VERSION", "LC_VERSION_MIN_MACOSX"}:
            if kind == "LC_BUILD_VERSION":
                target = re.search(r"^\s*platform (\S+)", command, re.MULTILINE)
                if not target or target.group(1) not in {"1", "MACOS", "macos"}:
                    fail(f"Non-macOS native binary: {path}")
            value = re.search(r"^\s*(?:minos|version) (\d+(?:\.\d+)+)", command, re.MULTILINE)
            if value:
                minimums.append(value.group(1))
    if not minimums:
        fail(f"No macOS deployment target in native binary: {path}")
    return {"architectures": arches, "minimum_macos": max(minimums, key=version_tuple), "dependencies": dependencies, "rpaths": rpaths, "install_name": identifier, "current_version": current_version, "compatibility_version": compatibility_version}


def system_library(name: str) -> bool:
    return name.startswith(SYSTEM_PREFIXES)


def expand_load_path(value: str, loader: Path, executable: Path) -> Path | None:
    if value.startswith("@loader_path/"):
        return loader.parent / value.removeprefix("@loader_path/")
    if value == "@loader_path":
        return loader.parent
    if value.startswith("@executable_path/"):
        return executable.parent / value.removeprefix("@executable_path/")
    if value == "@executable_path":
        return executable.parent
    if value.startswith("/"):
        return Path(value)
    return None


def resolve_dependency(name: str, loader: Path, info: dict, executables: list[Path], executable_info: dict[Path, dict]) -> Path:
    candidates = []
    for executable in executables:
        direct = expand_load_path(name, loader, executable)
        if direct is not None:
            candidates.append(direct)
        elif name.startswith("@rpath/"):
            for rpath in info["rpaths"]:
                base = expand_load_path(rpath, loader, executable)
                if base is not None:
                    candidates.append(base / name.removeprefix("@rpath/"))
            for rpath in executable_info[executable]["rpaths"]:
                base = expand_load_path(rpath, executable, executable)
                if base is not None:
                    candidates.append(base / name.removeprefix("@rpath/"))
    found = {candidate.resolve() for candidate in candidates if candidate.is_file()}
    if len(found) != 1:
        fail(f"Cannot uniquely resolve {name!r} from {loader}; candidates: {candidates}, found: {sorted(map(str, found))}")
    return found.pop()


def bundle_native(root: Path, origins: dict[Path, Path], executables: list[Path]) -> tuple[list[dict], list[Path]]:
    executable_info = {path: macho_info(path) for path in executables}
    original_to_copy = {original: copied for copied, original in origins.items()}
    infos = {}
    queue = [path for path in package_paths(root) if is_macho(path)]
    external = []
    dependency_targets = {}
    for copied in queue:
        original = origins[copied]
        info = macho_info(original)
        infos[copied] = info
        targets = {}
        for dependency in info["dependencies"]:
            if system_library(dependency):
                targets[dependency] = dependency
                continue
            resolved = resolve_dependency(dependency, original, info, executables, executable_info)
            if system_library(str(resolved)):
                targets[dependency] = str(resolved)
                continue
            target = original_to_copy.get(resolved)
            if target is None:
                framework = next((parent for parent in resolved.parents if parent.name.endswith(".framework")), None)
                if framework is not None:
                    destination = root / "runtime/lib" / framework.name
                    if destination.exists():
                        fail(f"Conflicting external framework: {framework}")
                    before = set(origins)
                    copy_tree(framework, destination, origins)
                    for added in set(origins) - before:
                        original_to_copy[origins[added]] = added
                        if is_macho(added):
                            queue.append(added)
                    target = original_to_copy[resolved]
                else:
                    target = root / "runtime/lib" / resolved.name
                    if target.exists():
                        fail(f"Conflicting native library filename: {resolved}")
                    copy_file(resolved, target, origins)
                    original_to_copy[resolved] = target
                    if not is_macho(target):
                        fail(f"Native dependency is not Mach-O: {resolved}")
                    queue.append(target)
                external.append(resolved)
            targets[dependency] = target
        dependency_targets[copied] = targets
    inventory = []
    for copied, info in infos.items():
        bundled = {}
        for dependency, target in dependency_targets[copied].items():
            if isinstance(target, str):
                continue
            bundled[dependency] = target.relative_to(root).as_posix()
            # dyld can substitute this basename even for an unchanged absolute install name.
            alias = root / 'runtime/lib' / Path(dependency).name
            if alias != target:
                if alias.exists():
                    if alias.resolve() != target.resolve():
                        fail(f'Conflicting bundled dyld basename: {dependency}')
                else:
                    alias.symlink_to(os.path.relpath(target, alias.parent))
        original_hash = digest(origins[copied])
        copied_hash = digest(copied)
        if copied_hash != original_hash:
            fail(f'Native artifact was modified during copying: {copied}')
        inventory.append({"path": copied.relative_to(root).as_posix(), "input_sha256": original_hash, "sha256": copied_hash, "bundled_dependencies": bundled, **info})
    return inventory, external


PYTHON_QUERY = r'''
import importlib.metadata as metadata, json, platform, sys, sysconfig
packages = []
for name in ('Pillow', 'qrcode'):
    dist = metadata.distribution(name)
    if dist.files is None:
        raise RuntimeError('Distribution has no RECORD: ' + name)
    packages.append({'name': dist.metadata['Name'], 'version': dist.version,
                     'root': str(dist.locate_file('')), 'files': list(map(str, dist.files))})
print(json.dumps({'version': platform.python_version(), 'architecture': platform.machine(),
                  'implementation': platform.python_implementation(), 'base_prefix': sys.base_prefix,
                  'interpreter': getattr(sys, '_base_executable', sys.executable),
                  'stdlib': sysconfig.get_path('stdlib'), 'packages': packages}))
'''

TDLIB_QUERY = r'''
import ctypes, json, sys
library = ctypes.CDLL(sys.argv[1])
execute = library.td_json_client_execute
execute.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
execute.restype = ctypes.c_char_p
answer = json.loads(execute(None, b'{"@type":"getOption","name":"version"}'))
if answer.get('@type') != 'optionValueString':
    raise RuntimeError('TDLib did not report its version: ' + str(answer))
print(answer['value'])
'''


def write_record(base: Path, record: Path, files: list[Path]) -> None:
    rows = []
    for path in sorted(files):
        if path == record:
            continue
        raw = bytes.fromhex(digest(path))
        rows.append([path.relative_to(base).as_posix(), 'sha256=' + base64.urlsafe_b64encode(raw).rstrip(b'=').decode(), path.stat().st_size])
    rows.append([record.relative_to(base).as_posix(), '', ''])
    with record.open('w', newline='') as destination:
        csv.writer(destination).writerows(rows)


def copy_python_distribution(package: dict, site: Path, origins: dict[Path, Path]) -> dict:
    source_root = Path(package["root"]).resolve()
    copied = []
    licenses = []
    for name in package["files"]:
        relative = Path(name)
        if relative.is_absolute() or '..' in relative.parts:
            # The distributions' host-environment console entry points are not runtime inputs.
            if relative.parts[:3] == ('..', '..', '..') and relative.parts[3:4] == ('bin',):
                continue
            fail(f"Escaping distribution RECORD path: {package['name']}: {name}")
        if any(part in SKIP_NAMES for part in relative.parts) or relative.suffix in {'.pyc', '.pyo'} or relative.name in {'direct_url.json', 'uv_cache.json', 'uv_build.json'}:
            continue
        source = source_root / relative
        if not source.resolve(strict=True).is_relative_to(source_root) or source.is_symlink():
            fail(f"Unsafe distribution file: {source}")
        target = site / relative
        copy_file(source, target, origins)
        copied.append(target)
        if re.search(r'(?i)(license|copying|notice)', source.name) and source.is_file():
            licenses.append(target)
    metadata = [path for path in copied if path.name == 'METADATA' and path.parent.name.endswith('.dist-info')]
    if len(metadata) != 1:
        fail(f"Distribution metadata incomplete: {package['name']}")
    record = metadata[0].parent / 'RECORD'
    write_record(site, record, copied)
    return {"name": package['name'], "version": package['version'], "metadata": metadata[0], "licenses": licenses}


def copy_native_notices(name: str, candidates: list[Path | None], root: Path) -> dict:
    """Retain existing supplied notices only; absence never blocks local packaging."""
    sources = []
    for candidate in candidates:
        if candidate is None or not candidate.exists():
            continue
        if candidate.is_file():
            sources.append(candidate)
        else:
            sources.extend(path for path in candidate.iterdir() if path.is_file() and re.search(r'(?i)^(license|copying|notice|third.party)', path.name))
    destination = root / 'licenses/native' / re.sub(r'[^A-Za-z0-9_.-]', '_', name)
    destination.mkdir(parents=True, exist_ok=True)
    notices = []
    for index, source in enumerate(dict.fromkeys(sources)):
        target = destination / f'{index + 1:02d}-{source.name}'
        shutil.copy2(source, target)
        notices.append({"path": target.relative_to(root).as_posix(), "sha256": digest(target)})
    return {"name": name, "licenses": notices, "notice_status": "available-texts-copied" if notices else "not-present-in-supplied-artifact"}


def homebrew_root(path: Path) -> Path | None:
    return next((parent for parent in path.parents if (parent / 'INSTALL_RECEIPT.json').is_file()), None)


def assemble(args: argparse.Namespace) -> None:
    if sys.platform != 'darwin' or platform.machine() != 'arm64':
        fail('Build this arm64-only package on an Apple Silicon macOS host')
    for tool in ('lipo', 'otool'):
        if not (Path('/usr/bin') / tool).is_file():
            fail(f'Apple build tool missing: /usr/bin/{tool}; install Xcode Command Line Tools')
    project = tomllib.loads((REPO / 'pyproject.toml').read_text())['project']
    version = project['version']
    if args.expect_version != version:
        fail(f'Project version {version} differs from requested {args.expect_version}')
    plugin_source = REPO / 'packaging/tern'
    if not (plugin_source / 'plugin.toml').is_file() or not (plugin_source / 'window.luau').is_file():
        fail('Missing packaging/tern/plugin.toml or window.luau; plugin package must be supplied before building')
    manifest = tomllib.loads((plugin_source / 'plugin.toml').read_text())
    if manifest.get('schema') != 1 or manifest.get('id') != 'terngram' or manifest.get('version') != version or manifest.get('window') != 'window.luau':
        fail('Plugin manifest does not match the schema-1 Terngram release contract')
    python = args.python.expanduser().absolute()
    bun = args.bun.expanduser().resolve(strict=True)
    tdlib = args.tdlib.expanduser().resolve(strict=True)
    macho_info(python.resolve(strict=True))
    macho_info(bun)
    macho_info(tdlib)
    clean_environment = {key: value for key, value in os.environ.items() if not key.startswith(('PYTHON', 'DYLD_')) and key != '__PYVENV_LAUNCHER__'}
    clean_environment['PYTHONDONTWRITEBYTECODE'] = '1'
    python_info = json.loads(run(python, '-I', '-B', '-c', PYTHON_QUERY, env=clean_environment))
    if python_info['architecture'] != 'arm64' or python_info['implementation'] != 'CPython':
        fail(f'Unsupported Python interpreter: {python_info}')
    require_version('Python', python_info['version'], '3.12', args.expect_python_version)
    bun_version = run(bun, '--version', env=clean_environment)
    require_version('Bun', bun_version, '1.3.14', args.expect_bun_version)
    tdlib_version = run(python, '-I', '-B', '-c', TDLIB_QUERY, tdlib, env=clean_environment)
    require_version('TDLib', tdlib_version, '1.8.67', args.expect_tdlib_version)
    for package in python_info['packages']:
        minimum = '8.2' if package['name'].lower() == 'qrcode' else '1.0'
        require_version(package['name'], package['version'], minimum, None)
        if package['name'].lower() == 'qrcode' and version_tuple(package['version']) >= (9,):
            fail('qrcode must satisfy the project dependency range >=8.2,<9')
    output = owned_directory(args.output_dir, 'output')
    staging = owned_directory(args.staging_dir, 'staging')
    input_roots = [Path(python_info['base_prefix']).resolve(), REPO / 'terngram', REPO / 'node_modules', plugin_source]
    if any(directory.is_relative_to(source) for directory in (output, staging) for source in input_roots):
        fail('Output/staging directories must not be inside runtime or project source inputs')
    artifact = output / f'terngram-{version}-macos-arm64.zip'
    sidecar = artifact.with_suffix('.zip.sha256')
    if artifact.exists() or sidecar.exists():
        fail(f'Refusing to overwrite an existing release: {artifact}; choose a new --output-dir')
    root = Path(tempfile.mkdtemp(prefix=f'terngram-{version}-', dir=staging)) / 'terngram'
    root.mkdir()
    origins = {}
    for filename in ('plugin.toml', 'window.luau'):
        copy_file(plugin_source / filename, root / filename, origins)
    app = root / 'app'
    app.mkdir()
    # Explicit source whitelist: no checkout-wide copy, fixtures or user storage.
    for filename in PROJECT_FILES:
        source = REPO / filename
        if source.is_symlink():
            fail(f'Project source symlink is not allowed: {source}')
        copy_file(source, app / filename, origins)
    package_json = json.loads((app / 'package.json').read_text())
    runtime_roots = node_runtime_roots(REPO / 'node_modules', package_json)
    copy_tree(REPO / 'node_modules', app / 'node_modules', origins, include_roots=runtime_roots)
    for name, required in package_json['dependencies'].items():
        installed = json.loads((app / 'node_modules' / name / 'package.json').read_text())
        if installed['version'] != required:
            fail(f'Pinned Node dependency mismatch: {name}: {installed["version"]} != {required}')
    node_inventory = []
    for relative in sorted(runtime_roots):
        package_root = app / 'node_modules' / relative
        if package_root.is_symlink():
            continue
        path = package_root / 'package.json'
        metadata = json.loads(path.read_text())
        license_files = [item for item in path.parent.iterdir() if item.is_file() and re.search(r'(?i)(license|copying|notice)', item.name)]
        destination = root / 'licenses/node' / metadata['name']
        destination.mkdir(parents=True, exist_ok=True)
        for source in license_files:
            shutil.copy2(source, destination / source.name)
        node_inventory.append({"name": metadata['name'], "version": metadata['version'], "license": metadata.get('license'), "repository": metadata.get('repository'), "path": path.parent.relative_to(root).as_posix(), "licenses": [(destination / source.name).relative_to(root).as_posix() for source in license_files]})
    python_base = Path(python_info['base_prefix']).resolve()
    python_runtime = root / 'runtime/python'
    copy_tree(python_base / 'lib', python_runtime / 'lib', origins, skip={'site-packages', 'ensurepip', 'pkgconfig'})
    interpreter = Path(python_info['interpreter']).resolve(strict=True)
    if not interpreter.is_relative_to(python_base):
        fail('Python base interpreter is outside its reported portable base_prefix')
    copy_file(interpreter, python_runtime / 'bin/python3', origins)
    (python_runtime / 'bin/python').symlink_to('python3')
    (python_runtime / 'bin' / f'python{sys_version(python_info["version"])}').symlink_to('python3')
    site = python_runtime / 'lib' / f'python{sys_version(python_info["version"])}' / 'site-packages'
    site.mkdir()
    python_inventory = []
    for package in python_info['packages']:
        installed = copy_python_distribution(package, site, origins)
        destination = root / 'licenses/python' / installed['name']
        destination.mkdir(parents=True)
        for index, source in enumerate(installed['licenses']):
            shutil.copy2(source, destination / f'{index + 1:02d}-{source.name}')
        python_inventory.append({"name": installed['name'], "version": installed['version'], "metadata": installed['metadata'].relative_to(root).as_posix(), "licenses": [path.relative_to(root).as_posix() for path in destination.iterdir()]})
    dist_info = app / f'terngram-{version}.dist-info'
    dist_info.mkdir()
    metadata = ['Metadata-Version: 2.3', f'Name: {project["name"]}', f'Version: {version}', f'Summary: {project["description"]}', f'Requires-Python: {project["requires-python"]}']
    metadata += [f'Requires-Dist: {dependency}' for dependency in project.get('dependencies', [])]
    (dist_info / 'METADATA').write_text('\n'.join(metadata) + '\n\n')
    (dist_info / 'entry_points.txt').write_text('[console_scripts]\nterngram = terngram.__main__:main\n')
    (dist_info / 'INSTALLER').write_text('terngram-release-builder\n')
    (dist_info / 'top_level.txt').write_text('terngram\n')
    (dist_info / 'WHEEL').write_text('Wheel-Version: 1.0\nGenerator: terngram-release-builder\nRoot-Is-Purelib: true\nTag: py3-none-any\n')
    copy_file(bun, root / 'runtime/bin/bun', origins)
    copy_file(tdlib, root / 'runtime/lib/libtdjson.dylib', origins)
    copy_file(REPO / 'packaging/macos/terngram', root / 'bin/terngram', origins)
    (root / 'bin/terngram').chmod(0o755)
    native_inventory, external = bundle_native(root, origins, [interpreter, bun])
    write_record(app, dist_info / 'RECORD', list(package_paths(app / 'terngram')) + list(package_paths(dist_info)))
    known_td_notice = Path.home() / 'Library/Caches/Homebrew/tdlib--git/LICENSE_1_0.txt'
    native_notices = [
        copy_native_notices('python', [python_base, python_base / 'lib' / f'python{sys_version(python_info["version"])}'], root),
        copy_native_notices('bun', [bun.parent, bun.parent.parent], root),
        copy_native_notices('tdlib', [homebrew_root(tdlib), known_td_notice], root),
    ]
    for library in external:
        native_notices.append(copy_native_notices(library.name, [homebrew_root(library)], root))
    if args.license_file:
        native_notices.append(copy_native_notices('supplied-notices', args.license_file, root))
    floor = max((item['minimum_macos'] for item in native_inventory), key=version_tuple)
    if args.maximum_macos_floor and version_tuple(floor) > version_tuple(args.maximum_macos_floor):
        fail(f'Bundled deployment floor {floor} exceeds requested maximum {args.maximum_macos_floor}')
    build_info = {"name": project['name'], "version": version, "platform": 'macos', "architecture": 'arm64', "minimum_macos": floor, "minimum_tern": '0.4', "signing": 'not-performed', "developer_id_signed": False, "notarized": False, "runtime_signatures": 'preserved-as-supplied', "license_inventory_complete": False, "built_at": datetime.now(timezone.utc).isoformat(), "runtimes": {"python": python_info['version'], "bun": bun_version, "tdlib": tdlib_version}, "inputs": {"python": {"filename": interpreter.name, "sha256": digest(interpreter)}, "bun": {"filename": bun.name, "sha256": digest(bun)}, "tdlib": {"filename": tdlib.name, "sha256": digest(tdlib)}}}
    (root / 'BUILD-INFO.json').write_text(json.dumps(build_info, indent=2) + '\n')
    dependencies = {"python": python_inventory, "node": node_inventory, "native": native_inventory, "native_notices": native_notices, "license_inventory_complete": False, "loader_policy": {"strategy": 'package-scoped-dyld-library-path', "library_paths": ['runtime/lib', 'runtime/python/lib'], "framework_paths": ['runtime/lib'], "mach_o_modified": False, "signing_performed": False}}
    (root / 'DEPENDENCIES.json').write_text(json.dumps(dependencies, indent=2) + '\n')
    install = (REPO / 'packaging/macos/INSTALL.md').read_text().replace('@VERSION@', version).replace('@MIN_MACOS@', floor)
    (root / 'INSTALL.md').write_text(install)
    links = {}
    for path in package_paths(root):
        if path.is_symlink():
            target = os.readlink(path)
            resolved = path.resolve(strict=True)
            if os.path.isabs(target) or not resolved.is_relative_to(root):
                fail(f'Nonportable packaged symlink: {path} -> {target}')
            links[path.relative_to(root).as_posix()] = target
        if any(part in SKIP_NAMES for part in path.relative_to(root).parts) or path.suffix in {'.pyc', '.pyo'}:
            fail(f'Excluded file reached package: {path}')
    (root / 'SYMLINKS.json').write_text(json.dumps(links, indent=2, sort_keys=True) + '\n')
    checksums = [f'{digest(path)}  {path.relative_to(root).as_posix()}\n' for path in sorted(package_paths(root)) if path.is_file()]
    (root / 'SHA256SUMS').write_text(''.join(checksums))
    with zipfile.ZipFile(artifact, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
        for path in sorted(package_paths(root)):
            name = 'terngram/' + path.relative_to(root).as_posix()
            if path.is_symlink():
                entry = zipfile.ZipInfo(name)
                entry.create_system = 3
                entry.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(entry, os.readlink(path).encode())
            else:
                archive.write(path, name)
    with sidecar.open('x') as destination:
        destination.write(f'{digest(artifact)}  {artifact.name}\n')
    print(json.dumps({"archive": str(artifact), "sha256": digest(artifact), "checksum": str(sidecar), "package": str(root), "minimum_macos": floor}, indent=2))


def sys_version(version: str) -> str:
    return '.'.join(version.split('.')[:2])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--python', type=Path, default=REPO / '.venv/bin/python', help='Project interpreter with installed Pillow/qrcode; base_prefix must be portable')
    parser.add_argument('--bun', type=Path, required=True, help='Actual Bun arm64 executable')
    parser.add_argument('--tdlib', type=Path, required=True, help='Actual official libtdjson dylib (custom isolated builds supported)')
    parser.add_argument('--license-file', type=Path, action='append', default=[], help='Optional additional existing notice/license text to copy; no completeness claim')
    parser.add_argument('--output-dir', type=Path, default=REPO / 'dist', help='Output directory; never overwrite existing release files')
    parser.add_argument('--staging-dir', type=Path, default=REPO / 'build/macos-release', help='Builder-owned staging parent; each build gets a new subdirectory')
    parser.add_argument('--expect-version', default='0.1.1', help='Required project/plugin version')
    parser.add_argument('--expect-python-version', help='Optional exact interpreter version requirement')
    parser.add_argument('--expect-bun-version', help='Optional exact Bun binary version requirement')
    parser.add_argument('--expect-tdlib-version', help='Optional exact TDLib version requirement')
    parser.add_argument('--maximum-macos-floor', help='Reject an actual native deployment floor above this version; never rewrites it')
    args = parser.parse_args()
    try:
        assemble(args)
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        parser.exit(1, f'build_release: {error}\n')


if __name__ == '__main__':
    main()
