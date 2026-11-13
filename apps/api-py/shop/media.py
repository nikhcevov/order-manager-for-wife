"""Image upload, strict decoding, storage, authorization, and cleanup."""

from __future__ import annotations

import asyncio
import errno
import io
import os
import re
import stat
import time
import uuid
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import Depends, FastAPI, Request
from PIL import Image, ImageOps, UnidentifiedImageError
from python_multipart.multipart import (
    FileError,
    FormParserError,
    MultipartParseError,
    MultipartParser,
    parse_options_header,
)
from starlette.responses import Response, StreamingResponse

from .auth import authenticate
from .config import Settings
from .db import transaction
from .http import ApiError, User, owner, seller

MAX_FILE_SIZE = 10 * 1024 * 1024
MAX_PIXELS = 25_000_000
MAX_DIMENSION = 8192
MAX_FIELD_SIZE = 1024 * 1024
CHUNK = 256 * 1024

STORAGE_KEY = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpeg|png|webp)$")
IMAGE_FORMATS = {
    "JPEG": ("jpeg", "image/jpeg"),
    "PNG": ("png", "image/png"),
    "WEBP": ("webp", "image/webp"),
}
IMAGE_ERROR = (
    "Upload a valid single-frame JPEG, PNG, or WebP image, at most 10 MiB, "
    "8192 pixels per side and 25 megapixels."
)


@dataclass(frozen=True, slots=True)
class DecodedImage:
    data: bytes
    extension: str
    mime: str


def invalid_upload() -> ApiError:
    return ApiError(400, "invalid_upload", "Select an image and its upload kind.")


def decode_image(data: bytes) -> DecodedImage:
    """Decode, bound, orient, and re-encode an image without trusting its name."""
    try:
        with warnings.catch_warnings():
            # Pillow warns instead of failing on suspiciously large images.
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as opened:
                template = IMAGE_FORMATS.get(opened.format or "")
                width, height = opened.size
                if (
                    template is None
                    or width > MAX_DIMENSION
                    or height > MAX_DIMENSION
                    or width * height > MAX_PIXELS
                    or getattr(opened, "n_frames", 1) != 1
                ):
                    raise ValueError("Unsupported image dimensions or format")
                opened.load()
                image = ImageOps.exif_transpose(opened)
                buffer = io.BytesIO()
                if template[0] == "jpeg":
                    if image.mode not in {"RGB", "L"}:
                        image = image.convert("RGB")
                    image.save(buffer, format="JPEG", quality=80)
                elif template[0] == "webp":
                    image.save(buffer, format="WEBP", quality=80)
                else:
                    image.save(buffer, format="PNG")
                normalized = buffer.getvalue()
                if not normalized or len(normalized) > MAX_FILE_SIZE:
                    raise ValueError("Image too large after decoding")
                return DecodedImage(normalized, *template)
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise ApiError(400, "invalid_image", IMAGE_ERROR) from None


def media_path(config: Settings, storage_key: str) -> Path:
    if not STORAGE_KEY.fullmatch(storage_key):
        raise ApiError(404, "not_found", "Image not found")
    return config.media_dir / storage_key


