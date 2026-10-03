"""Markdown composition and native rendering share Telegram's UTF-16 entity offsets."""

import re

from telethon import types
from telethon.extensions import markdown
from telethon.helpers import add_surrogate, del_surrogate

_DELIMITERS = {
    "**": types.MessageEntityBold, "__": types.MessageEntityBold,
    "*": types.MessageEntityItalic, "_": types.MessageEntityItalic,
    "~~": types.MessageEntityStrike, "`": types.MessageEntityCode,
    "```": types.MessageEntityPre,
}
_ESCAPE = re.compile(r"([\\`*_{}\[\]()#+.!|>~<\-])")
_PROTECTED = re.compile(r"(?P<fence>`{3,})[\s\S]*?(?P=fence)|(?P<inline>`{1,2})[^\n]*?(?P=inline)|\\(?P<escaped>[\\`*_{}\[\]()#+.!|>~<\-])")


def parse_markdown(text: str):
    """Use Telethon's parser; protect literal escapes and retain fenced-code languages."""
    escaped = {}
    next_placeholder = 0xe000

    def protect(match):
        nonlocal next_placeholder
        value = match.group("escaped")
        if value is None:
            return match.group()
        while chr(next_placeholder) in text:
            next_placeholder += 1
        placeholder = chr(next_placeholder)
        next_placeholder += 1
        escaped[placeholder] = value
        return placeholder

    protected = _PROTECTED.sub(protect, text)
    delimiters = dict(_DELIMITERS)
    for run in re.findall(r"`+", protected):
        delimiters[run] = types.MessageEntityPre if len(run) >= 3 else types.MessageEntityCode
    plain, entities = markdown.parse(protected, delimiters=delimiters)
    plain = add_surrogate(plain)
    for entity in sorted((entity for entity in entities if isinstance(entity, types.MessageEntityPre)), key=lambda entity: entity.offset, reverse=True):
        body = plain[entity.offset:entity.offset + entity.length]
        language = re.match(r"^([A-Za-z0-9_+.#-]+)\n", body)
        removed = len(language.group()) if language else 1 if body.startswith("\n") else 0
        if not removed:
            continue
        entity.language = language.group(1) if language else ""
        at = entity.offset
        plain = plain[:at] + plain[at + removed:]
        for affected in entities:
            start, end = affected.offset, affected.offset + affected.length
            affected.offset = start - min(max(start - at, 0), removed)
            affected.length = end - min(max(end - at, 0), removed) - affected.offset
    for entity in entities:
        if isinstance(entity, types.MessageEntityTextUrl) and entity.url.startswith("<") and entity.url.endswith(">"):
            entity.url = entity.url[1:-1]
    entities = [entity for entity in entities if entity.length > 0]
    plain = del_surrogate(plain)
    if escaped:
        plain = "".join(escaped.get(character, character) for character in plain)
    return plain, entities


def display_markdown(text: str, entities) -> str:
    """Render only actual Telegram formatting; literal Markdown stays literal."""
    text = add_surrogate(text)
    openings, closings, code_ranges = {}, {}, []
    for entity in sorted(entities or (), key=lambda entity: (entity.offset, -entity.length)):
        start, end = entity.offset, entity.offset + entity.length
        if not 0 <= start < end <= len(text):
            continue
        body = text[start:end]
        if isinstance(entity, types.MessageEntityBold):
            opening = closing = "**"
        elif isinstance(entity, types.MessageEntityItalic):
            opening = closing = "*"
        elif isinstance(entity, types.MessageEntityStrike):
            opening = closing = "~~"
        elif isinstance(entity, (types.MessageEntityCode, types.MessageEntityPre)):
            longest = max((len(run) for run in re.findall(r"`+", body)), default=0)
            if isinstance(entity, types.MessageEntityPre):
                fence = "`" * max(3, longest + 1)
                language = (entity.language or "") if re.fullmatch(r"[A-Za-z0-9_+.#-]*", entity.language or "") else ""
                opening, closing = fence + language + "\n", "\n" + fence
            else:
                fence = "`" * (longest + 1)
                padding = " " if body.startswith(("`", " ")) or body.endswith(("`", " ")) else ""
                opening = closing = fence + padding
                closing = padding + fence
            code_ranges.append((start, end))
        elif isinstance(entity, (types.MessageEntityTextUrl, types.MessageEntityMentionName)):
            url = entity.url if isinstance(entity, types.MessageEntityTextUrl) else f"tg://user?id={entity.user_id}"
            opening, closing = "[", "](<" + url.replace("<", "%3C").replace(">", "%3E") + ">)"
        else:
            continue
        openings.setdefault(start, []).append(opening)
        closings.setdefault(end, []).insert(0, closing)
    boundaries = sorted({0, len(text), *openings, *closings})
    output = []
    for index, start in enumerate(boundaries):
        output.extend(closings.get(start, ()))
        output.extend(openings.get(start, ()))
        if index + 1 < len(boundaries):
            end = boundaries[index + 1]
            chunk = text[start:end]
            output.append(chunk if any(left <= start and end <= right for left, right in code_ranges) else _ESCAPE.sub(r"\\\1", chunk))
    return del_surrogate("".join(output))
