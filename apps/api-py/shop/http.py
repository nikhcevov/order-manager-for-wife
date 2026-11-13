"""HTTP-level primitives shared by every route: the user, API errors, access checks."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class User:
    id: str
    first_name: str
    username: str | None
    is_seller: bool


class ApiError(Exception):
    """An expected failure with a stable code the frontend localizes."""

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        details: Any = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details


def seller(user: User) -> User:
    if not user.is_seller:
        raise ApiError(403, "forbidden", "Seller access required")
    return user


def owner(user: User, user_id: str) -> None:
    # A seller may read other customers' records; everyone else gets a 404, not a 403,
    # so the API does not reveal that somebody else's record exists.
    if not user.is_seller and user.id != user_id:
        raise ApiError(404, "not_found", "Record not found")


def check_version(actual: int, expected: int) -> None:
    if actual != expected:
        raise ApiError(
            409,
            "stale_version",
            "This record changed. Refresh and review it before trying again.",
            {"version": actual},
        )
