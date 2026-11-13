import os
import time
import uuid
from uuid import UUID

from shop.http import ApiError
from shop.media import cleanup_media, validate_stored_product_image

from .helpers import ALICE, BOB, SELLER, Env, session
from .uploads import bearer, image_bytes, upload, upload_body


async def test_product_upload_requires_a_seller_and_stays_private_until_published(env: Env) -> None:
    alice = await session(env, ALICE)
    seller = await session(env, SELLER)

    denied = await upload(env, alice, b"product")
    assert denied.status_code == 403
    assert await env.pool.fetchval("SELECT count(*) FROM media") == 0

    allowed = await upload(env, seller, b"product")
    assert allowed.status_code == 200
    body = allowed.json()
    assert body["mime"] == "image/png"
    media_id = body["id"]

    row = await env.pool.fetchrow("SELECT storage_key,user_id,kind,mime FROM media WHERE id=$1", UUID(media_id))
    assert row["storage_key"] == f"{media_id}.png"
    assert (row["user_id"], row["kind"], row["mime"]) == ("1001", "product", "image/png")
    path = env.config.media_dir / row["storage_key"]
    assert path.stat().st_mode & 0o777 == 0o600
    assert env.config.media_dir.stat().st_mode & 0o777 == 0o700

    assert (await env.client.get(f"/api/media/{media_id}")).status_code == 401
    assert (await env.client.get(f"/api/media/{media_id}", headers=bearer(alice))).status_code == 404
    assert (await env.client.get(f"/api/public-media/{media_id}")).status_code == 404

    seller_view = await env.client.get(f"/api/media/{media_id}", headers=bearer(seller))
    assert seller_view.status_code == 200
    assert seller_view.headers["content-type"] == "image/png"
    assert seller_view.headers["content-security-policy"] == "default-src 'none'"
    assert seller_view.content == path.read_bytes()

    product_id = uuid.uuid4()
    await env.pool.execute(
        """INSERT INTO products(id,name,comment,price,remaining_unsold,published)
           VALUES($1,'Fixture product','',100,1,true)""",
        product_id,
    )
    await env.pool.execute(
        "INSERT INTO product_images(product_id,media_id,position) VALUES($1,$2,0)",
        product_id,
        UUID(media_id),
    )
    assert (await env.client.get(f"/api/public-media/{media_id}")).status_code == 200
    assert (await env.client.get(f"/api/media/{media_id}", headers=bearer(alice))).status_code == 200


async def test_evidence_is_visible_only_to_its_owner_and_the_seller(env: Env) -> None:
    alice = await session(env, ALICE)
    bob = await session(env, BOB)
    seller = await session(env, SELLER)

    uploaded = await upload(env, alice, b"evidence")
    assert uploaded.status_code == 200
    media_id = uploaded.json()["id"]

    assert (await env.client.get(f"/api/media/{media_id}")).status_code == 401
    assert (await env.client.get(f"/api/media/{media_id}", headers=bearer(bob))).status_code == 404
    assert (await env.client.get(f"/api/public-media/{media_id}")).status_code == 404
    for token in (alice, seller):
        response = await env.client.get(f"/api/media/{media_id}", headers=bearer(token))
        assert response.status_code == 200
        assert response.headers["content-type"] == "image/png"


async def test_rejects_disguised_unsupported_oversized_and_dimensional_images(env: Env) -> None:
    alice = await session(env, ALICE)
    cases = [
        (b'<svg xmlns="http://www.w3.org/2000/svg"></svg>', "fake.png", "image/png", 400, "invalid_image"),
        (b"not an image", "receipt.jpg", "image/jpeg", 400, "invalid_image"),
        (image_bytes(fmt="GIF"), "receipt.gif", "image/gif", 400, "invalid_image"),
        (b"\x00" * (10 * 1024 * 1024 + 1), "huge.png", "image/png", 413, "file_too_large"),
        (image_bytes(width=12001, height=1), "wide.png", "image/png", 400, "invalid_image"),
        (b"", "empty.png", "image/png", 413, "file_too_large"),
    ]
    for data, filename, mime, status, code in cases:
        response = await upload(env, alice, b"evidence", data, filename=filename, mime=mime)
        assert response.status_code == status, (filename, response.text)
        assert response.json()["error"] == code
    assert await env.pool.fetchval("SELECT count(*) FROM media") == 0
    assert not any(env.config.media_dir.iterdir())


