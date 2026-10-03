"""Official TDLib JSON transport; native TDLib is an external dependency.

Requires TDLib >= 1.8.67. On macOS install ``brew install tdlib --HEAD``;
TERNGRAM_TDLIB_LIBRARY can select another official libtdjson build. The private
``_api`` constructor argument injects the four C JSON functions for offline tests.
"""

import asyncio
import ctypes
import ctypes.util
import itertools
import json
import os
import re
import sys
import threading
import weakref
from collections.abc import Awaitable, Callable
from concurrent.futures import Future as ThreadFuture


class TDLibError(Exception):
    def __init__(self, code: int, message: str, retry_after: float | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        if retry_after is None and code in (420, 429):
            match = re.search(r"\bretry after (\d+(?:\.\d+)?)\b|\bFLOOD_WAIT_(\d+)\b", message, re.IGNORECASE)
            if match:
                retry_after = float(match.group(1) or match.group(2))
        self.retry_after = retry_after


def _encode(query: dict) -> bytes:
    return json.dumps(query, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _decode(raw: bytes | str | None) -> dict:
    if raw is None:
        raise TDLibError(500, "TDLib returned no response.")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise TDLibError(500, "TDLib returned an invalid response.")
    return value


def _result(value: dict) -> dict:
    value = {key: item for key, item in value.items() if key not in ("@extra", "@client_id")}
    if value.get("@type") == "error":
        raise TDLibError(value["code"], value["message"])
    return value


class _NativeAPI:
    def __init__(self):
        configured = os.environ.get("TERNGRAM_TDLIB_LIBRARY")
        if configured:
            candidates = [os.path.expanduser(configured)]
        else:
            found = ctypes.util.find_library("tdjson")
            if sys.platform == "darwin":
                candidates = [
                    "/opt/homebrew/opt/tdlib/lib/libtdjson.dylib",
                    "/usr/local/opt/tdlib/lib/libtdjson.dylib",
                    "libtdjson.dylib",
                ]
            elif sys.platform == "win32":
                candidates = ["tdjson.dll", "libtdjson.dll"]
            else:
                candidates = ["libtdjson.so", "/usr/local/lib/libtdjson.so"]
            if found:
                candidates.insert(0, found)
        library = None
        for candidate in dict.fromkeys(candidates):
            try:
                library = ctypes.CDLL(candidate)
                break
            except OSError:
                pass
        if library is None:
            raise TDLibError(
                500,
                "Could not load the official TDLib JSON library. Install TDLib >= 1.8.67 "
                "(macOS: brew install tdlib --HEAD), or set TERNGRAM_TDLIB_LIBRARY to "
                "the full path of libtdjson.dylib, libtdjson.so, or tdjson.dll. "
                f"Tried: {', '.join(candidates)}",
            )
        try:
            self.td_create_client_id = library.td_create_client_id
            self.td_create_client_id.argtypes = []
            self.td_create_client_id.restype = ctypes.c_int
            self.td_send = library.td_send
            self.td_send.argtypes = [ctypes.c_int, ctypes.c_char_p]
            self.td_send.restype = None
            self._receive = library.td_receive
            self._receive.argtypes = [ctypes.c_double]
            self._receive.restype = ctypes.c_char_p
            self._execute = library.td_execute
            self._execute.argtypes = [ctypes.c_char_p]
            self._execute.restype = ctypes.c_char_p
        except AttributeError as exc:
            raise TDLibError(
                500,
                "The selected TDLib library lacks the modern C JSON API. Install official "
                "TDLib >= 1.8.67 (macOS: brew install tdlib --HEAD), or correct "
                "TERNGRAM_TDLIB_LIBRARY.",
            ) from exc
        self._library = library
        # Copy c_char_p results before any other call can invalidate TDLib's buffer.
        self._result_lock = threading.Lock()

    def td_receive(self, timeout: float) -> bytes | None:
        with self._result_lock:
            return self._receive(timeout)

    def td_execute(self, query: bytes) -> bytes | None:
        with self._result_lock:
            return self._execute(query)


class _Receiver:
    """A single td_receive owner, shared by all clients using the same API."""

    def __init__(self, api):
        self.api = api
        self._lock = threading.Lock()
        self._clients: dict[int, _Client] = {}
        self._thread: threading.Thread | None = None
        self._serials = itertools.count(1)
        # Disable even token-bearing internal logs before creating any client.
        self.execute({"@type": "setLogStream", "log_stream": {"@type": "logStreamEmpty"}})
        self.execute({"@type": "setLogVerbosityLevel", "new_verbosity_level": 0})

    def execute(self, query: dict) -> dict:
        return _result(_decode(self.api.td_execute(_encode(query))))

    def create(self, on_update: Callable[[dict], Awaitable[None]]) -> "_Client":
        with self._lock:
            client_id = self.api.td_create_client_id()
            if client_id <= 0:
                raise TDLibError(500, "TDLib could not create a client.")
            client = _Client(self, client_id, next(self._serials), on_update)
            self._clients[client_id] = client
            if self._thread is None:
                self._thread = threading.Thread(target=self._run, name="terngram-tdlib")
                self._thread.start()
            client.thread = self._thread
            return client

    def _run(self) -> None:
        retired: _Client | None = None
        try:
            while True:
                try:
                    raw = self.api.td_receive(0.1)
                    if raw is None:
                        continue
                    value = _decode(raw)
                except Exception:
                    with self._lock:
                        clients = tuple(self._clients.values())
                    for client in clients:
                        client.loop.call_soon_threadsafe(client.fail, "TDLib could not receive updates.")
                    # A broken boundary must not busy-spin or expose raw exception data.
                    threading.Event().wait(0.1)
                    continue
                with self._lock:
                    client = self._clients.get(value.get("@client_id"))
                    if client is None:
                        continue
                    native_closed = (
                        value.get("@type") == "updateAuthorizationState"
                        and value.get("authorization_state", {}).get("@type") == "authorizationStateClosed"
                    )
                    if native_closed:
                        del self._clients[client.client_id]
                        if not self._clients:
                            # No further receive calls from this thread; a new client can
                            # start a new receiver without overlapping native receives.
                            self._thread = None
                            retired = client
                            client.receiver_stopped = ThreadFuture()
                    client.loop.call_soon_threadsafe(client.deliver, value)
                    if retired is not None:
                        return
        finally:
            if retired is not None:
                retired.receiver_stopped.set_result(None)


class _Client:
    def __init__(self, receiver: _Receiver, client_id: int, serial: int, on_update):
        self.receiver = receiver
        self.client_id = client_id
        self.serial = serial
        self.on_update = on_update
        self.loop = asyncio.get_running_loop()
        self.thread: threading.Thread | None = None
        self.receiver_stopped: ThreadFuture | None = None
        self.pending: dict[str, asyncio.Future] = {}
        self.updates: asyncio.Queue[dict] = asyncio.Queue()
        self.ready = asyncio.Event()
        self.closed = self.loop.create_future()
        self.closing = False
        self.disposed = False
        self.failure: TDLibError | None = None
        self._requests = itertools.count(1)
        self._shutdown: asyncio.Task | None = None
        self.worker = asyncio.create_task(self._consume(), name="terngram-tdlib-updates")

    async def request(self, query: dict) -> dict:
        if self.closing or self.closed.done() or self.disposed:
            raise self.failure or TDLibError(503, "TDLib is closed.")
        extra = f"{self.serial}:{next(self._requests)}"
        raw = _encode({**query, "@extra": extra})
        future = self.loop.create_future()
        self.pending[extra] = future
        try:
            try:
                self.receiver.api.td_send(self.client_id, raw)
            except Exception as exc:
                raise TDLibError(500, "TDLib could not send the request.") from exc
            return _result(await future)
        finally:
            self.pending.pop(extra, None)

    def _reject_pending(self, error: TDLibError) -> None:
        for future in self.pending.values():
            if not future.done():
                future.set_exception(error)
        self.pending.clear()

    def deliver(self, value: dict) -> None:
        if self.disposed:
            return
        if "@extra" in value:
            extra = value["@extra"]
            future = self.pending.get(extra) if isinstance(extra, str) else None
            if future is not None and not future.done():
                future.set_result(value)
            return  # Never turn cancelled, unknown, or late replies into updates.
        update = _result(value)
        if (
            update.get("@type") == "updateAuthorizationState"
            and update.get("authorization_state", {}).get("@type") == "authorizationStateClosed"
        ):
            self._reject_pending(self.failure or TDLibError(503, "TDLib is closed."))
            if not self.closed.done():
                self.closed.set_result(None)
        self.updates.put_nowait(update)

    def fail(self, message: str) -> None:
        if self.failure is None and not self.disposed:
            self.failure = TDLibError(500, message)
            self._reject_pending(self.failure)
            self.closing = True
            self._begin_shutdown()

    def _begin_shutdown(self) -> None:
        if self._shutdown is None:
            called_from_worker = asyncio.current_task() is self.worker
            self._shutdown = asyncio.create_task(
                self._close_native(called_from_worker), name="terngram-tdlib-close",
            )
            self._shutdown.add_done_callback(self._shutdown_finished)

    def _shutdown_finished(self, task: asyncio.Task) -> None:
        if not task.cancelled():
            task.exception()  # Retrieve failures without logging request/update content.

    async def _consume(self) -> None:
        try:
            await self.ready.wait()
            while not self.closing:
                update = await self.updates.get()
                await self.on_update(update)
                if self.closed.done() and not self.updates.qsize():
                    return
        except asyncio.CancelledError:
            raise
        except Exception:
            if not self.closing and not self.closed.done():
                self.fail("TDLib update handler failed.")

    async def _close_native(self, called_from_worker: bool) -> None:
        if not self.closed.done():
            self.receiver.api.td_send(
                self.client_id,
                _encode({"@type": "close", "@extra": f"{self.serial}:close"}),
            )
        await self.closed
        if self.receiver_stopped is not None:
            await asyncio.wrap_future(self.receiver_stopped)
            # The receiver is past its final native call; join this exact retired
            # thread, never a newer client's live receiver.
            await asyncio.to_thread(self.thread.join)
        self.disposed = True
        if not called_from_worker:
            self.worker.cancel()
            await asyncio.gather(self.worker, return_exceptions=True)

    async def close(self) -> None:
        self.closing = True
        self._reject_pending(self.failure or TDLibError(503, "TDLib is closed."))
        self._begin_shutdown()
        await asyncio.shield(self._shutdown)
        if asyncio.current_task() is not self.worker:
            self.worker.cancel()
            await asyncio.gather(self.worker, return_exceptions=True)


_owner_lock = threading.Lock()
_native_receiver: _Receiver | None = None
_injected_receivers: weakref.WeakValueDictionary = weakref.WeakValueDictionary()


def _receiver(api) -> _Receiver:
    global _native_receiver
    with _owner_lock:
        if api is None:
            if _native_receiver is None:
                _native_receiver = _Receiver(_NativeAPI())
            return _native_receiver
        owner = _injected_receivers.get(api)
        if owner is None:
            owner = _Receiver(api)
            _injected_receivers[api] = owner
        return owner


class TDLib:
    """An async TDLib client with ordered updates and independently matched replies."""

    def __init__(self, on_update: Callable[[dict], Awaitable[None]], *, _api=None):
        self._on_update = on_update
        self._api = _api
        self._receiver: _Receiver | None = None
        self._client: _Client | None = None
        self._lifecycle = asyncio.Lock()

    def _owner(self) -> _Receiver:
        if self._receiver is None:
            self._receiver = _receiver(self._api)
        return self._receiver

    async def start(self) -> None:
        async with self._lifecycle:
            if self._client is not None and not self._client.disposed:
                if self._client.closing or self._client.closed.done():
                    raise TDLibError(503, "TDLib is closing; await close before restarting.")
                return
            client = self._owner().create(self._on_update)
            self._client = client
            try:
                version = await client.request({"@type": "getOption", "name": "version"})
                value = version.get("value")
                match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:[-+].*)?", value) if isinstance(value, str) else None
                if (
                    version.get("@type") != "optionValueString"
                    or match is None
                    or tuple(map(int, match.group(1, 2, 3))) < (1, 8, 67)
                ):
                    raise TDLibError(
                        500,
                        "Terngram requires official TDLib >= 1.8.67. Install "
                        "brew install tdlib --HEAD on macOS, or set TERNGRAM_TDLIB_LIBRARY "
                        "to a compatible official libtdjson build.",
                    )
                await client.request({"@type": "getAuthorizationState"})
                client.ready.set()
            except BaseException:
                await client.close()
                self._client = None
                raise

    async def request(self, query: dict) -> dict:
        client = self._client
        if client is None:
            raise TDLibError(503, "TDLib is not started.")
        return await client.request(query)

    def execute(self, query: dict) -> dict:
        return self._owner().execute(query)

    async def close(self) -> None:
        client = self._client
        if client is None:
            return
        await client.close()
        if self._client is client:
            self._client = None
