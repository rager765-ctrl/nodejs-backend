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

/**
 * 5. Send Campus Gig & Opportunity Notification
 */
export async function sendGigOpportunityNotice({
  submitterName = 'Campus Member',
  submitterEmail,
  gigTitle,
  gigCategory = 'General',
  budget,
  description,
  recipients,
  adminEmail = ADMIN_EMAIL
}) {
  const targetRecipients = (recipients && recipients.length > 0)
    ? recipients
    : Array.from(new Set([adminEmail, submitterEmail].filter(Boolean)));
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>New Campus Gig: ${gigTitle}</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F4F4F5; margin: 0; padding: 24px 12px; color: #18181B;">
      <div style="max-width: 600px; margin: 0 auto; background: #FFFFFF; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06); border: 1px solid #E4E4E7;">
        ${getEmailHeaderHTML('New Campus Gig Listed', `Category: ${gigCategory}`)}
        <div style="padding: 32px 24px;">
          <p style="font-size: 15px; margin-top: 0; color: #18181B;">A new opportunity has been posted on <strong>Kwabz Campus Gigs</strong>:</p>
          <div style="background-color: #FAFAFA; border: 1px solid #E4E4E7; border-left: 3px solid #000000; border-radius: 8px; padding: 18px; margin: 24px 0;">
            <p style="margin: 4px 0; font-size: 15px; color: #000000;"><strong>Title:</strong> ${gigTitle}</p>
            <p style="margin: 4px 0; font-size: 14px; color: #18181B;"><strong>Posted By:</strong> ${submitterName} (${submitterEmail || 'N/A'})</p>
            ${budget ? `<p style="margin: 4px 0; font-size: 14px; color: #18181B;"><strong>Budget / Reward:</strong> GHS ${Number(budget).toFixed(2)}</p>` : ''}
            ${description ? `<p style="margin: 10px 0 0 0; font-size: 13px; color: #52525B; line-height: 1.5;">${description}</p>` : ''}
          </div>
          <div style="text-align: center; margin-top: 32px;">
            <a href="${STORE_URL}/gigs.html" style="display: inline-block; background-color: #000000; color: #FFFFFF; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 700; font-size: 14px;">View Campus Gigs</a>
          </div>
        </div>
        ${getEmailFooterHTML()}
      </div>
    </body>
    </html>
  `;

  return await sendEmail({
    to: targetRecipients,
    subject: `New Campus Gig: ${gigTitle}`,
    html
  });
}

/**
 * 6. Send Campus Journal / Blog Post Notification
 */
export async function sendBlogJournalNotice({
  title,
  author = 'Kwabz Editorial',
  category = 'Campus Journal',
  excerpt,
  postUrl = `${STORE_URL}/blog.html`,
  recipients,
  adminEmail = ADMIN_EMAIL
}) {
  const targetRecipients = (recipients && recipients.length > 0) ? recipients : adminEmail;

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>New Journal Article: ${title}</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F4F4F5; margin: 0; padding: 24px 12px; color: #18181B;">
      <div style="max-width: 600px; margin: 0 auto; background: #FFFFFF; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06); border: 1px solid #E4E4E7;">
        ${getEmailHeaderHTML('Campus Journal Update', `Category: ${category}`)}
        <div style="padding: 32px 24px;">
          <p style="font-size: 13px; color: #71717A; text-transform: uppercase; font-weight: 700; letter-spacing: 1px; margin: 0 0 6px 0;">New Article Published</p>
          <h2 style="font-size: 20px; font-weight: 800; color: #000000; margin: 0 0 12px 0;">${title}</h2>
          <p style="font-size: 13px; color: #71717A; margin: 0 0 16px 0;">By <strong>${author}</strong></p>
          ${excerpt ? `<div style="background-color: #FAFAFA; border: 1px solid #E4E4E7; border-radius: 8px; padding: 16px; font-size: 14px; color: #27272A; line-height: 1.6; margin-bottom: 24px;">${excerpt}</div>` : ''}
          <div style="text-align: center; margin-top: 28px;">
            <a href="${postUrl}" style="display: inline-block; background-color: #000000; color: #FFFFFF; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 700; font-size: 14px;">Read Full Article</a>
          </div>
        </div>
        ${getEmailFooterHTML()}
      </div>
    </body>
    </html>
  `;

  return await sendEmail({
    to: targetRecipients,
    subject: `New Journal Article: ${title}`,
    html
  });
}

