import { Resend } from 'resend';
import dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.RESEND_API_KEY;

/**
 * Resend client instance initialized with RESEND_API_KEY environment variable.
 */
export const resend = apiKey ? new Resend(apiKey) : null;

/**
 * Default Sender Email Address for transactional emails.
 */
export const DEFAULT_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'Kwabz Store <noreply@kwabz.store>';

/**
 * Check whether Resend email service is properly configured with an API key.
 * @returns {boolean}
 */
export function isEmailConfigured() {
  return Boolean(apiKey && apiKey.trim().length > 0);
}

/**
 * Send an email via Resend email service.
 * 
 * @param {Object} options
 * @param {string|string[]} options.to - Recipient email address(es)
 * @param {string} options.subject - Email subject line
 * @param {string} [options.html] - HTML body
 * @param {string} [options.text] - Plain text body
 * @param {string} [options.from] - Sender email address (defaults to DEFAULT_FROM_EMAIL)
 * @returns {Promise<{success: boolean, data?: any, error?: any}>}
 */
export async function sendEmail({ to, subject, html, text, from = DEFAULT_FROM_EMAIL }) {
  if (!resend) {
    const errorMsg = 'Resend client is not initialized. Please verify RESEND_API_KEY in your .env file.';
    console.error('[Resend] ❌', errorMsg);
    return { success: false, error: errorMsg };
  }

  try {
    const rawRecipients = Array.isArray(to) ? to : [to];
    const recipients = Array.from(new Set(rawRecipients.filter(Boolean)));

    if (recipients.length === 0) {
      return { success: false, error: 'No valid recipient email address provided.' };
    }

    // Single recipient
    if (recipients.length === 1) {
      const target = recipients[0];
      const payload = { from, to: [target], subject };
      if (html) payload.html = html;
      if (text) payload.text = text;

      const response = await resend.emails.send(payload);
      if (response.error) {
        if (response.error.statusCode === 403 && response.error.message?.includes('not verified') && from !== 'Kwabz Store <onboarding@resend.dev>') {
          console.warn('[Resend] ⚠️ Custom domain sender unverified on Resend. Auto-retrying with onboarding@resend.dev...');
          payload.from = 'Kwabz Store <onboarding@resend.dev>';
          const retryResponse = await resend.emails.send(payload);
          if (!retryResponse.error) {
            console.log('[Resend] 📧 Fallback Email sent successfully! ID:', retryResponse.data?.id);
            return { success: true, data: retryResponse.data, usedFallback: true };
          }
        }
        console.error('[Resend] ❌ Error response from Resend API:', response.error);
        return { success: false, error: response.error };
      }

      console.log('[Resend] 📧 Email sent successfully! ID:', response.data?.id);
      return { success: true, data: response.data };
    }

    // Multiple recipients (Broadcast) — throttle in chunks of 5 with 600ms delay to stay well within Resend's 10 req/sec limit
    console.log(`[Resend] 🚀 Throttling broadcast of ${recipients.length} individual email(s)...`);
    const results = [];
    const chunkSize = 5;

    for (let i = 0; i < recipients.length; i += chunkSize) {
      const chunk = recipients.slice(i, i + chunkSize);
      const chunkResults = await Promise.allSettled(
        chunk.map(async (target) => {
          const payload = { from, to: [target], subject };
          if (html) payload.html = html;
          if (text) payload.text = text;

          try {
            let res = await resend.emails.send(payload);
            if (res.error && res.error.statusCode === 403 && res.error.message?.includes('not verified') && from !== 'Kwabz Store <onboarding@resend.dev>') {
              payload.from = 'Kwabz Store <onboarding@resend.dev>';
              res = await resend.emails.send(payload);
            }
            if (res.error) {
              console.error(`[Resend] ❌ Failed to send email to ${target}:`, res.error);
            } else {
              console.log(`[Resend] 📧 Email delivered to ${target} (ID: ${res.data?.id})`);
            }
            return res;
          } catch (e) {
            console.error(`[Resend] ❌ Error sending email to ${target}:`, e.message);
            return { error: e };
          }
        })
      );
      results.push(...chunkResults);
      if (i + chunkSize < recipients.length) {
        await new Promise(resolve => setTimeout(resolve, 600));
      }
    }

    const successfulCount = results.filter(r => r.status === 'fulfilled' && r.value && !r.value.error).length;
    console.log(`[Resend] 📧 Batch broadcast complete: ${successfulCount}/${recipients.length} emails delivered successfully.`);
    return { success: true, sentCount: successfulCount, total: recipients.length };
  } catch (error) {
    console.error('[Resend] ❌ Exception while sending email:', error);
    return { success: false, error };
  }
}

if (!apiKey) {
  console.warn('[Resend] ⚠️ RESEND_API_KEY is not defined in environment variables.');
} else {
  console.log('[Resend] ✅ Email configuration loaded successfully.');
}
