// Outbound email via Resend — closes the gap every leader-access build note
// up to this point flagged as "no delivery infra": magic links (claim +
// self-service login) previously only ever came back as a raw token in an
// API response, for an admin to copy-paste and hand-deliver manually.
//
// Optional by design: if RESEND_API_KEY isn't set (local dev, CI, a fresh
// clone), every send is a no-op that logs the link instead of throwing —
// the routes that call this (routes/admin.ts, routes/leader.ts) keep
// returning the raw token in their response bodies regardless, so nothing
// here is a hard dependency for local development.
import { Resend } from "resend";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
// Resend's shared sandbox sender — works out of the box with no domain
// verification, but only delivers to the Resend account's own verified
// email while the account is in test mode. Set RESEND_FROM_EMAIL (a sender
// on a domain verified in the Resend dashboard) to send to arbitrary
// recipients — see .env.example.
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "GT Opportunity Finder <onboarding@resend.dev>";

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

export const emailDeliveryConfigured = !!resend;

// Contact on file for an org can be an email OR a phone number (the request
// form's field is "email or phone" — see leader.ts) — there's no SMS
// delivery infra, so only the email-shaped contacts are actually mailable.
export function looksLikeEmail(contact: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact);
}

function escapeHtmlBasic(str: string): string {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

export async function sendMagicLinkEmail(opts: {
  to: string;
  orgName: string;
  purpose: "claim" | "login";
  url: string;
}): Promise<{ sent: boolean; error?: string }> {
  if (!resend) {
    console.warn(`[email] RESEND_API_KEY not set — would have emailed ${opts.to}: ${opts.url}`);
    return { sent: false, error: "not_configured" };
  }

  const subject =
    opts.purpose === "claim"
      ? `Manage your ${opts.orgName} listing — GT Opportunity Finder`
      : "Your GT Opportunity Finder login link";
  const actionText = opts.purpose === "claim" ? "Claim your listing" : "Log in";
  const intro =
    opts.purpose === "claim"
      ? `You've been approved to manage <strong>${escapeHtmlBasic(opts.orgName)}</strong>'s listing on GT Opportunity Finder.`
      : `Here's the login link you requested for <strong>${escapeHtmlBasic(opts.orgName)}</strong> on GT Opportunity Finder.`;

  try {
    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: opts.to,
      subject,
      html: `
        <p>${intro}</p>
        <p><a href="${opts.url}" style="display:inline-block;background:#B3A369;color:#003057;font-weight:700;padding:10px 18px;border-radius:8px;text-decoration:none;">${actionText}</a></p>
        <p style="color:#666;font-size:13px;">This link is single-use and expires soon. If you didn't request it, you can ignore this email.</p>
      `,
    });
    if (error) {
      console.error("[email] Resend rejected the send:", error);
      return { sent: false, error: error.message };
    }
    return { sent: true };
  } catch (err) {
    console.error("[email] Resend send failed:", err);
    return { sent: false, error: err instanceof Error ? err.message : String(err) };
  }
}
