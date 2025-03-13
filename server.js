import express from "express";
import crypto from "crypto";
import cors from "cors";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const port = process.env.PORT || 8000;

app.use(express.json());
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? process.env.FRONTEND_URL 
    : 'http://localhost:5173'
}));

// Supabase Configuration
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// PhonePe Configuration (Test Environment)
const PHONEPE_CONFIG = {
  merchantId: process.env.MERCHANT_ID,
  saltKey: process.env.PHONEPE_SALT_KEY,
  saltIndex: process.env.PHONEPE_SALT_INDEX || 1,
  baseUrl: "https://api-preprod.phonepe.com/apis/pg-sandbox"
};

// Generate Transaction ID
const generateTxnId = () => `TXN${Date.now()}${crypto.randomBytes(2).readUInt16BE()}`;

// Enhanced order saving with validation
const saveOrderToSupabase = async (orderData) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .insert([orderData])
      .select()
      .single();

    if (error) throw new Error(`Database Error: ${error.message}`);
    return data;
  } catch (error) {
    console.error('Order Save Failed:', error.message);
    throw error;
  }
};

// Payment Endpoint
app.post("/create-order", async (req, res) => {
  try {
    const { name, email, mobileNumber, address, service_type, amount } = req.body;

    // Validation
    if (!/^\d{10}$/.test(mobileNumber)) {
      return res.status(400).json({ error: "Invalid mobile number" });
    }
    if (amount < 1) {
      return res.status(400).json({ error: "Minimum amount is ₹1" });
    }

    const txnId = generateTxnId();
    const orderData = {
      txn_id: txnId,
      name,
      email,
      phone: mobileNumber,
      address,
      service_type,
      amount: Number(amount),
      status: "PENDING",
      created_at: new Date().toISOString()
    };

    await saveOrderToSupabase(orderData);

    // Prepare PhonePe Request
    const paymentPayload = {
      merchantId: PHONEPE_CONFIG.merchantId,
      merchantTransactionId: txnId,
      amount: Math.round(amount * 100), // Convert to paise
      merchantUserId: `CUST_${mobileNumber}`,
      redirectUrl: `${process.env.BASE_URL}/payment/success?txn_id=${txnId}`,
      redirectMode: "POST",
      paymentInstrument: { type: "PAY_PAGE" }
    };

    // Generate Checksum
    const base64Payload = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
    const checksumString = `/pg/v1/pay${base64Payload}${PHONEPE_CONFIG.saltKey}`;
    const checksum = crypto
      .createHmac('sha256', PHONEPE_CONFIG.saltKey)
      .update(checksumString)
      .digest('hex');

    console.log("Payment Request Debug:", {
      checksumString: checksumString.slice(0, 50) + '...',
      checksum: checksum.slice(0, 50) + '...'
    });

    const paymentResponse = await fetch(`${PHONEPE_CONFIG.baseUrl}/pg/v1/pay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-VERIFY": `${checksum}###${PHONEPE_CONFIG.saltIndex}`
      },
      body: JSON.stringify({ request: base64Payload })
    });

    const result = await paymentResponse.json();
    console.log("PhonePe Response:", JSON.stringify(result, null, 2));

    if (!result?.data?.instrumentResponse?.redirectInfo?.url) {
      throw new Error("Payment gateway configuration error");
    }

    res.json({
      success: true,
      url: result.data.instrumentResponse.redirectInfo.url,
      txnId
    });

  } catch (error) {
    console.error("Payment Error:", {
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
    
    res.status(500).json({
      error: "Payment processing failed",
      code: "PAYMENT_ERROR",
      supportId: `ERR-${Date.now()}`
    });
  }
});

// Success Webhook
app.post("/payment/success", async (req, res) => {
  try {
    const { txn_id } = req.query;
    const paymentData = req.body;

    const { error } = await supabase
      .from('orders')
      .update({ 
        status: "SUCCESS",
        payment_details: paymentData,
        updated_at: new Date().toISOString()
      })
      .eq('txn_id', txn_id);

    if (error) throw error;

    res.redirect(`${process.env.FRONTEND_URL}/payment-success?txn_id=${txn_id}`);
  } catch (error) {
    console.error("Webhook Error:", error);
    res.redirect(`${process.env.FRONTEND_URL}/payment-error`);
  }
});

app.listen(port, () => console.log(`Server running on port ${port}`));
