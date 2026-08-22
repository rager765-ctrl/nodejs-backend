import { sendEmail, DEFAULT_FROM_EMAIL } from './emailConfig.js';

const STORE_URL = process.env.STORE_URL || 'https://kwabz.store';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'opoku3765@gmail.com';
const LOGO_URL = `${STORE_URL}/icon-152x152.png`;

/**
 * Native Black & White Kwabz Store Email Header.
 */
function getEmailHeaderHTML(title, subtitle) {
  return `
    <div style="background: #000000; padding: 36px 24px; text-align: center; border-bottom: 1px solid #27272A;">
      <div style="display: inline-block; background: #000000; padding: 8px; border-radius: 12px; margin-bottom: 14px;">
        <img src="${LOGO_URL}" alt="Kwabz Logo" width="44" height="44" style="display: block; width: 44px; height: 44px; border-radius: 8px; border: none;" />
      </div>
      <div style="font-size: 18px; font-weight: 900; color: #FFFFFF; letter-spacing: 3px; text-transform: uppercase; margin-bottom: 6px;">
        KWABZ STORE
      </div>
      <h1 style="color: #FFFFFF; margin: 4px 0 0 0; font-size: 20px; font-weight: 700; letter-spacing: -0.3px;">${title}</h1>
      ${subtitle ? `<p style="color: #A1A1AA; margin: 6px 0 0 0; font-size: 13px; font-weight: 400; letter-spacing: 0.2px;">${subtitle}</p>` : ''}
    </div>
  `;
}

/**
 * Native Black & White Kwabz Store Email Footer.
 */
function getEmailFooterHTML() {
  const currentYear = new Date().getFullYear();
  return `
    <div style="background-color: #FAFAFA; padding: 24px 20px; text-align: center; border-top: 1px solid #E4E4E7; font-size: 12px; color: #71717A;">
      <div style="margin-bottom: 12px;">
        <a href="${STORE_URL}" style="color: #000000; text-decoration: none; font-weight: 700; margin: 0 10px;">Visit Store</a> • 
        <a href="${STORE_URL}/account.html" style="color: #000000; text-decoration: none; font-weight: 700; margin: 0 10px;">Account</a> • 
        <a href="${STORE_URL}/about.html" style="color: #000000; text-decoration: none; font-weight: 700; margin: 0 10px;">Support</a>
      </div>
      <p style="margin: 4px 0; color: #A1A1AA; font-size: 11px; letter-spacing: 0.2px;">Copyright ${currentYear} Kwabz Store. All rights reserved.</p>
    </div>
  `;
}

/**
 * 1. Send New Order Notification to Seller
 */
