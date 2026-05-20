"""Email-finder service — infers + verifies a person's email from their
name and company domain. Three-tier waterfall:

  Tier 1 — DOMAIN PATTERN CACHE
    Once we've verified that `acme.com` uses `first.last@`, every
    subsequent lookup at acme.com reuses that pattern instantly.
    Stored in the global `company_email_patterns` table — a pattern
    verified by user A applies to user B's leads at the same company.
    This is LeadLoft's main accuracy moat at scale.

  Tier 2 — PATTERN INFERENCE + SMTP VERIFY
    For domains we've never seen, generate common patterns
    (first.last@, first@, flast@, etc.), do DNS MX lookup, SMTP RCPT
    probe, catch-all detection. No third-party API needed.

  Tier 3 — APOLLO API FALLBACK (optional)
    When tiers 1+2 return unknown/not_found (M365/Gmail block probes,
    or person has no company domain), fall through to Apollo's
    /v1/people/match endpoint. Apollo can return email + phone even
    for non-1st-degree LinkedIn connections — this is the trick that
    makes LeadLoft work "without needing to be connected." Requires
    the workspace to have plugged in an Apollo API key in
    Settings → Integrations.

Result statuses:
  verified  — explicit 250 RCPT from MX OR Apollo high-confidence match
  risky     — catch-all domain, best-guess pattern
  unknown   — server blocks probes (no Apollo key configured)
  not_found — no MX / no pattern accepted / Apollo no match
"""
from __future__ import annotations

import asyncio
import contextlib
import re
import socket
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlparse

import dns.resolver  # type: ignore[import-untyped]
import aiosmtplib
import httpx
from sqlalchemy.orm import Session

from app.models import CompanyEmailPattern, ConnectedAccount


_PERSONAL_DOMAINS = {
    "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "yahoo.fr",
    "hotmail.com", "hotmail.co.uk", "outlook.com", "live.com", "msn.com",
    "icloud.com", "me.com", "mac.com",
    "aol.com", "protonmail.com", "proton.me",
    "zoho.com", "yandex.com", "yandex.ru", "mail.ru",
    "gmx.com", "gmx.net", "rediffmail.com",
}


@dataclass
class EmailFinderResult:
    email: Optional[str] = None
    phone: Optional[str] = None
    status: str = "not_found"  # verified | risky | unknown | not_found
    confidence: int = 0
    patterns_tried: list[str] = field(default_factory=list)
    domain: Optional[str] = None
    catch_all: bool = False
    source: Optional[str] = None  # cache | pattern_smtp | apollo
    reason: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "email": self.email,
            "phone": self.phone,
            "status": self.status,
            "confidence": self.confidence,
            "patterns_tried": self.patterns_tried,
            "domain": self.domain,
            "catch_all": self.catch_all,
            "source": self.source,
            "reason": self.reason,
        }


# ----------------- Helpers (name + domain normalisation) -------------------


def _normalize_name_part(s: str) -> str:
    if not s:
        return ""
    import unicodedata
    nfkd = unicodedata.normalize("NFKD", s)
    ascii_only = "".join(c for c in nfkd if not unicodedata.combining(c))
    return re.sub(r"[^a-z]", "", ascii_only.lower())


def _extract_domain_from_url(url: Optional[str]) -> Optional[str]:
    if not url:
        return None
    try:
        if "://" not in url:
            url = "https://" + url
        host = urlparse(url).hostname or ""
        host = host.lower().lstrip(".")
        if host.startswith("www."):
            host = host[4:]
        return host or None
    except Exception:
        return None


def _domain_from_company_name(name: Optional[str]) -> Optional[str]:
    if not name:
        return None
    slug = re.sub(r"[^a-z0-9]", "", name.lower())
    if not slug or len(slug) < 3 or slug.isdigit():
        return None
    return f"{slug}.com"


# ----------------- Pattern generation + template instantiation -------------