/**
 * 7. Send Lost and Found Alert Notification
 */
export async function sendLostFoundNotice({
  reporterName = 'Campus Student',
  reporterEmail,
  reporterPhone,
  itemType = 'Lost',
  itemName,
  location = 'Campus',
  description,
  recipients,
  adminEmail = ADMIN_EMAIL
}) {
  const targetRecipients = (recipients && recipients.length > 0)
    ? recipients
    : Array.from(new Set([adminEmail, reporterEmail].filter(Boolean)));
  const typeLabel = (itemType || 'Lost').toUpperCase();

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${typeLabel} Item Reported: ${itemName}</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F4F4F5; margin: 0; padding: 24px 12px; color: #18181B;">
      <div style="max-width: 600px; margin: 0 auto; background: #FFFFFF; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06); border: 1px solid #E4E4E7;">
        ${getEmailHeaderHTML('Lost and Found Report', `${typeLabel} ITEM ALERT`)}
        <div style="padding: 32px 24px;">
          <p style="font-size: 15px; margin-top: 0; color: #18181B;">A new <strong>${typeLabel}</strong> item report has been published on Kwabz Lost & Found:</p>
          <div style="background-color: #FAFAFA; border: 1px solid #E4E4E7; border-left: 3px solid #000000; border-radius: 8px; padding: 18px; margin: 24px 0;">
            <p style="margin: 4px 0; font-size: 15px; color: #000000;"><strong>Item Name:</strong> ${itemName}</p>
            <p style="margin: 4px 0; font-size: 14px; color: #18181B;"><strong>Status:</strong> ${typeLabel}</p>
            <p style="margin: 4px 0; font-size: 14px; color: #18181B;"><strong>Location:</strong> ${location}</p>
            <p style="margin: 4px 0; font-size: 14px; color: #18181B;"><strong>Reporter:</strong> ${reporterName} ${reporterPhone ? `(${reporterPhone})` : ''}</p>
            ${description ? `<p style="margin: 10px 0 0 0; font-size: 13px; color: #52525B; line-height: 1.5;">${description}</p>` : ''}
          </div>
          <div style="text-align: center; margin-top: 32px;">
            <a href="${STORE_URL}/lost-found.html" style="display: inline-block; background-color: #000000; color: #FFFFFF; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 700; font-size: 14px;">Open Lost & Found Hub</a>
          </div>
        </div>
        ${getEmailFooterHTML()}
      </div>
    </body>
    </html>
  `;

  return await sendEmail({
    to: targetRecipients,
    subject: `${typeLabel} Item Reported: ${itemName}`,
    html
  });
}

/**
 * 8. Send Thrift Market Listing Notification
 */
export async function sendThriftItemNotice({
  sellerName = 'Thrift Seller',
  sellerEmail,
  sellerPhone,
  itemTitle,
  price,
  location = 'Campus',
  condition = 'Pre-owned',
  recipients,
  adminEmail = ADMIN_EMAIL
}) {
  const targetRecipients = (recipients && recipients.length > 0)
    ? recipients
    : Array.from(new Set([adminEmail, sellerEmail].filter(Boolean)));

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>New Thrift Listing: ${itemTitle}</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F4F4F5; margin: 0; padding: 24px 12px; color: #18181B;">
      <div style="max-width: 600px; margin: 0 auto; background: #FFFFFF; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06); border: 1px solid #E4E4E7;">
        ${getEmailHeaderHTML('New Thrift Market Listing', `Condition: ${condition}`)}
        <div style="padding: 32px 24px;">
          <p style="font-size: 15px; margin-top: 0; color: #18181B;">A new pre-owned item was listed on <strong>Kwabz Thrift Market</strong>:</p>
          <div style="background-color: #FAFAFA; border: 1px solid #E4E4E7; border-left: 3px solid #000000; border-radius: 8px; padding: 18px; margin: 24px 0;">
            <p style="margin: 4px 0; font-size: 15px; color: #000000;"><strong>Item:</strong> ${itemTitle}</p>
            <p style="margin: 4px 0; font-size: 15px; color: #000000; font-weight: 800;"><strong>Price:</strong> GHS ${Number(price || 0).toFixed(2)}</p>
            <p style="margin: 4px 0; font-size: 14px; color: #18181B;"><strong>Seller:</strong> ${sellerName} ${sellerPhone ? `(${sellerPhone})` : ''}</p>
            <p style="margin: 4px 0; font-size: 14px; color: #18181B;"><strong>Pickup Location:</strong> ${location}</p>
          </div>
          <div style="text-align: center; margin-top: 32px;">
            <a href="${STORE_URL}/thrift.html" style="display: inline-block; background-color: #000000; color: #FFFFFF; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 700; font-size: 14px;">Browse Thrift Market</a>
          </div>
        </div>
        ${getEmailFooterHTML()}
      </div>
    </body>
    </html>
  `;

  return await sendEmail({
    to: targetRecipients,
    subject: `New Thrift Listing: ${itemTitle}`,
    html
  });
}