export async function sendSellerOrderNotice({
  sellerEmail,
  sellerName = 'Valued Seller',
  storeName = 'Kwabz Store',
  orderId,
  items = [],
  totalAmount,
  customerName,
  customerPhone,
  deliveryAddress
}) {
  if (!sellerEmail) {
    console.error('[EmailServices] Cannot send seller order notice: missing sellerEmail');
    return { success: false, error: 'Missing sellerEmail' };
  }

  const itemsHtml = items.map(item => `
    <tr>
      <td style="padding: 12px 10px; border-bottom: 1px solid #E4E4E7; font-size: 14px; color: #18181B;">
        <strong>${item.title || item.name || 'Product'}</strong> x ${item.quantity || 1}
      </td>
      <td style="padding: 12px 10px; border-bottom: 1px solid #E4E4E7; font-size: 14px; color: #18181B; text-align: right; font-weight: 600;">
        GHS ${(item.price || 0).toFixed(2)}
      </td>
    </tr>
  `).join('');

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>New Order Received - Order #${orderId}</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F4F4F5; margin: 0; padding: 24px 12px; color: #18181B;">
      <div style="max-width: 600px; margin: 0 auto; background: #FFFFFF; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06); border: 1px solid #E4E4E7;">
        
        ${getEmailHeaderHTML('New Order Received', `Store: ${storeName}`)}
        
        <div style="padding: 32px 24px;">
          <p style="font-size: 15px; margin-top: 0; color: #18181B;">Hello <strong>${sellerName}</strong>,</p>
          <p style="font-size: 14px; color: #52525B; line-height: 1.5;">You have received a new order <strong>#${orderId}</strong> on your store.</p>
          
          <div style="background-color: #FAFAFA; border: 1px solid #E4E4E7; border-left: 3px solid #000000; border-radius: 8px; padding: 18px; margin: 24px 0;">
            <h3 style="margin: 0 0 10px 0; font-size: 12px; color: #71717A; text-transform: uppercase; letter-spacing: 1px; font-weight: 700;">Customer Delivery Details</h3>
            <p style="margin: 4px 0; font-size: 14px; color: #18181B;"><strong>Customer:</strong> ${customerName || 'N/A'}</p>
            ${customerPhone ? `<p style="margin: 4px 0; font-size: 14px; color: #18181B;"><strong>Phone:</strong> ${customerPhone}</p>` : ''}
            ${deliveryAddress ? `<p style="margin: 4px 0; font-size: 14px; color: #18181B;"><strong>Address:</strong> ${deliveryAddress}</p>` : ''}
          </div>

          <h3 style="margin: 24px 0 12px 0; font-size: 14px; color: #000000; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px;">Order Summary</h3>
          <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
            <thead>
              <tr style="background-color: #000000; color: #FFFFFF;">
                <th style="padding: 10px; text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;">Item</th>
                <th style="padding: 10px; text-align: right; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;">Price</th>
              </tr>
            </thead>
            <tbody>
              ${itemsHtml}
            </tbody>
            <tfoot>
              <tr>
                <td style="padding: 14px 10px; font-weight: 700; font-size: 15px; color: #000000;">Total Order Value</td>
                <td style="padding: 14px 10px; font-weight: 900; font-size: 16px; color: #000000; text-align: right;">GHS ${Number(totalAmount || 0).toFixed(2)}</td>
              </tr>
            </tfoot>
          </table>

          <div style="text-align: center; margin-top: 32px;">
            <a href="${STORE_URL}/seller-dashboard.html?orderId=${orderId}" style="display: inline-block; background-color: #000000; color: #FFFFFF; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 700; font-size: 14px; letter-spacing: 0.3px;">Open Seller Dashboard</a>
          </div>
        </div>

        ${getEmailFooterHTML()}
      </div>
    </body>
    </html>
  `;

  return await sendEmail({
    to: sellerEmail,
    subject: `New Order Received - Order #${orderId}`,
    html
  });
}

/**
 * 2. Send Seller Onboarding PIN / Activation Notice to Admin
 */