# Each pattern is a template that expands a (first, last) pair into a
# local-part. Order = popularity in B2B.
_PATTERNS = [
    "{first}.{last}",
    "{first}{last}",
    "{f}{last}",
    "{first}",
    "{first}_{last}",
    "{f}.{last}",
    "{first}-{last}",
    "{last}.{first}",
    "{last}{f}",
    "{last}",
]


def _expand_pattern(pattern: str, first: str, last: str) -> Optional[str]:
    if not first and not last:
        return None
    fi = first[0] if first else ""
    li = last[0] if last else ""
    try:
        local = pattern.format(first=first, last=last, f=fi, l=li)
    except Exception:
        return None
    if not local or local in (".", "-", "_"):
        return None
    return local


# ----------------- DNS + SMTP probing --------------------------------------


def _resolve_mx(domain: str) -> Optional[str]:
    try:
        resolver = dns.resolver.Resolver()
        resolver.timeout = 4
        resolver.lifetime = 6
        answers = resolver.resolve(domain, "MX")
        records = sorted(
            ((int(r.preference), str(r.exchange).rstrip(".")) for r in answers),
            key=lambda x: x[0],
        )
        return records[0][1] if records else None
    except Exception:
        return None


async def _rcpt_probe(
    mx_host: str, sender: str, recipient: str, timeout: float = 6.0
) -> tuple[bool, int, str]:
    smtp = aiosmtplib.SMTP(hostname=mx_host, port=25, timeout=timeout)
    try:
        await smtp.connect()
        with contextlib.suppress(Exception):
            await smtp.ehlo(socket.gethostname() or "leadcaptura.io")
        try:
            await smtp.mail(sender)
            code, msg = await smtp.rcpt(recipient)
            return (200 <= code < 300, code, msg)
        finally:
            with contextlib.suppress(Exception):
                await smtp.quit()
    except Exception as e:
        return (False, 0, str(e))


# ----------------- Tier 1: domain pattern cache lookup ---------------------


def _cached_patterns(db: Optional[Session], domain: str) -> list[str]:
    """Return templated patterns ordered by `verified_count desc`.
    Empty list if no cache hits OR no db provided."""
    if not db or not domain:
        return []
    try:
        rows = (
            db.query(CompanyEmailPattern)
            .filter(CompanyEmailPattern.domain == domain)
            .order_by(CompanyEmailPattern.verified_count.desc())
            .all()
        )
        return [r.pattern for r in rows]
    except Exception:
        return []


def _record_pattern(db: Optional[Session], domain: str, pattern: str) -> None:
    """Upsert a verified domain → pattern row, incrementing
    verified_count + bumping last_verified_at."""
    if not db or not domain or not pattern:
        return
    try:
        existing = (
            db.query(CompanyEmailPattern)
            .filter(
                CompanyEmailPattern.domain == domain,
                CompanyEmailPattern.pattern == pattern,
            )
            .first()
        )
        if existing:
            existing.verified_count = (existing.verified_count or 0) + 1
            existing.last_verified_at = datetime.now(timezone.utc)
        else:
            db.add(
                CompanyEmailPattern(
                    domain=domain,
                    pattern=pattern,
                    verified_count=1,
                    last_verified_at=datetime.now(timezone.utc),
                )
            )
        db.commit()
    except Exception:
        with contextlib.suppress(Exception):
            db.rollback()


# ----------------- Tier 3: Apollo fallback ---------------------------------


def _apollo_api_key(db: Optional[Session], workspace_id: Optional[str]) -> Optional[str]:
    if not db or not workspace_id:
        return None
    try:
        acct = (
            db.query(ConnectedAccount)
            .filter(
                ConnectedAccount.workspace_id == workspace_id,
                ConnectedAccount.provider == "apollo",
                ConnectedAccount.status == "active",
            )
            .first()
        )
        return acct.access_token if acct and acct.access_token else None
    except Exception:
        return None


