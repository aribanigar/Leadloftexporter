from datetime import datetime, timedelta, timezone
from typing import Optional

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.core.config import get_settings

_settings = get_settings()
_pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(password: str) -> str:
    return _pwd_ctx.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return _pwd_ctx.verify(plain, hashed)


def create_access_token(subject: str, extra: Optional[dict] = None, expires_minutes: Optional[int] = None) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=expires_minutes or _settings.access_token_expire_minutes)
    payload = {"sub": subject, "exp": expire}
    if extra:
        payload.update(extra)
    return jwt.encode(payload, _settings.secret_key, algorithm=_settings.jwt_algorithm)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, _settings.secret_key, algorithms=[_settings.jwt_algorithm])
    except JWTError as exc:
        raise ValueError("invalid_token") from exc
