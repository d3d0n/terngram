"""Compose Markdown and render TDLib entities using Telegram's UTF-16 offsets.

The compose dialect is intentionally independent of TDLib Markdown versions:
**/__ bold, */_ italic, ~~ strike, backtick code, fenced code, and links.
"""

import re

_DELIMITERS = {
    "**": "textEntityTypeBold", "__": "textEntityTypeBold",
    "*": "textEntityTypeItalic", "_": "textEntityTypeItalic",
    "~~": "textEntityTypeStrikethrough",
}
_ESCAPE = re.compile(r"([\\`*_{}\[\]()#+.!|>~<\-])")
_LANGUAGE = re.compile(r"[A-Za-z0-9_+.#-]+")


def _units(text: str) -> int:
    return sum(2 if ord(character) > 0xffff else 1 for character in text)


def _entity(offset: int, length: int, kind: str, **fields) -> dict:
    return {"@type": "textEntity", "offset": offset, "length": length,
            "type": {"@type": kind, **fields}}


def parse_markdown(text: str) -> tuple[str, list[dict]]:
    """Parse the compose dialect without a native library or network access."""
    def scan(start, stop=None):
        parts, entities, length = [], [], 0
        index = start

        def append(body, nested=(), kind=None, fields=None):
            nonlocal length
            size = _units(body)
            parts.append(body)
            if size and kind:
                entities.append(_entity(length, size, kind, **(fields or {})))
            for entity in nested:
                entities.append({**entity, "offset": entity["offset"] + length})
            length += size

        while index < len(text):
            doubled = stop in {"*", "_"} and text.startswith(stop * 2, index) and not text.startswith(stop * 3, index)
            if stop and text.startswith(stop, index) and not doubled:
                return "".join(parts), entities, index + len(stop), True
            character = text[index]
            if character == "\\" and index + 1 < len(text) and _ESCAPE.fullmatch(text[index + 1]):
                append(text[index + 1])
                index += 2
                continue
            if character == "`":
                run = re.match(r"`+", text[index:]).group()
                # A delimiter must be a complete run, not part of a longer one.
                end = index + len(run)
                match = re.search(r"(?<!`)" + re.escape(run) + r"(?!`)", text[end:])
                if match:
                    closing = end + match.start()
                    body = text[end:closing]
                    if len(run) >= 3:
                        language, separator, rest = body.partition("\n")
                        fields = {}
                        kind = "textEntityTypePre"
                        if separator and (_LANGUAGE.fullmatch(language) or not language):
                            body = rest
                            if language:
                                kind, fields = "textEntityTypePreCode", {"language": language}
                        if body.endswith("\n"):
                            body = body[:-1]
                        append(body, kind=kind, fields=fields)
                    else:
                        if body.startswith(" ") and body.endswith(" ") and body.strip():
                            body = body[1:-1]
                        append(body, kind="textEntityTypeCode")
                    index = closing + len(run)
                    continue
                append(run)
                index += len(run)
                continue
            if character == "[":
                # Balance labels and destinations so escaped brackets and URL
                # parentheses remain usable, including display's <URL> form.
                depth, cursor = 1, index + 1
                while cursor < len(text) and depth:
                    if text[cursor] == "\\":
                        cursor += 2
                        continue
                    depth += (text[cursor] == "[") - (text[cursor] == "]")
                    cursor += 1
                label_end = cursor - 1
                if not depth and text[cursor:cursor + 1] == "(":
                    url_start = cursor + 1
                    if text[url_start:url_start + 1] == "<":
                        url_end = text.find(">)", url_start + 1)
                        closing = url_end + 2
                        url = text[url_start + 1:url_end]
                    else:
                        depth, cursor = 1, url_start
                        while cursor < len(text) and depth:
                            if text[cursor] == "\\":
                                cursor += 2
                                continue
                            depth += (text[cursor] == "(") - (text[cursor] == ")")
                            cursor += 1
                        url_end = cursor - 1 if not depth else -1
                        closing = cursor
                        url = text[url_start:url_end]
                    if url_end >= url_start:
                        body, nested = parse_markdown(text[index + 1:label_end])
                        url = re.sub(r"\\([\\()])", r"\1", url)
                        append(body, nested, "textEntityTypeTextUrl", {"url": url})
                        index = closing
                        continue
            delimiter = next((token for token in _DELIMITERS if text.startswith(token, index)), None)
            if delimiter:
                body, nested, end, closed = scan(index + len(delimiter), delimiter)
                if closed:
                    append(body, nested, _DELIMITERS[delimiter])
                    index = end
                    continue
                append(delimiter)
                index += len(delimiter)
                continue
            append(character)
            index += 1
        return "".join(parts), entities, index, False

    plain, entities, _, _ = scan(0)
    return plain, entities


def display_markdown(text: str, entities: list[dict] | None) -> str:
    """Render real TDLib formatting; unknown/invalid entities stay literal-safe."""
    # Mapping only whole Unicode characters also rejects mid-surrogate ranges.
    positions, offset = {0: 0}, 0
    for index, character in enumerate(text):
        offset += 2 if ord(character) > 0xffff else 1
        positions[offset] = index + 1
    valid = []
    for entity in entities or ():
        if not isinstance(entity, dict) or not isinstance(entity.get("type"), dict):
            continue
        start, size = entity.get("offset"), entity.get("length")
        if type(start) is not int or type(size) is not int or size <= 0:
            continue
        if start not in positions or start + size not in positions:
            continue
        valid.append((positions[start], positions[start + size], entity["type"]))
    openings, closings, accepted, code_ranges = {}, {}, [], []
    for start, end, kind in sorted(valid, key=lambda item: (item[0], -item[1])):
        if any(left < start < right < end for left, right in accepted):
            continue  # Crossing ranges cannot be represented by nested Markdown.
        if any(left <= start and end <= right for left, right in code_ranges):
            continue
        body = text[start:end]
        name = kind.get("@type")
        if name == "textEntityTypeBold":
            opening = closing = "**"
        elif name == "textEntityTypeItalic":
            opening = closing = "*"
        elif name == "textEntityTypeStrikethrough":
            opening = closing = "~~"
        elif name in {"textEntityTypeCode", "textEntityTypePre", "textEntityTypePreCode"}:
            longest = max((len(run) for run in re.findall(r"`+", body)), default=0)
            if name != "textEntityTypeCode":
                fence = "`" * max(3, longest + 1)
                language = kind.get("language", "")
                if not isinstance(language, str) or (language and not _LANGUAGE.fullmatch(language)):
                    language = ""
                opening, closing = fence + language + "\n", "\n" + fence
            else:
                # Three backticks denote pre, so bodies with a run of two or
                # more backticks use a fence too (still a literal code body).
                fence = "`" * (longest + 1)
                if len(fence) >= 3:
                    opening, closing = fence + "\n", "\n" + fence
                else:
                    padding = " " if body.startswith("`") or body.endswith("`") or (body.strip() and (body.startswith(" ") or body.endswith(" "))) else ""
                    opening, closing = fence + padding, padding + fence
            code_ranges.append((start, end))
        elif name in {"textEntityTypeTextUrl", "textEntityTypeMentionName"}:
            url = kind.get("url") if name == "textEntityTypeTextUrl" else f"tg://user?id={kind.get('user_id')}"
            if not isinstance(url, str):
                continue
            url = url.replace("<", "%3C").replace(">", "%3E").replace("\\", "%5C").replace("\n", "%0A").replace("\r", "%0D")
            opening, closing = "[", "](<" + url + ">)"
        else:
            continue
        accepted.append((start, end))
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
    return "".join(output)
