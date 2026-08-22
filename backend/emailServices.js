import { sendEmail, DEFAULT_FROM_EMAIL } from './emailConfig.js';

const STORE_URL = process.env.STORE_URL || 'https://kwabz.store';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'opoku3765@gmail.com';
const LOGO_URL = `${STORE_URL}/icon-512.png`;

/**
 * Generates the unified, professional Kwabz Store Email Header.
 */
function getEmailHeaderHTML(title, subtitle, accentColor = '#4ADE80') {
  return `
    <div style="background: #0F172A; padding: 32px 24px; text-align: center; border-bottom: 3px solid ${accentColor};">
      <div style="display: inline-block; background: #1E293B; padding: 10px; border-radius: 14px; margin-bottom: 12px; border: 1px solid #334155; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">
        <img src="${LOGO_URL}" alt="Kwabz Logo" width="48" height="48" style="display: block; width: 48px; height: 48px; border-radius: 10px; border: none;" />
      </div>
      <div style="font-size: 20px; font-weight: 800; color: #FFFFFF; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 4px;">
        KWABZ<span style="color: ${accentColor};">STORE</span>
      </div>
      <h1 style="color: #FFFFFF; margin: 8px 0 0 0; font-size: 22px; font-weight: 700; letter-spacing: -0.5px;">${title}</h1>
      ${subtitle ? `<p style="color: #94A3B8; margin: 6px 0 0 0; font-size: 14px; font-weight: 400;">${subtitle}</p>` : ''}
    </div>
  `;
}

/**
 * Generates the unified Kwabz Store Email Footer.
 */