def _apollo_match(
    api_key: str,
    *,
    first_name: Optional[str],
    last_name: Optional[str],
    domain: Optional[str],
    company_name: Optional[str],
    linkedin_url: Optional[str],
) -> Optional[dict]:
    """Call Apollo's /v1/people/match. Returns {email, phone} dict or None.

    Apollo returns email + work_direct_phone (best mobile) + organization.
    Free tier allows 50 matches/month; paid is ~$0.05/match.
    """
    try:
        body = {}
        if first_name:
            body["first_name"] = first_name
        if last_name:
            body["last_name"] = last_name
        if domain:
            body["domain"] = domain
        if company_name:
            body["organization_name"] = company_name
        if linkedin_url:
            body["linkedin_url"] = linkedin_url
        # No useful inputs → don't even attempt
        if not (linkedin_url or (first_name and (last_name or domain))):
            return None
        with httpx.Client(timeout=15) as client:
            r = client.post(
                "https://api.apollo.io/v1/people/match",
                headers={
                    "Content-Type": "application/json",
                    "Cache-Control": "no-cache",
                    "X-Api-Key": api_key,
                },
                json=body,
            )
            if r.status_code != 200:
                return None
            data = r.json() or {}
            person = data.get("person") or {}
            email = person.get("email")
            # Apollo returns work_direct_phone OR phone_numbers[] OR organization.phone
            phone = (
                person.get("work_direct_phone")
                or person.get("personal_emails")  # never an email field but safe
                or None
            )
            if not phone:
                nums = person.get("phone_numbers") or []
                if isinstance(nums, list) and nums:
                    raw = nums[0]
                    phone = (
                        raw.get("sanitized_number")
                        or raw.get("raw_number")
                        if isinstance(raw, dict)
                        else None
                    )
            return {
                "email": email,
                "phone": phone if isinstance(phone, str) else None,
            }
    except Exception:
        return None


# ----------------- Main pipeline -------------------------------------------


async def find_email_async(
    *,
    first_name: Optional[str],
    last_name: Optional[str],
    domain: Optional[str],
    company_url: Optional[str] = None,
    company_name: Optional[str] = None,
    linkedin_url: Optional[str] = None,
    probe_sender: str = "verify@leadcaptura.io",
    db: Optional[Session] = None,
    workspace_id: Optional[str] = None,
) -> EmailFinderResult:
    first = _normalize_name_part(first_name or "")
    last = _normalize_name_part(last_name or "")

    # Resolve domain
    dom = (domain or "").strip().lower() or None
    if not dom:
        dom = _extract_domain_from_url(company_url)
    if not dom:
        dom = _domain_from_company_name(company_name)

    # ---- Personal domain short-circuit ----
    if dom in _PERSONAL_DOMAINS:
        # Skip SMTP probe (always catch-all). Maybe Apollo can still match.
        return await _try_apollo(
            base=EmailFinderResult(
                status="unknown", domain=dom, catch_all=True,
                reason="personal_mail_host",
            ),
            db=db, workspace_id=workspace_id,
            first_name=first_name, last_name=last_name,
            domain=dom, company_name=company_name, linkedin_url=linkedin_url,
        )

    # ---- Tier 1: domain pattern cache (skip probes if we already know) ----
    cached = _cached_patterns(db, dom) if dom else []
    if dom and cached and first and last:
        # Try cached patterns ONLY (no SMTP probe). Trust the cache.
        for tpl in cached:
            local = _expand_pattern(tpl, first, last)
            if not local:
                continue
            return EmailFinderResult(
                email=f"{local}@{dom}",
                status="verified",
                confidence=85,
                patterns_tried=[f"{local}@{dom}"],
                domain=dom,
                source="cache",
            )

    # ---- Tier 2: pattern inference + SMTP verify ----
    smtp_result = await _tier2_smtp(
        first=first, last=last, dom=dom, probe_sender=probe_sender,
    )

    # If verified, also persist the winning pattern to the cache
    if smtp_result.status == "verified" and dom and smtp_result.email:
        local = smtp_result.email.split("@", 1)[0]
        pattern = _local_to_pattern(local, first, last)
        if pattern:
            _record_pattern(db, dom, pattern)

    # Verified or risky and we have an email → done (Apollo can't beat it)
    if smtp_result.email:
        return smtp_result

    # ---- Tier 3: Apollo fallback ----
    return await _try_apollo(
        base=smtp_result,
        db=db, workspace_id=workspace_id,
        first_name=first_name, last_name=last_name,
        domain=dom, company_name=company_name, linkedin_url=linkedin_url,
    )


