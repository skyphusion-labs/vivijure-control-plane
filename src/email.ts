// Magic-link delivery via postern's send door (#52; transport ruled by the lead at the #52 gate).
//
// CONTRACT (postern inbound/src/api.ts + mailbox.ts, verified against the source, not assumed):
//   POST <POSTERN_SEND_URL>  body: SendRequest { to, subject, text?, html?, ... }
//   Authorization: Bearer <POSTERN_SEND_TOKEN>   -> needs `send` or `both` scope
//   200 { ok: true, messageId, threadId } | non-2xx { ok: false, error, message }
//
// We deliberately do NOT pass `from`. postern binds the sender identity to the token via its
// registry (POSTERN_SEND_IDENTITIES) and treats the bound `from` as AUTHORITATIVE; passing one
// would either be ignored or rejected. The identity is a deploy-time concern, not ours.

import type { ControlPlaneEnv } from "./env";

export interface MailSender {
  send(to: string, subject: string, text: string): Promise<void>;
}

/** Raised when postern refuses. Carries the REAL error, honest-failures rule. */
export class MailSendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MailSendError";
  }
}

export function posternSender(env: ControlPlaneEnv, fetchImpl: typeof fetch = fetch): MailSender {
  return {
    async send(to: string, subject: string, text: string): Promise<void> {
      const url = env.POSTERN_SEND_URL;
      const token = env.POSTERN_SEND_TOKEN;
      // Fail CLOSED and loud. An unconfigured send door must never look like a delivered mail.
      if (!url || !token) {
        throw new MailSendError("magic-link send is not configured (POSTERN_SEND_URL/TOKEN unset)", 503);
      }
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ to, subject, text }),
      });
      if (!res.ok) {
        // Surface postern's own words; do not invent a friendlier story about someone else's failure.
        let detail = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: string; message?: string };
          if (body?.error) detail = body.message ? `${body.error}: ${body.message}` : body.error;
        } catch {
          // non-JSON body: the status line is the honest detail
        }
        throw new MailSendError(`postern send failed (${detail})`, res.status);
      }
    },
  };
}

/** The magic-link mail. Plain text on purpose: it renders everywhere and cannot hide its target. */
export function magicLinkMail(link: string, ttlMinutes: number): { subject: string; text: string } {
  return {
    subject: "Your vivijure sign-in link",
    text: [
      "Here is your sign-in link for vivijure studio:",
      "",
      link,
      "",
      `It works once and expires in ${ttlMinutes} minutes.`,
      "If you did not ask for this link, you can ignore this mail; nothing was created.",
    ].join("\n"),
  };
}
