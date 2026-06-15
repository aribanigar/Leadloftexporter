/* LinkedIn Voyager API interceptor — runs at document_start BEFORE LinkedIn's
 * own scripts load, so we catch the very first batch of API responses.
 *
 * We never call LinkedIn's APIs ourselves. We only observe responses to
 * requests that LinkedIn's own app is already making — the same requests that
 * appear in the browser's Network tab. This is purely passive.
 *
 * Data captured:
 *   window.__lcMsgQueue   — conversation participant profiles (for lead enrichment)
 *   window.__lcMsgCounts  — unread message counts per mailbox category
 *   window.__lcMsgThreads — raw message events (for timeline logging)
 */
(() => {
  if (window.__lcInterceptorInstalled) return;
  window.__lcInterceptorInstalled = true;

  window.__lcMsgQueue = [];   // { linkedin_url, first_name, last_name, full_name, headline, photo_url }
  window.__lcMsgCounts = {};  // { INBOX: 0, MESSAGE_REQUEST_PENDING: 0, ... }
  window.__lcMsgThreads = []; // raw message objects for timeline logging

  const _orig = window.fetch;

  window.fetch = async function (resource, init) {
    const res = await _orig.apply(this, arguments);
    try {
      const url = typeof resource === "string" ? resource : (resource?.url || "");
      if (!url.includes("voyagerMessagingGraphQL")) return res;

      const clone = res.clone();
      clone.json().then((data) => {
        // ── Conversation participants ──────────────────────────────────────────
        const convElements =
          data?.data?.messengerConversationsBySyncToken?.elements || [];
        for (const conv of convElements) {
          for (const p of (conv.conversationParticipants || [])) {
            const member = p?.participantType?.member;
            if (!member) continue;
            if (member.distance === "SELF") continue; // skip logged-in user
            const profileUrl = member.profileUrl;
            if (!profileUrl) continue;
            const firstName = member.firstName?.text || "";
            const lastName = member.lastName?.text || "";
            const fullName = `${firstName} ${lastName}`.trim();
            if (!firstName && !lastName) continue;
            // Best photo: prefer 400px, fall back to first available
            const artifacts = member.profilePicture?.artifacts || [];
            const root = member.profilePicture?.rootUrl || "";
            const art400 = artifacts.find((a) => a.width === 400) || artifacts[0];
            const photoUrl = art400 ? root + art400.fileIdentifyingUrlPathSegment : null;
            window.__lcMsgQueue.push({
              linkedin_url: profileUrl,
              first_name: firstName,
              last_name: lastName,
              full_name: fullName,
              headline: member.headline?.text || "",
              photo_url: photoUrl,
            });
          }
        }

        // ── Mailbox unread counts ─────────────────────────────────────────────
        const countElements =
          data?.data?.messengerMailboxCountsByMailbox?.elements || [];
        for (const c of countElements) {
          if (c.category && c.unreadConversationCount != null) {
            window.__lcMsgCounts[c.category] = c.unreadConversationCount;
          }
        }

        // ── Message content (for timeline logging) ────────────────────────────
        const msgBatch =
          data?.data?.messengerMessagesBySyncTokensInBatch || [];
        if (Array.isArray(msgBatch) && msgBatch.length > 0) {
          window.__lcMsgThreads.push(...msgBatch);
        }
      }).catch(() => { /* silently ignore parse errors */ });
    } catch { /* never let the interceptor break LinkedIn's app */ }
    return res;
  };
})();
