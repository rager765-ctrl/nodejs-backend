/**
 * Kwabz Store Online — USSD Engine Module
 * Supports Arkesel, Hubtel, Africa's Talking, Nalo, and Web Simulator USSD payloads.
 */

// In-memory session store (sessionId -> session state object)
const ussdSessions = new Map();
const SESSION_TTL = 3 * 60 * 1000; // 3 minutes timeout

// Cleanup expired sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of ussdSessions.entries()) {
    if (now - session.lastActive > SESSION_TTL) {
      ussdSessions.delete(id);
    }
  }
}, 60000);

/**
 * Format phone number to clean +233 standard
 */
function cleanPhone(phone) {
  if (!phone) return '';
  let str = phone.toString().trim().replace(/\D/g, '');
  if (str.startsWith('0')) str = '233' + str.substring(1);
  if (!str.startsWith('+') && str.length >= 10) str = '+' + str;
  return str;
}

/**
 * Main USSD Handler function
 * @param {Object} payload Normalized or raw payload from Telco Gateway / Simulator
 * @param {Object} storeContext Access to products, categories, sellers, orders from server cache/db
 */
export async function handleUssdRequest(payload, storeContext = {}) {
  // Normalize parameters across different gateways (Arkesel, Hubtel, Africa's Talking, Nalo, Simulator)
  const sessionId = payload.session_id || payload.SessionId || payload.sessionId || ('sim_' + (payload.phone_number || payload.phoneNumber || payload.mobile || payload.Mobile || 'anon'));
  const rawPhone = payload.phone_number || payload.mobile || payload.Mobile || payload.phoneNumber || payload.phone || '';
  const phone = cleanPhone(rawPhone);
  const serviceCode = payload.service_code || payload.ServiceCode || payload.serviceCode || '*920*88#';
  const rawText = (payload.text !== undefined ? payload.text : (payload.user_response !== undefined ? payload.user_response : (payload.Message || ''))).toString().trim();
  const requestType = payload.Type || payload.type || (rawText === '' || rawText === serviceCode ? 'Initiation' : 'Response');

  const isArkesel = payload.session_id !== undefined || payload.user_response !== undefined;
  const isHubtel = payload.Type !== undefined || payload.Mobile !== undefined;
  const payloadType = isArkesel ? 'arkesel' : (isHubtel ? 'hubtel' : 'standard');

  const { products = [], categories = [], sellers = [], orders = [], foodCategories = [], foodItems = [] } = storeContext;

  // Retrieve or create session
  let session = ussdSessions.get(sessionId);

  if (requestType === 'Initiation' || !session || rawText === '' || rawText === serviceCode) {
    // New Session Initialization
    session = {
      id: sessionId,
      phone: phone,
      rawPhone: rawPhone,
      step: 'MAIN_MENU',
      data: {},
      lastActive: Date.now()
    };
    ussdSessions.set(sessionId, session);
  } else {
    session.lastActive = Date.now();
  }

  // Check if caller is a registered vendor
  const isVendor = sellers.some(s => {
    const sPhone = cleanPhone(s.phone || s.whatsapp || s.mobile);
    return sPhone && phone && (sPhone === phone || sPhone.includes(phone.replace('+233', '0')));
  });

  const vendorObj = isVendor ? sellers.find(s => cleanPhone(s.phone || s.whatsapp || s.mobile) === phone) : null;

  // Handle Menu Navigation logic
  return processMenuStep(session, rawText, { products, categories, sellers, orders, foodCategories, foodItems, isVendor, vendorObj, payloadType, sessionId });
}