/**
 * 9. Send Selected Products Email Push Advertisement
 */
export async function sendProductAdNotice({
  products = [],
  customTitle,
  customMessage,
  recipients,
  adminEmail = ADMIN_EMAIL
}) {
  const targetRecipients = (recipients && recipients.length > 0)
    ? recipients
    : [adminEmail];

  const firstProd = products[0] || {};
  const mainTitle = customTitle || (products.length === 1 ? `🔥 Product Promo: ${firstProd.name || 'Featured Item'}` : `🛒 Product Spotlight: ${products.length} Featured Items!`);
  const cleanSubject = mainTitle.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();

  const productCardsHTML = products.map(p => {
    const discountedPrice = (p.discount && p.discount > 0) ? (p.price * (1 - p.discount / 100)) : p.price;
    const priceStr = `GH₵ ${Number(discountedPrice || 0).toFixed(2)}`;
    const originalPriceStr = (p.discount && p.discount > 0) ? `<span style="text-decoration: line-through; color: #A1A1AA; font-size: 13px; margin-left: 6px;">GH₵ ${Number(p.price).toFixed(2)}</span>` : '';
    const prodUrl = `${STORE_URL}/product-detail.html?id=${p.id}`;

    return `
      <div style="background-color: #FAFAFA; border: 1px solid #E4E4E7; border-radius: 12px; padding: 16px; margin-bottom: 16px; display: flex; align-items: center; gap: 16px;">
        ${p.image_url ? `
          <img src="${p.image_url}" alt="${p.name}" style="width: 80px; height: 80px; object-fit: cover; border-radius: 8px; flex-shrink: 0; background: #E4E4E7;" />
        ` : ''}
        <div style="flex: 1; min-width: 0;">
          <h4 style="margin: 0 0 4px 0; font-size: 15px; font-weight: 700; color: #18181B; font-family: sans-serif;">${p.name}</h4>
          <p style="margin: 0 0 8px 0; font-size: 15px; font-weight: 800; color: #000000;">${priceStr} ${originalPriceStr}</p>
          <a href="${prodUrl}" style="display: inline-block; background-color: #000000; color: #FFFFFF; text-decoration: none; padding: 6px 14px; border-radius: 6px; font-weight: 700; font-size: 12px;">Shop Now →</a>
        </div>
      </div>
    `;
  }).join('');

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
        ${getEmailHeaderHTML(mainTitle, 'Featured Product Announcement')}
        <div style="padding: 32px 24px;">
          ${customMessage ? `<div style="font-size: 14px; color: #27272A; line-height: 1.6; margin-bottom: 24px; background: #F4F4F5; border-left: 3px solid #000; padding: 12px 16px; border-radius: 6px;">${customMessage}</div>` : ''}
          ${productCardsHTML}
          <div style="text-align: center; margin-top: 32px;">
            <a href="${STORE_URL}/shop.html" style="display: inline-block; background-color: #000000; color: #FFFFFF; text-decoration: none; padding: 14px 36px; border-radius: 8px; font-weight: 700; font-size: 14px;">Browse Full Kwabz Store Catalog</a>
          </div>
        </div>
        ${getEmailFooterHTML()}
      </div>
    </body>
    </html>
  `;

  return await sendEmail({
    to: targetRecipients,
    subject: cleanSubject,
    html
  });
}

/**
 * 6. Send Admin Notification when a Data Bundle is Purchased
 */
export async function sendAdminBundleOrderNotice({
  buyerName = 'Valued Customer',
  targetPhone,
  network,
  packageName,
  packagePrice,
  orderLabel = 'N/A',
  paymentMethod = 'Local',
  customerEmail,
  adminEmail = ADMIN_EMAIL
}) {
  if (!targetPhone || !network || !packageName) {
    console.error('[EmailServices] Cannot send admin bundle order notice: missing bundle parameters');
    return { success: false, error: 'Missing required bundle parameters' };
  }

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>New Data Bundle Order - ${network.toUpperCase()} ${packageName}</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F4F4F5; margin: 0; padding: 24px 12px; color: #18181B;">
      <div style="max-width: 600px; margin: 0 auto; background: #FFFFFF; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06); border: 1px solid #E4E4E7;">
        
        ${getEmailHeaderHTML('New Data Bundle Order', `Network: ${network.toUpperCase()}`)}
        
        <div style="padding: 32px 24px;">
          <p style="font-size: 15px; margin-top: 0; color: #18181B;">Hello <strong>Admin</strong>,</p>
          <p style="font-size: 14px; color: #52525B; line-height: 1.5;">A new internet data bundle purchase was placed on Kwabz Store:</p>
          
          <div style="background-color: #FAFAFA; border: 1px solid #E4E4E7; border-left: 3px solid #000000; border-radius: 8px; padding: 18px; margin: 24px 0;">
            <h3 style="margin: 0 0 10px 0; font-size: 12px; color: #71717A; text-transform: uppercase; letter-spacing: 1px; font-weight: 700;">Customer & Target SIM Info</h3>
            <p style="margin: 6px 0; font-size: 14px; color: #18181B;"><strong>Customer Name:</strong> ${buyerName || 'N/A'}</p>
            <p style="margin: 6px 0; font-size: 14px; color: #18181B;"><strong>Target SIM Phone:</strong> <span style="font-size: 16px; font-weight: 900; color: #000000;">${targetPhone}</span></p>
            <p style="margin: 6px 0; font-size: 14px; color: #18181B;"><strong>Network Operator:</strong> <span style="font-weight: 800; text-transform: uppercase;">${network}</span></p>
            ${customerEmail ? `<p style="margin: 6px 0; font-size: 14px; color: #18181B;"><strong>Customer Email:</strong> ${customerEmail}</p>` : ''}
          </div>

          <div style="background-color: #000000; border-radius: 8px; padding: 20px; text-align: center; margin: 24px 0; color: #FFFFFF;">
            <span style="font-size: 11px; color: #A1A1AA; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px; display: block; margin-bottom: 6px;">ORDER & BUNDLE PACKAGE</span>
            <div style="font-size: 24px; font-weight: 900; color: #FFFFFF; margin-bottom: 4px;">${network.toUpperCase()} ${packageName}</div>
            <div style="font-size: 16px; color: #10B981; font-weight: 700;">GHS ${Number(packagePrice || 0).toFixed(2)} (${paymentMethod.toUpperCase()})</div>
            <div style="font-size: 12px; color: #A1A1AA; margin-top: 6px;">Order ID: ${orderLabel}</div>
          </div>

          <div style="text-align: center; margin-top: 32px;">
            <a href="${STORE_URL}/admin-bundles.html" style="display: inline-block; background-color: #000000; color: #FFFFFF; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 700; font-size: 14px; letter-spacing: 0.3px;">Open Admin Bundles Panel</a>
          </div>
        </div>

        ${getEmailFooterHTML()}
      </div>
    </body>
    </html>
  `;

  return await sendEmail({
    to: adminEmail,
    subject: `📶 Data Bundle Purchased: ${network.toUpperCase()} ${packageName} (${targetPhone})`,
    html
  });
}