function getEmailFooterHTML() {
  const currentYear = new Date().getFullYear();
  return `
    <div style="background-color: #F8FAFC; padding: 24px 20px; text-align: center; border-top: 1px solid #E2E8F0; font-size: 13px; color: #64748B;">
      <div style="margin-bottom: 12px;">
        <a href="${STORE_URL}" style="color: #4F46E5; text-decoration: none; font-weight: 600; margin: 0 10px;">Visit Store</a> • 
        <a href="${STORE_URL}/account.html" style="color: #4F46E5; text-decoration: none; font-weight: 600; margin: 0 10px;">My Account</a> • 
        <a href="${STORE_URL}/about.html" style="color: #4F46E5; text-decoration: none; font-weight: 600; margin: 0 10px;">Customer Support</a>
      </div>
      <p style="margin: 4px 0; color: #94A3B8; font-size: 12px;">© ${currentYear} Kwabz Store. High-end curated essentials.</p>
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
    console.error('[EmailServices] ❌ Cannot send seller order notice: missing sellerEmail');
    return { success: false, error: 'Missing sellerEmail' };
  }

  const itemsHtml = items.map(item => `
    <tr>
      <td style="padding: 12px 10px; border-bottom: 1px solid #E2E8F0; font-size: 14px; color: #1E293B;">
        <strong>${item.title || item.name || 'Product'}</strong> x ${item.quantity || 1}
      </td>
      <td style="padding: 12px 10px; border-bottom: 1px solid #E2E8F0; font-size: 14px; color: #1E293B; text-align: right;">
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
      <title>New Order Received - Kwabz Store</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F1F5F9; margin: 0; padding: 24px 12px; color: #334155;">
      <div style="max-width: 600px; margin: 0 auto; background: #FFFFFF; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.08); border: 1px solid #E2E8F0;">
        
        ${getEmailHeaderHTML('🛒 New Order Received!', `Store: ${storeName}`, '#4ADE80')}
        
        <div style="padding: 32px 24px;">
          <p style="font-size: 16px; margin-top: 0; color: #0F172A;">Hi <strong>${sellerName}</strong>,</p>
          <p style="font-size: 15px; color: #475569; line-height: 1.5;">You have received a new order <strong style="color: #0F172A;">#${orderId}</strong> on your store!</p>
          
          <div style="background-color: #F8FAFC; border-left: 4px solid #4ADE80; border-radius: 8px; padding: 18px; margin: 24px 0; border: 1px solid #E2E8F0; border-left-width: 4px;">
            <h3 style="margin: 0 0 10px 0; font-size: 13px; color: #64748B; text-transform: uppercase; letter-spacing: 0.5px;">Customer Delivery Info</h3>
            <p style="margin: 4px 0; font-size: 14px; color: #1E293B;"><strong>Customer:</strong> ${customerName || 'N/A'}</p>
            ${customerPhone ? `<p style="margin: 4px 0; font-size: 14px; color: #1E293B;"><strong>Phone:</strong> ${customerPhone}</p>` : ''}
            ${deliveryAddress ? `<p style="margin: 4px 0; font-size: 14px; color: #1E293B;"><strong>Address:</strong> ${deliveryAddress}</p>` : ''}
          </div>

          <h3 style="margin: 24px 0 12px 0; font-size: 15px; color: #0F172A; font-weight: 700;">Order Summary</h3>
          <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
            <thead>
              <tr style="background-color: #F8FAFC;">
                <th style="padding: 10px; text-align: left; font-size: 12px; color: #64748B; border-bottom: 2px solid #E2E8F0; text-transform: uppercase;">Product Item</th>
                <th style="padding: 10px; text-align: right; font-size: 12px; color: #64748B; border-bottom: 2px solid #E2E8F0; text-transform: uppercase;">Price</th>
              </tr>
            </thead>
            <tbody>
              ${itemsHtml}
            </tbody>
            <tfoot>
              <tr>
                <td style="padding: 14px 10px; font-weight: 700; font-size: 16px; color: #0F172A;">Total Order Value</td>
                <td style="padding: 14px 10px; font-weight: 800; font-size: 18px; color: #16A34A; text-align: right;">GHS ${Number(totalAmount || 0).toFixed(2)}</td>
              </tr>
            </tfoot>
          </table>

          <div style="text-align: center; margin-top: 32px;">
            <a href="${STORE_URL}/seller-dashboard.html?orderId=${orderId}" style="display: inline-block; background: linear-gradient(135deg, #1E293B 0%, #0F172A 100%); color: #FFFFFF; text-decoration: none; padding: 14px 32px; border-radius: 10px; font-weight: 700; font-size: 15px; box-shadow: 0 4px 12px rgba(15, 23, 42, 0.15);">Manage Order in Dashboard</a>
          </div>
        </div>

        ${getEmailFooterHTML()}
      </div>
    </body>
    </html>
  `;

  return await sendEmail({
    to: sellerEmail,
    subject: `🛒 New Order #${orderId} Received - ${storeName}`,
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
      <title>Seller Onboarding PIN Request - Kwabz Store</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F1F5F9; margin: 0; padding: 24px 12px; color: #334155;">
      <div style="max-width: 600px; margin: 0 auto; background: #FFFFFF; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.08); border: 1px solid #E2E8F0;">
        
        ${getEmailHeaderHTML('🔐 Seller Activation Needed', 'New Seller Registration Alert', '#818CF8')}
        
        <div style="padding: 32px 24px;">
          <p style="font-size: 15px; color: #475569; margin-top: 0; line-height: 1.5;">A new seller store has registered and requires admin PIN verification:</p>
          
          <div style="background-color: #F8FAFC; border-left: 4px solid #6366F1; border-radius: 8px; padding: 18px; margin: 24px 0; border: 1px solid #E2E8F0; border-left-width: 4px;">
            <p style="margin: 6px 0; font-size: 14px; color: #1E293B;"><strong>Store Name:</strong> ${storeName || 'N/A'}</p>
            <p style="margin: 6px 0; font-size: 14px; color: #1E293B;"><strong>Seller Name:</strong> ${sellerName || 'N/A'}</p>
            <p style="margin: 6px 0; font-size: 14px; color: #1E293B;"><strong>Email Address:</strong> ${sellerEmail || 'N/A'}</p>
            <p style="margin: 6px 0; font-size: 14px; color: #1E293B;"><strong>Phone Number:</strong> ${sellerPhone || 'N/A'}</p>
          </div>

          <div style="background: linear-gradient(135deg, #EEF2FF 0%, #E0E7FF 100%); border: 2px dashed #6366F1; border-radius: 12px; padding: 24px; text-align: center; margin: 28px 0;">
            <span style="font-size: 12px; color: #4338CA; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px;">ONBOARDING ACTIVATION PIN</span>
            <div style="font-size: 36px; font-weight: 900; color: #3730A3; letter-spacing: 8px; margin-top: 8px;">
              ${activationPin || '------'}
            </div>
          </div>

          <div style="text-align: center; margin-top: 32px;">
            <a href="${STORE_URL}/admin-sellers.html" style="display: inline-block; background-color: #4F46E5; color: #FFFFFF; text-decoration: none; padding: 14px 32px; border-radius: 10px; font-weight: 700; font-size: 15px; box-shadow: 0 4px 12px rgba(79, 70, 229, 0.2);">Open Admin Sellers Panel</a>
          </div>
        </div>

        ${getEmailFooterHTML()}
      </div>
    </body>
    </html>
  `;

  return await sendEmail({
    to: adminEmail,
    subject: `🔐 Seller Activation Needed: ${storeName || sellerName}`,
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
    console.error('[EmailServices] ❌ Cannot send order update notice: missing customerEmail');
    return { success: false, error: 'Missing customerEmail' };
  }

  const statusColors = {
    'Processing': { bg: '#DBEAFE', text: '#1E40AF', border: '#93C5FD' },
    'Dispatched': { bg: '#FEF3C7', text: '#92400E', border: '#FDE68A' },
    'Delivered': { bg: '#DCFCE7', text: '#166534', border: '#86EFAC' },
    'Completed': { bg: '#DCFCE7', text: '#166534', border: '#86EFAC' },
    'Cancelled': { bg: '#FEE2E2', text: '#991B1B', border: '#FCA5A5' }
  };

  const style = statusColors[newStatus] || { bg: '#F1F5F9', text: '#334155', border: '#CBD5E1' };

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Order Status Update - Kwabz Store</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F1F5F9; margin: 0; padding: 24px 12px; color: #334155;">
      <div style="max-width: 600px; margin: 0 auto; background: #FFFFFF; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.08); border: 1px solid #E2E8F0;">
        
        ${getEmailHeaderHTML('📦 Order Status Update', `Order #${orderId}`, '#38BDF8')}
        
        <div style="padding: 32px 24px;">
          <p style="font-size: 16px; margin-top: 0; color: #0F172A;">Hi <strong>${customerName}</strong>,</p>
          <p style="font-size: 15px; color: #475569; line-height: 1.5;">Your order status has been updated on Kwabz Store:</p>
          
          <div style="background-color: ${style.bg}; border: 1px solid ${style.border}; border-radius: 12px; padding: 20px; text-align: center; margin: 24px 0;">
            <span style="font-size: 12px; color: #64748B; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; display: block; margin-bottom: 4px;">CURRENT STATUS</span>
            <span style="font-size: 24px; font-weight: 800; color: ${style.text};">${newStatus}</span>
            ${statusNotes ? `<p style="margin: 10px 0 0 0; font-size: 14px; color: #475569;">${statusNotes}</p>` : ''}
          </div>

          ${totalAmount ? `<p style="font-size: 15px; color: #1E293B;"><strong>Total Order Amount:</strong> GHS ${Number(totalAmount).toFixed(2)}</p>` : ''}

          <div style="text-align: center; margin-top: 32px;">
            <a href="${STORE_URL}/tracking.html?orderId=${orderId}" style="display: inline-block; background-color: #0284C7; color: #FFFFFF; text-decoration: none; padding: 14px 32px; border-radius: 10px; font-weight: 700; font-size: 15px; box-shadow: 0 4px 12px rgba(2, 132, 199, 0.2);">Track Your Order</a>
          </div>
        </div>

        ${getEmailFooterHTML()}
      </div>
    </body>
    </html>
  `;

  return await sendEmail({
    to: customerEmail,
    subject: `📦 Order #${orderId} Update: ${newStatus} - Kwabz Store`,
    html
  });
}