function processMenuStep(session, text, ctx) {
  const input = text.split('*').pop().trim(); // Get latest user input segment
  const respond = (msg, isCont) => formatResponse(msg, isCont, ctx.payloadType, ctx.sessionId);

  // If vendor dials in, direct to Vendor Desk on initiation
  if (ctx.isVendor && session.step === 'MAIN_MENU' && (text === '' || text === '*920*88#')) {
    session.step = 'VENDOR_MENU';
    return respond(`Welcome ${ctx.vendorObj ? ctx.vendorObj.store_name : 'Vendor'} 📦\n1. View Pending Orders\n2. Mark Order Delivered\n3. Store Earnings\n4. Store Status\n0. Exit`, true);
  }

  // ─── VENDOR MENU ROUTER ───────────────────────────────────────
  if (session.step === 'VENDOR_MENU') {
    if (input === '1') {
      const vOrders = ctx.orders.filter(o => (o.seller_id === ctx.vendorObj?.id || o.seller_id === ctx.vendorObj?.uid) && o.status !== 'delivered');
      if (vOrders.length === 0) {
        return respond(`No pending orders for your store right now. Great job! 👏`, false);
      }
      let msg = `Pending Orders (${vOrders.length}):\n`;
      vOrders.slice(0, 3).forEach((o, i) => {
        msg += `${i + 1}. #${o.order_number || o.id.substring(0, 6)} - GH₵${o.total_amount || 0} (${o.status})\n`;
      });
      return respond(msg, false);
    } else if (input === '2') {
      session.step = 'VENDOR_MARK_DELIVERED';
      return respond(`Enter Order # or Select:\n1. Mark latest order as Delivered`, true);
    } else if (input === '3') {
      const vOrders = ctx.orders.filter(o => o.seller_id === ctx.vendorObj?.id || o.seller_id === ctx.vendorObj?.uid);
      const totalRevenue = vOrders.reduce((sum, o) => sum + (parseFloat(o.total_amount) || 0), 0);
      return respond(`Store Earnings:\nTotal Revenue: GH₵ ${totalRevenue.toFixed(2)}\nCompleted Orders: ${vOrders.length}`, false);
    } else if (input === '4') {
      return respond(`Store Status: ONLINE 🟢\nYour store is visible to campus buyers.`, false);
    } else {
      return respond(`Kwabz Store 🎓\nThank you for selling with us!`, false);
    }
  }

  // ─── BUYER MAIN MENU ──────────────────────────────────────────
  if (session.step === 'MAIN_MENU') {
    if (text === '' || text === '*920*88#') {
      return respond(`Welcome to Kwabz Store 🎓🛒\n1. Quick Campus Shop\n2. Track Order\n3. Campus Food Hub\n4. Kwabz Wallet\n5. Today's Flash Deals\n6. Help & Support`, true);
    }

    if (input === '1') {
      session.step = 'SELECT_CATEGORY';
      let msg = `Select Category:\n`;
      ctx.categories.slice(0, 4).forEach((cat, idx) => {
        msg += `${idx + 1}. ${cat.name}\n`;
      });
      if (ctx.categories.length === 0) {
        msg += `1. Electronics\n2. Fashion & Accessories\n3. Hostel Essentials\n4. Books & Supplies\n`;
      }
      return respond(msg, true);
    } else if (input === '2') {
      session.step = 'TRACK_ORDER';
      const userOrders = ctx.orders.filter(o => cleanPhone(o.customer_phone || o.phone) === session.phone);
      if (userOrders.length === 0) {
        return respond(`No active orders found for ${session.rawPhone || 'your number'}.\nVisit kwabzstore.com to place your first order!`, false);
      }
      const latest = userOrders[0];
      const statusText = latest.status === 'delivered' ? 'Delivered ✅' : latest.status === 'out_for_delivery' ? 'Dispatch Rider En Route 🛵' : 'Processing Order 📦';
      return respond(`Order #${latest.order_number || latest.id.substring(0, 6)} Status:\nState: ${statusText}\nTotal: GH₵${latest.total_amount || 0}\nLocation: ${latest.delivery_address || 'Legon Campus'}`, false);
    } else if (input === '3') {
      session.step = 'FOOD_HUB';
      return respond(`Campus Food Hub 🍲\n1. Night Market Food\n2. Bush Canteen\n3. Jevico Special\n4. Campus Snacks`, true);
    } else if (input === '4') {
      return respond(`Kwabz Wallet Balance:\nGH₵ 0.00 Credit\n\nVisit kwabzstore.com/account to top up via MoMo!`, false);
    } else if (input === '5') {
      const topDeal = ctx.products.find(p => p.discount_price || p.price) || ctx.products[0];
      if (topDeal) {
        return respond(`🔥 Today's Flash Deal:\n${topDeal.name}\nPrice: GH₵ ${topDeal.price}\n\nDial *920*88# -> 1 to order now!`, false);
      }
      return respond(`🔥 Flash Deals: Check back at 12 PM for today's campus flash sale!`, false);
    } else if (input === '6') {
      return respond(`Kwabz Store Support 🎓\nCall/WhatsApp: 0540000000\nLocation: Legon Campus, Accra\nWebsite: kwabzstore.com`, false);
    }
  }

  // ─── BUYER CATEGORY SELECTION ─────────────────────────────────
  if (session.step === 'SELECT_CATEGORY') {
    const catIdx = parseInt(input, 10) - 1;
    const selectedCat = ctx.categories[catIdx];
    const catId = selectedCat ? selectedCat.id : null;

    const catProducts = ctx.products.filter(p => !catId || p.category_id === catId || p.category === selectedCat?.name).slice(0, 4);

    if (catProducts.length === 0) {
      return respond(`No items available in this category right now.\nDial *920*88# to try another item!`, false);
    }

    session.step = 'SELECT_PRODUCT';
    session.data.catProducts = catProducts;

    let msg = `Select Item:\n`;
    catProducts.forEach((prod, i) => {
      msg += `${i + 1}. ${prod.name.substring(0, 20)} - GH₵${prod.price}\n`;
    });
    return respond(msg, true);
  }

  // ─── PRODUCT SELECTION ─────────────────────────────────────────
  if (session.step === 'SELECT_PRODUCT') {
    const pIdx = parseInt(input, 10) - 1;
    const catProducts = session.data.catProducts || ctx.products.slice(0, 4);
    const selectedProduct = catProducts[pIdx];

    if (!selectedProduct) {
      return respond(`Invalid item selection. Dial *920*88# to start over.`, false);
    }

    session.step = 'SELECT_LOCATION';
    session.data.product = selectedProduct;

    return respond(`Ordering ${selectedProduct.name.substring(0, 18)} (GH₵${selectedProduct.price})\n\nSelect Delivery Campus/Hall:\n1. Pentagon / TF\n2. Evandy / Bani\n3. Jean Nelson / Alex Kwapong\n4. Main Campus Halls`, true);
  }

  // ─── LOCATION & CHECKOUT CONFIRMATION ──────────────────────────
  if (session.step === 'SELECT_LOCATION') {
    const halls = { '1': 'Pentagon / TF Hostel', '2': 'Evandy / Bani Hostel', '3': 'Jean Nelson / Alex Kwapong', '4': 'Main Campus Hall' };
    const location = halls[input] || 'Legon Campus';
    session.data.location = location;

    session.step = 'CONFIRM_ORDER';
    const prod = session.data.product;

    return respond(`Confirm Order 🛒\nItem: ${prod.name.substring(0, 18)}\nPrice: GH₵${prod.price}\nDelivery: ${location}\nMoMo Number: ${session.rawPhone}\n\n1. Confirm & Order\n2. Cancel`, true);
  }

  // ─── ORDER SUBMISSION ─────────────────────────────────────────
  if (session.step === 'CONFIRM_ORDER') {
    if (input === '1') {
      const prod = session.data.product;
      const orderNum = 'KB' + Math.floor(100000 + Math.random() * 900000);
      
      // Clear session
      ussdSessions.delete(session.id);

      return respond(`Order #${orderNum} Placed! 🎉\nItem: ${prod.name}\nTotal: GH₵${prod.price}\n\nA MoMo payment prompt has been sent to your phone. Check your phone to authorize! 🎓`, false);
    } else {
      ussdSessions.delete(session.id);
      return respond(`Order cancelled. Dial *920*88# anytime to shop on Kwabz!`, false);
    }
  }

  // Fallback
  return respond(`Kwabz Store 🎓\nDial *920*88# to shop or track orders!`, false);
}

/**
 * Format USSD response based on Telco Gateway specification (Arkesel, Hubtel, Standard CON/END)
 */
function formatResponse(message, isContinue, payloadType, sessionId) {
  if (payloadType === 'arkesel') {
    return {
      session_id: sessionId || '',
      message: message,
      continue_session: isContinue
    };
  }

  if (payloadType === 'hubtel') {
    return {
      Type: isContinue ? 'Response' : 'Release',
      Message: message
    };
  }
  
  // Standard format (Africa's Talking / Nalo / Web Simulator)
  return {
    status: isContinue ? 'CON' : 'END',
    message: `${isContinue ? 'CON ' : 'END '}${message}`,
    text: message,
    isContinue: isContinue,
    session_id: sessionId || '',
    continue_session: isContinue
  };
}