export async function sendAdminSellerOnboardingNotice({
  sellerName,
  sellerEmail,
  sellerPhone,
  storeName,
  activationPin,
  adminEmail = ADMIN_EMAIL
}) {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Seller Activation Needed - Kwabz Store</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F4F4F5; margin: 0; padding: 24px 12px; color: #18181B;">
      <div style="max-width: 600px; margin: 0 auto; background: #FFFFFF; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06); border: 1px solid #E4E4E7;">
        
        ${getEmailHeaderHTML('Seller Activation Needed', 'New Seller Registration Alert')}
        
        <div style="padding: 32px 24px;">
          <p style="font-size: 14px; color: #52525B; margin-top: 0; line-height: 1.5;">A new seller store has registered and requires administrator activation PIN approval:</p>
          
          <div style="background-color: #FAFAFA; border: 1px solid #E4E4E7; border-left: 3px solid #000000; border-radius: 8px; padding: 18px; margin: 24px 0;">
            <p style="margin: 6px 0; font-size: 14px; color: #18181B;"><strong>Store Name:</strong> ${storeName || 'N/A'}</p>
            <p style="margin: 6px 0; font-size: 14px; color: #18181B;"><strong>Seller Name:</strong> ${sellerName || 'N/A'}</p>
            <p style="margin: 6px 0; font-size: 14px; color: #18181B;"><strong>Email Address:</strong> ${sellerEmail || 'N/A'}</p>
            <p style="margin: 6px 0; font-size: 14px; color: #18181B;"><strong>Phone Number:</strong> ${sellerPhone || 'N/A'}</p>
          </div>

          <div style="background-color: #000000; border-radius: 8px; padding: 24px; text-align: center; margin: 28px 0; color: #FFFFFF;">
            <span style="font-size: 11px; color: #A1A1AA; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; display: block;">ACTIVATION PIN CODE</span>
            <div style="font-size: 36px; font-weight: 900; color: #FFFFFF; letter-spacing: 10px; margin-top: 8px;">
              ${activationPin || '------'}
            </div>
          </div>

          <div style="text-align: center; margin-top: 32px;">
            <a href="${STORE_URL}/admin-sellers.html" style="display: inline-block; background-color: #000000; color: #FFFFFF; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 700; font-size: 14px; letter-spacing: 0.3px;">Open Admin Sellers Panel</a>
          </div>
        </div>

        ${getEmailFooterHTML()}
      </div>
    </body>
    </html>
  `;

  return await sendEmail({
    to: adminEmail,
    subject: `Seller Activation Needed: ${storeName || sellerName}`,
    html
  });
}

/**
 * 3. Send User Order Status Update Notification
 */
export async function sendUserOrderUpdateNotice({
  customerEmail,
  customerName = 'Valued Customer',
  orderId,
  newStatus,
  statusNotes,
  totalAmount
}) {
  if (!customerEmail) {
    console.error('[EmailServices] Cannot send order update notice: missing customerEmail');
    return { success: false, error: 'Missing customerEmail' };
  }

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Order Status Update - Order #${orderId}</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F4F4F5; margin: 0; padding: 24px 12px; color: #18181B;">
      <div style="max-width: 600px; margin: 0 auto; background: #FFFFFF; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06); border: 1px solid #E4E4E7;">
        
        ${getEmailHeaderHTML('Order Status Update', `Order #${orderId}`)}
        
        <div style="padding: 32px 24px;">
          <p style="font-size: 15px; margin-top: 0; color: #18181B;">Hello <strong>${customerName}</strong>,</p>
          <p style="font-size: 14px; color: #52525B; line-height: 1.5;">Your order status has been updated on Kwabz Store:</p>
          
          <div style="background-color: #000000; border-radius: 8px; padding: 20px; text-align: center; margin: 24px 0; color: #FFFFFF;">
            <span style="font-size: 11px; color: #A1A1AA; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; display: block; margin-bottom: 6px;">CURRENT STATUS</span>
            <span style="font-size: 22px; font-weight: 800; color: #FFFFFF; letter-spacing: 0.5px;">${newStatus.toUpperCase()}</span>
            ${statusNotes ? `<p style="margin: 10px 0 0 0; font-size: 13px; color: #D4D4D8;">${statusNotes}</p>` : ''}
          </div>

          ${totalAmount ? `<p style="font-size: 14px; color: #18181B;"><strong>Total Order Value:</strong> GHS ${Number(totalAmount).toFixed(2)}</p>` : ''}

          <div style="text-align: center; margin-top: 32px;">
            <a href="${STORE_URL}/tracking.html?orderId=${orderId}" style="display: inline-block; background-color: #000000; color: #FFFFFF; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 700; font-size: 14px; letter-spacing: 0.3px;">Track Order Status</a>
          </div>
        </div>

        ${getEmailFooterHTML()}
      </div>
    </body>
    </html>
  `;

  return await sendEmail({
    to: customerEmail,
    subject: `Order Update: #${orderId} - ${newStatus}`,
    html
  });
}

/**
 * 4. Send Platform Announcement / Broadcast Email Notification
 */
export async function sendPlatformAnnouncement({
  recipients,
  subject,
  title = 'Platform Announcement',
  message,
  actionUrl = STORE_URL,
  actionText = 'Visit Kwabz Store',
  bannerImageUrl
}) {
  if (!recipients || (Array.isArray(recipients) && recipients.length === 0)) {
    console.error('[EmailServices] Cannot send platform announcement: missing recipients');
    return { success: false, error: 'Missing recipients' };
  }

  // Clean title/subject from any emojis
  const cleanTitle = (title || 'Platform Announcement').replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();
  const cleanSubject = (subject || cleanTitle).replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${cleanSubject}</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F4F4F5; margin: 0; padding: 24px 12px; color: #18181B;">
      <div style="max-width: 600px; margin: 0 auto; background: #FFFFFF; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06); border: 1px solid #E4E4E7;">
        
        ${getEmailHeaderHTML(cleanTitle, 'Official Kwabz Store Notice')}
        
        ${bannerImageUrl ? `
          <div style="width: 100%; max-height: 240px; overflow: hidden;">
            <img src="${bannerImageUrl}" alt="Banner" style="width: 100%; height: auto; display: block; border: none;" />
          </div>
        ` : ''}

        <div style="padding: 32px 24px;">
          <div style="font-size: 14px; color: #27272A; line-height: 1.7;">
            ${message}
          </div>

          ${actionUrl ? `
            <div style="text-align: center; margin-top: 36px;">
              <a href="${actionUrl}" style="display: inline-block; background-color: #000000; color: #FFFFFF; text-decoration: none; padding: 14px 36px; border-radius: 8px; font-weight: 700; font-size: 14px; letter-spacing: 0.3px;">${actionText}</a>
            </div>
          ` : ''}
        </div>

        ${getEmailFooterHTML()}
      </div>
    </body>
    </html>
  `;

  return await sendEmail({
    to: recipients,
    subject: cleanSubject,
    html
  });
}
