"""Local stdio bridge; Telegram credentials and messages are never diagnostic output."""

import argparse
import asyncio
import inspect
import json
import sys
from dataclasses import asdict, is_dataclass
from pathlib import Path

from .telegram import ClientError, TelegramService, retry_after, retry_scope

METHODS = frozenset((
    "has_credentials", "connect", "request_code", "sign_in_code", "sign_in_password",
    "me", "dialogs", "dialog", "chat_info", "message_readers", "history", "album", "send", "edit", "delete", "forward", "mark_read",
    "photo", "avatar", "load_state", "save_state", "logout", "close", "select_peer", "typing", "activity",
))
AUTH_METHODS = frozenset(("connect", "request_code", "sign_in_code", "sign_in_password", "logout", "close"))


def emit(value) -> None:
    def record(item):
        if is_dataclass(item):
            return asdict(item)
        raise TypeError("Unexpected client data")

    sys.stdout.write(json.dumps(value, default=record, ensure_ascii=False) + "\n")
    sys.stdout.flush()


async def serve(data_dir: Path) -> None:
    async def updated(update: dict) -> None:
        emit({"event": "update", **update})

    async def connection(connected: bool) -> None:
        emit({"event": "connection", "connected": connected})

    service = TelegramService(data_dir, updated, connection)
    tasks: set[asyncio.Task] = set()
    admission = asyncio.Condition()
    active = 0
    transitioning = False
    waiting_transitions = 0

    def finished(task: asyncio.Task) -> None:
        tasks.discard(task)
        if not task.cancelled():
            task.exception()  # Retrieve transport failures when stdout is gone.

    async def dispatch(request_id: int, method: str, args: list) -> None:
        nonlocal active, transitioning, waiting_transitions
        exclusive = method in AUTH_METHODS
        admitted = False
        try:
            async with admission:
                if exclusive:
                    waiting_transitions += 1
                    try:
                        await admission.wait_for(lambda: not transitioning and active == 0)
                        transitioning = True
                    finally:
                        waiting_transitions -= 1
                        admission.notify_all()
                else:
                    await admission.wait_for(lambda: not transitioning and waiting_transitions == 0)
                    active += 1
                admitted = True
            result = getattr(service, method)(*args)
            if inspect.isawaitable(result):
                result = await result
            emit({"id": request_id, "result": result})
        except ClientError as exc:
            cooldown = retry_after(exc)
            emit({"id": request_id, "error": str(exc), "error_code": service.record_error(method, exc),
                  **({"retry_after": cooldown, "retry_scope": retry_scope(exc)} if cooldown is not None else {})})
        except Exception as exc:
            cooldown = retry_after(exc)
            emit({"id": request_id, "error": "The local Telegram client could not complete this request.", "error_code": service.record_error(method, exc),
                  **({"retry_after": cooldown, "retry_scope": retry_scope(exc)} if cooldown is not None else {})})
        finally:
            if admitted:
                async with admission:
                    if exclusive:
                        transitioning = False
                    else:
                        active -= 1
                    admission.notify_all()

    try:
        while line := await asyncio.to_thread(sys.stdin.readline):
            request_id = None
            try:
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise ClientError("Invalid local client request.")
                request_id = request.get("id")
                method = request.get("method")
                args = request.get("args", [])
                if type(request_id) is not int or not isinstance(method, str) or method not in METHODS or not isinstance(args, list):
                    raise ClientError("Invalid local client request.")
                task = asyncio.create_task(dispatch(request_id, method, args))
                tasks.add(task)
                task.add_done_callback(finished)
            except ClientError as exc:
                emit({"id": request_id, "error": str(exc)})
            except Exception:
                emit({"id": request_id, "error": "The local Telegram client could not complete this request."})
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await service.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Private terngram worker, launched by the native UI.")
    parser.add_argument("--data-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        asyncio.run(serve(args.data_dir))
    except (BrokenPipeError, KeyboardInterrupt, ClientError):
        pass


if __name__ == "__main__":
    main()