async def test_upload_requires_one_kind_field_before_one_file(env: Env) -> None:
    alice = await session(env, ALICE)

    body, headers = upload_body(b"evidence", image_bytes(), file_first=True)
    response = await env.client.post(
        "/api/media", content=body, headers={**headers, "authorization": f"Bearer {alice}"}
    )
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_upload"

    body, headers = upload_body(
        b"evidence", image_bytes(), extra=("another", b"value", None)
    )
    response = await env.client.post(
        "/api/media", content=body, headers={**headers, "authorization": f"Bearer {alice}"}
    )
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_upload"

    response = await env.client.post(
        "/api/media",
        content=b"not multipart",
        headers={"content-type": "application/octet-stream", "authorization": f"Bearer {alice}"},
    )
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_upload"

    assert await env.pool.fetchval("SELECT count(*) FROM media") == 0


async def test_cleanup_removes_abandoned_uploads_and_keeps_referenced_ones(env: Env) -> None:
    alice = await session(env, ALICE)
    seller = await session(env, SELLER)

    draft_image = (await upload(env, seller, b"product")).json()["id"]
    product_id = uuid.uuid4()
    await env.pool.execute(
        """INSERT INTO products(id,name,comment,price,remaining_unsold,published)
           VALUES($1,'Draft','',100,1,false)""",
        product_id,
    )
    await env.pool.execute(
        "INSERT INTO product_images(product_id,media_id,position) VALUES($1,$2,0)",
        product_id,
        UUID(draft_image),
    )

    evidence_image = (await upload(env, alice, b"evidence")).json()["id"]
    group_id, order_id, revision_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    async with env.pool.acquire() as connection:
        async with connection.transaction():
            await connection.execute(
                "INSERT INTO fulfillment_groups(id,user_id) VALUES($1,'2001')", group_id
            )
            await connection.execute(
                """INSERT INTO orders(id,user_id,group_id,deadline,current_revision,currency)
                   VALUES($1,'2001',$2,clock_timestamp()+interval '30 minutes',$3,'USD')""",
                order_id,
                group_id,
                revision_id,
            )
            await connection.execute(
                "INSERT INTO order_revisions(id,order_id,number,total,author_id) VALUES($1,$2,1,0,'2001')",
                revision_id,
                order_id,
            )
            await connection.execute(
                """INSERT INTO payment_evidence(id,order_id,revision_id,media_id)
                   VALUES($1,$2,$3,$4)""",
                uuid.uuid4(),
                order_id,
                revision_id,
                UUID(evidence_image),
            )

    abandoned = (await upload(env, alice, b"evidence")).json()["id"]
    recent = (await upload(env, alice, b"evidence")).json()["id"]
    await env.pool.execute(
        "UPDATE media SET created_at=clock_timestamp()-interval '2 days' WHERE id<>$1",
        UUID(recent),
    )

    orphan = env.config.media_dir / f"{uuid.uuid4()}.png"
    orphan.write_bytes(image_bytes())
    old = time.time() - 2 * 24 * 60 * 60
    os.utime(orphan, (old, old))

    await cleanup_media(env.pool, env.config)

    assert await env.pool.fetchval("SELECT count(*) FROM media") == 3
    assert not (await env.pool.fetch("SELECT 1 FROM media WHERE id=$1", UUID(abandoned)))
    for media_id, token in ((draft_image, seller), (evidence_image, alice), (recent, alice)):
        response = await env.client.get(f"/api/media/{media_id}", headers=bearer(token))
        assert response.status_code == 200, media_id
    assert not orphan.exists()


async def test_publication_revalidates_stored_image_bytes(env: Env) -> None:
    seller = await session(env, SELLER)
    uploaded = (await upload(env, seller, b"product")).json()
    row = await env.pool.fetchrow("SELECT * FROM media WHERE id=$1", UUID(uploaded["id"]))
    await validate_stored_product_image(row, env.config)

    path = env.config.media_dir / row["storage_key"]
    path.write_bytes(b"not an image")
    for media in (row, {**dict(row), "storage_key": f"{uuid.uuid4()}.png"}):
        try:
            await validate_stored_product_image(media, env.config)
        except ApiError as error:
            assert (error.status_code, error.code) == (400, "invalid_image")
        else:
            raise AssertionError("corrupted or missing image must be rejected")


async def test_traversal_identifier_is_not_found(env: Env) -> None:
    alice = await session(env, ALICE)
    response = await env.client.get(
        "/api/media/%2e%2e%2f%2e%2e%2fetc%2fpasswd", headers=bearer(alice)
    )
    assert response.status_code in {400, 404}
    assert response.json()["error"] in {"not_found", "invalid_input"}
