#!/usr/bin/env python3
"""Verify a local macOS release without installing it or opening an account.

Usage: mise run release:verify ARTIFACT
The verifier host needs Python 3.12+ and Apple's /usr/bin/otool and lipo.
Every application/fixture process uses only the relocated bundled runtimes.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime, timedelta


class VerificationError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise VerificationError(message)


def relative_path(name):
    require(isinstance(name, str) and name and "\\" not in name and "\0" not in name,
            f"Invalid package path: {name!r}")
    path = PurePosixPath(name)
    require(not path.is_absolute() and all(part not in ("", ".", "..") for part in name.split("/")),
            f"Unsafe package path: {name!r}")
    return Path(*path.parts)


def within(path, root):
    return path.resolve().is_relative_to(root.resolve())


def validate_link(path, root):
    target = os.readlink(path)
    require(target and not os.path.isabs(target) and "\\" not in target,
            f"Unsafe symlink: {path} -> {target!r}")
    try:
        resolved = path.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise VerificationError(f"Broken or cyclic symlink: {path} -> {target}") from exc
    require(resolved.is_relative_to(root), f"Escaping symlink: {path} -> {target}")


def package_entries(root):
    for directory, directories, files in os.walk(root, followlinks=False):
        for name in directories + files:
            path = Path(directory) / name
            mode = path.lstat().st_mode
            require(stat.S_ISDIR(mode) or stat.S_ISREG(mode) or stat.S_ISLNK(mode),
                    f"Special file is not allowed: {path}")
            if path.is_symlink():
                validate_link(path, root)
            yield path


def unpack(artifact, destination):
    """Never follow archive links while writing; validate all links before use."""
    destination.mkdir()
    if artifact.is_dir():
        source = artifact.resolve()
        entries = list(package_entries(source))
        for path in entries:
            relative = path.relative_to(source)
            out = destination / relative
            if path.is_symlink():
                continue
            if path.is_dir():
                out.mkdir(parents=True, exist_ok=True)
            else:
                out.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, out)
                out.chmod(stat.S_IMODE(path.stat().st_mode) & 0o777)
        for path in entries:
            if path.is_symlink():
                out = destination / path.relative_to(source)
                out.parent.mkdir(parents=True, exist_ok=True)
                out.symlink_to(os.readlink(path))
    else:
        require(zipfile.is_zipfile(artifact), f"Not a ZIP or package directory: {artifact}")
        with zipfile.ZipFile(artifact) as archive:
            members = {}
            for info in archive.infolist():
                name = info.filename[:-1] if info.is_dir() else info.filename
                relative = relative_path(name)
                require(relative not in members, f"Duplicate archive member: {name}")
                mode = info.external_attr >> 16
                kind = stat.S_IFMT(mode)
                require(kind in (0, stat.S_IFDIR, stat.S_IFREG, stat.S_IFLNK),
                        f"Special archive member: {name}")
                require(not (info.flag_bits & 1), f"Encrypted archive member: {name}")
                members[relative] = (info, mode)
            for relative in members:
                for parent in relative.parents:
                    if parent in members:
                        info, mode = members[parent]
                        require(info.is_dir() and not stat.S_ISLNK(mode),
                                f"Archive member has non-directory parent: {relative}")
            links = []
            for relative, (info, mode) in members.items():
                out = destination / relative
                if stat.S_ISLNK(mode):
                    links.append((out, archive.read(info).decode("utf-8")))
                elif info.is_dir():
                    out.mkdir(parents=True, exist_ok=True)
                else:
                    out.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(info) as source, out.open("xb") as target:
                        shutil.copyfileobj(source, target)
                    out.chmod((stat.S_IMODE(mode) or 0o644) & 0o777)
            for out, target in links:
                require(target and not os.path.isabs(target) and "\\" not in target,
                        f"Unsafe archive symlink: {out} -> {target!r}")
                out.parent.mkdir(parents=True, exist_ok=True)
                out.symlink_to(target)
    list(package_entries(destination.resolve()))
    candidates = [destination] + [path for path in destination.iterdir() if path.is_dir() and not path.is_symlink()]
    roots = [path for path in candidates if (path / "BUILD-INFO.json").is_file()]
    require(len(roots) == 1, "Expected exactly one package root containing BUILD-INFO.json")
    root = roots[0].resolve()
    entries = list(package_entries(root))
    # Link confinement is to the package, not merely the larger extraction directory.
    require(not any(path.name == ".smoke-client.ts" for path in entries), "Release must not ship the fixture harness")
    require(not any(path.name in (".git", ".venv", "__pycache__") for path in entries),
            "Release contains checkout/cache files")
    print(f"VERIFIED relocation: {root} (owned temporary path containing spaces)", flush=True)
    return root


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify_checksums(root):
    manifest = root / "SHA256SUMS"
    require(manifest.is_file() and not manifest.is_symlink(), "Missing regular SHA256SUMS")
    expected = {}
    for line in manifest.read_text().splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
        require(match is not None, f"Malformed SHA256SUMS record: {line!r}")
        relative = relative_path(match[2])
        require(relative not in expected and relative != Path("SHA256SUMS"),
                f"Duplicate/self-referencing checksum: {relative}")
        expected[relative] = match[1]
    files = {path.relative_to(root) for path in package_entries(root) if path.is_file()}
    files.discard(Path("SHA256SUMS"))
    require(set(expected) == files,
            f"Checksum coverage differs: missing={sorted(map(str, files - set(expected)))}, extra={sorted(map(str, set(expected) - files))}")
    for relative, checksum in expected.items():
        require(digest(root / relative) == checksum, f"SHA256 mismatch: {relative}")
    link_metadata = root / "SYMLINKS.json"
    require(link_metadata.is_file() and not link_metadata.is_symlink(), "Missing regular SYMLINKS.json")
    links = {path.relative_to(root).as_posix(): os.readlink(path) for path in package_entries(root) if path.is_symlink()}
    require(json.loads(link_metadata.read_text()) == links, "SYMLINKS.json does not exactly describe packaged links")
    print(f"VERIFIED SHA256SUMS: {len(expected)} files (including link targets); SYMLINKS.json: {len(links)} confined links", flush=True)


def run(command, *, env, cwd, timeout=60, report=True, return_stderr=False):
    if report:
        print(f"CHECK: {shlex.join(map(str, command))}", flush=True)
    process = subprocess.Popen(list(map(str, command)), cwd=cwd, env=env,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, start_new_session=True)
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        os.killpg(process.pid, signal.SIGKILL)
        stdout, stderr = process.communicate()
        if stdout:
            print(stdout, end="" if stdout.endswith("\n") else "\n", flush=True)
        if stderr:
            print(stderr, file=sys.stderr, end="" if stderr.endswith("\n") else "\n", flush=True)
        raise VerificationError(f"Command timed out after {timeout}s: {shlex.join(map(str, command))}") from exc
    if report or process.returncode:
        if stdout:
            print(stdout, end="" if stdout.endswith("\n") else "\n", flush=True)
        if stderr:
            print(stderr, file=sys.stderr, end="" if stderr.endswith("\n") else "\n", flush=True)
    require(process.returncode == 0,
            f"Command failed ({process.returncode}): {shlex.join(map(str, command))}")
    return (stdout, stderr) if return_stderr else stdout


def version_tuple(value):
    require(isinstance(value, str) and re.fullmatch(r"\d+(?:\.\d+){0,2}", value),
            f"Invalid macOS version: {value!r}")
    parts = tuple(map(int, value.split(".")))
    return parts + (0,) * (3 - len(parts))


MACHO_MAGICS = {bytes.fromhex(value) for value in (
    "feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca",
)}


def is_macho(path):
    with path.open("rb") as stream:
        return stream.read(4) in MACHO_MAGICS


def inspect_macho(root, declared_floor, env, native_metadata):
    records = {}
    for path in package_entries(root):
        if not path.is_file() or path.is_symlink() or not is_macho(path):
            continue
        architectures = run(["/usr/bin/lipo", "-archs", path], env=env, cwd=root, report=False).split()
        require("arm64" in architectures, f"Mach-O lacks arm64: {path.relative_to(root)} ({architectures})")
        load_commands = run(["/usr/bin/otool", "-arch", "arm64", "-l", path], env=env, cwd=root, report=False)
        minimums = []
        dependencies = []
        rpaths = []
        identities = []
        for block in re.split(r"Load command \d+\n", load_commands)[1:]:
            command = re.search(r"^\s*cmd (\S+)", block, re.M)
            require(command is not None, f"Cannot parse load command in {path}")
            kind = command[1]
            if kind == "LC_BUILD_VERSION":
                target_platform = re.search(r"^\s*platform (\S+)", block, re.M)
                require(target_platform and target_platform[1] in ("1", "MACOS", "macos"),
                        f"Non-macOS Mach-O: {path}")
                match = re.search(r"^\s*minos (\S+)", block, re.M)
                require(match is not None, f"Missing minos: {path}")
                minimums.append(version_tuple(match[1]))
            elif kind == "LC_VERSION_MIN_MACOSX":
                match = re.search(r"^\s*version (\S+)", block, re.M)
                require(match is not None, f"Missing macOS floor: {path}")
                minimums.append(version_tuple(match[1]))
            elif kind == "LC_RPATH":
                match = re.search(r"^\s*path (.+) \(offset \d+\)", block, re.M)
                require(match is not None, f"Cannot parse rpath: {path}")
                rpaths.append(match[1])
            elif kind in ("LC_LOAD_DYLIB", "LC_LOAD_WEAK_DYLIB", "LC_REEXPORT_DYLIB", "LC_LOAD_UPWARD_DYLIB", "LC_ID_DYLIB"):
                match = re.search(r"^\s*name (.+) \(offset \d+\)", block, re.M)
                require(match is not None, f"Cannot parse dylib load: {path}")
                (identities if kind == "LC_ID_DYLIB" else dependencies).append(match[1])
        require(minimums, f"No macOS deployment floor in {path.relative_to(root)}")
        require(max(minimums) <= version_tuple(declared_floor),
                f"Mach-O floor exceeds declared macOS {declared_floor}: {path.relative_to(root)}")
        records[path.resolve()] = {"dependencies": dependencies, "rpaths": rpaths, "identities": identities,
                                   "floor": max(minimums), "architectures": architectures}
    require(records, "Package contains no Mach-O binaries")
    described = {}
    for entry in native_metadata:
        relative = relative_path(entry["path"])
        require(relative not in described, f"Duplicate native metadata path: {relative}")
        described[relative] = entry
    actual_paths = {path.relative_to(root) for path in records}
    require(set(described) == actual_paths, "DEPENDENCIES.json native list does not exactly cover regular Mach-O files")
    for path, record in records.items():
        relative = path.relative_to(root)
        entry = described[relative]
        require(sorted(entry["architectures"]) == sorted(record["architectures"]),
                f"Native architecture metadata differs: {relative}")
        require(version_tuple(entry["minimum_macos"]) == record["floor"],
                f"Native macOS floor metadata differs: {relative}")
        require(entry["dependencies"] == record["dependencies"] and entry["rpaths"] == record["rpaths"],
                f"Native dependency/rpath metadata differs: {relative}")
        require(entry.get("install_name") == (record["identities"][0] if record["identities"] else None),
                f"Native install-name metadata differs: {relative}")
        require(re.fullmatch(r"[0-9a-f]{64}", entry.get("input_sha256", "")) and digest(path) == entry["input_sha256"] == entry.get("sha256"),
                f"Bundled Mach-O bytes differ from unchanged upstream input hash: {relative}")
    measured = max(record["floor"] for record in records.values())
    require(measured == version_tuple(declared_floor),
            f"Declared macOS floor {declared_floor} differs from measured {'.'.join(map(str, measured))}")
    require(version_tuple(platform.mac_ver()[0]) >= measured,
            f"Verification host is older than required macOS {declared_floor}")

    def system_path(value):
        return value.startswith(("/usr/lib/", "/System/Library/")) and ".." not in PurePosixPath(value).parts

    # Upstream install names/signatures are deliberately preserved. The packaged
    # scoped DYLD_LIBRARY_PATH must provide every non-system dependency basename.
    edges = 0
    for path, record in records.items():
        entry = described[path.relative_to(root)]
        non_system = {value for value in record["dependencies"] if not system_path(value)}
        require(isinstance(entry.get("bundled_dependencies"), dict) and set(entry["bundled_dependencies"]) == non_system,
                f"Bundled dependency metadata differs: {path.relative_to(root)}")
        for value in record["dependencies"]:
            if system_path(value):
                continue  # OS dylibs may reside only in Apple's shared cache.
            basename = PurePosixPath(value).name
            candidates = [root / "runtime/lib" / basename, root / "runtime/python/lib" / basename]
            if value.startswith("@loader_path/"):
                candidates.append(path.parent / value[len("@loader_path/"):])
            matches = [candidate for candidate in candidates if candidate.is_file() and within(candidate, root)]
            require(matches, f"Missing packaged dependency basename {basename!r} for {path.relative_to(root)} ({value})")
            require(matches[0].resolve() in records, f"Dependency is not packaged arm64 Mach-O: {matches[0]}")
            recorded_target = root / relative_path(entry["bundled_dependencies"][value])
            require(within(recorded_target, root) and recorded_target.is_file() and recorded_target.resolve() == matches[0].resolve(),
                    f"Bundled dependency target metadata differs for {value} in {path.relative_to(root)}")
            edges += 1
    print(f"VERIFIED Mach-O: {len(records)} arm64 files unchanged from input hashes; {edges} non-system dependency edges covered by packaged basenames; measured macOS floor {declared_floor}", flush=True)


PYTHON_PROBE = r'''
import asyncio, ctypes, importlib.metadata, json, os, pathlib, sys
import qrcode
from PIL import Image
import terngram
from terngram.tdlib import TDLib, _NativeAPI
root = pathlib.Path(os.environ["TERNGRAM_VERIFY_ROOT"]).resolve()
for module in (qrcode, Image, terngram):
    assert pathlib.Path(module.__file__).resolve().is_relative_to(root), module.__file__
assert pathlib.Path(sys.executable).resolve().is_relative_to(root), sys.executable
assert importlib.metadata.version("terngram") == os.environ["TERNGRAM_VERIFY_VERSION"]
assert sys.version.split()[0] == os.environ["TERNGRAM_VERIFY_PYTHON_VERSION"]
for name in ("qrcode", "Pillow"):
    assert importlib.metadata.version(name) == json.loads(os.environ["TERNGRAM_VERIFY_PYTHON_PACKAGES"])[name]
image = qrcode.make("terngram-offline-release-verification")
assert image.size[0] > 0
states = []
calls = []
class RestrictedAPI:
    def __init__(self):
        self.native = _NativeAPI()
    def td_create_client_id(self):
        return self.native.td_create_client_id()
    def td_send(self, client_id, raw):
        query = json.loads(raw)
        assert query["@type"] in ("getOption", "getAuthorizationState", "close"), query["@type"]
        if query["@type"] == "getOption":
            assert query["name"] == "version"
        calls.append(query["@type"])
        self.native.td_send(client_id, raw)
    def td_execute(self, raw):
        query = json.loads(raw)
        assert query["@type"] in ("setLogStream", "setLogVerbosityLevel"), query["@type"]
        return self.native.td_execute(raw)
    def td_receive(self, timeout):
        raw = self.native.td_receive(timeout)
        if raw:
            update = json.loads(raw)
            if update.get("@type") == "updateAuthorizationState":
                state = update["authorization_state"]["@type"]
                assert state in ("authorizationStateWaitTdlibParameters", "authorizationStateClosing", "authorizationStateClosed"), state
                states.append(state)
        return raw
async def updated(update):
    if update.get("@type") == "updateAuthorizationState":
        assert update["authorization_state"]["@type"] in states
async def probe():
    client = TDLib(updated, _api=RestrictedAPI())
    try:
        await asyncio.wait_for(client.start(), 15)
        version = await asyncio.wait_for(client.request({"@type": "getOption", "name": "version"}), 10)
        assert version["@type"] == "optionValueString"
        assert version["value"] == os.environ["TERNGRAM_VERIFY_TDLIB_VERSION"], version
    finally:
        await asyncio.wait_for(client.close(), 15)
    assert "authorizationStateClosed" in states, states
    assert calls == ["getOption", "getAuthorizationState", "getOption", "close"], calls
    extra_libraries = [ctypes.CDLL(str(path)) for path in sorted((root / "runtime/lib").glob("*.dylib"))]
    dyld = ctypes.CDLL(None)
    dyld._dyld_image_count.argtypes = []
    dyld._dyld_image_count.restype = ctypes.c_uint32
    dyld._dyld_get_image_name.argtypes = [ctypes.c_uint32]
    dyld._dyld_get_image_name.restype = ctypes.c_char_p
    packaged_images = set()
    for index in range(dyld._dyld_image_count()):
        raw = dyld._dyld_get_image_name(index)
        assert raw, index
        path = pathlib.Path(os.fsdecode(raw)).resolve()
        if path.is_relative_to(root):
            packaged_images.add(path)
        else:
            assert str(path).startswith(("/usr/lib/", "/System/Library/", "/System/Volumes/Preboot/Cryptexes/OS/usr/lib/", "/System/Volumes/Preboot/Cryptexes/OS/System/Library/")), f"External dyld image: {path}"
    required_images = {path.resolve() for path in (root / "runtime/lib").glob("*.dylib")}
    assert required_images <= packaged_images, required_images - packaged_images
    assert pathlib.Path(sys.executable).resolve() in packaged_images
    print("VERIFIED actual dyld images (all non-system images package-local):", json.dumps(sorted(str(path.relative_to(root)) for path in packaged_images)))
    print("VERIFIED bundled Python:", json.dumps({"python": sys.version.split()[0], "terngram": importlib.metadata.version("terngram"), "qrcode": importlib.metadata.version("qrcode"), "Pillow": importlib.metadata.version("Pillow"), "TDLib": version["value"], "authorization_states": states}))
asyncio.run(probe())
'''


def isolated_environment(directory):
    names = ("home", "config", "data", "cache", "state", "tmp", "runtime")
    paths = {name: directory / name for name in names}
    for path in paths.values():
        path.mkdir(mode=0o700)
    return {"PATH": str(paths["runtime"]), "HOME": str(paths["home"]),
            "XDG_CONFIG_HOME": str(paths["config"]), "XDG_DATA_HOME": str(paths["data"]),
            "XDG_CACHE_HOME": str(paths["cache"]), "XDG_STATE_HOME": str(paths["state"]),
            "XDG_RUNTIME_DIR": str(paths["runtime"]), "TMPDIR": str(paths["tmp"]),
            "LANG": "en_US.UTF-8", "LC_ALL": "en_US.UTF-8", "TERM": "dumb"}


def read_metadata(root, expected_version):
    info = json.loads((root / "BUILD-INFO.json").read_text())
    require(isinstance(info, dict), "BUILD-INFO.json must be an object")
    require(info.get("name") == "terngram" and info.get("version") == expected_version,
            f"Unexpected application/version metadata: {info.get('name')} {info.get('version')}")
    require(info.get("platform") == "macos" and info.get("architecture") == "arm64",
            "Release metadata must target macos/arm64")
    version_tuple(info.get("minimum_macos"))
    require(info.get("minimum_tern") == "0.4", "Release must declare Tern 0.4 minimum")
    require(info.get("signing") == "not-performed" and info.get("runtime_signatures") == "preserved-as-supplied"
            and info.get("developer_id_signed") is False and info.get("notarized") is False,
            "Release must declare no signing performed and unchanged supplied runtime signatures")
    built_at = datetime.fromisoformat(info["built_at"].replace("Z", "+00:00"))
    require(built_at.utcoffset() == timedelta(0), "Build timestamp must be UTC")
    runtimes = info["runtimes"]
    require(isinstance(runtimes, dict) and all(isinstance(runtimes.get(name), str) and runtimes[name] for name in ("python", "bun", "tdlib")),
            "Missing bundled Python/Bun/TDLib version metadata")
    dependencies = json.loads((root / "DEPENDENCIES.json").read_text())
    require(isinstance(dependencies, dict) and isinstance(dependencies.get("native"), list),
            "Missing native dependency metadata")
    require(dependencies.get("loader_policy") == {
        "strategy": "package-scoped-dyld-library-path",
        "library_paths": ["runtime/lib", "runtime/python/lib"],
        "framework_paths": ["runtime/lib"], "mach_o_modified": False, "signing_performed": False,
    }, "Unsupported loader policy: expected unchanged Mach-O with package-only DYLD paths")
    python_packages = {entry["name"].lower(): entry["version"] for entry in dependencies["python"]}
    require(all(name in python_packages for name in ("qrcode", "pillow")), "Missing qrcode/Pillow dependency versions")
    print("VERIFIED build metadata:", json.dumps(info, sort_keys=True), flush=True)
    return info, dependencies, {"qrcode": python_packages["qrcode"], "Pillow": python_packages["pillow"]}


def verify(artifact, fixture, expected_version):
    require(sys.platform == "darwin" and platform.machine() == "arm64",
            "Actual relocated runtime verification requires a native macOS arm64 host")
    for tool in ("/usr/bin/lipo", "/usr/bin/otool"):
        require(Path(tool).is_file(), f"Required Apple binary inspection tool is missing: {tool}")
    require(artifact.exists(), f"Artifact does not exist: {artifact}")
    require(fixture.is_file(), f"Fixture harness does not exist: {fixture}")
    fixture_bytes = fixture.read_bytes()
    require(b"TERNGRAM_SMOKE_PYTHON" in fixture_bytes,
            "Fixture checkout must support explicit TERNGRAM_SMOKE_PYTHON (no host uv discovery)")
    if artifact.is_file():
        sidecar = artifact.with_suffix(artifact.suffix + ".sha256")
        require(sidecar.is_file(), f"Missing archive checksum sidecar: {sidecar}")
        expected = re.fullmatch(r"([0-9a-f]{64})  " + re.escape(artifact.name) + r"\n?", sidecar.read_text())
        require(expected is not None, f"Malformed archive checksum sidecar: {sidecar}")
        require(digest(artifact) == expected[1], "Archive SHA256 differs from sidecar")
        print(f"VERIFIED archive SHA256: {expected[1]}", flush=True)
    with tempfile.TemporaryDirectory(prefix="terngram release verification ", dir="/private/tmp") as temporary:
        workspace = Path(temporary).resolve()
        root = unpack(artifact, workspace / "relocated package with spaces")
        verify_checksums(root)
        info, dependencies, python_packages = read_metadata(root, expected_version)
        isolated = workspace / "isolated environment"
        isolated.mkdir()
        env = isolated_environment(isolated)
        inspect_macho(root, info["minimum_macos"], env, dependencies["native"])
        launcher = root / "bin/terngram"
        python = root / "runtime/python/bin/python3"
        bun = root / "runtime/bin/bun"
        library = root / "runtime/lib/libtdjson.dylib"
        for executable in (launcher, python, bun):
            require(executable.is_file() and within(executable, root) and os.access(executable, os.X_OK),
                    f"Missing/non-executable packaged runtime: {executable.relative_to(root)}")
        require(library.is_file() and within(library, root), "Missing bundled libtdjson")
        # Begin with an empty owned PATH; even system-installed Python/Bun/uv are not offered.
        version = run([launcher, "--version"], env=env, cwd=workspace).strip()
        require(version == f"terngram {expected_version}", f"Launcher version differs: {version!r}")
        help_text = run([launcher, "--help"], env=env, cwd=workspace)
        require("usage: terngram" in help_text and "--data-dir" in help_text, "Launcher help is incomplete")
        print("VERIFIED launcher --version/--help with empty clean PATH and isolated HOME/XDG/TMPDIR", flush=True)
        runtime_env = env | {
            "PATH": f"{root / 'runtime/bin'}:{root / 'runtime/python/bin'}",
            "PYTHONHOME": str(root / "runtime/python"), "PYTHONPATH": str(root / "app"),
            "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1",
            "DYLD_LIBRARY_PATH": ":".join(str(root / relative_path(path)) for path in dependencies["loader_policy"]["library_paths"]),
            "DYLD_FRAMEWORK_PATH": ":".join(str(root / relative_path(path)) for path in dependencies["loader_policy"]["framework_paths"]),
            "TERNGRAM_TDLIB_LIBRARY": str(library), "TERNGRAM_VERIFY_ROOT": str(root),
            "TERNGRAM_VERIFY_VERSION": expected_version,
            "TERNGRAM_VERIFY_PYTHON_VERSION": info["runtimes"]["python"],
            "TERNGRAM_VERIFY_PYTHON_PACKAGES": json.dumps(python_packages),
            "TERNGRAM_VERIFY_TDLIB_VERSION": info["runtimes"]["tdlib"],
        }
        bun_version = run([bun, "--version"], env=runtime_env, cwd=root / "app").strip()
        require(bun_version == info["runtimes"]["bun"], f"Bun version differs from metadata: {bun_version!r}")
        probe = workspace / "bundled Python and TDLib probe.py"
        probe.write_text(PYTHON_PROBE)
        run([python, "-P", "-s", probe], env=runtime_env, cwd=root / "app")
        print("VERIFIED real TDLib C API start/getOption(version)/close; enforced request allowlist excludes parameters, credentials and account startup", flush=True)
        copied_fixture = root / "app/.smoke-client.ts"
        require(not copied_fixture.exists(), "Release unexpectedly contains the fixture harness")
        copied_fixture.write_bytes(fixture_bytes)
        fixture_env = runtime_env | {
            "TERNGRAM_SMOKE_PYTHON": str(python),
            "DYLD_PRINT_LIBRARIES": "1",
            # Existing fixtures use local worker persistence, never a native account.
            # Any accidental native connect must fail instead of reaching libtdjson.
            "TERNGRAM_TDLIB_LIBRARY": str(workspace / "native account forbidden" / "libtdjson.dylib"),
        }
        print(f"FIXTURE source: {fixture}; SHA256 {hashlib.sha256(fixture_bytes).hexdigest()}; temporary copy only", flush=True)
        output, loader_trace = run([bun, copied_fixture], env=fixture_env, cwd=root / "app", timeout=180, return_stderr=True)
        require("SMOKE PASS:" in output, "Fixture command did not report its complete SMOKE PASS")
        loaded_images = set()
        for line in loader_trace.splitlines():
            match = re.match(r"^dyld(?:\[\d+\])?:.*?(/.*)$", line)
            if not match:
                continue
            path = Path(match[1]).resolve()
            require(path.is_relative_to(root) or str(path).startswith((
                "/usr/lib/", "/System/Library/", "/System/Volumes/Preboot/Cryptexes/OS/usr/lib/",
                "/System/Volumes/Preboot/Cryptexes/OS/System/Library/",
            )), f"Fixture loaded a non-system image outside the package: {path}")
            loaded_images.add(path)
        require(bun.resolve() in loaded_images, "Bun fixture did not provide actual DYLD_PRINT_LIBRARIES executable-image evidence")
        print(f"VERIFIED Bun fixture loader trace: {len(loaded_images)} images; all non-system images package-local", flush=True)
        for path in workspace.rglob("*"):
            require(path.name != "credentials.json" and not (path.is_dir() and path.name in ("db", "files") and path.parent.name == "tdlib"),
                    f"Verification unexpectedly created account/credential data: {path}")
        print("VERIFIED existing NativeBackend/TspDocument app fixtures with bundled Bun/Python, no host uv and no native account access", flush=True)
        print("LIMITATIONS: original upstream absolute install names/signatures are preserved, not rewritten or newly signed; no Tern plugin registration or host rendering/pixel geometry; no live Telegram/account/login/delivery/cryptographic-path testing; no Developer ID/notarization or full API Terms compliance certification.", flush=True)
        print("RELEASE VERIFICATION PASS (temporary extracted package and isolated environment will be removed)", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact", type=Path, help="produced ZIP (with .zip.sha256 sidecar) or package root directory")
    parser.add_argument("fixtures", type=Path, help="source checkout or its .smoke-client.ts fixture harness")
    parser.add_argument("--expected-version", default="0.1.2")
    args = parser.parse_args()
    fixture = args.fixtures / ".smoke-client.ts" if args.fixtures.is_dir() else args.fixtures
    try:
        verify(args.artifact.resolve(), fixture.resolve(), args.expected_version)
    except (VerificationError, OSError, ValueError, KeyError, TypeError, RuntimeError, zipfile.BadZipFile) as exc:
        print(f"RELEASE VERIFICATION FAIL: {exc}", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
