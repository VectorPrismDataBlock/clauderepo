"""Fetch a lesson page by URL and turn it into plain text for the tutor prompt."""

import re
from html.parser import HTMLParser
from urllib.parse import urlparse

import httpx

from .config import FETCH_TIMEOUT, FETCH_USER_AGENT, MAX_LESSON_CHARS

# Tags whose text content is never lesson content. These must all be elements
# with a REQUIRED closing tag — the skip counter below desyncs otherwise, and a
# stuck counter silently swallows the entire document. That rules out <head>
# (its closing tag is optional) and any void element.
_SKIP_TAGS = {"script", "style", "noscript", "svg", "template"}

# Void elements never fire handle_endtag, so they must never touch the counter.
_VOID_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
}

# Tags that should produce a line break so paragraphs/list items stay separated.
_BLOCK_TAGS = {
    "p", "div", "br", "li", "tr", "section", "article", "header", "footer",
    "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "table",
}


class LessonError(Exception):
    """Raised when a lesson URL can't be fetched or yields no readable text."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.title = ""
        self._skip_depth = 0
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            self._in_title = True
        elif tag in _VOID_TAGS:
            if tag in _BLOCK_TAGS:  # <br>
                self.parts.append("\n")
        elif tag in _SKIP_TAGS:
            self._skip_depth += 1
        elif tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        elif tag in _VOID_TAGS:
            pass
        elif tag in _SKIP_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
        elif tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data):
        # Captured separately so the title doesn't repeat inside the body text.
        if self._in_title:
            self.title += data
        elif self._skip_depth == 0:
            self.parts.append(data)


def parse_lesson(html: str, max_chars: int = MAX_LESSON_CHARS) -> tuple[str, str]:
    """Return (text, title). Accepts plain text too — it just passes through."""
    parser = _TextExtractor()
    parser.feed(html)
    parser.close()

    # Collapse runs of whitespace within each line, then drop blank lines.
    lines = (" ".join(line.split()) for line in "".join(parser.parts).splitlines())
    text = "\n".join(line for line in lines if line)
    return text[:max_chars], " ".join(parser.title.split())


# Fetching the same URL twice (once for the iframe, once to start the session)
# is the common path, so keep the last few pages around.
_cache: dict[str, tuple[str, str, str]] = {}


async def fetch_lesson(url: str) -> tuple[str, str, str]:
    """Fetch a lesson URL. Returns (html, text, title)."""
    url = url.strip()
    if urlparse(url).scheme not in ("http", "https"):
        raise LessonError(400, "Lesson URL must start with http:// or https://")

    if url in _cache:
        return _cache[url]

    try:
        async with httpx.AsyncClient(
            timeout=FETCH_TIMEOUT,
            follow_redirects=True,
            headers={"User-Agent": FETCH_USER_AGENT},
        ) as client:
            response = await client.get(url)
    except httpx.RequestError as exc:
        raise LessonError(502, f"Could not fetch the lesson page: {exc}") from exc

    if response.is_error:
        raise LessonError(response.status_code, f"Lesson page returned {response.status_code}")

    html = response.text
    text, title = parse_lesson(html)
    if not text:
        raise LessonError(
            422,
            "No readable text at that URL — the page may render its content with "
            "JavaScript, which this fetcher does not run.",
        )

    if len(_cache) > 8:
        _cache.clear()
    _cache[url] = (html, text, title or url)
    return _cache[url]


_HEAD_RE = re.compile(r"<head[^>]*>", re.IGNORECASE)


def inject_base_href(html: str, url: str) -> str:
    """Make relative images/CSS resolve once we re-serve the page from our origin.

    The first <base> in a document wins, so inserting ours immediately after
    <head> beats any the page already declares.
    """
    tag = f'<base href="{url}">'
    match = _HEAD_RE.search(html)
    if match:
        return html[: match.end()] + tag + html[match.end() :]
    return tag + html