async def validate_stored_product_image(media: Any, config: Settings) -> None:
    """Re-decode a stored file so a corrupted or swapped upload cannot be published."""
    if not STORAGE_KEY.fullmatch(media["storage_key"]):
        raise ApiError(400, "invalid_image", "A selected product image is unavailable. Upload it again.")
    path = config.media_dir / media["storage_key"]
    try:
        fd = await asyncio.to_thread(os.open, path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        raise ApiError(400, "invalid_image", "A selected product image is missing or invalid. Upload it again.") from None
    try:
        info = await asyncio.to_thread(os.fstat, fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE_SIZE:
            raise ValueError("Invalid stored file")
    except (OSError, ValueError):
        os.close(fd)
        raise ApiError(400, "invalid_image", "A selected product image is missing or invalid. Upload it again.") from None
    try:
        data = await asyncio.to_thread(_read_fd, fd)
    except OSError:
        raise ApiError(400, "invalid_image", "A selected product image is missing or invalid. Upload it again.") from None
    image = await asyncio.to_thread(decode_image, data)
    if image.mime != media["mime"]:
        raise ApiError(400, "invalid_image", "A selected product image is missing or invalid. Upload it again.")


def _read_fd(fd: int) -> bytes:
    with os.fdopen(fd, "rb") as file:
        return file.read(MAX_FILE_SIZE + 1)


@dataclass(slots=True)
class _Part:
    kind: str
    name: str
    filename: str | None
    content: bytearray = field(default_factory=bytearray)


async def _read_upload(request: Request, user: User) -> tuple[str, bytes]:
    content_type = request.headers.get("content-type", "")
    if not content_type.lower().startswith("multipart/form-data"):
        raise invalid_upload()
    _, options = parse_options_header(content_type)
    boundary = options.get(b"boundary")
    if not boundary:
        raise invalid_upload()

    parts: list[_Part] = []
    headers: dict[bytes, bytes] = {}
    header_field = bytearray()
    header_value = bytearray()
    current_kind: str | None = None

    def on_part_begin() -> None:
        if len(parts) >= 2:
            raise invalid_upload()
        headers.clear()
        header_field.clear()
        header_value.clear()

    def on_header_field(data: bytes, start: int, end: int) -> None:
        header_field.extend(data[start:end])

    def on_header_value(data: bytes, start: int, end: int) -> None:
        header_value.extend(data[start:end])

    def on_header_end() -> None:
        headers[bytes(header_field).lower()] = bytes(header_value)

    def on_headers_finished() -> None:
        nonlocal current_kind
        disposition, options = parse_options_header(headers.get(b"content-disposition", b""))
        name = options.get(b"name", b"").decode("utf-8", "replace")
        filename = options.get(b"filename")
        if disposition != b"form-data":
            raise invalid_upload()
        if not parts:
            if filename is not None or name != "kind":
                raise invalid_upload()
            parts.append(_Part(kind="field", name=name, filename=None))
        else:
            if name != "file" or filename is None or current_kind is None:
                raise invalid_upload()
            parts.append(
                _Part(
                    kind="file",
                    name=name,
                    filename=filename.decode("utf-8", "replace"),
                )
            )

    def on_part_data(data: bytes, start: int, end: int) -> None:
        if not parts:
            raise invalid_upload()
        part = parts[-1]
        chunk = data[start:end]
        if part.kind == "field":
            if len(part.content) + len(chunk) > MAX_FIELD_SIZE:
                raise invalid_upload()
        elif len(part.content) + len(chunk) > MAX_FILE_SIZE:
            raise ApiError(413, "file_too_large", "The image must be no larger than 10 MiB.")
        part.content.extend(chunk)

    def on_part_end() -> None:
        nonlocal current_kind
        if not parts:
            return
        part = parts[-1]
        if part.kind != "field":
            return
        try:
            value = bytes(part.content).decode("utf-8")
        except UnicodeDecodeError:
            raise invalid_upload() from None
        if value not in {"product", "evidence"}:
            raise invalid_upload()
        if value == "product":
            seller(user)
        current_kind = value

    callbacks = {
        "on_part_begin": on_part_begin,
        "on_header_field": on_header_field,
        "on_header_value": on_header_value,
        "on_header_end": on_header_end,
        "on_headers_finished": on_headers_finished,
        "on_part_data": on_part_data,
        "on_part_end": on_part_end,
    }
    parser = MultipartParser(boundary, callbacks)
    try:
        async for chunk in request.stream():
            parser.write(chunk)
    except ApiError:
        raise
    except (MultipartParseError, FormParserError, FileError, ValueError):
        raise invalid_upload() from None

    if current_kind is None or len(parts) != 2:
        raise invalid_upload()
    if not parts[1].content:
        raise ApiError(413, "file_too_large", "The image must be no larger than 10 MiB.")
    return current_kind, bytes(parts[1].content)


def _write_file(path: Path, data: bytes) -> None:
    # O_EXCL: never overwrite an existing object; 0600: only this service reads it.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as file:
        file.write(data)


async def _send_image(media: Any, config: Settings) -> Response:
    path = media_path(config, media["storage_key"])
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as error:
        if error.errno in {errno.ENOENT, errno.ELOOP, errno.ENOTDIR}:
            raise ApiError(404, "not_found", "Image not found") from None
        raise
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise ApiError(404, "not_found", "Image not found")
    except BaseException:
        os.close(fd)
        raise

    async def chunks() -> AsyncIterator[bytes]:
        try:
            remaining = info.st_size
            while remaining > 0:
                chunk = await asyncio.to_thread(os.read, fd, min(CHUNK, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk
        finally:
            os.close(fd)

    return StreamingResponse(
        chunks(),
        media_type=media["mime"],
        headers={
            "Content-Length": str(info.st_size),
            "Content-Security-Policy": "default-src 'none'",
        },
    )


def register_media(app: FastAPI, pool: asyncpg.Pool, config: Settings) -> None:
    config.media_dir.mkdir(mode=0o700, parents=True, exist_ok=True)

    @app.post("/api/media")
    async def upload(request: Request, user: User = Depends(authenticate)) -> dict[str, str]:
        kind, data = await _read_upload(request, user)
        image = await asyncio.to_thread(decode_image, data)
        media_id = uuid.uuid4()
        storage_key = f"{media_id}.{image.extension}"
        path = media_path(config, storage_key)
        await asyncio.to_thread(_write_file, path, image.data)
        try:
            await pool.execute(
                "INSERT INTO media(id,user_id,kind,storage_key,mime) VALUES($1,$2,$3,$4,$5)",
                media_id,
                user.id,
                kind,
                storage_key,
                image.mime,
            )
        except BaseException:
            await asyncio.to_thread(path.unlink, missing_ok=True)
            raise
        return {"id": str(media_id), "mime": image.mime}

    @app.get("/api/media/{media_id}")
    async def private_media(media_id: UUID, user: User = Depends(authenticate)) -> Response:
        media = await pool.fetchrow(
            """SELECT m.*, EXISTS(
                 SELECT 1 FROM product_images pi JOIN products p ON p.id=pi.product_id
                 WHERE pi.media_id=m.id AND p.published) AS published
               FROM media m WHERE m.id=$1""",
            media_id,
        )
        if media is None:
            raise ApiError(404, "not_found", "Image not found")
        if media["kind"] == "evidence":
            owner(user, media["user_id"])
        elif not media["published"] and not user.is_seller:
            raise ApiError(404, "not_found", "Image not found")
        return await _send_image(media, config)

    @app.get("/api/public-media/{media_id}")
    async def public_media(media_id: UUID) -> Response:
        media = await pool.fetchrow(
            """SELECT m.* FROM media m WHERE m.id=$1 AND m.kind='product' AND EXISTS(
                 SELECT 1 FROM product_images pi JOIN products p ON p.id=pi.product_id
                 WHERE pi.media_id=m.id AND p.published)""",
            media_id,
        )
        if media is None:
            raise ApiError(404, "not_found", "Image not found")
        return await _send_image(media, config)


@dataclass(slots=True)
class _Sweep:
    running: bool = False
    cursor: int = 0


_sweeps: dict[Path, _Sweep] = {}


async def cleanup_media(pool: asyncpg.Pool, config: Settings) -> None:
    """Delete abandoned uploads and orphan files older than 24 hours."""
    sweep = _sweeps.setdefault(config.media_dir, _Sweep())
    if sweep.running:
        return
    sweep.running = True
    try:
        await asyncio.to_thread(config.media_dir.mkdir, mode=0o700, parents=True, exist_ok=True)
        async with transaction(pool) as connection:
            selected = await connection.fetch(
                """SELECT m.id,m.storage_key FROM media m
                   WHERE m.created_at<clock_timestamp()-interval '24 hours'
                     AND NOT EXISTS(SELECT 1 FROM product_images pi WHERE pi.media_id=m.id)
                     AND NOT EXISTS(SELECT 1 FROM payment_evidence pe WHERE pe.media_id=m.id)
                   ORDER BY m.created_at,m.id LIMIT 100 FOR UPDATE OF m SKIP LOCKED"""
            )
            rows: list[Any] = []
            if selected:
                rows = await connection.fetch(
                    """DELETE FROM media m WHERE m.id=ANY($1::uuid[])
                       AND NOT EXISTS(SELECT 1 FROM product_images pi WHERE pi.media_id=m.id)
                       AND NOT EXISTS(SELECT 1 FROM payment_evidence pe WHERE pe.media_id=m.id)
                       RETURNING m.id,m.storage_key""",
                    [row["id"] for row in selected],
                )
        for row in rows:
            if STORAGE_KEY.fullmatch(row["storage_key"]):
                await asyncio.to_thread(
                    (config.media_dir / row["storage_key"]).unlink, missing_ok=True
                )

        # Walk the directory with a persistent cursor so old orphans are reached
        # even when the first names are recent or still referenced.
        names = await asyncio.to_thread(
            lambda: sorted(
                entry.name
                for entry in os.scandir(config.media_dir)
                if entry.is_file(follow_symlinks=False) and STORAGE_KEY.fullmatch(entry.name)
            )
        )
        if not names:
            sweep.cursor = 0
            return
        cursor = sweep.cursor % len(names)
        now = time.time()
        for name in names[cursor : cursor + 100]:
            path = config.media_dir / name
            try:
                info = await asyncio.to_thread(os.stat, path, follow_symlinks=False)
            except FileNotFoundError:
                continue
            if now - info.st_mtime <= 24 * 60 * 60:
                continue
            if await pool.fetchval("SELECT 1 FROM media WHERE storage_key=$1", name):
                continue
            await asyncio.to_thread(path.unlink, missing_ok=True)
        sweep.cursor = (cursor + 100) % len(names)
    finally:
        sweep.running = False