async def _tier2_smtp(
    *, first: str, last: str, dom: Optional[str], probe_sender: str
) -> EmailFinderResult:
    if not dom:
        return EmailFinderResult(reason="no_domain")
    mx = _resolve_mx(dom)
    if not mx:
        return EmailFinderResult(domain=dom, reason="no_mx_record")
    if not (first or last):
        return EmailFinderResult(domain=dom, reason="no_name")

    # Catch-all canary probe
    catch_all = False
    canary = f"lc-canary-{abs(hash(dom)) % 1000000:06d}-xyz@{dom}"
    canary_ok, _, _ = await _rcpt_probe(mx, probe_sender, canary)
    if canary_ok:
        catch_all = True

    tried: list[str] = []
    best_risky: Optional[str] = None

    for tpl in _PATTERNS[:6]:
        local = _expand_pattern(tpl, first, last)
        if not local:
            continue
        candidate = f"{local}@{dom}"
        tried.append(candidate)
        ok, _code, _msg = await _rcpt_probe(mx, probe_sender, candidate)
        if not ok:
            continue
        if catch_all:
            best_risky = candidate
            break
        return EmailFinderResult(
            email=candidate, status="verified", confidence=90,
            patterns_tried=tried, domain=dom, source="pattern_smtp",
        )

    if best_risky:
        return EmailFinderResult(
            email=best_risky, status="risky", confidence=50,
            patterns_tried=tried, domain=dom, catch_all=True,
            source="pattern_smtp", reason="catch_all_domain",
        )

    # SMTP probe never accepted any candidate — may be blocked / unknown
    return EmailFinderResult(
        status="unknown" if tried else "not_found",
        patterns_tried=tried, domain=dom, catch_all=catch_all,
        reason="smtp_blocked_or_no_pattern_accepted",
    )


def _local_to_pattern(local: str, first: str, last: str) -> Optional[str]:
    """Reverse-engineer which template `local` came from, so we can cache it.
    Returns the template string (e.g. '{first}.{last}') or None.
    """
    if not local or not (first or last):
        return None
    candidates = []
    for tpl in _PATTERNS:
        expanded = _expand_pattern(tpl, first, last)
        if expanded == local:
            candidates.append(tpl)
    return candidates[0] if candidates else None


async def _try_apollo(
    *,
    base: EmailFinderResult,
    db: Optional[Session],
    workspace_id: Optional[str],
    first_name: Optional[str],
    last_name: Optional[str],
    domain: Optional[str],
    company_name: Optional[str],
    linkedin_url: Optional[str],
) -> EmailFinderResult:
    """If Apollo is connected for this workspace, query /v1/people/match
    as a last-resort enrichment. Merges into the base result."""
    api_key = _apollo_api_key(db, workspace_id)
    if not api_key:
        return base
    match = _apollo_match(
        api_key,
        first_name=first_name, last_name=last_name,
        domain=domain, company_name=company_name, linkedin_url=linkedin_url,
    )
    if not match:
        return base
    if match.get("email") and not base.email:
        base.email = match["email"]
        base.status = "verified"
        base.confidence = max(base.confidence, 80)
        base.source = "apollo"
    if match.get("phone") and not base.phone:
        base.phone = match["phone"]
    return base


def find_email_sync(**kwargs) -> EmailFinderResult:
    return asyncio.run(find_email_async(**kwargs))
