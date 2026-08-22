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
    const recipients = Array.isArray(to) ? to : [to];
    const payload = {
      from,
      to: recipients,
      subject,
    };
    if (html) payload.html = html;
    if (text) payload.text = text;

    const response = await resend.emails.send(payload);
    if (response.error) {
      console.error('[Resend] ❌ Error response from Resend API:', response.error);
      return { success: false, error: response.error };
    }

    console.log('[Resend] 📧 Email sent successfully! ID:', response.data?.id);
    return { success: true, data: response.data };
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