/**
 * 12. Send Instant Wallet Top-Up Confirmation Email to User
 */
export async function sendUserWalletTopupNotice({
  userEmail,
  userName = 'Valued Customer',
  amount,
  reference,
  paymentMethod = 'Paystack MoMo / Card',
  newBalance
}) {
  if (!userEmail) {
    console.error('[EmailServices] Cannot send wallet topup notice: missing userEmail');
    return { success: false, error: 'Missing userEmail' };
  }

  const formattedAmount = Number(amount || 0).toFixed(2);
  const formattedBalance = newBalance !== undefined && newBalance !== null ? Number(newBalance).toFixed(2) : null;
  const dateStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Wallet Top-Up Successful</title>
    </head>
    <body style="font-family: Arial, sans-serif; background-color: #F4F4F5; margin: 0; padding: 20px; color: #18181B;">
      <div style="max-width: 580px; margin: 0 auto; background-color: #FFFFFF; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);">
        ${getEmailHeaderHTML('Wallet Deposit Received', 'Payment Processed Successfully')}
        
        <div style="padding: 32px 24px;">
          <p style="font-size: 15px; color: #18181B; margin-top: 0;">Hi <strong>${userName}</strong>,</p>
          <p style="font-size: 14px; color: #52525B; line-height: 1.5;">Your deposit of <strong>GH₵ ${formattedAmount}</strong> via <strong>${paymentMethod}</strong> has been received and credited to your Kwabz Store Wallet.</p>
          
          <div style="background-color: #000000; color: #FFFFFF; border-radius: 12px; padding: 20px; margin: 24px 0; text-align: center;">
            <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #A1A1AA; margin-bottom: 4px;">AMOUNT CREDITED</div>
            <div style="font-size: 28px; font-weight: 900; color: #10B981;">+ GH₵ ${formattedAmount}</div>
            ${formattedBalance ? `<div style="font-size: 13px; color: #E4E4E7; margin-top: 6px;">New Wallet Balance: <strong>GH₵ ${formattedBalance}</strong></div>` : ''}
          </div>

          <div style="background-color: #F4F4F5; border-radius: 10px; padding: 16px 20px; font-size: 13px; color: #52525B;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
              <span>Reference Number:</span>
              <strong style="color: #18181B; font-family: monospace;">${reference}</strong>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
              <span>Payment Method:</span>
              <strong style="color: #18181B;">${paymentMethod}</strong>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span>Date & Time:</span>
              <strong style="color: #18181B;">${dateStr}</strong>
            </div>
          </div>

          <div style="text-align: center; margin-top: 32px;">
            <a href="${STORE_URL}/account.html" style="display: inline-block; background-color: #000000; color: #FFFFFF; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 700; font-size: 14px; letter-spacing: 0.3px;">View Wallet Account</a>
          </div>
        </div>

        ${getEmailFooterHTML()}
      </div>
    </body>
    </html>
  `;

  return await sendEmail({
    to: userEmail,
    subject: `💳 Kwabz Wallet Top-Up Successful (+GH₵ ${formattedAmount})`,
    html
  });
}


