"""Multipart upload helpers shared by media and catalog tests."""

from __future__ import annotations

import io

from PIL import Image

from .helpers import Env

BOUNDARY = "isolated-image-boundary"


def image_bytes(width: int = 64, height: int = 48, fmt: str = "PNG") -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "#507aca").save(buffer, format=fmt)
    return buffer.getvalue()


def upload_body(
    kind: bytes,
    data: bytes | None,
    *,
    filename: str = "screenshot.png",
    mime: str = "image/png",
    extra: tuple[str, bytes, str | None] | None = None,
    file_first: bool = False,
) -> tuple[bytes, dict[str, str]]:
    file_part = (filename, data, mime) if data is not None else None

    def part(name: str, value: bytes, part_filename: str | None = None) -> bytes:
        disposition = f'form-data; name="{name}"'
        if part_filename is not None:
            disposition += f'; filename="{part_filename}"'
        return b"".join(
            [
                f"--{BOUNDARY}\r\nContent-Disposition: {disposition}\r\n".encode(),
                b"Content-Type: application/octet-stream\r\n\r\n",
                value,
                b"\r\n",
            ]
        )

    chunks: list[bytes] = []
    if file_first and file_part:
        chunks.append(part("file", file_part[1], file_part[0]))
    chunks.append(part("kind", kind))
    if not file_first and file_part:
        chunks.append(part("file", file_part[1], file_part[0]))
    if extra:
        chunks.append(part(extra[0], extra[1], extra[2]))
    chunks.append(f"--{BOUNDARY}--\r\n".encode())
    return b"".join(chunks), {"content-type": f"multipart/form-data; boundary={BOUNDARY}"}


async def upload(
    env: Env,
    token: str,
    kind: bytes = b"evidence",
    data: bytes | None = None,
    **options,
):
    body, headers = upload_body(kind, image_bytes() if data is None else data, **options)
    return await env.client.post(
        "/api/media",
        content=body,
        headers={**headers, "authorization": f"Bearer {token}"},
    )


def bearer(token: str) -> dict[str, str]:
    return {"authorization": f"Bearer {token}"}
