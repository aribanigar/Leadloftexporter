"""Email finder — pattern generation + DNS MX verification.

When a lead is captured from LinkedIn we typically have first_name, last_name,
and company_name but no email. This module:

1. Resolves a company name to its most likely web domain (slug + common TLDs,
   filtered by which actually have MX records).
2. Generates ranked email candidates for a person at that domain using the
   patterns that real B2B inboxes overwhelmingly use.
3. Picks the top candidate and stores it with email_status:
   - "guessed"      → domain has MX records, address is a pattern guess
   - "invalid"      → domain has no MX records (company has no email infra)
   - "unknown"      → we couldn't resolve a domain at all

SMTP RCPT-TO probing is intentionally NOT done here. Render's outbound port 25
is blocked and aggressive probing gets the source IP blacklisted across major
ESPs. Verification is a separate concern that, when wired in, should call a
third-party verification API (Hunter, Bouncer, etc.) — never raw SMTP from our
infrastructure.
"""
from __future__ import annotations

import re
from typing import Iterable, Optional
from urllib.parse import urlparse

import dns.exception
import dns.resolver

# Patterns ranked by global B2B prevalence (Hunter/Findymail aggregate data).
# Each pattern is a format string that consumes {first}, {last}, {fi}, {li}.
_PATTERNS: tuple[str, ...] = (
    "{first}.{last}",
    "{first}",
    "{first}{last}",
    "{fi}{last}",
    "{fi}.{last}",
    "{first}_{last}",
    "{first}-{last}",
    "{last}.{first}",
    "{last}{first}",
    "{last}",
)

# TLDs we attempt when guessing a domain from a company name, in order.
# .com is overwhelmingly dominant; the rest catch the long tail.
_TLDS: tuple[str, ...] = ("com", "io", "co", "ai", "net", "org")

# Cache MX lookups within a process so a single batch ingestion doesn't
# hammer the resolver. Sized small — keys are domains, leaks are bounded.
_mx_cache: dict[str, bool] = {}

_resolver = dns.resolver.Resolver()
_resolver.lifetime = 3.0  # total budget per lookup; do not block request handler
_resolver.timeout = 1.5


def _slug(text: str) -> str:
    """Lowercase, strip everything except letters and digits."""
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def _clean_part(part: Optional[str]) -> str:
    """Person name part → safe local-part segment."""
    return _slug(part or "")


def has_mx(domain: str) -> bool:
    """True if the domain has at least one MX record. Cached per process."""
    if not domain:
        return False
    if domain in _mx_cache:
        return _mx_cache[domain]
    ok = False
    try:
        answers = _resolver.resolve(domain, "MX")
        ok = len(answers) > 0
    except (dns.resolver.NoAnswer, dns.resolver.NXDOMAIN, dns.resolver.NoNameservers):
        ok = False
    except dns.exception.Timeout:
        ok = False
    except Exception:
        ok = False
    _mx_cache[domain] = ok
    return ok


def domain_from_url(url: Optional[str]) -> Optional[str]:
    """Extract a bare domain ('acme.com') from a URL of any shape."""
    if not url:
        return None
    s = url.strip()
    if "://" not in s:
        s = "http://" + s
    try:
        host = urlparse(s).hostname or ""
    except ValueError:
        return None
    host = host.lower()
    if host.startswith("www."):
        host = host[4:]
    return host or None


def guess_domain(company_name: Optional[str], website: Optional[str] = None) -> Optional[str]:
    """Best-effort: real website beats a guess, but we always verify MX."""
    if website:
        d = domain_from_url(website)
        if d and has_mx(d):
            return d
    if not company_name:
        return None
    slug = _slug(company_name)
    if not slug:
        return None
    # Try the slug as-is first, then a few common variants. Bail at first MX hit.
    candidates: list[str] = []
    for tld in _TLDS:
        candidates.append(f"{slug}.{tld}")
    # Also try with first significant word only (e.g. "Acme Corp" → "acme")
    head = re.split(r"\s+", (company_name or "").strip())[0]
    head_slug = _slug(head)
    if head_slug and head_slug != slug:
        for tld in _TLDS:
            candidates.append(f"{head_slug}.{tld}")
    for d in candidates:
        if has_mx(d):
            return d
    return None


def candidate_emails(
    first_name: Optional[str],
    last_name: Optional[str],
    domain: str,
) -> list[str]:
    """All candidate addresses for this person at this domain, ranked."""
    first = _clean_part(first_name)
    last = _clean_part(last_name)
    if not first and not last:
        return []
    fi = first[:1]
    li = last[:1]
    seen: set[str] = set()
    out: list[str] = []
    for pat in _PATTERNS:
        try:
            local = pat.format(first=first, last=last, fi=fi, li=li)
        except (KeyError, IndexError):
            continue
        local = local.strip(".-_")
        if not local or local in seen:
            continue
        seen.add(local)
        out.append(f"{local}@{domain}")
    return out


def find_best_email(
    first_name: Optional[str],
    last_name: Optional[str],
    company_name: Optional[str],
    website: Optional[str] = None,
    explicit_domain: Optional[str] = None,
) -> tuple[Optional[str], str, list[str]]:
    """Return (best_email, status, all_candidates).

    status ∈ {"guessed", "invalid", "unknown"}.
    - "guessed":  domain resolves with MX, candidates returned, top is best_email
    - "invalid":  domain provided/found but no MX; no usable email
    - "unknown":  couldn't determine a domain at all
    """
    domain = explicit_domain or guess_domain(company_name, website)
    if not domain:
        return None, "unknown", []
    if not has_mx(domain):
        return None, "invalid", []
    candidates = candidate_emails(first_name, last_name, domain)
    if not candidates:
        return None, "invalid", []
    return candidates[0], "guessed", candidates
