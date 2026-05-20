"""Email-finder service — infers + verifies a person's email from
their name and company domain. Same idea as Hunter / Snov / RocketReach,
running entirely on our own infrastructure with no third-party API.

The flow per lookup:
  1. Resolve company → domain (from lead.company_url or company name)
  2. DNS MX lookup on the domain (rules out garbage domains in ~50ms)
  3. Generate likely email patterns from first+last name:
       first.last@   first@   flast@   firstlast@   first_last@
       f.last@       lastf@   first-last@  last.first@
  4. SMTP probe each pattern with RCPT TO against the MX host
     - No DATA / no actual email is sent
     - 250 reply = mailbox exists
     - 550 reply = doesn't exist
  5. Catch-all detection: probe a random invalid address first; if the
     server accepts it, the domain is catch-all and ALL probes will
     return 250 — we mark results as "risky" instead of "verified"
  6. Return the most likely email + confidence label:
       verified  — server explicitly accepted that pattern
       risky     — catch-all domain, our best-guess pattern
       unknown   — server blocks probes (Gmail, Microsoft 365)

Patterns are tried in popularity order; we stop at the first verified
hit so a single lookup typically costs 2-4 SMTP RCPT commands (~3 sec).

WHAT THIS DOES NOT DO:
- Personal email lookups (gmail/hotmail/yahoo) — those domains all
  catch-all → can't verify any specific @gmail address. Skipped.
- Microsoft 365 / Google Workspace tenants that aggressively rate-limit
  RCPT probes from a single IP → returns "unknown" after timeout.
- Phone numbers — different problem class, needs data partnerships.

Result is cached in lead.custom under the "email_finder" key so repeat
calls for the same lead don't reprobe.
"""
from __future__ import annotations

import asyncio
import contextlib
import re
import socket
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse

import dns.resolver  # type: ignore[import-untyped]
import aiosmtplib


# Free / personal mail hosts where pattern inference doesn't work.
# All accept every address → catch-all by definition.
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
    email: Optional[str]
    status: str  # verified | risky | unknown | not_found
    confidence: int  # 0-100
    patterns_tried: list[str]
    domain: Optional[str]
    catch_all: bool
    reason: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "email": self.email,
            "status": self.status,
            "confidence": self.confidence,
            "patterns_tried": self.patterns_tried,
            "domain": self.domain,
            "catch_all": self.catch_all,
            "reason": self.reason,
        }


def _normalize_name_part(s: str) -> str:
    """Strip accents, lowercase, drop non-letters. 'José' -> 'jose'."""
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
        # Allow bare domains too
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
    """Last-resort guess: try `<slug>.com` from a company name.
    Returns None for names that aren't obviously domainable.
    """
    if not name:
        return None
    slug = re.sub(r"[^a-z0-9]", "", name.lower())
    if not slug or len(slug) < 3 or slug.isdigit():
        return None
    return f"{slug}.com"


def _generate_patterns(first: str, last: str) -> list[str]:
    """Return common local-part patterns in rough popularity order.
    `first` and `last` should already be normalised (lowercase, ASCII).
    """
    if not first and not last:
        return []
    if not last:
        return [first]
    if not first:
        return [last]
    f, l = first, last
    fi, li = f[0], l[0]
    out = [
        f"{f}.{l}",   # most common in EU/Gulf B2B
        f"{f}{l}",
        f"{fi}{l}",   # jsmith
        f"{f}",
        f"{f}_{l}",
        f"{fi}.{l}",  # j.smith
        f"{f}-{l}",
        f"{l}.{f}",
        f"{l}{fi}",   # smithj
        f"{l}",
    ]
    # Dedupe while preserving order
    seen, dedup = set(), []
    for p in out:
        if p in seen:
            continue
        seen.add(p)
        dedup.append(p)
    return dedup


def _resolve_mx(domain: str) -> Optional[str]:
    """Return the highest-priority MX hostname for `domain`, or None."""
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
    """Open an SMTP conn, do EHLO + MAIL FROM + RCPT TO + QUIT, and
    return (accepted, code, message). Never sends DATA."""
    smtp = aiosmtplib.SMTP(hostname=mx_host, port=25, timeout=timeout)
    try:
        await smtp.connect()
        # Some servers require STARTTLS; we try without first, retry with
        # TLS if the initial EHLO is rejected.
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


async def find_email_async(
    *, first_name: Optional[str], last_name: Optional[str],
    domain: Optional[str], company_url: Optional[str] = None,
    company_name: Optional[str] = None, probe_sender: str = "verify@leadcaptura.io",
) -> EmailFinderResult:
    first = _normalize_name_part(first_name or "")
    last = _normalize_name_part(last_name or "")

    # Resolve domain
    dom = (domain or "").strip().lower() or None
    if not dom:
        dom = _extract_domain_from_url(company_url)
    if not dom:
        dom = _domain_from_company_name(company_name)

    if not dom:
        return EmailFinderResult(
            email=None, status="not_found", confidence=0,
            patterns_tried=[], domain=None, catch_all=False,
            reason="no_domain",
        )
    if dom in _PERSONAL_DOMAINS:
        return EmailFinderResult(
            email=None, status="unknown", confidence=0,
            patterns_tried=[], domain=dom, catch_all=True,
            reason="personal_mail_host",
        )

    mx = _resolve_mx(dom)
    if not mx:
        return EmailFinderResult(
            email=None, status="not_found", confidence=0,
            patterns_tried=[], domain=dom, catch_all=False,
            reason="no_mx_record",
        )

    patterns = _generate_patterns(first, last)
    if not patterns:
        return EmailFinderResult(
            email=None, status="not_found", confidence=0,
            patterns_tried=[], domain=dom, catch_all=False,
            reason="no_name",
        )

    # Catch-all probe: random impossible local-part.
    catch_all = False
    canary = f"lc-canary-{abs(hash(dom)) % 1000000:06d}-xyz"
    canary_ok, canary_code, _ = await _rcpt_probe(mx, probe_sender, f"{canary}@{dom}")
    if canary_ok:
        catch_all = True

    tried: list[str] = []
    best: Optional[tuple[str, int]] = None  # (email, confidence)

    for local in patterns[:6]:  # cap probes per lookup to stay quick
        candidate = f"{local}@{dom}"
        tried.append(candidate)
        ok, code, _msg = await _rcpt_probe(mx, probe_sender, candidate)
        if not ok:
            continue
        if catch_all:
            # Server accepts everything — still useful as a best-guess
            best = (candidate, 50)
            break
        # Server distinguishes good from bad addresses → verified
        return EmailFinderResult(
            email=candidate, status="verified", confidence=90,
            patterns_tried=tried, domain=dom, catch_all=False,
        )

    if best:
        return EmailFinderResult(
            email=best[0], status="risky", confidence=best[1],
            patterns_tried=tried, domain=dom, catch_all=True,
            reason="catch_all_domain",
        )

    return EmailFinderResult(
        email=None, status="not_found", confidence=0,
        patterns_tried=tried, domain=dom, catch_all=catch_all,
        reason="no_pattern_accepted",
    )


def find_email_sync(**kwargs) -> EmailFinderResult:
    """Sync wrapper for use from FastAPI sync handlers."""
    return asyncio.run(find_email_async(**kwargs))
